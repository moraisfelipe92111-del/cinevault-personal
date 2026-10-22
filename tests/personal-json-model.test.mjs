import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readPersonalJsonModel,updatePersonalJsonModel } from '../src/personalJsonModel.ts'
const key='cinevault.personal.v2'
const reader=raw=>({getItem(){return raw}})
const empty=()=>({known:[]})
const decode=raw=>{if(!raw||typeof raw!=='object'||!Array.isArray(raw.known))throw Error('invalid');return {known:[...new Set(raw.known.filter(id=>id===1||id===2))]}}

test('model reads never turn missing, empty, malformed or JSON-null text into a replacement write',()=>{
 assert.equal(readPersonalJsonModel(reader(null),key,decode,empty).blocked,false)
 assert.deepEqual(updatePersonalJsonModel(reader(null),key,decode,empty,value=>value),[])
 for(const raw of ['', '{broken','null','[]','0']){
  assert.equal(readPersonalJsonModel(reader(raw),key,decode,empty).blocked,true)
  assert.throws(()=>updatePersonalJsonModel(reader(raw),key,decode,empty,()=>({known:[1]})),/preservados/)
 }
})

test('unknown IDs, duplicate entries and unknown fields lock only the reduced model for review',()=>{
 for(const raw of ['{"known":[1,999999]}','{"known":[1,1]}','{"known":[1],"future":{}}']){
  assert.equal(readPersonalJsonModel(reader(raw),key,decode,empty).blocked,true)
  assert.throws(()=>updatePersonalJsonModel(reader(raw),key,decode,empty,value=>value),/revisão/)
 }
})

test('whitespace and object-key order do not falsely block a semantically lossless projection',()=>{
 const input=reader('  {"b":2,"a":1}\r\n'),decode=value=>({a:value.a,b:value.b})
 assert.equal(readPersonalJsonModel(input,key,decode,()=>({})).blocked,false)
 assert.deepEqual(updatePersonalJsonModel(input,key,decode,()=>({}),value=>value),[])
})

test('non-finite numbers in nested maps cannot be silently rewritten as JSON null',()=>{
 const decode=value=>value
 for(const raw of ['{"year":1e999}','{"nested":[1,1e999]}'])assert.equal(readPersonalJsonModel(reader(raw),key,decode,()=>({})).blocked,true)
})

test('an explicit valid edit is captured even for an in-place updater and invalid proposed values are refused',()=>{
 const input=reader('{"known":[1]}')
 assert.deepEqual(updatePersonalJsonModel(input,key,decode,empty,value=>{value.known.push(2);return value}),[{key,value:{known:[1,2]}}])
 assert.throws(()=>updatePersonalJsonModel(input,key,decode,empty,()=>({known:[999999]})),/confirmados/)
})
