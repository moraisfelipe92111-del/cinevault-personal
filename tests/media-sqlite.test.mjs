import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {serializeMediaBackup} from '../src/mediaBackup.ts'
import {serializePersonalStorageSnapshot} from '../src/personalStorageSnapshot.ts'
import {host,v1,ready,source,progress,changes,mutations} from './helpers/media-sqlite.mjs'

test('media repository import and construction are lazy and reading absence creates no defaults',async t=>{
  const url=new URL('../src/mediaSqlite.ts',import.meta.url).href
  const code=`for(const key of ['localStorage','crypto'])Object.defineProperty(globalThis,key,{get(){throw Error('unexpected global')}});const m=await import(${JSON.stringify(url)});m.createMediaSqliteRepository(new Proxy({},{get(){throw Error('unexpected DB')}}));`
  const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  const f=host(t)
  assert.equal(await f.repository().read(),null);assert.equal(mutations(f),0)
})

test('upgrade exposes all seven slots and its marker atomically and retains every exact v1 value',async t=>{
  const f=await v1(t),before=await f.legacy().read(),prepared=await f.repo.prepareUpgrade(before)
  assert.equal(f.native.isTransaction,true)
  const observer=f.observer()
  try{assert.equal(observer.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'cv_media_%'").get().n,0)}finally{observer.close()}
  const state=await prepared.commit()
  assert.equal(state.schemaVersion,2);assert.equal(state.revision,0);assert.equal(state.parentRevision,before.revision)
  assert.equal(state.currentSha256,state.originSha256)
  assert.deepEqual(state.backup.legacy,f.original);assert.deepEqual(state.backup.progress.entries,[])
  assert.deepEqual(await f.legacy().read(),before)
  assert.equal(f.native.prepare('SELECT COUNT(*) AS n FROM cv_media_value').get().n,7)
  assert.deepEqual(await f.reopen().read(),state)
})

test('closing a prepared upgrade rolls back all media objects and safely retries from the frozen origin',async t=>{
  const f=await v1(t)
  await f.repo.prepareUpgrade(f.parent)
  const reopened=f.reopen()
  assert.equal(await reopened.read(),null);assert.deepEqual(f.tables(),[])
  const committed=await (await reopened.prepareUpgrade(f.parent)).commit()
  assert.equal(committed.revision,0);assert.deepEqual(committed.backup.legacy,f.original)
  assert.deepEqual(await f.legacy().read(),f.parent)
})

test('an authoritative upgrade never replaces its v1 origin or performs a second migration',async t=>{
  const f=await ready(t),before=mutations(f)
  await assert.rejects(f.repo.prepareUpgrade(f.parent),/already authoritative/)
  assert.equal(mutations(f),before)
  assert.deepEqual((await f.reopen().read()).backup.legacy,f.original)
})

test('failed upgrade headers, chunks or receipt roll back every new object and retain the frozen origin',async t=>{
  for(const target of ['cv_media_value ','cv_media_value_chunk ','cv_media_revision ']){
    const f=await v1(t),run=f.connection.run
    f.connection.run=async(sql,values,transaction)=>{
      if(sql.startsWith('INSERT INTO main.'+target))throw Error('PRIVATE upgrade error')
      return run(sql,values,transaction)
    }
    await assert.rejects(f.repo.prepareUpgrade(f.parent),error=>!error.message.includes('PRIVATE'))
    assert.equal(f.native.isTransaction,false);assert.deepEqual(f.tables(),[])
    assert.deepEqual(await f.legacy().read(),f.parent)
  }
})

test('invalid batches, revisions and unsupported progress fail before native access',async t=>{
  const f=host(t),repo=f.repository()
  for(const input of [null,{}, {changes:Array(1)},{changes:changes([0,1])},{changes:changes([0,'a'],[0,'b'])},
    {changes:[],progress:{format:'future'}},{changes:[],extra:true},{changes:[{key:'other',raw:null}]}])await assert.rejects(repo.prepareWrite(input,0))
  for(const revision of [-1,NaN,Infinity,0.5,'0',Number.MAX_SAFE_INTEGER+1])await assert.rejects(repo.prepareWrite({changes:[]},revision))
  assert.equal(f.calls.length,0)
})

test('legacy raw values and episode progress share one visible revision and only changed slots are written',async t=>{
  const f=await ready(t),request={changes:changes([0,'{"favorites":[1]}'],[5,'preferences']),progress:progress()}
  f.calls.length=0
  const prepared=await f.repo.prepareWrite(request,0),observer=f.observer()
  try{assert.equal(observer.prepare('SELECT revision FROM cv_media_revision').get().revision,0)}finally{observer.close()}
  assert.deepEqual(prepared.changedSlots,[0,5,6])
  const committed=await prepared.commit()
  assert.equal(committed.revision,1);assert.deepEqual(committed.backup.progress,request.progress)
  assert.equal(committed.backup.legacy.entries[0].raw,request.changes[0].raw)
  assert.deepEqual(await f.legacy().read(),f.parent)
  assert.deepEqual(await f.reopen().read(),committed)
})

test('mutable write inputs detach before the first await and an identical retry has no DML or revision change',async t=>{
  const f=await ready(t),request={changes:changes([0,'original']),progress:progress()},expected=structuredClone(request)
  const preparing=f.repo.prepareWrite(request,0)
  request.changes[0].raw='mutated';request.progress.entries[0].watchedEpisodes[0].episode=99
  const state=await (await preparing).commit()
  assert.equal(state.backup.legacy.entries[0].raw,'original');assert.deepEqual(state.backup.progress,expected.progress)
  f.calls.length=0
  const retry=await f.repo.writeBatch(expected,1)
  assert.equal(retry.revision,1);assert.equal(mutations(f),0)
})

test('large Unicode values use bounded bridge chunks and survive reopening exactly',async t=>{
  const f=await ready(t),text='🎬 ação\r\n\u0000\ud800x\udfff'.repeat(120000)
  const state=await f.repo.writeBatch({changes:changes([0,text]),progress:progress()},0)
  assert.ok(serializeMediaBackup(state.backup).length>2*1024*1024)
  for(const row of f.native.prepare('SELECT payload FROM cv_media_value_chunk').all()){
    assert.ok(row.payload.length<=16384)
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(row.payload)),row.payload)
  }
  assert.equal((await f.reopen().read()).backup.legacy.entries[0].raw,text)
})

