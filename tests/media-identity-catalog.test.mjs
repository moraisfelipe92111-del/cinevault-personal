import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {mediaKey,parseMediaKey,legacyMovieKey,episodeKey} from '../src/mediaIdentity.ts'
import {adaptLegacyMovieCatalog,createMediaCatalog,validateMediaRecord} from '../src/mediaCatalog.ts'

const read = name => JSON.parse(fs.readFileSync(new URL('../src/'+name,import.meta.url),'utf8'))
const films = read('films.json'), links = read('movieTmdbIds.json')
const item = (key='tmdb:tv:42', changes={}) => ({key,aliases:[],title:'Título de teste',year:2024,
  classifications:[],runtimeMinutes:45,runtimeScope:'episode',legacyMovieId:null,...changes})

test('movie, series and preserved local IDs never collide even when their numbers are equal',()=>{
  const keys=[mediaKey('local','movie',42),mediaKey('tmdb','movie',42),mediaKey('tmdb','tv',42)]
  assert.equal(new Set(keys).size,3)
  for(const key of keys){const parsed=parseMediaKey(key);assert.equal(mediaKey(parsed.source,parsed.mediaType,parsed.id),key);assert.ok(Object.isFrozen(parsed))}
  assert.equal(legacyMovieKey(42),'local:movie:42')
})

test('typed keys refuse coercion, unsafe integers, unknown sources and alternate spellings',()=>{
  for(const key of [null,42,'42','tmdb:tv:0','tmdb:tv:01','tmdb:tv:1.5','tmdb:tv:+1','tmdb:tv:1e2',
    'tmdb:tv:9007199254740992',' tmdb:tv:1','tmdb:TV:1','imdb:tv:1','tmdb:series:1','tmdb:tv:1\n','__proto__']) assert.throws(()=>parseMediaKey(key))
  for(const id of [0,-1,NaN,Infinity,1.5,'1',9007199254740992])assert.throws(()=>mediaKey('tmdb','tv',id))
  assert.throws(()=>mediaKey('unknown','tv',1));assert.throws(()=>mediaKey('tmdb','anime',1))
  assert.equal(mediaKey('tmdb','tv',Number.MAX_SAFE_INTEGER),'tmdb:tv:9007199254740991')
})

test('episodes retain their series, season and special-season identity',()=>{
  assert.notEqual(episodeKey('tmdb:tv:42',1,2),episodeKey('tmdb:tv:43',1,2))
  assert.notEqual(episodeKey('tmdb:tv:42',1,2),episodeKey('tmdb:tv:42',2,2))
  assert.equal(episodeKey('tmdb:tv:42',0,1),'tmdb:tv:42:season:0:episode:1')
  for(const [season,episode] of [[-1,1],[-0,1],[1,0],[1,1.5],[1,'1'],[Infinity,1]])assert.throws(()=>episodeKey('tmdb:tv:42',season,episode))
  assert.throws(()=>episodeKey('tmdb:movie:42',1,1))
})

test('all 1000 real movies keep their numeric IDs and 983 reviewed aliases without changing a source field',()=>{
  const before=JSON.stringify({films,links})
  const catalog=adaptLegacyMovieCatalog(films,links)
  assert.equal(catalog.records.length,1000)
  assert.equal(catalog.records.reduce((n,f)=>n+f.aliases.length,0),983)
  for(const film of films){
    const entry=catalog.getLegacyMovie(film.id)
    assert.equal(entry.key,'local:movie:'+film.id)
    assert.equal(entry.legacyMovieId,film.id)
    assert.equal(entry.title,film.title);assert.equal(entry.year,film.year)
    assert.deepEqual(entry.classifications,[])
    if(Object.hasOwn(links,String(film.id)))assert.equal(catalog.get('tmdb:movie:'+links[film.id]),entry)
    else assert.deepEqual(entry.aliases,[])
  }
  assert.equal(catalog.records.filter(f=>f.aliases.length===0).length,17)
  assert.equal(JSON.stringify({films,links}),before)
})

test('an anime documentary series has one canonical record in both categories',()=>{
  const catalog=createMediaCatalog([item('tmdb:tv:42',{classifications:['anime','animation','documentary']}),
    item('tmdb:movie:42',{runtimeScope:'movie',runtimeMinutes:120,classifications:['anime']})])
  assert.equal(catalog.records.length,2)
  assert.equal(catalog.byClassification('anime').length,2)
  assert.equal(catalog.byClassification('documentary')[0],catalog.get('tmdb:tv:42'))
  assert.notEqual(catalog.get('tmdb:tv:42'),catalog.get('tmdb:movie:42'))
  assert.equal(catalog.get('tmdb:tv:999'),null)
})

