import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {validatePilotCatalog,filterPilot,pilotKind} from '../src/mediaPilot.ts'
import {adaptLegacyMovieCatalog,createMediaCatalog} from '../src/mediaCatalog.ts'
import {mediaKey,parseMediaKey,episodeKey} from '../src/mediaIdentity.ts'
import {emptyMediaProgressSnapshot} from '../src/mediaProgress.ts'

const read=file=>JSON.parse(fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8'))
const data=read('mediaPilotData.json'),catalog=validatePilotCatalog(data)
const empty=emptyMediaProgressSnapshot()

test('the pilot has exactly eight reviewed show identities and no fabricated personal ratings or TMDb links',()=>{
  assert.deepEqual(catalog.items.map(x=>[x.media.key,x.media.title,x.media.year]),[
    ['tvmaze:tv:169','Breaking Bad',2008],['tvmaze:tv:161','Dexter',2006],['tvmaze:tv:269','Peaky Blinders',2013],
    ['tvmaze:tv:26856','You',2018],['tvmaze:tv:64632','Solo Leveling',2024],['tvmaze:tv:17779','MasterChef Brasil',2014],
    ['tvmaze:tv:114','Survivor',2000],['tvmaze:tv:22036','Planet Earth II',2016]])
  assert.equal(catalog.reviewedAt,'2026-10-25')
  for(const {media,sourceUrl} of catalog.items){
    assert.equal(media.legacyMovieId,null);assert.deepEqual(media.aliases,[]);assert.equal(media.runtimeScope,'episode')
    assert.equal(media.runtimeMinutes,null);assert.ok(!Object.hasOwn(media,'rating'));assert.ok(!Object.hasOwn(media,'priority'))
    assert.ok(sourceUrl.includes('/shows/'+parseMediaKey(media.key).id+'/'))
  }
})

test('the preserved 1000-film catalogue and all its fields remain unchanged beside the eight shows',()=>{
  const films=read('films.json'),links=read('movieTmdbIds.json'),before=JSON.stringify({films,links})
  const old=adaptLegacyMovieCatalog(films,links),combined=createMediaCatalog([...old.records,...catalog.media.records])
  assert.equal(combined.records.length,1008)
  for(const movie of films){assert.deepEqual(combined.getLegacyMovie(movie.id),old.getLegacyMovie(movie.id));assert.equal(combined.getLegacyMovie(movie.id).key,'local:movie:'+movie.id)}
  assert.equal(combined.get('tvmaze:tv:169').title,'Breaking Bad')
  assert.equal(combined.get('tmdb:tv:169'),null)
  assert.equal(JSON.stringify({films,links}),before)
})

test('TVmaze IDs round trip in their own namespace and cannot collide with equal movie or TMDb IDs',()=>{
  const keys=[mediaKey('tvmaze','tv',169),mediaKey('tmdb','tv',169),mediaKey('tmdb','movie',169),mediaKey('local','movie',169)]
  assert.equal(new Set(keys).size,4)
  assert.deepEqual(parseMediaKey(keys[0]),{source:'tvmaze',mediaType:'tv',id:169})
  assert.notEqual(episodeKey(keys[0],1,1),episodeKey(keys[1],1,1))
  for(const key of ['tvmaze:tv:0169','TVmaze:tv:169','tvmaze:tv:1e2','tvmaze:tv:0','tvmaze:tv:169\n','tvmaze:tv:169;DROP TABLE x'])assert.throws(()=>parseMediaKey(key))
})

test('overlapping fiction and anime categories reuse the same canonical item without duplication',()=>{
  const anime=filterPilot(catalog,'','Animes',empty),fiction=filterPilot(catalog,'','Ficção',empty)
  assert.equal(anime.length,1);assert.equal(fiction.length,5);assert.equal(anime[0],fiction.find(x=>x.media.key===anime[0].media.key))
  assert.equal(filterPilot(catalog,'','Realities',empty).length,2)
  assert.equal(filterPilot(catalog,'','Documentários',empty).length,1)
  assert.equal(pilotKind(anime[0].media),'Anime')
  assert.equal(new Set(filterPilot(catalog,'','Todos',empty).map(x=>x.media.key)).size,8)
})

test('search handles accents, punctuation and years while the tracked filter retains unmapped progress',()=>{
  assert.equal(filterPilot(catalog,'MÁSTER-CHEF','Todos',empty)[0].media.key,'tvmaze:tv:17779')
  assert.equal(filterPilot(catalog,'2016','Documentários',empty)[0].media.title,'Planet Earth II')
  const progress={...empty,entries:[{key:'tvmaze:tv:169',status:'paused',watchedEpisodes:[]},{key:'tmdb:tv:169',status:'watching',watchedEpisodes:[]},{key:'tvmaze:tv:9999999',status:'completed',watchedEpisodes:[]}]}
  const before=JSON.stringify(progress)
  assert.deepEqual(filterPilot(catalog,'','Acompanhando',progress).map(x=>x.media.key),['tvmaze:tv:169'])
  assert.equal(JSON.stringify(progress),before)
  assert.throws(()=>filterPilot(catalog,'','unknown',empty))
})

test('unreviewed aliases, unsafe poster/source URLs and unexpected personal metadata cannot enter the pilot',()=>{
  for(const change of [x=>x.entries[0].media.aliases.push('tmdb:tv:1396'),x=>x.entries[0].media.priority='S',
    x=>x.entries[0].media.legacyMovieId=169,x=>x.entries[0].sourceUrl='https://www.tvmaze.com.attacker/shows/169/breaking-bad',
    x=>x.entries[0].sourceUrl+='?affiliate=unknown',x=>x.entries[0].posterUrl='javascript:alert(1)',
    x=>x.entries[0].summary='<script>bad</script>',x=>x.entries.push(x.entries[0]),x=>x.entries[0].media.key='tmdb:tv:169',
    x=>x.reviewedAt='2026-02-30',x=>x.license='unknown',x=>x.version=2]){
    const copy=structuredClone(data);change(copy);assert.throws(()=>validatePilotCatalog(copy))
  }
})

test('reviewed pilot metadata is immutable and detached, with attribution and ShareAlike licence retained',()=>{
  const copy=structuredClone(data),result=validatePilotCatalog(copy)
  copy.entries[0].media.title='Changed';copy.entries[0].summary='Changed'
  assert.equal(result.items[0].media.title,'Breaking Bad');assert.notEqual(result.items[0].summary,'Changed')
  assert.throws(()=>result.items.push(result.items[0]));assert.throws(()=>result.items[0].media.classifications.push('anime'))
  assert.equal(result.licenseUrl,'https://creativecommons.org/licenses/by-sa/4.0/')
})