test('interrupted writes preserve the old values, progress and revision before a single retry',async t=>{
  const f=await ready(t),first=await f.repo.writeBatch({changes:changes([0,'old']),progress:progress('paused')},0)
  const request={changes:changes([0,'pending'],[1,null]),progress:progress('completed',8)}
  await f.repo.prepareWrite(request,1)
  const repo=f.reopen()
  assert.deepEqual(await repo.read(),first)
  const final=await repo.writeBatch(request,1)
  assert.equal(final.revision,2);assert.equal(final.backup.legacy.entries[0].raw,'pending')
})

test('stale revisions and revision overflow never replace newer state but exact no-ops remain valid',async t=>{
  const f=await ready(t)
  await f.repo.writeBatch({changes:changes([0,'new'])},0)
  await assert.rejects(f.repo.writeBatch({changes:changes([0,'stale'])},0),/stale media revision/)
  let repo=f.reopen()
  assert.equal((await repo.read()).backup.legacy.entries[0].raw,'new')
  f.native.prepare('UPDATE cv_media_revision SET revision = ?').run(Number.MAX_SAFE_INTEGER)
  repo=f.reopen()
  assert.equal((await repo.writeBatch({changes:changes([0,'new'])},Number.MAX_SAFE_INTEGER)).revision,Number.MAX_SAFE_INTEGER)
  await assert.rejects(repo.writeBatch({changes:changes([0,'overflow'])},Number.MAX_SAFE_INTEGER),/overflow/)
})

test('header, chunk and marker failures or ignored writes roll back the entire batch without private errors',async t=>{
  for(const kind of ['header','chunk','marker','ignored']){
    const f=await ready(t),run=f.connection.run
    f.connection.run=async(sql,values,transaction)=>{
      const hit=(kind==='header'&&sql.startsWith('UPDATE main.cv_media_value '))||
        (kind==='chunk'&&sql.startsWith('INSERT INTO main.cv_media_value_chunk '))||
        (kind==='marker'&&sql.startsWith('UPDATE main.cv_media_revision '))
      if(hit)throw Error('PRIVATE VALUES quota')
      if(kind==='ignored'&&sql.startsWith('UPDATE main.cv_media_revision '))return {}
      return run(sql,values,transaction)
    }
    await assert.rejects(f.repo.writeBatch({changes:changes([0,'new']),progress:progress()},0),e=>!e.message.includes('PRIVATE'))
    assert.equal(f.native.isTransaction,false)
    assert.deepEqual(await f.reopen().read(),f.state)
  }
})

