import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPersonalStorageCoordinator } from '../src/personalStorage.ts'
import { PERSONAL_STORAGE_KEYS, serializePersonalStorageSnapshot } from '../src/personalStorageSnapshot.ts'
import { createPersonalSqliteSnapshotRepository } from '../src/personalSqliteSnapshot.ts'
import { createPersonalSqliteMigrationRepository } from '../src/personalSqliteMigration.ts'

const RECEIPT = 'cv_personal_migration', VALUES = 'cv_personal_value', CHUNKS = 'cv_personal_value_chunk'
const ORIGINALS = ['cv_personal_raw_snapshot', 'cv_personal_raw_snapshot_chunk']
const hash = value => createHash('sha256').update(value).digest('hex')

function source(values = [null, '', 'null', '[broken JSON', "🎬 ação\r\n\u0000\ud800x\udfff", ' {"volume":0,"future":[999999]}\r\n']) {
  const data = new Map(PERSONAL_STORAGE_KEYS.map((key, index) => [key, values[index] ?? null]))
  const store = {getItem(key) { return data.get(key) ?? null }, setItem(key, value) { data.set(key, value) }, removeItem(key) { data.delete(key) }}
  const coordinator = createPersonalStorageCoordinator(() => store), pause = coordinator.pauseWrites()
  const snapshot = pause.captureSnapshot()
  return {data, store, coordinator, pause, snapshot, guard: () => pause.assertUnchanged(snapshot)}
}

function host(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-personal-migration-'))
  const filename = path.join(directory, 'synthetic.sqlite')
  let native = new DatabaseSync(filename)
  const calls = []
  const connection = {
    async execute(sql, transaction) { calls.push(['execute', sql]); assert.equal(transaction, false); return native.prepare(sql).run() },
    async run(sql, values, transaction) { calls.push(['run', sql, values]); assert.equal(transaction, false); return native.prepare(sql).run(...values) },
    async query(sql, values = []) { calls.push(['query', sql, values]); return {values: native.prepare(sql).all(...values).map(row => ({...row}))} },
    async beginTransaction() { calls.push(['begin']); native.exec('BEGIN') },
    async commitTransaction() { calls.push(['commit']); native.exec('COMMIT') },
    async rollbackTransaction() { calls.push(['rollback']); native.exec('ROLLBACK') },
    async isTransactionActive() { calls.push(['active']); return {result: native.isTransaction} },
  }
  const fixture = {
    connection, calls, filename,
    get native() { return native },
    repository() { return createPersonalSqliteMigrationRepository(connection) },
    reopen() { native.close(); native = new DatabaseSync(filename); return this.repository() },
    tables() { return native.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name) },
  }
  t.after(() => { native.close(); fs.rmSync(directory, {recursive: true}) })
  return fixture
}

async function migrate(fixture, input = source()) {
  const repository = fixture.repository(), prepared = await repository.prepare(input.snapshot)
  return {repository, input, prepared, state: await prepared.commit(input.guard)}
}

import { createPersonalStorageBootstrap } from '../src/personalStorageBootstrap.ts'
import { acquirePersonalStorageLock } from '../src/personalStorageLock.ts'
import { createPersonalAuthorityStore } from '../src/personalStorageAuthority.ts'

function legacy(values=[' {"future":[999999]}\r\n','{broken',null,'','null','preferences']) {
 const data=new Map(PERSONAL_STORAGE_KEYS.map((key,i)=>[key,values[i]]))
 let reads=0,denied=false,receipt=null
 const authority=createPersonalAuthorityStore('cinevault_personal',{async read(){return receipt},async write(text){receipt=text}})
 const coordinator=createPersonalStorageCoordinator(()=>({getItem(key){reads++;if(denied)throw Error('PRIVATE READ FAILURE');return data.get(key)??null},setItem(key,raw){data.set(key,raw)},removeItem(key){data.delete(key)}}))
 return {coordinator,data,authority,get reads(){return reads},set denied(value){denied=value}}
}

test('bootstrap construction is lazy and first open migrates exact raw data before exposing a UI reader', async t=>{
 const f=host(t),old=legacy(),boot=createPersonalStorageBootstrap(old.coordinator,old.authority)
 assert.equal(old.reads,0);assert.equal(f.calls.length,0)
 const opening=boot.open(f.connection)
 assert.equal(old.coordinator.phase,'paused')
 assert.throws(()=>old.coordinator.store.setItem(PERSONAL_STORAGE_KEYS[0],'premature'),/pausada/)
 const store=await opening
 assert.equal(store.kind,'sqlite');assert.equal(old.coordinator.phase,'closed')
 assert.deepEqual(store.captureSnapshot().entries.map(entry=>entry.raw),[...old.data.values()])
 assert.throws(()=>old.coordinator.store.getItem(PERSONAL_STORAGE_KEYS[0]),/encerrado/)
 assert.equal((await f.reopen().read()).revision,0)
})

test('an authoritative database is opened without reading or replacing stale or denied legacy storage', async t=>{
 const f=host(t),{repository}=await migrate(f)
 await repository.writeBatch([{key:PERSONAL_STORAGE_KEYS[0],raw:'newest durable state'}],0)
 const old=legacy(),boot=createPersonalStorageBootstrap(old.coordinator,old.authority)
 old.denied=true
 const store=await boot.open(f.connection)
 assert.equal(old.reads,0)
 assert.equal(store.reader.getItem(PERSONAL_STORAGE_KEYS[0]),'newest durable state')
 assert.equal(old.coordinator.phase,'closed')
})

