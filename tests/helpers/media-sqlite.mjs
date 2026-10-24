import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {capturePersonalStorageSnapshot,PERSONAL_STORAGE_KEYS} from '../../src/personalStorageSnapshot.ts'
import {createPersonalSqliteMigrationRepository} from '../../src/personalSqliteMigration.ts'
import {createMediaSqliteRepository} from '../../src/mediaSqlite.ts'

export function host(t) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sintonema-media-')),filename=path.join(folder,'synthetic.sqlite')
  let native=new DatabaseSync(filename)
  const calls=[]
  const connection={
    async execute(sql,transaction){calls.push(['execute',sql]);assert.equal(transaction,false);return native.prepare(sql).run()},
    async run(sql,values,transaction){calls.push(['run',sql,values]);assert.equal(transaction,false);return native.prepare(sql).run(...values)},
    async query(sql,values=[]){calls.push(['query',sql,values]);return {values:native.prepare(sql).all(...values).map(row=>({...row}))}},
    async beginTransaction(){calls.push(['begin']);native.exec('BEGIN')},
    async commitTransaction(){calls.push(['commit']);native.exec('COMMIT')},
    async rollbackTransaction(){calls.push(['rollback']);native.exec('ROLLBACK')},
    async isTransactionActive(){calls.push(['active']);return {result:native.isTransaction}},
  }
  t.after(()=>{native.close();fs.rmSync(folder,{recursive:true})})
  return {connection,calls,filename,get native(){return native},
    repository(){return createMediaSqliteRepository(connection)},
    legacy(){return createPersonalSqliteMigrationRepository(connection)},
    reopen(){native.close();native=new DatabaseSync(filename);return createMediaSqliteRepository(connection)},
    observer(){return new DatabaseSync(filename)},
    tables(){return native.prepare("SELECT name FROM main.sqlite_master WHERE name LIKE 'cv_media_%' ORDER BY name").all().map(row=>row.name)},
  }
}
export function source(values=[null,'','null','{broken',"🎬 ação\r\n\u0000\ud800x\udfff",'{"volume":0,"future":true}']) {
  return capturePersonalStorageSnapshot({getItem:key=>values[PERSONAL_STORAGE_KEYS.indexOf(key)]??null})
}
export async function v1(t,snapshot=source()) {
  const f=host(t),repo=f.legacy(),prepared=await repo.prepare(snapshot)
  f.original=snapshot;f.parent=await prepared.commit(()=>{})
  f.repo=f.repository()
  return f
}
export async function ready(t,snapshot) {
  const f=await v1(t,snapshot)
  f.state=await (await f.repo.prepareUpgrade(f.parent)).commit()
  return f
}
export const progress=(status='watching',episode=1)=>({format:'sintonema.media-progress',version:1,
  entries:[{key:'tmdb:tv:42',status,watchedEpisodes:[{season:1,episode}]}]})
export const changes=(...values)=>values.map(([slot,raw])=>({key:PERSONAL_STORAGE_KEYS[slot],raw}))
export const mutations=f=>f.calls.filter(call=>['run','execute'].includes(call[0])).length
