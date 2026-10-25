import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {needsFirstAccess,completeFirstAccess,saveDiscoveryPreferences,readDiscoveryPreferences,discoveryDestination} from '../src/publicAccess.ts'
import {EXPERIENCE_DEFAULTS,EXPERIENCE_KEY,decodeExperiencePreferences,validateDiscoveryFormats} from '../src/experiencePreferences.ts'
import {createBrowserPersonalPersistence,createSqliteMediaPersonalPersistence} from '../src/personalPersistence.ts'
import {emptyMediaProgressSnapshot} from '../src/mediaProgress.ts'
import {capturePersonalStorageSnapshot,PERSONAL_STORAGE_KEYS} from '../src/personalStorageSnapshot.ts'
import {ready,mutations,source} from './helpers/media-sqlite.mjs'
import {serializeMediaBackup} from '../src/mediaBackup.ts'
import {restoreLibraryBackup} from '../src/personalBackupImport.ts'
import {editMediaProgress} from '../src/mediaProgressActions.ts'

function browser(initial={}) {
  const values=new Map(Object.entries(initial));let writes=0
  const persistence=createBrowserPersonalPersistence({getItem:key=>values.get(key)??null,
    setItem(key,value){writes++;values.set(key,value)},removeItem(key){writes++;values.delete(key)}})
  return {persistence,values,get writes(){return writes}}
}

test('only all absent keys and no progress invite first access; empty, invalid and unknown data remain existing',()=>{
  const p=emptyMediaProgressSnapshot(),f=browser()
  assert.equal(needsFirstAccess(f.persistence.reader,p),true);assert.equal(f.writes,0)
  for(const key of PERSONAL_STORAGE_KEYS)for(const value of ['', 'null','{}','{broken','{"future":true}']){
    const old=browser({[key]:value})
    assert.equal(needsFirstAccess(old.persistence.reader,p),false)
    assert.equal(old.writes,0);assert.equal(old.values.get(key),value)
  }
  assert.equal(needsFirstAccess(f.persistence.reader,{...p,entries:[{key:'tvmaze:tv:169',status:'watching',watchedEpisodes:[]}]}),false)
  assert.throws(()=>needsFirstAccess({getItem(){throw Error('denied')}},p),/denied/)
})

test('skip and selected formats create only versioned experience preferences, never accounts or personal defaults',async()=>{
  for(const formats of [[],['anime','movies','reality']]){
    const f=browser();await completeFirstAccess(f.persistence,formats)
    assert.deepEqual([...f.values.keys()],[EXPERIENCE_KEY])
    assert.deepEqual(JSON.parse(f.values.get(EXPERIENCE_KEY)),{...EXPERIENCE_DEFAULTS,publicAccess:{version:1,completed:true,formats}})
    assert.equal(needsFirstAccess(f.persistence.reader,emptyMediaProgressSnapshot()),false)
    const writes=f.writes;await completeFirstAccess(f.persistence,formats);assert.equal(f.writes,writes)
  }
})

test('onboarding choices detach before queueing and fail if another queued edit has created a library',async()=>{
  const f=browser(),formats=['anime'];const save=completeFirstAccess(f.persistence,formats);formats[0]='movies';await save
  assert.deepEqual(readDiscoveryPreferences(f.persistence.reader).value.publicAccess.formats,['anime'])
  const g=browser(),edit=g.persistence.writeRaw([{key:PERSONAL_STORAGE_KEYS[0],raw:'{"future":true}'}])
  const access=completeFirstAccess(g.persistence,[])
  await edit;await assert.rejects(access,/biblioteca mudou/)
  assert.equal(g.values.get(EXPERIENCE_KEY),undefined);assert.equal(g.values.get(PERSONAL_STORAGE_KEYS[0]),'{"future":true}')
})

test('unknown, malformed and future preferences never authorize a reduced settings write',async()=>{
  for(const value of [{...EXPERIENCE_DEFAULTS,future:{important:true}},
    {...EXPERIENCE_DEFAULTS,publicAccess:{version:2,completed:true,formats:[]}},
    {...EXPERIENCE_DEFAULTS,publicAccess:{version:1,completed:true,formats:['anime'],unknown:1}},
    {...EXPERIENCE_DEFAULTS,publicAccess:{version:1,completed:true,formats:['anime','anime']}}]){
    const raw=JSON.stringify(value),f=browser({[EXPERIENCE_KEY]:raw})
    assert.equal(readDiscoveryPreferences(f.persistence.reader).blocked,true)
    await assert.rejects(saveDiscoveryPreferences(f.persistence,['movies']),/preservados/)
    assert.equal(f.writes,0);assert.equal(f.values.get(EXPERIENCE_KEY),raw)
  }
  for(const input of [null,{},['unknown'],['movies','movies'],[4]])assert.throws(()=>validateDiscoveryFormats(input))
  const f=browser();assert.throws(()=>completeFirstAccess(f.persistence,['unknown']));assert.equal(f.writes,0)
})

