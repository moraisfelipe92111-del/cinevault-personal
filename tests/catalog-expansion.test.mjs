import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeMovieName,catalogNameKeys,preexistingMovie,qualifiedMovie,candidateScore,resolveCandidates,collectSources} from '../scripts/collect-movie-candidates.mjs'
const old=[{id:1,title:'Garota Exemplar (Gone Girl)',year:2014,priority:'S'}, {id:2,title:'Os Suspeitos (Prisoners)',year:2013,priority:'A'}]
const movie=(id,title,year,extras={})=>({id,title,original_title:title,release_date:year+'-03-20',genre_ids:[53,80],poster_path:'/a.jpg',vote_average:7.8,vote_count:2000,adult:false,...extras})
test('canonical names normalize accents and punctuation',()=>assert.equal(normalizeMovieName('É Um—Filme!!!'),'e um filme'))
test('Portuguese and parenthesized original names are preserved',()=>{const v=catalogNameKeys(old[0].title);assert.ok(v.has('gone girl'));assert.ok(v.has('garota exemplar'))})
test('TMDb identity prevents duplicate import even under different titles',()=>assert.equal(preexistingMovie(movie(999,'Unknown',2014),new Set([999]),new Map()),true))
test('same title and year prevents duplicates when TMDb ID absent',()=>assert.equal(preexistingMovie(movie(999,'Gone Girl',2014),new Set(),new Map([['gone girl|2014',1]])),true))
test('movie eligibility rejects TV, bad scores, missing poster or year',()=>{
  assert.equal(qualifiedMovie(movie(3,'A',2024)),true)
  assert.equal(qualifiedMovie(movie(3,'A',2024,{vote_count:10})),false)
  assert.equal(qualifiedMovie(movie(3,'A',2024,{adult:true})),false)
  assert.equal(qualifiedMovie(movie(3,'A',2024,{poster_path:null})),false)
  assert.equal(qualifiedMovie(movie(3,'A',2030)),false)
})
test('candidate scoring prefers related recommended stories',()=>{
  const base={genreIds:[53,80],voteAverage:7.1,voteCount:2000,recommendedBy:[]}
  assert.ok(candidateScore({...base,recommendedBy:['Garota Exemplar']})>candidateScore(base))
})
test('existing IDs and stable catalogue are never modified',()=>{
  const original=JSON.stringify(old)
  const {candidates,stats}=resolveCandidates({films:old,existingTmdbMap:{'1':210577},
    sources:[{movie:movie(210577,'Gone Girl',2014),seed:'Os Suspeitos'},
      {movie:movie(100,'Novo suspense',2021),seed:'Garota Exemplar'},
      {movie:movie(100,'Novo suspense',2021),seed:'Os Suspeitos'},
      {movie:movie(999,'Garota Exemplar',2014),seed:'Falso'},
      {movie:movie(101,'Outra história',2020),seed:null}]})
  assert.equal(JSON.stringify(old),original)
  assert.equal(candidates.length,2)
  assert.equal(candidates[0].tmdbId,100)
  assert.equal(candidates[0].recommendedBy.length,2)
  assert.ok(stats.alreadyExcluded>=2)
  assert.ok(candidates.every(c=>!('id' in c)))
})
test('source collection uses only registered high priority seed TMDb IDs',async()=>{
  const urls=[];const {sources,seeds,requests}=await collectSources({films:old,ids:{'1':210577},maxSeeds:1,pagesPerGenre:1,
    request:async(endpoint,params)=>{urls.push({endpoint,params});return {results:[movie(222,'Teste',2019)]}}})
  assert.equal(seeds,1)
  assert.equal(requests,13)
  assert.equal(sources.length,13)
  assert.equal(urls.filter(u=>u.endpoint.includes('recommendations')).length,2)
})