test('rejected and lost COMMIT acknowledgements require reopening and reveal the actual durable revision',async t=>{
  for(const durable of [false,true]){
    const f=await ready(t),prepared=await f.repo.prepareWrite({changes:changes([0,'committed']),progress:progress()},0),commit=f.connection.commitTransaction
    f.connection.commitTransaction=async()=>{if(durable)await commit();throw Error('PRIVATE COMMIT')}
    await assert.rejects(prepared.commit(),e=>!e.message.includes('PRIVATE'))
    await assert.rejects(f.repo.read(),/reopen/)
    f.connection.commitTransaction=commit
    const state=await f.reopen().read()
    assert.equal(state.revision,durable?1:0)
    assert.equal(state.backup.legacy.entries[0].raw,durable?'committed':f.original.entries[0].raw)
  }
})

test('foreign transactions are refused without committing, rolling back or changing their writes',async t=>{
  const f=await ready(t)
  f.native.exec('CREATE TABLE unrelated (value TEXT); BEGIN; INSERT INTO unrelated VALUES (\'keep\')')
  f.calls.length=0
  await assert.rejects(f.repo.prepareWrite({changes:changes([0,'other'])},0))
  assert.equal(f.native.isTransaction,true);assert.equal(f.native.prepare('SELECT value FROM unrelated').get().value,'keep')
  assert.ok(!f.calls.some(call=>['begin','commit','rollback'].includes(call[0])))
  f.native.exec('ROLLBACK')
})

test('stale leases and other repository instances cannot enter or end a newer prepared transaction',async t=>{
  const f=await ready(t),first=await f.repo.prepareWrite({changes:changes([0,'first'])},0)
  await first.rollback()
  const second=await f.repo.prepareWrite({changes:changes([0,'second'])},0),count=f.calls.length
  await assert.rejects(first.commit(),/owns/);await assert.rejects(first.rollback(),/owns/)
  await assert.rejects(f.repo.read(),/owns/)
  assert.equal(f.calls.length,count)
  await assert.rejects(f.repository().read())
  assert.equal(f.native.isTransaction,true)
  assert.equal((await second.commit()).backup.legacy.entries[0].raw,'second')
})

test('schema fragments, triggers and changed chunks refuse hydration without repair or fallback',async t=>{
  for(const sql of ['DROP TABLE cv_media_value_chunk','CREATE TRIGGER injected AFTER UPDATE ON cv_media_value BEGIN SELECT 1; END',
    "UPDATE cv_media_value_chunk SET payload='changed' WHERE slot=0 AND ordinal=0"]){
    const f=await ready(t)
    f.native.exec(sql);f.calls.length=0
    await assert.rejects(f.reopen().read())
    assert.equal(mutations(f),0)
  }
})

test('a missing or changed frozen v1 origin invalidates newer data instead of silently rebasing it',async t=>{
  const f=await ready(t)
  await f.legacy().writeBatch(changes([0,'changed outside media owner']),0)
  const repo=f.reopen()
  await assert.rejects(repo.read(),/origin/)
  assert.equal(serializePersonalStorageSnapshot(f.original),serializePersonalStorageSnapshot(f.state.backup.legacy))
})

test('prepared target tampering cannot commit and an acknowledged open COMMIT is rolled back',async t=>{
  for(const tamper of [true,false]){
    const f=await ready(t),prepared=await f.repo.prepareWrite({changes:changes([0,'new']),progress:progress()},0)
    const commit=f.connection.commitTransaction
    if(tamper)f.native.exec("UPDATE cv_media_value_chunk SET payload='changed' WHERE slot=0")
    else f.connection.commitTransaction=async()=>{}
    await assert.rejects(prepared.commit())
    assert.equal(f.native.isTransaction,false)
    f.connection.commitTransaction=commit
    assert.deepEqual(await f.reopen().read(),f.state)
  }
})

test('unknown native replies and rollback failures require reopening without exposing private content',async t=>{
  const f=await ready(t),prepared=await f.repo.prepareWrite({changes:changes([0,'new'])},0)
  f.connection.rollbackTransaction=async()=>{throw Error('PRIVATE rollback')}
  await assert.rejects(prepared.rollback(),e=>!e.message.includes('PRIVATE'))
  const calls=f.calls.length;await assert.rejects(f.repo.read(),/reopen/);assert.equal(f.calls.length,calls)
  assert.deepEqual(await f.reopen().read(),f.state)
  const g=await ready(t);g.connection.query=async()=>({})
  await assert.rejects(g.repo.read(),/did not return rows/)
})
