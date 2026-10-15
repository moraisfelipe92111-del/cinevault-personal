import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {buildFilmSearchIndex,normalizeFilmSearch,personalCurationOnly,countLinkedCovers} from '../src/cv2Performance.ts'
import {selectSession} from '../src/session.ts'
import {pickDaily} from '../src/pulse.ts'

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const json=relative=>JSON.parse(fs.readFileSync(path.join(base,relative),'utf8'))
const films=json('src/films.json')
const originals=json('planning/cv2-baseline/films-317.json')
const posters=json('src/catalogPosters.json')
const noHistory={favorites:[],watched:[],ratings:{}}

// Os testes usam os 1000 títulos reais e são executados SOMENTE no laboratório F.
test('preserva integralmente os 317 registros originais e os IDs dos 1000 filmes',()=>{
  assert.equal(films.length,1000)
  assert.deepEqual(films.slice(0,317),originals)
  assert.deepEqual(films.map(x=>x.id),Array.from({length:1000},(_,n)=>n+1))
})
test('índice de busca é equivalente à normalização antiga para todo o catálogo',()=>{
  const index=buildFilmSearchIndex(films)
  assert.equal(index.size,1000)
  for(const f of films){
    const expected=normalizeFilmSearch([f.title,f.genre,f.director,f.actors,f.year].join(' '))
    assert.equal(index.get(f.id),expected)
  }
})
test('consultas com acentos e diferentes grafias têm resultados idênticos à busca anterior',()=>{
  const index=buildFilmSearchIndex(films)
  for (const term of ['suspeitos','cão','acao','Korean','2025','diretor','blade','misterio','']) {
    const query=normalizeFilmSearch(term)
    const old=films.filter(f=>normalizeFilmSearch([f.title,f.genre,f.director,f.actors,f.year].join(' ')).includes(query)).map(f=>f.id)
    const current=films.filter(f=>(index.get(f.id)||'').includes(query)).map(f=>f.id)
    assert.deepEqual(current,old)
  }
})
test('sessões personalizadas só usam a curadoria original S/A/B/C/D',()=>{
  const curated=personalCurationOnly(films)
  assert.equal(curated.length,317)
  assert.deepEqual(curated,originals)
  const choices=selectSession(curated,noHistory,{mood:'Todos',duration:'Qualquer',round:0})
  assert.ok(choices.length>0)
  assert.ok(choices.every(f=>f.priority!=='N'))
})
test('filme do dia não seleciona títulos N sem avaliação pessoal',()=>{
  const curated=personalCurationOnly(films)
  for(let offset=0;offset<10;offset++){
    const daily=pickDaily(curated,noHistory,'2026-10-14',offset)
    assert.ok(daily && daily.priority!=='N')
  }
})
test('317 títulos originais disponíveis mesmo quando os novos ficam fora das recomendações',()=>{
  const curated=personalCurationOnly(films)
  assert.equal(curated[0].id,1)
  assert.equal(curated.at(-1).id,317)
  assert.equal(films.filter(f=>f.priority==='N').length,683)
})
test('contagem de capas considera links da biblioteca, sem inventar imagens',()=>{
  assert.equal(Object.keys(posters).length,1000)
  assert.equal(countLinkedCovers(films,posters),1000)
  assert.equal(countLinkedCovers(films,{}),0)
  assert.equal(countLinkedCovers(films,{'1':'url','318':'url'}),2)
})
test('arquivos de capas separados e módulos pesados carregados dinamicamente',()=>{
  const app=fs.readFileSync(path.join(base,'src/App.tsx'),'utf8')
  assert.match(app,/import\('\.\/catalogPosters\.json'\)/)
  assert.doesNotMatch(app,/import catalogPostersData from/)
  assert.match(app,/const text=filmSearchIndex\.get\(f\.id\)\|\|''/)
  assert.match(app,/selectSession\(curatedFilms,saved/)
  assert.match(app,/pickDaily\(curatedFilms,saved/)
  assert.match(app,/import\('\.\/FilmTrailer'\)/)
  assert.match(app,/visible\.slice\(0,limit\)/)
})
test('nenhum campo de classificação N recebeu nota pessoal inventada',()=>{
  for(const f of films.slice(317)){
    assert.equal(f.priority,'N')
    assert.equal(f.stars,'N/D')
    assert.equal(f.imdb,'N/D')
    assert.equal(f.tension,0)
    assert.equal(f.emotion,0)
  }
})
