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

import { createBrowserPersonalPersistence, createSqlitePersonalPersistence } from '../src/personalPersistence.ts'
import { readPersonalJsonModel, updatePersonalJsonModel } from '../src/personalJsonModel.ts'
import { createAsyncJsonMapStorage } from '../src/jsonMapStorage.ts'
const key = PERSONAL_STORAGE_KEYS[0], pulseKey = PERSONAL_STORAGE_KEYS[1]
const patch = (key, raw) => [{key,raw}]
async function session(t) {
  const fixture=host(t), {repository,state,input}=await migrate(fixture)
  return {fixture,repository,state,input,store:createSqlitePersonalPersistence(repository,state)}
}

test('the read cache and UI version advance only after the native commit acknowledgement', async t=>{
 const {store,state,repository,fixture}=await session(t)
 let entered,release
 const waiting=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
 const delayed=createSqlitePersonalPersistence({async writeBatch(...args){const committed=await repository.writeBatch(...args);entered();await gate;return committed}},state)
 const notifications=[];delayed.subscribe(()=>notifications.push(delayed.getStatus()))
 const writing=delayed.commitJson([{key,value:{favorites:[1],watched:[],ratings:{}}}])
 await waiting
 assert.equal(delayed.reader.getItem(key),state.snapshot.entries[0].raw)
 assert.equal(delayed.getStatus().version,0)
 assert.equal(delayed.getStatus().phase,'saving')
 assert.equal(fixture.native.prepare('SELECT revision FROM cv_personal_migration').get().revision,1)
 release();await writing
 assert.deepEqual(JSON.parse(delayed.reader.getItem(key)),{favorites:[1],watched:[],ratings:{}})
 assert.equal(delayed.getStatus().version,1);assert.equal(delayed.getStatus().phase,'ready')
 assert.ok(notifications.some(status=>status.phase==='saving'&&status.version===0))
 assert.equal(store.reader.getItem(key),state.snapshot.entries[0].raw)
})

test('queued transformations read the preceding committed state rather than a stale React closure', async t=>{
 const {store,fixture}=await session(t)
 await store.commitJson([{key,value:{count:0}}])
 await Promise.all(Array.from({length:6},()=>store.update(reader=>[{key,value:{count:JSON.parse(reader.getItem(key)).count+1}}])))
 assert.equal(JSON.parse(store.reader.getItem(key)).count,6)
 assert.equal((await fixture.reopen().read()).revision,7)
 assert.equal(store.getStatus().pending,0)
})

test('a personal list and its watch journal are acknowledged in one SQLite revision', async t=>{
 const {store,fixture,input}=await session(t)
 const saved={favorites:[1],watched:[2],ratings:{2:5}},pulse={queue:[],history:[{filmId:2,watchedAt:'2026-10-22T12:00:00Z'}],notes:{},recent:[],dailyOffset:0}
 await store.update(()=>[{key,value:saved},{key:pulseKey,value:pulse}])
 const current=await fixture.reopen().read()
 assert.equal(current.revision,1)
 assert.deepEqual(JSON.parse(current.snapshot.entries[0].raw),saved)
 assert.deepEqual(JSON.parse(current.snapshot.entries[1].raw),pulse)
 assert.deepEqual(await createPersonalSqliteSnapshotRepository(fixture.connection).read(),input.snapshot)
})

test('lost commit acknowledgement blocks queued writers and reopening reads the actual durable state', async t=>{
 const {state,repository,fixture}=await session(t)
 let calls=0,secondRan=false
 const store=createSqlitePersonalPersistence({async writeBatch(...args){calls++;await repository.writeBatch(...args);throw Error('PRIVATE NATIVE DATA')}},state)
 const first=store.commitJson([{key,value:{newest:true}}])
 const second=store.update(()=>{secondRan=true;return [{key:pulseKey,value:{mustNotWrite:true}}]})
 await assert.rejects(first,error=>!error.message.includes('PRIVATE'))
 await assert.rejects(second,/interrompido/)
 await assert.rejects(store.flush(),/interrompido/)
 assert.equal(calls,1);assert.equal(secondRan,false);assert.equal(store.getStatus().phase,'failed')
 assert.equal(store.reader.getItem(key),state.snapshot.entries[0].raw)
 const repo=fixture.reopen(),recovered=await repo.read(),reopened=createSqlitePersonalPersistence(repo,recovered)
 assert.deepEqual(JSON.parse(reopened.reader.getItem(key)),{newest:true})
 await assert.rejects(store.writeRaw(patch(key,'stale')),/interrompido/)
})

test('closing drains already accepted edits, rejects new edits and revokes old readers', async t=>{
 const {store,fixture}=await session(t)
 const first=store.writeRaw(patch(key,'durable'))
 const closing=store.close()
 await assert.rejects(store.writeRaw(patch(key,'stale')),/encerrada/)
 await first;await closing
 assert.throws(()=>store.reader.getItem(key),/encerrada/)
 assert.equal((await fixture.reopen().read()).snapshot.entries[0].raw,'durable')
})

