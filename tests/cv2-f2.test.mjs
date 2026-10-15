import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFilmSearchIndex,personalCurationOnly } from '../src/cv2Performance.ts'
import { pickDaily } from '../src/pulse.ts'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const getFile=(p)=>fs.readFileSync(path.join(root,p),'utf8')
const j=(p)=>JSON.parse(getFile(p))
const films=j('src/films.json')
const originals=j('planning/cv2-baseline/films-317.json')
const sample={ favorites:[],watched:[],ratings:{} }

test('F2 keeps 1000 stable film IDs and 317 unchanged originals',()=>{
  assert.equal(films.length,1000)
  assert.deepEqual(films.slice(0,317),originals)
  assert.deepEqual(films.map(f=>f.id),Array.from({length:1000},(_,i)=>i+1))
})
test('F2 preserves 683 unranked films and their search index',()=>{
  assert.equal(films.filter(f=>f.priority==='N').length,683)
  const index=buildFilmSearchIndex(films)
  assert.equal(index.size,1000)
  assert.ok(index.get(318)?.length>0)
})
test('daily recommendations never select new unranked titles',()=>{
  const curated=personalCurationOnly(films)
  assert.equal(curated.length,317)
  for(let offset=0;offset<20;offset++){
    const f=pickDaily(curated,sample,'2026-10-14',offset)
    assert.ok(f?.priority!=='N')
  }
})
test('F2 removes motion/react from the runtime entry and uses CSS transitions',()=>{
  const app=getFile('src/App.tsx'),css=getFile('src/index.css')
  assert.doesNotMatch(app,/from ['"]motion\/react['"]|<motion\./)
  assert.match(app,/<section className="hero cv-f2-hero-enter">/)
  assert.match(app,/<div className="detail cv-f2-detail-enter"/)
  assert.match(css,/@media \(prefers-reduced-motion: reduce\)/)
})
test('F2 keeps input responsive and defers expensive filtering',()=>{
  const app=getFile('src/App.tsx')
  assert.match(app,/useDeferredValue\(query\)/)
  assert.match(app,/normalizeSearch\(deferredQuery\.trim\(\)\)/)
  assert.match(app,/<input aria-label="Buscar filmes"[^>]*value=\{query\}/)
})
test('F2 retains lazy trailers and poster chunks',()=>{
  const app=getFile('src/App.tsx')
  assert.match(app,/import\('\.\/catalogPosters\.json'\)/)
  assert.match(app,/lazy\(\(\) => import\('\.\/FilmTrailer'\)/)
  assert.match(app,/visible\.slice\(0,limit\)/)
})
test('F2 retains personal JSON backup interfaces',()=>{
  const app=getFile('src/App.tsx')
  assert.match(app,/const KEY='cinevault\.personal\.v2'/)
  assert.match(app,/const exportBackup=async/)
  assert.match(app,/const importBackup=async/)
})
