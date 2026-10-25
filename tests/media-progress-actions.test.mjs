import {test} from 'node:test'
import assert from 'node:assert/strict'
import {editMediaProgress,episodeInputs} from '../src/mediaProgressActions.ts'
import {emptyMediaProgressSnapshot,MEDIA_STATUSES} from '../src/mediaProgress.ts'

const key='tvmaze:tv:169',unknown={key:'tmdb:tv:169',status:'paused',watchedEpisodes:[{season:1,episode:99}]}

test('each chosen status creates an explicit record without changing equal-numbered or unmapped identities',()=>{
  const initial={...emptyMediaProgressSnapshot(),entries:[unknown]}
  for(const status of MEDIA_STATUSES){const result=editMediaProgress(initial,key,{type:'status',status});assert.equal(result.entries[1].status,status);assert.deepEqual(result.entries[0],unknown)}
  assert.deepEqual(initial.entries,[unknown])
})

test('an explicit watched episode starts tracking and special-season positions remain separate',()=>{
  let current=editMediaProgress(emptyMediaProgressSnapshot(),key,{type:'episode',season:1,episode:1,watched:true})
  current=editMediaProgress(current,key,{type:'episode',season:0,episode:1,watched:true})
  current=editMediaProgress(current,key,{type:'episode',season:2,episode:1,watched:true})
  assert.equal(current.entries[0].status,'watching')
  assert.deepEqual(current.entries[0].watchedEpisodes,[{season:0,episode:1},{season:1,episode:1},{season:2,episode:1}])
})

test('episodes never silently complete a series or resume an explicit paused or abandoned state',()=>{
  for(const status of ['watching','paused','abandoned','completed']){
    let p=editMediaProgress(emptyMediaProgressSnapshot(),key,{type:'status',status})
    for(const episode of [1,2,3])p=editMediaProgress(p,key,{type:'episode',season:1,episode,watched:true})
    assert.equal(p.entries[0].status,status)
  }
})

test('marking, unmarking and removal target only the chosen work and retain the source snapshot',()=>{
  let p=editMediaProgress({...emptyMediaProgressSnapshot(),entries:[unknown]},key,{type:'episode',season:1,episode:1,watched:true})
  const before=JSON.stringify(p)
  assert.deepEqual(editMediaProgress(p,key,{type:'episode',season:1,episode:1,watched:true}),p)
  const unmarked=editMediaProgress(p,key,{type:'episode',season:1,episode:1,watched:false})
  assert.deepEqual(unmarked.entries[1].watchedEpisodes,[]);assert.deepEqual(unmarked.entries[0],unknown)
  assert.deepEqual(editMediaProgress(p,key,{type:'remove'}).entries,[unknown]);assert.equal(JSON.stringify(p),before)
  assert.deepEqual(editMediaProgress(emptyMediaProgressSnapshot(),key,{type:'episode',season:1,episode:1,watched:false}),emptyMediaProgressSnapshot())
})

test('invalid edits reject before producing a reduced snapshot or changing caller input',()=>{
  const p={...emptyMediaProgressSnapshot(),entries:[unknown]},before=JSON.stringify(p)
  for(const edit of [null,{}, {type:'status',status:'unknown'},{type:'status',status:'watching',future:true},
    {type:'episode',season:1,episode:0,watched:true},{type:'episode',season:1,episode:2,watched:'true'},
    {type:'episode',season:NaN,episode:1,watched:true},{type:'episode',season:1,episode:Infinity,watched:true},{type:'unknown'}])assert.throws(()=>editMediaProgress(p,key,edit))
  assert.throws(()=>editMediaProgress(p,'local:movie:169',{type:'episode',season:1,episode:1,watched:true}))
  assert.equal(JSON.stringify(p),before)
})

test('episode fields accept canonical integer positions including specials and reject coercion and overflow',()=>{
  assert.deepEqual(episodeInputs('0','1'),{season:0,episode:1});assert.deepEqual(episodeInputs('2','12'),{season:2,episode:12})
  for(const pair of [['-0','1'],['01','1'],['1','0'],['1','1.5'],['1','1e2'],['1',''],[' 1','1'],['1','9007199254740992']])assert.throws(()=>episodeInputs(...pair))
})