test('a denied initial snapshot leaves writers paused and retrying a fresh connection can safely complete', async t=>{
 const f=host(t),old=legacy(),boot=createPersonalStorageBootstrap(old.coordinator,old.authority)
 old.denied=true
 await assert.rejects(boot.open(f.connection),/cannot read/)
 assert.equal(old.coordinator.phase,'paused');assert.deepEqual(f.tables(),[])
 old.denied=false;f.reopen()
 const session=await boot.open(f.connection)
 assert.equal(session.reader.getItem(PERSONAL_STORAGE_KEYS[0]),old.data.get(PERSONAL_STORAGE_KEYS[0]))
 assert.equal(old.coordinator.phase,'closed')
})

test('a lost migration commit acknowledgement never selects a legacy fallback and retry reads the durable marker', async t=>{
 const f=host(t),old=legacy(),boot=createPersonalStorageBootstrap(old.coordinator,old.authority),commit=f.connection.commitTransaction
 let lost=false
 f.connection.commitTransaction=async()=>{
  const exists=f.native.prepare("SELECT name FROM sqlite_master WHERE name='cv_personal_migration'").get()
  await commit()
  if(exists&&!lost){lost=true;throw Error('PRIVATE LOST ACK')}
 }
 await assert.rejects(boot.open(f.connection),error=>!error.message.includes('PRIVATE'))
 assert.equal(old.coordinator.phase,'paused')
 const reads=old.reads
 f.connection.commitTransaction=commit;f.reopen()
 const session=await boot.open(f.connection)
 assert.equal(old.reads,reads)
 assert.equal(session.kind,'sqlite');assert.equal(old.coordinator.phase,'closed')
})

test('a corrupt committed database cannot trigger migration from the legacy source or replace its original', async t=>{
 const f=host(t),{input}=await migrate(f)
 f.native.exec("UPDATE cv_personal_value_chunk SET payload='corrupt' WHERE slot=0")
 const old=legacy(),boot=createPersonalStorageBootstrap(old.coordinator,old.authority)
 await assert.rejects(boot.open(f.connection),/integrity mismatch/)
 assert.equal(old.reads,0);assert.equal(old.coordinator.phase,'paused')
 assert.deepEqual(await createPersonalSqliteSnapshotRepository(f.connection).read(),input.snapshot)
})

test('another source pause and concurrent bootstrap calls are refused before joining their work', async t=>{
 const f=host(t),old=legacy()
 old.coordinator.pauseWrites()
 await assert.rejects(createPersonalStorageBootstrap(old.coordinator,old.authority).open(f.connection),/Outra operação/)
 assert.equal(f.calls.length,0)
 const current=legacy(),boot=createPersonalStorageBootstrap(current.coordinator,current.authority)
 const first=boot.open(f.connection)
 await assert.rejects(boot.open(f.connection),/andamento/)
 const opened=await first
 assert.equal(opened.kind,'sqlite')
})

test('owner locks refuse missing support and an occupied resource rather than opening unprotected', async()=>{
 await assert.rejects(acquirePersonalStorageLock(undefined),/proteção necessária/)
 const taken={request:async(name,options,callback)=>{assert.equal(options.ifAvailable,true);return callback(null)}}
 await assert.rejects(acquirePersonalStorageLock(taken),/outra janela/)
})

test('the native context lock remains held until its owner explicitly releases it', async()=>{
 let held=false,finished=false
 const locks={request:async(name,options,callback)=>{assert.equal(options.mode,'exclusive');held=true;await callback({name});held=false;finished=true}}
 const lease=await acquirePersonalStorageLock(locks)
 assert.equal(held,true);assert.equal(finished,false)
 await lease.release()
 assert.equal(held,false);assert.equal(finished,true)
 await lease.release()
})


test('an independent authority receipt prevents re-migration after the whole personal database is lost',async t=>{
 const f=host(t),old=legacy(),boot=createPersonalStorageBootstrap(old.coordinator,old.authority)
 const session=await boot.open(f.connection)
 await session.commitJson([{key:PERSONAL_STORAGE_KEYS[0],value:{newest:true}}]);await session.close()
 for(const name of f.tables())f.native.exec('DROP TABLE '+name)
 f.reopen()
 const restarted=legacy()
 await assert.rejects(createPersonalStorageBootstrap(restarted.coordinator,old.authority).open(f.connection),/banco confirmado/)
 assert.equal(restarted.reads,0);assert.deepEqual(f.tables(),[])
})

test('an invalid authority receipt is refused before any database operation or legacy source read',async t=>{
 const f=host(t),old=legacy(),authority=createPersonalAuthorityStore('cinevault_personal',{async read(){return '{broken'},async write(){assert.fail('must not overwrite invalid receipt')}})
 await assert.rejects(createPersonalStorageBootstrap(old.coordinator,authority).open(f.connection),/Marcador/)
 assert.equal(old.reads,0);assert.equal(f.calls.length,0)
})
