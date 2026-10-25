import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ready,changes} from './helpers/media-sqlite.mjs'
import {createSqliteMediaPersonalPersistence} from '../src/personalPersistence.ts'
import {editMediaProgress} from '../src/mediaProgressActions.ts'
import {serializeMediaBackup,validateMediaBackup} from '../src/mediaBackup.ts'

const key='tvmaze:tv:169'

test('TVmaze tracking survives real SQLite reopen while every original raw value stays intact',async t=>{
  const f=await ready(t),session=createSqliteMediaPersonalPersistence(f.repo,f.state)
  await session.updateMedia(p=>({progress:editMediaProgress(p,key,{type:'status',status:'want_to_watch'})}))
  await session.updateMedia(p=>({progress:editMediaProgress(p,key,{type:'episode',season:1,episode:1,watched:true})}))
  const saved=session.captureMediaBackup();assert.equal(saved.progress.entries[0].key,key)
  assert.equal(saved.progress.entries[0].status,'watching');assert.deepEqual(saved.legacy,f.original)
  await session.close()
  const reopened=await f.reopen().read();assert.equal(serializeMediaBackup(reopened.backup),serializeMediaBackup(saved))
  assert.equal(reopened.revision,2);assert.deepEqual((await f.legacy().read()).snapshot,f.original)
})

test('queued progress edits read the preceding commit, retain unmapped IDs and round trip in complete restore',async t=>{
  const f=await ready(t),session=createSqliteMediaPersonalPersistence(f.repo,f.state)
  const base=session.captureMediaBackup(),unknown={key:'tmdb:tv:9999999',status:'paused',watchedEpisodes:[{season:9,episode:99}]}
  await session.restoreMediaBackup({...base,progress:{...base.progress,entries:[unknown]}})
  const first=session.updateMedia(p=>({progress:editMediaProgress(p,key,{type:'episode',season:1,episode:1,watched:true})}))
  const second=session.updateMedia(p=>({progress:editMediaProgress(p,key,{type:'status',status:'paused'})}))
  await Promise.all([first,second])
  const backup=validateMediaBackup(JSON.parse(serializeMediaBackup(session.captureMediaBackup())))
  assert.deepEqual(backup.progress.entries[0],unknown)
  assert.equal(backup.progress.entries[1].status,'paused');assert.deepEqual(backup.progress.entries[1].watchedEpisodes,[{season:1,episode:1}])
  await session.writeRaw(changes([5,'{"volume":0.77}']))
  await session.updateMedia(p=>({progress:editMediaProgress(p,key,{type:'remove'})}))
  await session.restoreMediaBackup(backup)
  assert.equal(serializeMediaBackup(session.captureMediaBackup()),serializeMediaBackup(backup))
  await session.close();assert.equal(serializeMediaBackup((await f.reopen().read()).backup),serializeMediaBackup(backup))
})

test('a failed tracking commit never publishes progress or permits queued edits to claim success',async t=>{
  const f=await ready(t),before=f.state
  const session=createSqliteMediaPersonalPersistence({async writeBatch(){throw Error('private failure detail')}},before)
  const a=session.updateMedia(p=>({progress:editMediaProgress(p,key,{type:'status',status:'watching'})}))
  const b=session.updateMedia(p=>({progress:editMediaProgress(p,key,{type:'episode',season:1,episode:1,watched:true})}))
  assert.deepEqual((await Promise.allSettled([a,b])).map(x=>x.status),['rejected','rejected'])
  assert.equal(session.getStatus().phase,'failed');assert.deepEqual(session.getMediaProgress().entries,[])
  assert.deepEqual((await f.repo.read()).backup,before.backup)
})
