import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = f => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'))
const films = read('../src/films.json')
const old = read('../planning/cv2-baseline/films-317.json')
const ids = read('../src/movieTmdbIds.json')
const oldIds = read('../planning/cv2-baseline/movieTmdbIds.json')
const trailers = read('../src/trailerCatalog.json')
const oldTrailers = read('../planning/cv2-baseline/trailerCatalog.json')
const posters = read('../src/catalogPosters.json')
const details = read('../src/filmDetails.json')

test('1.000 filmes, sem duplicar ou renumerar IDs locais', () => {
  assert.equal(films.length, 1000)
  assert.deepEqual(films.map(f=>f.id), Array.from({length: 1000},(_,i)=>i+1))
})
test('os 317 filmes existentes conservam todos os campos', () => {
  assert.deepEqual(films.slice(0,317),old)
})
test('notas pessoais dos 683 novos filmes nunca são fabricadas', () => {
  for (const f of films.slice(317)) {
    assert.equal(f.priority, 'N')
    assert.equal(f.stars, 'N/D')
    assert.equal(f.imdb,'N/D')
    assert.equal(f.tension,0)
    assert.equal(f.emotion,0)
  }
})
test('vínculos TMDb existentes preservados e novos exclusivos', () => {
  for(const [id,tmdb] of Object.entries(oldIds))assert.equal(ids[id],tmdb)
  assert.equal(Object.keys(ids).length,Object.keys(oldIds).length+683)
  assert.equal(new Set(Object.values(ids)).size,Object.keys(ids).length)
})
test('295 trailers antigos permanecem iguais; 678 novos', () => {
  for(const [id,trailer] of Object.entries(oldTrailers))assert.deepEqual(trailers[id],trailer)
  assert.equal(Object.keys(trailers).length,Object.keys(oldTrailers).length+678)
})
test('1000 URLs oficiais: 317 originais e 683 novos, sem colisões', () => {
  assert.equal(Object.keys(posters).length,1000)
  assert.equal(Object.keys(posters).filter(id=>Number(id)<=317).length,317)
  assert.equal(Object.keys(posters).filter(id=>Number(id)>=318).length,683)
  for(const [id,url] of Object.entries(posters)){
    assert.ok(+id>=1 && +id<=1000)
    assert.match(url,/^https:\/\/image\.tmdb\.org\/t\/p\/w500\/[A-Za-z0-9_./-]+\.(?:jpe?g|png|webp)$/i)
  }
})
test('683 metadados com identidade correspondente', () => {
  assert.equal(Object.keys(details).length,683)
  for(const [id,detail] of Object.entries(details)){
    assert.equal(detail.tmdbId,ids[id])
    assert.equal(detail.personalized,false)
  }
})
test('biblioteca mantém carregamento paginado e divisão dos módulos pesados', () => {
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8')
  const detailsModule=readFileSync(new URL('../src/Cv2FilmDetails.tsx',import.meta.url),'utf8')
  assert.match(app,/const PAGE_SIZE=30/)
  assert.match(app,/visible\.slice\(0,limit\)/)
  assert.match(app,/import\('\.\/FilmTrailer'\)/)
  assert.match(app,/priority==='N'/)
  assert.match(app,/selected\.priority!=='N'/)
  assert.match(detailsModule,/import\('\.\/filmDetails\.json'\)/)
})
