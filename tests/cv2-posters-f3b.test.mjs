import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const read=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'))
const posters=read('../tests/fixtures/catalogPosters-f3c.json')
const audit=read('../planning/cv2-f3b/original-audit.json')
const original=read('../planning/cv2-f3b/original-posters.json')
const proposals=read('../planning/cv2-f3b/unapproved-id-proposals.json')
const films=read('../src/films.json')
const ids=read('../src/movieTmdbIds.json')
const baseline=read('../planning/cv2-baseline/films-317.json')
const valid=/^https:\/\/image\.tmdb\.org\/t\/p\/w500\/[A-Za-z0-9_./-]+\.(?:jpe?g|png|webp)$/i

test('F3B catálogo de 1000 filmes e 317 originais intocados',()=>{
  assert.equal(films.length,1000)
  assert.deepEqual(films.slice(0,317),baseline)
})
test('F3B 985 capas: 302 originais + 683 novas',()=>{
  assert.equal(Object.keys(posters).length,985)
  assert.equal(Object.keys(posters).filter(x=>+x<=317).length,302)
  assert.equal(Object.keys(posters).filter(x=>+x>=318).length,683)
})
test('F3B todas URLs são imagens TMDb canônicas, sem redirects',()=>{
  for(const [key,value] of Object.entries(posters)){
    assert.ok(+key>=1 && +key<=1000)
    assert.match(value,valid)
  }
})
test('F3B os 302 originais são idênticos à auditoria',()=>{
  assert.equal(Object.keys(original).length,302)
  for(const [key,value] of Object.entries(original))assert.equal(posters[key],value)
})
test('F3B preserva 15 pendências em vez de inventar capas',()=>{
  const pending=audit.movies.filter(x=>x.result==='pending')
  assert.equal(pending.length,15)
  for(const m of pending)assert.equal(posters[String(m.id)],undefined)
})
test('F3B não aceita propostas TMDb não revisadas como IDs definitivos',()=>{
  assert.deepEqual(Object.keys(proposals).sort(),['108','117','7'].sort())
  assert.equal(Object.keys(ids).length,983)
  for(const key of Object.keys(proposals))assert.equal(ids[key],undefined)
})
