import test from 'node:test'
import assert from 'node:assert/strict'
import { bestTrailer, chooseMovieMatch, rankedVideos, nameVariants, normalizeFilmName } from '../src/trailerRanking.mjs'
const dub={site:'YouTube',type:'Trailer',key:'abcdefghijk',official:true,iso_639_1:'pt',iso_3166_1:'BR',name:'Trailer oficial dublado',published_at:'2020-01-01'}
const english={site:'YouTube',type:'Trailer',key:'zyxwvutsrqp',official:true,iso_639_1:'en',iso_3166_1:'US',name:'Official Trailer',published_at:'2021-01-01'}
test('Portuguese translated title and original in parentheses are recognized',()=>assert.deepEqual(nameVariants('Garota Exemplar (Gone Girl)'),['garota exemplar gone girl','garota exemplar','gone girl']))
test('film matching requires exact title/year and rejects wrong movie',()=>{
 const f={title:'Garota Exemplar (Gone Girl)',year:2014}
 assert.equal(chooseMovieMatch(f,[{id:210577,title:'Garota Exemplar',original_title:'Gone Girl',release_date:'2014-10-01'}]),210577)
 assert.equal(chooseMovieMatch(f,[{id:333,title:'Garota Exemplar',original_title:'Gone Girl',release_date:'2008-10-01'}]),null)
 assert.equal(chooseMovieMatch(f,[{id:333,title:'Garota Exemplar 2',original_title:'Gone Girl 2',release_date:'2014-10-01'}]),null)
})
test('ambiguity yields no attachment',()=>{
 assert.equal(chooseMovieMatch({title:'O Enigma',year:2015},[{id:1,title:'O Enigma',release_date:'2015-01-01'},{id:2,title:'O Enigma',release_date:'2015-02-01'}]),null)
})
test('video picker prioritizes official dubbed Portuguese',()=>{
 const v=bestTrailer([english,dub],210577)
 assert.equal(v.youtubeVideoId,dub.key)
 assert.equal(v.official,true)
 assert.equal(v.dubbedStatus,'indicated_by_title')
})
test('Portuguese language without dubbing label is UNKNOWN, never called confirmed',()=>{
 const t=bestTrailer([{...dub,name:'Trailer Oficial'}],100)
 assert.equal(t.dubbedStatus,'unknown')
})
test('fan-made, forged and invalid YouTube IDs never enter the catalog',()=>{
 const bad=[{...dub,key:'https://evil.example/malware'},{...dub,key:'not11'},{...dub,name:'Fan Made Trailer'}]
 assert.equal(rankedVideos(bad).length,0)
 assert.equal(bestTrailer(bad,1),null)
})
test('official English trailer outranks unverified PT-BR',()=>{
 const ptNotOfficial={...dub,official:false,name:'Trailer',key:'ABCDEFGHIJK'}
 assert.equal(bestTrailer([ptNotOfficial,english],1).youtubeVideoId,english.key)
})
test('translated names ignore accents and punctuation',()=>assert.equal(normalizeFilmName('A Órfã: A Origem'), 'a orfa a origem'))
test('non-trailers do not autoplay from other video types',()=>assert.equal(bestTrailer([{...dub,type:'Teaser'}],1),null))