test('reviewed aliases cannot ambiguously identify two records or mix movie and TV namespaces',()=>{
  const first=item('local:movie:1',{legacyMovieId:1,runtimeScope:'movie',aliases:['tmdb:movie:42']})
  assert.throws(()=>createMediaCatalog([first,item('tmdb:movie:42',{runtimeScope:'movie'})]))
  assert.throws(()=>createMediaCatalog([first,{...first}]))
  assert.throws(()=>createMediaCatalog([item('tmdb:tv:42',{aliases:['tmdb:movie:42']})]))
  assert.throws(()=>validateMediaRecord(item('tmdb:tv:42',{aliases:['tmdb:tv:42']})))
  assert.throws(()=>validateMediaRecord(item('tmdb:tv:42',{aliases:['tmdb:tv:43','tmdb:tv:43']})))
  assert.throws(()=>validateMediaRecord(item('tmdb:tv:42',{aliases:['local:tv:1']})))
})

test('legacy mapping refuses duplicate IDs, unreviewed links and links for absent movies',()=>{
  assert.throws(()=>adaptLegacyMovieCatalog([films[0],films[0]],{}))
  assert.throws(()=>adaptLegacyMovieCatalog(Array(1),{}))
  assert.throws(()=>createMediaCatalog(Array(1)))
  assert.throws(()=>adaptLegacyMovieCatalog([films[0]],{'1':0}))
  assert.throws(()=>adaptLegacyMovieCatalog([films[0]],{'2':42}))
  assert.throws(()=>adaptLegacyMovieCatalog([films[0]],{'01':42}))
  assert.throws(()=>adaptLegacyMovieCatalog([films[0]],{'1':NaN}))
  assert.throws(()=>adaptLegacyMovieCatalog([films[0],films[1]],{'1':42,'2':42}))
  assert.throws(()=>validateMediaRecord(item('local:movie:1',{legacyMovieId:2,runtimeScope:'movie'})))
  assert.throws(()=>validateMediaRecord(item('local:tv:1')))
})

test('movie length and episode length have different scopes and unknown time is never fabricated',()=>{
  assert.equal(validateMediaRecord(item()).runtimeScope,'episode')
  assert.throws(()=>validateMediaRecord(item('tmdb:tv:42',{runtimeScope:'movie'})))
  assert.throws(()=>validateMediaRecord(item('tmdb:movie:42')))
  for(const minutes of [NaN,Infinity,-1,0,'45'])assert.throws(()=>validateMediaRecord(item('tmdb:tv:42',{runtimeMinutes:minutes})))
  const catalog=adaptLegacyMovieCatalog([{...films[0],duration:'N/D'},{...films[1],duration:'12 min'}],{})
  assert.equal(catalog.getLegacyMovie(1).runtimeMinutes,null)
  assert.equal(catalog.getLegacyMovie(2).runtimeMinutes,12)
})

test('catalogue records and category results detach from caller arrays and remain immutable',()=>{
  const raw=item('tmdb:tv:42',{aliases:['tmdb:tv:43'],classifications:['anime']})
  const catalog=createMediaCatalog([raw])
  raw.aliases.push('tmdb:tv:44');raw.classifications.push('documentary');raw.title='Mudou'
  const saved=catalog.get('tmdb:tv:42')
  assert.equal(saved.title,'Título de teste');assert.deepEqual(saved.aliases,['tmdb:tv:43'])
  assert.deepEqual(saved.classifications,['anime'])
  assert.equal(catalog.get('tmdb:tv:44'),null)
  assert.throws(()=>catalog.records.push(saved));assert.throws(()=>saved.aliases.push('tmdb:tv:44'))
  assert.throws(()=>catalog.byClassification('anime').pop())
})

test('unsupported record fields and classifications are refused rather than silently stripped',()=>{
  for(const changes of [{future:true},{classifications:['anime','anime']},{classifications:['unknown']},
    {classifications:Array(1)},{aliases:Array(1)},{year:NaN},{title:''}])assert.throws(()=>validateMediaRecord(item('tmdb:tv:42',changes)))
})
