import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {capturePersonalStorageSnapshot,serializePersonalStorageSnapshot,PERSONAL_STORAGE_KEYS} from '../src/personalStorageSnapshot.ts'
import {createMediaBackup,validateMediaBackup,serializeMediaBackup,parseMediaBackup} from '../src/mediaBackup.ts'
import {parseBackup} from '../src/backupValidation.ts'

const values=['{"favorites":[1,9999],"future":{"unknown":true}}','not valid JSON','',null,' \r\n\u0000\ud800\udfff😀','{"soundVolume":0.13,"future":true}']
const legacy=()=>capturePersonalStorageSnapshot({getItem:key=>values[PERSONAL_STORAGE_KEYS.indexOf(key)]})
const progress=()=>({format:'sintonema.media-progress',version:1,entries:[
  {key:'local:movie:1',status:'completed',watchedEpisodes:[]},
  {key:'tmdb:tv:1',status:'paused',watchedEpisodes:[{season:0,episode:1},{season:2,episode:20}]},
  {key:'tmdb:tv:999999999',status:'want_to_watch',watchedEpisodes:[]}]})

test('new backups preserve every raw legacy code unit and typed progress without catalogue filtering',()=>{
  const source=legacy(), backup=createMediaBackup(source,progress())
  const reopened=parseMediaBackup(serializeMediaBackup(backup))
  assert.equal(serializePersonalStorageSnapshot(reopened.legacy),serializePersonalStorageSnapshot(source))
  assert.deepEqual(reopened.progress,progress())
  for(let i=0;i<values.length;i++)assert.equal(reopened.legacy.entries[i].raw,values[i])
  assert.equal(reopened.progress.entries[2].key,'tmdb:tv:999999999')
})

test('a preserved legacy snapshot receives no invented personal defaults or progress entries',()=>{
  const missing=capturePersonalStorageSnapshot({getItem:()=>null})
  const reopened=parseMediaBackup(serializeMediaBackup(createMediaBackup(missing)))
  assert.ok(reopened.legacy.entries.every(entry=>entry.raw===null))
  assert.deepEqual(reopened.progress.entries,[])
})

test('unsupported backups, missing raw keys or invalid progress fail as a whole instead of returning reduced data',()=>{
  const valid=createMediaBackup(legacy(),progress())
  for(const bad of [null,{}, {...valid,version:2},{...valid,format:'other'},{...valid,future:true},
    {...valid,legacy:{...valid.legacy,entries:valid.legacy.entries.slice(0,5)}},
    {...valid,progress:{...valid.progress,version:2}},
    {...valid,progress:{...valid.progress,entries:[...valid.progress.entries,{...valid.progress.entries[0]}]}}])assert.throws(()=>validateMediaBackup(bad))
  for(const text of ['', 'not json','null','[]','{}'])assert.throws(()=>parseMediaBackup(text))
})

test('future fields within progress reject conversion while future fields within legacy raw JSON remain exact',()=>{
  const backup=createMediaBackup(legacy(),progress())
  const future=structuredClone(backup)
  future.progress.entries[1].futureEpisodeState={neverDiscard:true}
  assert.throws(()=>parseMediaBackup(JSON.stringify(future)))
  assert.equal(parseMediaBackup(serializeMediaBackup(backup)).legacy.entries[0].raw,values[0])
})

test('backup creation detaches before serialization and freezes both old and new structures',()=>{
  const source=structuredClone(legacy()), current=progress(), backup=createMediaBackup(source,current)
  source.entries[0].raw='changed';current.entries[1].watchedEpisodes[0].episode=999
  assert.equal(backup.legacy.entries[0].raw,values[0]);assert.equal(backup.progress.entries[1].watchedEpisodes[0].episode,1)
  assert.throws(()=>backup.legacy.entries[0].raw='changed')
  assert.throws(()=>backup.progress.entries[1].watchedEpisodes.pop())
})

test('legacy and versions 1 to 4 still use the existing importer and the new format cannot masquerade as v4',()=>{
  const base={favorites:[1],watched:[2],ratings:{1:5}}
  for(const version of [undefined,1,2,3,4]){
    const raw={...base,...(version===undefined?{}:{version})}
    if(version===4)raw.pulse={queue:[],history:[],notes:{},recent:[],dailyOffset:0}
    assert.deepEqual(parseBackup(raw,new Set([1,2])).saved,base)
  }
  assert.throws(()=>parseBackup(createMediaBackup(legacy(),progress()),new Set([1,2])))
})

test('oversized serialized backups are refused before JSON parsing or successful export',()=>{
  const huge='x'.repeat(32*1024*1024+1)
  assert.throws(()=>parseMediaBackup(huge),/limite/)
  const source=structuredClone(legacy());source.entries[0].raw=huge
  assert.throws(()=>serializeMediaBackup(createMediaBackup(source)),/limite/)
})

test('importing the new model opens no database, storage or network and does not activate production migration',()=>{
  const modules=['mediaIdentity.ts','mediaCatalog.ts','mediaProgress.ts','mediaBackup.ts'].map(name=>new URL('../src/'+name,import.meta.url).href)
  const script=`
    for(const key of ['localStorage','indexedDB','crypto','fetch'])Object.defineProperty(globalThis,key,{configurable:true,get(){throw Error('Unexpected access: '+key)}});
    for(const url of ${JSON.stringify(modules)})await import(url);
    process.stdout.write('lazy');
  `
  assert.equal(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{encoding:'utf8'}),'lazy')
})
