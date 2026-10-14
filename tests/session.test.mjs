import { test } from 'node:test'
import assert from 'node:assert/strict'
import {durationMinutes, matchesMood, selectSession} from '../src/session.ts'

const make = (id, extra = {}) => ({id, title:`Filme ${id}`, genre:'Crime / Investigação', director:`Diretor ${id}`, priority:'S', duration:'98 min', tension:9, emotion:5, twist:'Forte', year:2019, ...extra})
const catalog = [make(1),make(2,{duration:'150 min',director:'Diretor 1'}),make(3,{duration:'105 min'}),make(4,{priority:'A',genre:'Drama',tension:2,emotion:9}),make(5,{priority:'B',genre:'Terror'})]
const profile = {watched:[],favorites:[],ratings:{}}
const opts = {mood:'Todos',duration:'Qualquer',round:0}

test('extracts realistic runtime safely',()=>{
  assert.equal(durationMinutes('105 min'),105)
  assert.equal(durationMinutes('N/D'),null)
  assert.equal(durationMinutes('1 min'),null)
})
test('returns deterministic unique picks and respects watched',()=>{
  const one=selectSession(catalog,{...profile,watched:[1]},opts)
  assert.equal(one.length,3)
  assert.deepEqual(one,selectSession(catalog,{...profile,watched:[1]},opts))
  assert.equal(new Set(one.map(f=>f.id)).size,3)
  assert.ok(!one.some(f=>f.id===1))
})
test('filters exact mood and maximum runtime',()=>{
  const picks=selectSession(catalog,profile,{mood:'Investigação',duration:'110',round:0})
  assert.ok(picks.length>0)
  assert.ok(picks.every(f=>matchesMood(f,'Investigação')&&durationMinutes(f.duration)<=110))
})
test('rotates selections and handles exhausted lists',()=>{
  assert.notDeepEqual(selectSession(catalog,profile,opts).map(f=>f.id),selectSession(catalog,profile,{...opts,round:1}).map(f=>f.id))
  assert.deepEqual(selectSession(catalog,{...profile,watched:catalog.map(f=>f.id)},opts),[])
})
test('favors high priorities and diverse directors',()=>{
  const picks=selectSession(catalog,profile,opts)
  assert.equal(picks[0].priority,'S')
  assert.equal(new Set(picks.map(f=>f.director)).size,picks.length)
})
