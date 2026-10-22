import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createPersonalAuthorityStore,createFilesystemPersonalAuthority} from '../src/personalStorageAuthority.ts'
const source='a'.repeat(64),other='b'.repeat(64)
const receipt=()=>JSON.stringify({format:'cinevault.personal-sqlite-authority',version:1,database:'cinevault_personal',sourceSha256:source})

test('authority construction is lazy and first confirmation persists one immutable source identity',async()=>{
 let raw=null,reads=0,writes=0
 const store=createPersonalAuthorityStore('cinevault_personal',{async read(){reads++;return raw},async write(text){writes++;raw=text}})
 assert.equal(reads,0);assert.equal(writes,0)
 assert.equal(await store.read(),null)
 await store.ensure(source);await store.ensure(source)
 assert.equal(writes,1);assert.equal((await store.read()).sourceSha256,source)
 await assert.rejects(store.ensure(other),/outra origem/);assert.equal(writes,1)
})

test('malformed, missing-field, wrong-database and future authority receipts are never treated as absent or overwritten',async()=>{
 for(const raw of ['', '{broken','null', JSON.stringify({...JSON.parse(receipt()),version:2}),JSON.stringify({...JSON.parse(receipt()),database:'other'}),JSON.stringify({...JSON.parse(receipt()),extra:true})]){
  const store=createPersonalAuthorityStore('cinevault_personal',{async read(){return raw},async write(){assert.fail('must not repair an invalid receipt')}})
  await assert.rejects(store.read(),/inválido/);await assert.rejects(store.ensure(source),/inválido/)
 }
})

test('a denied authority read and missing write acknowledgement cannot be misreported as confirmation',async()=>{
 const denied=createPersonalAuthorityStore('cinevault_personal',{async read(){throw Error('denied')},async write(){assert.fail('no write')}})
 await assert.rejects(denied.ensure(source),/denied/)
 const ignored=createPersonalAuthorityStore('cinevault_personal',{async read(){return null},async write(){}})
 await assert.rejects(ignored.ensure(source),/confirmar/)
})

test('a lost acknowledgement after durable authority rename is recoverable without replacing it',async()=>{
 let raw=null,writes=0
 const io={async read(){return raw},async write(text){raw=text;writes++;throw Error('lost acknowledgement')}}
 await assert.rejects(createPersonalAuthorityStore('cinevault_personal',io).ensure(source),/lost acknowledgement/)
 await createPersonalAuthorityStore('cinevault_personal',io).ensure(source)
 assert.equal(writes,1)
})

test('the native authority adapter stages a bounded private file then renames it in the same directory',async()=>{
 const files=new Map(),calls=[]
 const io={
  async readdir(options){calls.push(['list',options]);return {files:[...files].map(([name,value])=>({name,size:value.length}))}},
  async readFile(options){return {data:files.get(options.path)}},
  async writeFile(options){calls.push(['write',options]);files.set(options.path,options.data)},
  async rename(options){calls.push(['rename',options]);files.set(options.to,files.get(options.from));files.delete(options.from)},
 }
 const authority=createFilesystemPersonalAuthority(io,'DATA','cinevault_personal')
 await authority.ensure(source)
 assert.equal(files.size,1);assert.ok(files.has('cinevault_personal-authority.json'))
 const write=calls.find(call=>call[0]==='write')[1],rename=calls.find(call=>call[0]==='rename')[1]
 assert.equal(write.directory,'DATA');assert.equal(rename.directory,'DATA')
 assert.equal(rename.from,write.path);assert.equal(rename.to,'cinevault_personal-authority.json')
 assert.ok(write.data.length<2048)
})
