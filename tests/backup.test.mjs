import { test } from 'node:test'
import assert from 'node:assert/strict'
import {parseBackup} from '../src/backupValidation.ts'
const ids = new Set([1,2])
const backup = {version:3,favorites:[1,1,999],watched:[2],ratings:{1:5,2:0},posters:{1:'https://image.tmdb.org/t/p/w500/abc.jpg',999:'https://example.com/evil.png'}}

test('preserves known ids, filters invalid entries and duplicate favorites',()=>{
  const p=parseBackup(backup,ids)
  assert.deepEqual(p.saved.favorites,[1])
  assert.deepEqual(p.saved.watched,[2])
  assert.deepEqual(p.saved.ratings,{'1':5})
  assert.deepEqual(p.posters,{'1':'https://image.tmdb.org/t/p/w500/abc.jpg'})
})
test('rejects malformed backup before any apply',()=>{
  for (const raw of [null,{}, {...backup,version:99}, {...backup,posters:[]}, {...backup,ratings:[]}, {...backup,watched:'bad'}]) {
    assert.throws(()=>parseBackup(raw,ids))
  }
})
test('maintains compatibility with older backups without posters',()=>{
  const p=parseBackup({favorites:[],watched:[],ratings:{}},ids)
  assert.equal(p.posters,undefined)
})
test('filters unsafe image urls',()=>{
  const p=parseBackup({...backup,posters:{1:'javascript:alert(1)',2:'https://image.tmdb.org/t/p/w500/safe.png'}},ids)
  assert.deepEqual(p.posters,{'2':'https://image.tmdb.org/t/p/w500/safe.png'})
})
