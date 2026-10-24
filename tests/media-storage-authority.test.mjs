import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createMediaAuthorityStore} from '../src/mediaStorageAuthority.ts'
import {createPersonalAuthorityStore} from '../src/personalStorageAuthority.ts'
const source='a'.repeat(64),origin='b'.repeat(64),database='cinevault_personal'
function fixture(initial=null){let text=initial;const writes=[];const io={async read(){return text},async write(value){writes.push(value);text=value}};return {io,writes,get text(){return text},set text(value){text=value},store:createMediaAuthorityStore(database,io)}}

test('media authority is lazy, retains v1 and reserves before confirming one immutable media origin',async()=>{
  const f=fixture();assert.equal(f.writes.length,0)
  await f.store.ensureLegacy(source);assert.equal((await f.store.read()).version,1)
  await f.store.reserve(source,origin,7);assert.equal((await f.store.read()).mediaState,'reserved')
  await f.store.reserve(source,origin,7);assert.equal(f.writes.length,2)
  await f.store.confirm(source,origin,7);assert.equal((await f.store.read()).mediaState,'complete')
  await f.store.confirm(source,origin,7);assert.equal(f.writes.length,3)
  await assert.rejects(f.store.reserve(source,origin,7))
  await assert.rejects(f.store.ensureLegacy(source))
})

test('old app receipt readers reject the new authority instead of opening stale personal data',async()=>{
  const f=fixture();await f.store.ensureLegacy(source);await f.store.reserve(source,origin,0)
  const old=createPersonalAuthorityStore(database,f.io)
  await assert.rejects(old.read(),/inválido/);await assert.rejects(old.ensure(source))
  assert.equal((await f.store.read()).version,2)
})

test('missing, future, malformed and wrong-database receipts are never repaired or treated as absent',async()=>{
  const f=fixture();await f.store.ensureLegacy(source);await f.store.reserve(source,origin,0)
  const valid=JSON.parse(f.text)
  for(const bad of ['bad',JSON.stringify({...valid,version:3}),JSON.stringify({...valid,mediaState:'unknown'}),
    JSON.stringify({...valid,mediaOriginSha256:undefined}),JSON.stringify({...valid,mediaParentRevision:-1}),
    JSON.stringify({...valid,database:'other'}),JSON.stringify({...valid,extra:true})]){
    const x=fixture(bad);await assert.rejects(x.store.read());assert.equal(x.writes.length,0)
    await assert.rejects(x.store.reserve(source,origin,0));assert.equal(x.writes.length,0)
  }
  const empty=fixture();await assert.rejects(empty.store.confirm(source,origin,0));assert.equal(empty.writes.length,0)
})

test('source, parent revision and origin changes cannot replace a reserved or completed receipt',async()=>{
  const f=fixture();await f.store.ensureLegacy(source);await f.store.reserve(source,origin,2)
  for(const args of [['c'.repeat(64),origin,2],[source,'c'.repeat(64),2],[source,origin,3]]){
    await assert.rejects(f.store.reserve(...args));await assert.rejects(f.store.confirm(...args))
  }
  assert.equal(f.writes.length,2)
})

test('a missing write acknowledgement fails while a lost acknowledgement after durable write is recoverable',async()=>{
  const f=fixture();await f.store.ensureLegacy(source)
  const write=f.io.write
  f.io.write=async()=>{}
  await assert.rejects(f.store.reserve(source,origin,0));assert.equal((await f.store.read()).version,1)
  f.io.write=async value=>{await write(value);throw Error('lost acknowledgement')}
  await assert.rejects(f.store.reserve(source,origin,0))
  f.io.write=write
  assert.equal((await f.store.read()).mediaState,'reserved')
  await f.store.confirm(source,origin,0)
  assert.equal((await f.store.read()).mediaState,'complete')
})
