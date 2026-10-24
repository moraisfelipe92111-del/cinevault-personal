import {test} from 'node:test'
import assert from 'node:assert/strict'
import {host,source,progress,changes} from './helpers/media-sqlite.mjs'
import {createMediaStorageBootstrap} from '../src/mediaStorageBootstrap.ts'
import {createPersonalStorageCoordinator} from '../src/personalStorage.ts'
import {createMediaAuthorityStore} from '../src/mediaStorageAuthority.ts'

function environment(t,{deny=false}={}){
  const f=host(t),original=source();let reads=0,text=null
  const data=new Map(original.entries.map(entry=>[entry.key,entry.raw]))
  const coordinator=createPersonalStorageCoordinator(()=>({getItem(key){reads++;if(deny)throw Error('denied');return data.get(key)??null},
    setItem(){throw Error('legacy mutation')},removeItem(){throw Error('legacy removal')}}))
  const io={async read(){return text},async write(value){text=value}},authority=createMediaAuthorityStore('cinevault_personal',io)
  const bootstrap=createMediaStorageBootstrap(coordinator,authority)
  return {f,original,coordinator,data,io,authority,bootstrap,get reads(){return reads},get receipt(){return text},set receipt(value){text=value}}
}

test('first native open preserves the old origin, upgrades seven slots and confirms authority before exposing a reader',async t=>{
  const e=environment(t),session=await e.bootstrap.open(e.f.connection)
  assert.equal(session.mediaEnabled,true);assert.deepEqual(session.captureSnapshot(),e.original)
  assert.deepEqual(session.getMediaProgress().entries,[]);assert.equal((await e.authority.read()).mediaState,'complete')
  assert.equal(e.coordinator.phase,'closed');assert.equal(e.f.native.isTransaction,false)
  assert.equal((await e.f.legacy().read()).revision,0)
})

test('an authoritative media database reopens without reading stale or denied browser storage',async t=>{
  const e=environment(t),session=await e.bootstrap.open(e.f.connection)
  await session.updateMedia(()=>({progress:progress()}));await session.close();e.f.reopen()
  const denied=createPersonalStorageCoordinator(()=>({getItem(){throw Error('legacy must not be read')},setItem(){throw Error('write')},removeItem(){throw Error('remove')}}))
  const reopened=await createMediaStorageBootstrap(denied,e.authority).open(e.f.connection)
  assert.deepEqual(reopened.getMediaProgress(),progress());assert.equal(denied.phase,'closed')
})

test('a reserved upgrade interrupted before commit can retry only the same frozen v1 origin',async t=>{
  const e=environment(t),session=await e.bootstrap.open(e.f.connection)
  await session.close()
  const marker=JSON.parse(e.receipt);e.receipt=JSON.stringify({...marker,mediaState:'reserved'})
  e.f.native.exec('DROP TABLE cv_media_value_chunk; DROP TABLE cv_media_value; DROP TABLE cv_media_revision')
  e.f.reopen()
  const reopened=await e.bootstrap.open(e.f.connection)
  assert.deepEqual(reopened.captureSnapshot(),e.original);assert.equal((await e.authority.read()).mediaState,'complete')
  assert.deepEqual(reopened.getMediaProgress().entries,[])
})

test('completed authority forbids silently reconstructing deleted media tables from stale v1 values',async t=>{
  const e=environment(t),session=await e.bootstrap.open(e.f.connection)
  await session.updateMedia(()=>({progress:progress()}));await session.close()
  e.f.native.exec('DROP TABLE cv_media_value_chunk; DROP TABLE cv_media_value; DROP TABLE cv_media_revision')
  e.f.reopen();const calls=e.f.calls.length
  await assert.rejects(e.bootstrap.open(e.f.connection),/não está disponível/)
  assert.deepEqual(e.f.tables(),[])
  assert.ok(!e.f.calls.slice(calls).some(call=>['run','execute'].includes(call[0])))
})

test('a denied or malformed authority stops before every database operation and legacy read',async t=>{
  const e=environment(t);e.receipt='malformed'
  await assert.rejects(e.bootstrap.open(e.f.connection));assert.equal(e.f.calls.length,0);assert.equal(e.reads,0)
  e.io.read=async()=>{throw Error('denied')}
  await assert.rejects(e.bootstrap.open(e.f.connection));assert.equal(e.f.calls.length,0)
})

test('lost upgrade commit acknowledgement leaves reserved authority and reopening recovers the committed media state',async t=>{
  const e=environment(t),commit=e.f.connection.commitTransaction
  e.f.connection.commitTransaction=async()=>{
    const hasMedia=e.f.native.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='cv_media_revision'").get().n>0
    await commit()
    if(hasMedia)throw Error('lost media COMMIT acknowledgement')
  }
  await assert.rejects(e.bootstrap.open(e.f.connection))
  assert.equal((await e.authority.read()).mediaState,'reserved')
  e.f.connection.commitTransaction=commit;e.f.reopen()
  const session=await e.bootstrap.open(e.f.connection)
  assert.deepEqual(session.captureSnapshot(),e.original);assert.equal((await e.authority.read()).mediaState,'complete')
})

test('unrelated pauses and overlapping bootstrap calls never join another owner',async t=>{
  const e=environment(t),pause=e.coordinator.pauseWrites()
  await assert.rejects(e.bootstrap.open(e.f.connection),/Outra operação/)
  assert.equal(e.f.calls.length,0);pause.resumeLocalWrites()
  let release,entered
  const gate=new Promise(resolve=>{release=resolve}),waiting=new Promise(resolve=>{entered=resolve}),read=e.io.read
  let first=true
  e.io.read=async()=>{if(first){first=false;entered();await gate}return read()}
  const opening=e.bootstrap.open(e.f.connection);await waiting
  await assert.rejects(e.bootstrap.open(e.f.connection),/andamento/)
  release();await opening
})

test('a legacy-only restored snapshot preserves series progress in the new native state',async t=>{
  const e=environment(t),session=await e.bootstrap.open(e.f.connection)
  await session.updateMedia(()=>({changes:[{key:e.original.entries[0].key,value:{favorites:[1]}}],progress:progress()}))
  await session.restoreSnapshot(e.original)
  assert.deepEqual(session.captureSnapshot(),e.original);assert.deepEqual(session.getMediaProgress(),progress())
  assert.equal((await e.f.repository().read()).revision,2)
})
