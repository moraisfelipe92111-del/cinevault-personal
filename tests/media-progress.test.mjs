import {test} from 'node:test'
import assert from 'node:assert/strict'
import {MEDIA_STATUSES,validateMediaProgress,validateMediaProgressSnapshot,emptyMediaProgressSnapshot,
  setMediaStatus,setEpisodeWatched,summarizeSeason} from '../src/mediaProgress.ts'

const progress=(changes={})=>({key:'tmdb:tv:42',status:'watching',watchedEpisodes:[],...changes})
const snapshot=entries=>({format:'sintonema.media-progress',version:1,entries})

test('each personal state is explicit and setting it preserves episode positions',()=>{
  const original=progress({watchedEpisodes:[{season:1,episode:1}]})
  for(const status of MEDIA_STATUSES){const result=setMediaStatus(original,status);assert.equal(result.status,status);assert.deepEqual(result.watchedEpisodes,original.watchedEpisodes)}
  assert.equal(original.status,'watching');assert.throws(()=>setMediaStatus(original,'finished_season'))
})

test('finishing every known episode completes only the season and never the whole series',()=>{
  let current=progress()
  for(const episode of [1,2,3])current=setEpisodeWatched(current,1,episode,true)
  assert.deepEqual(summarizeSeason(current,1,[1,2,3]),{watched:3,known:3,complete:true})
  assert.equal(current.status,'watching')
  assert.deepEqual(summarizeSeason(current,2,[1,2]),{watched:0,known:2,complete:false})
  assert.equal(setMediaStatus(current,'completed').status,'completed')
})

test('marking and unmarking episodes is idempotent and never changes another season or specials',()=>{
  let current=progress({status:'paused'})
  current=setEpisodeWatched(current,2,1,true);current=setEpisodeWatched(current,0,1,true)
  current=setEpisodeWatched(current,1,1,true)
  const same=setEpisodeWatched(current,1,1,true)
  assert.deepEqual(same,current)
  const next=setEpisodeWatched(current,1,1,false)
  assert.deepEqual(next.watchedEpisodes,[{season:0,episode:1},{season:2,episode:1}])
  assert.equal(next.status,'paused');assert.equal(current.watchedEpisodes.length,3)
})

test('a partial catalogue preserves unseen episode IDs and cannot infer completion from missing counts',()=>{
  const current=progress({watchedEpisodes:[{season:1,episode:1},{season:1,episode:99}]})
  assert.deepEqual(summarizeSeason(current,1,null),{watched:2,known:null,complete:null})
  assert.deepEqual(summarizeSeason(current,1,[]),{watched:0,known:0,complete:null})
  assert.deepEqual(summarizeSeason(current,1,[1,2]),{watched:1,known:2,complete:false})
  assert.equal(validateMediaProgress(current).watchedEpisodes[1].episode,99)
})

test('movie progress cannot accidentally acquire episodes and all positions and counts are validated',()=>{
  const movie=progress({key:'local:movie:42',status:'completed'})
  assert.deepEqual(validateMediaProgress(movie).watchedEpisodes,[])
  assert.throws(()=>setEpisodeWatched(movie,1,1,true))
  assert.throws(()=>validateMediaProgress({...movie,watchedEpisodes:[{season:1,episode:1}]}))
  for(const positions of [Array(1),[{season:-1,episode:1}],[{season:1,episode:0}],[{season:1,episode:'1'}],
    [{season:1,episode:1,future:true}],[{season:1,episode:1},{season:1,episode:1}]])assert.throws(()=>validateMediaProgress(progress({watchedEpisodes:positions})))
  for(const counts of [[1,1],[0],[1.5],['1']])assert.throws(()=>summarizeSeason(progress(),1,counts))
  assert.throws(()=>setEpisodeWatched(progress(),1,1,'true'))
})

test('snapshots keep unknown catalogue identities and equal numeric film and TV IDs separate',()=>{
  const result=validateMediaProgressSnapshot(snapshot([
    progress({key:'local:movie:42',status:'completed'}),progress({key:'tmdb:movie:42',status:'abandoned'}),
    progress({key:'tmdb:tv:42'}),progress({key:'tmdb:tv:999999999'})]))
  assert.equal(result.entries.length,4);assert.equal(result.entries[3].key,'tmdb:tv:999999999')
  assert.throws(()=>validateMediaProgressSnapshot(snapshot([progress(),progress()])))
  assert.deepEqual(emptyMediaProgressSnapshot().entries,[])
})

test('future, partial and malformed progress envelopes reject the entire operation',()=>{
  for(const raw of [null,{}, {...snapshot([]),version:2},{...snapshot([]),future:true},snapshot([progress({status:'future'})]),
    snapshot([progress({future:true})]),{...snapshot([]),entries:{}},snapshot(Array(1)),snapshot([{key:'tmdb:tv:1',status:'watching'}])])assert.throws(()=>validateMediaProgressSnapshot(raw))
})

test('progress snapshots are deeply immutable and detached from mutable caller state',()=>{
  const input=snapshot([progress({watchedEpisodes:[{season:1,episode:1}]})])
  const result=validateMediaProgressSnapshot(input)
  input.entries[0].watchedEpisodes[0].episode=20;input.entries.push(progress({key:'tmdb:tv:2'}))
  assert.equal(result.entries.length,1);assert.equal(result.entries[0].watchedEpisodes[0].episode,1)
  assert.throws(()=>result.entries[0].watchedEpisodes[0].episode=2)
  assert.throws(()=>result.entries.push(progress()))
})
