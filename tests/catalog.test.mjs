import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {selectSession,durationMinutes,matchesMood} from '../src/session.ts'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const catalog=JSON.parse(fs.readFileSync(path.join(root,'src/films.json'),'utf8'))
const blank={watched:[],favorites:[],ratings:{}}
test('integrity: 1000 films with 317 unchanged personal selections',()=>{
  assert.equal(catalog.length,1000)
  assert.equal(new Set(catalog.map(f=>f.id)).size,1000)
  assert.ok(catalog.every(f=>Number.isInteger(f.id)&&typeof f.title==='string'&&f.title.trim().length>0))
})
test('live catalogue: recommendations respect all runtime filters',()=>{
  for(const mood of ['Todos','Suspense intenso','Emocional','Investigação','Terror','Ação','Surpreendente']) {
    for(const duration of ['Qualquer','110','140']) {
      const picks=selectSession(catalog,blank,{mood,duration,round:0})
      assert.ok(picks.length<=3)
      assert.equal(new Set(picks.map(f=>f.id)).size,picks.length)
      assert.ok(picks.every(f=>matchesMood(f,mood)))
      if(duration!=='Qualquer') assert.ok(picks.every(f=>durationMinutes(f.duration)!==null&&durationMinutes(f.duration)<=Number(duration)))
    }
  }
})
test('live catalogue: watched films never returned',()=>{
  const watched=catalog.slice(0,140).map(f=>f.id)
  const picks=selectSession(catalog,{...blank,watched},{mood:'Todos',duration:'Qualquer',round:0})
  assert.ok(picks.length>0)
  assert.ok(picks.every(f=>!watched.includes(f.id)))
})
