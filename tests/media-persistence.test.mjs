import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ready,progress,source} from './helpers/media-sqlite.mjs'
import {createSqliteMediaPersonalPersistence,createBrowserPersonalPersistence,isMediaPersonalBackup} from '../src/personalPersistence.ts'
import {createMediaBackup,serializeMediaBackup} from '../src/mediaBackup.ts'
import {createAsyncJsonMapStorage} from '../src/jsonMapStorage.ts'
const jsonChange=(key,value)=>[{key,value}]

test('media cache and legacy reader advance together only after the native commit acknowledgement',async t=>{
  const f=await ready(t);let release,entered
  const gate=new Promise(resolve=>{release=resolve}),waiting=new Promise(resolve=>{entered=resolve})
  const repo={async writeBatch(...args){const state=await f.repo.writeBatch(...args);entered();await gate;return state}}
  const session=createSqliteMediaPersonalPersistence(repo,f.state),key=f.original.entries[0].key
  const writing=session.updateMedia(()=>({changes:jsonChange(key,{favorites:[1]}),progress:progress()}))
  await waiting
  assert.equal(session.reader.getItem(key),f.original.entries[0].raw)
  assert.deepEqual(session.getMediaProgress().entries,[]);assert.equal(session.getStatus().version,0)
  release();await writing
  assert.deepEqual(JSON.parse(session.reader.getItem(key)),{favorites:[1]})
  assert.deepEqual(session.getMediaProgress(),progress());assert.equal(session.getStatus().version,1)
})

test('queued progress transforms read the preceding committed state and legacy-only edits retain progress',async t=>{
  const f=await ready(t),session=createSqliteMediaPersonalPersistence(f.repo,f.state),key=f.original.entries[5].key
  const first=session.updateMedia(()=>({progress:progress('watching',1)}))
  const second=session.updateMedia(current=>({progress:{...current,entries:current.entries.map(entry=>({...entry,status:'paused'}))}}))
  const third=session.commitJson(jsonChange(key,{volume:0.2}))
  await Promise.all([first,second,third])
  assert.deepEqual(session.getMediaProgress(),progress('paused',1))
  assert.equal(session.getStatus().version,3)
  assert.deepEqual((await f.reopen().read()).backup,session.captureMediaBackup())
})

test('a lost media COMMIT acknowledgement blocks queued changes until reopening actual durable state',async t=>{
  const f=await ready(t);let called=false
  const session=createSqliteMediaPersonalPersistence({async writeBatch(...args){await f.repo.writeBatch(...args);throw Error('PRIVATE lost acknowledgement')}},f.state)
  const first=session.updateMedia(()=>({progress:progress()}))
  const second=session.updateMedia(()=>{called=true;return {progress:progress('completed')}})
  await assert.rejects(first,e=>!e.message.includes('PRIVATE'));await assert.rejects(second,/interrompido/)
  assert.equal(called,false);assert.deepEqual(session.getMediaProgress().entries,[])
  const repo=f.reopen(),reopened=createSqliteMediaPersonalPersistence(repo,await repo.read())
  assert.deepEqual(reopened.getMediaProgress(),progress())
})

test('a complete audiovisual restore acknowledges all six raw values and progress atomically',async t=>{
  const f=await ready(t),session=createSqliteMediaPersonalPersistence(f.repo,f.state)
  const original=createMediaBackup(source(['invalid JSON',null,'','null','\ud800\u0000😀','{"volume":0.3}']),progress('paused',9))
  await session.restoreMediaBackup(original)
  assert.equal(serializeMediaBackup(session.captureMediaBackup()),serializeMediaBackup(original))
  assert.equal((await f.repo.read()).revision,1)
  assert.deepEqual(await f.legacy().read(),f.parent)
  await session.restoreSnapshot(f.original)
  assert.deepEqual(session.getMediaProgress(),progress('paused',9))
})

test('invalid progress and malformed imports perform no native writes and do not block later valid edits',async t=>{
  const f=await ready(t),session=createSqliteMediaPersonalPersistence(f.repo,f.state),calls=f.calls.length
  await assert.rejects(session.restoreMediaBackup({format:'sintonema.audiovisual-backup',version:99}))
  await assert.rejects(session.updateMedia(()=>({progress:{format:'future'}})))
  assert.equal(f.calls.length,calls);assert.equal(session.getStatus().phase,'ready')
  await session.updateMedia(()=>({progress:progress()}))
  assert.deepEqual(session.getMediaProgress(),progress())
})

test('closing drains accepted media edits and revokes both legacy and progress readers',async t=>{
  const f=await ready(t),session=createSqliteMediaPersonalPersistence(f.repo,f.state)
  const writing=session.updateMedia(()=>({progress:progress()})),closing=session.close()
  await assert.rejects(session.updateMedia(()=>({progress:progress('paused')})),/encerrada/)
  await writing;await closing
  assert.throws(()=>session.getMediaProgress(),/encerrada/);assert.throws(()=>session.captureMediaBackup())
  assert.deepEqual((await f.reopen().read()).backup.progress,progress())
})

test('poster restore guards remain locked until the whole audiovisual backup is acknowledged',async t=>{
  const f=await ready(t),session=createSqliteMediaPersonalPersistence(f.repo,f.state),maps=createAsyncJsonMapStorage(session)
  const key=f.original.entries[2].key
  maps.read(key);assert.equal(maps.hasBlocked(),true)
  const invalid={...session.captureMediaBackup(),progress:{format:'future'}}
  await assert.rejects(maps.restoreMediaBackup(invalid));assert.equal(maps.hasBlocked(),true)
  const entries=session.captureSnapshot().entries.map(entry=>entry.key===key?{key,raw:'{}'}:entry)
  await maps.restoreMediaBackup(createMediaBackup({...f.original,entries},progress()))
  assert.equal(maps.hasBlocked(),false);assert.deepEqual(session.getMediaProgress(),progress())
})

test('browser sessions reject nonempty audiovisual restores without dropping progress or changing existing keys',async()=>{
  const data=new Map(),store={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)}
  const session=createBrowserPersonalPersistence(store)
  assert.equal(session.mediaEnabled,false)
  const backup=createMediaBackup(source(),progress())
  assert.equal(isMediaPersonalBackup(backup),true)
  await assert.rejects(session.restoreMediaBackup(backup),/compatível/)
  assert.equal(data.size,0)
  await session.restoreMediaBackup(createMediaBackup(source()))
  assert.deepEqual(session.captureSnapshot(),source())
})