test('invalid input and failed model transformations do not call SQLite or block unrelated valid edits', async t=>{
 const {store}=await session(t)
 for(const invalid of [[{key:'outside',raw:'private'}],[{key,raw:1}],[{key,raw:'a'},{key,raw:'b'}]])await assert.rejects(store.writeRaw(invalid))
 await assert.rejects(store.commitJson([{key,value:undefined}]))
 await assert.rejects(store.update(async()=>[]),/inválido/)
 await assert.rejects(store.update(()=>{throw Error('model rejected')}),/model rejected/)
 assert.equal(store.getStatus().phase,'ready');assert.equal(store.getStatus().version,0)
 await store.writeRaw(patch(PERSONAL_STORAGE_KEYS[5],'valid other key'))
 assert.equal(store.getStatus().version,1)
})

test('batch inputs detach before yielding and an identical retry does not increment the native revision', async t=>{
 const {store,fixture}=await session(t)
 const value={exact:['first']},changes=[{key,value}]
 const job=store.commitJson(changes)
 value.exact[0]='mutated';changes.push({key:pulseKey,value:'later'})
 await job
 assert.deepEqual(JSON.parse(store.reader.getItem(key)),{exact:['first']})
 const version=store.getStatus().version
 await store.commitJson([{key,value:{exact:['first']}}])
 assert.equal(store.getStatus().version,version)
 assert.equal((await fixture.reopen().read()).revision,1)
})

test('complete snapshots restore all six raw values and preferences atomically and never replace the immutable source', async t=>{
 const {store,fixture,input}=await session(t),restored=source(['future IDs',null,'','null','{broken','preferences 🎬\ud800']).snapshot
 const mutable=structuredClone(restored),writing=store.restoreSnapshot(mutable)
 mutable.entries[0].raw='mutated after restore call'
 await writing
 assert.deepEqual(store.captureSnapshot(),restored)
 assert.equal((await fixture.reopen().read()).revision,1)
 assert.deepEqual(await createPersonalSqliteSnapshotRepository(fixture.connection).read(),input.snapshot)
 await assert.rejects(store.restoreSnapshot({...restored,version:2}))
 assert.deepEqual(store.captureSnapshot(),restored)
})

test('unknown IDs, fields and normalization remain readable but cannot be silently saved as a reduced model', async t=>{
 const {store}=await session(t)
 await store.writeRaw(patch(key,'  {"known":[1,999999],"future":true}\r\n'))
 const decode=value=>({known:value.known.filter(id=>id===1)})
 assert.equal(readPersonalJsonModel(store.reader,key,decode,()=>({known:[]})).blocked,true)
 const before=store.reader.getItem(key)
 await assert.rejects(store.update(reader=>updatePersonalJsonModel(reader,key,decode,()=>({known:[]}),old=>({...old,known:[]}))),/preservados/)
 assert.equal(store.reader.getItem(key),before)
 assert.equal(store.getStatus().phase,'ready')
})

test('async poster imports keep unreadable guards until the whole restore is durably acknowledged', async t=>{
 const {state,repository}=await session(t)
 let release,entered
 const gate=new Promise(resolve=>{release=resolve}),waiting=new Promise(resolve=>{entered=resolve})
 const store=createSqlitePersonalPersistence({async writeBatch(...args){const value=await repository.writeBatch(...args);entered();await gate;return value}},state)
 const maps=createAsyncJsonMapStorage(store),mapKey=PERSONAL_STORAGE_KEYS[3]
 maps.read(mapKey);assert.equal(maps.hasBlocked(),true)
 const restoring=maps.restore([{key:mapKey,value:{1:{year:2001}}}])
 await waiting;assert.equal(maps.hasBlocked(),true)
 release();await restoring;assert.equal(maps.hasBlocked(),false)
 await maps.update([mapKey],values=>[{key:mapKey,value:{...values[mapKey],2:{year:2002}}}])
 assert.equal(maps.read(mapKey)[2].year,2002)
})

test('the browser adapter is lazy and retains the synchronous rollback guard for failed multi-key imports', async()=>{
 let reads=0,fail=true
 const values=new Map([[key,'old']])
 const store=createBrowserPersonalPersistence({getItem(k){reads++;return values.get(k)??null},setItem(k,v){if(k===pulseKey&&fail){fail=false;throw Error('quota')}values.set(k,v)},removeItem(k){values.delete(k)}})
 assert.equal(reads,0)
 await assert.rejects(store.commitJson([{key,value:'new'},{key:pulseKey,value:{queue:[]}}]))
 assert.deepEqual([...values],[[key,'old']])
 assert.equal(store.getStatus().phase,'failed')
})