test('existing experience settings and versioned discovery choices survive each other without changing legacy values',async()=>{
  const old={...EXPERIENCE_DEFAULTS,intro:false,sound:false,updates:false,sonic:'impacto',volume:.85}
  const f=browser({[EXPERIENCE_KEY]:JSON.stringify(old),[PERSONAL_STORAGE_KEYS[0]]:'{untouched'})
  await saveDiscoveryPreferences(f.persistence,['documentary'])
  const updated=JSON.parse(f.values.get(EXPERIENCE_KEY))
  assert.deepEqual(updated,{...old,publicAccess:{version:1,completed:true,formats:['documentary']}})
  assert.deepEqual(decodeExperiencePreferences(updated),updated)
  assert.equal(f.values.get(PERSONAL_STORAGE_KEYS[0]),'{untouched')
  assert.deepEqual(discoveryDestination('movies'),{mode:'movies',filter:'Todos'})
  for(const [format,filter] of [['series','Ficção'],['anime','Animes'],['reality','Realities'],['documentary','Documentários']])
    assert.deepEqual(discoveryDestination(format),{mode:'series',filter})
})

test('native first access commits and reopens once with preferences in the existing complete backup and immutable origin',async t=>{
  const original=source(Array(6).fill(null)),f=await ready(t,original),p=createSqliteMediaPersonalPersistence(f.repo,f.state)
  await completeFirstAccess(p,['anime','series'])
  const backup=p.captureMediaBackup();assert.equal((await f.repo.read()).revision,1)
  assert.deepEqual(backup.legacy.entries.filter(e=>e.key!==EXPERIENCE_KEY).map(e=>e.raw),Array(5).fill(null))
  await p.close()
  const opened=await f.reopen().read(),next=createSqliteMediaPersonalPersistence(f.repo,opened)
  assert.equal(needsFirstAccess(next.reader,next.getMediaProgress()),false)
  assert.deepEqual(readDiscoveryPreferences(next.reader).value.publicAccess.formats,['anime','series'])
  assert.deepEqual((await f.legacy().read()).snapshot,original)
  await saveDiscoveryPreferences(next,['movies'])
  await restoreLibraryBackup(next,JSON.parse(serializeMediaBackup(backup)),1,new Set([1]))
  assert.equal(serializeMediaBackup(next.captureMediaBackup()),serializeMediaBackup(backup))
  assert.deepEqual((await f.legacy().read()).snapshot,original)
})

test('first-access UI cannot advance its read cache before native acknowledgement; failed commits remain failed',async t=>{
  const f=await ready(t,source(Array(6).fill(null)));let release
  const paused=new Promise(resolve=>{release=resolve})
  const p=createSqliteMediaPersonalPersistence({async writeBatch(...args){await paused;return f.repo.writeBatch(...args)}},f.state)
  const save=completeFirstAccess(p,['series']);await Promise.resolve();await Promise.resolve()
  assert.equal(p.reader.getItem(EXPERIENCE_KEY),null);assert.equal(p.getStatus().phase,'saving')
  release();await save;assert.equal(readDiscoveryPreferences(p.reader).value.publicAccess.completed,true)
  const failed=createSqliteMediaPersonalPersistence({async writeBatch(){throw Error('private failure')}},f.state)
  await assert.rejects(completeFirstAccess(failed,[]),/confirmar o salvamento/)
  assert.equal(failed.reader.getItem(EXPERIENCE_KEY),null);assert.equal(failed.getStatus().phase,'failed')
})

test('shared import validates complete and legacy formats without partial writes; TVmaze progress and raw unknown fields restore exactly',async t=>{
  const f=await ready(t),p=createSqliteMediaPersonalPersistence(f.repo,f.state)
  await p.updateMedia(progress=>({progress:editMediaProgress(progress,'tvmaze:tv:169',{type:'episode',season:1,episode:1,watched:true})}))
  const original=p.captureMediaBackup(),before=mutations(f)
  await assert.rejects(restoreLibraryBackup(p,{favorites:[],watched:[],ratings:{},posters:[]},1,new Set([1])))
  await assert.rejects(restoreLibraryBackup(p,{...original,version:99},1,new Set([1])))
  await assert.rejects(restoreLibraryBackup(p,original,97*1024*1024,new Set([1])))
  assert.equal(mutations(f),before)
  await restoreLibraryBackup(p,{version:3,favorites:[1],watched:[],ratings:{}},1,new Set([1]))
  assert.equal(p.getMediaProgress().entries[0].key,'tvmaze:tv:169')
  await restoreLibraryBackup(p,original,1,new Set([1]))
  assert.equal(serializeMediaBackup(p.captureMediaBackup()),serializeMediaBackup(original))
  const snapshot=capturePersonalStorageSnapshot({getItem:key=>key===EXPERIENCE_KEY?' {"future":42} ':null})
  await restoreLibraryBackup(p,snapshot,1,new Set([1]))
  assert.equal(p.reader.getItem(EXPERIENCE_KEY),' {"future":42} ')
  assert.equal(p.getMediaProgress().entries[0].key,'tvmaze:tv:169')
  await p.close();assert.equal((await f.reopen().read()).backup.legacy.entries[5].raw,' {"future":42} ')
})

test('new access modules import without global storage, crypto, navigator or database operations',()=>{
  const file=new URL('../src/publicAccess.ts',import.meta.url).href
  const script=`for(const key of ['localStorage','navigator','crypto'])Object.defineProperty(globalThis,key,{configurable:true,get(){throw Error('unexpected '+key)}});await import(${JSON.stringify(file)})`
  const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{encoding:'utf8'})
  assert.equal(child.status,0,child.stderr)
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8')
  assert.ok(app.includes('<FirstAccess persistence={persistence}'))
  assert.ok(app.includes('<DiscoveryPreferences persistence={persistence}/>'))
})
