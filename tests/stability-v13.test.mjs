import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitJsonBatch } from '../src/storageSafety.ts'
import { SONIC_FILES, playBrandAudio } from '../src/sonic.ts'
const root=join(dirname(fileURLToPath(import.meta.url)),'..')
function fakeStore(initial={},failKey){
 const data=new Map(Object.entries(initial));let failurePending=true
 return {data,getItem:k=>data.has(k)?data.get(k):null,
 setItem(k,v){if(k===failKey && failurePending){failurePending=false;throw Error('quota')}data.set(k,v)},
 removeItem(k){data.delete(k)}}
}
test('import saves all JSON keys on success',()=>{
 const db=fakeStore({older:'ok'});commitJsonBatch(db,[{key:'watch',value:{x:1}},{key:'list',value:[1,2]}]);
 assert.equal(db.getItem('watch'),'{"x":1}');assert.equal(db.getItem('list'),'[1,2]');assert.equal(db.getItem('older'),'ok')
})
test('import rolls back existing keys if a write fails',()=>{
 const db=fakeStore({watch:'old',list:'oldlist'},'list');
 assert.throws(()=>commitJsonBatch(db,[{key:'watch',value:{x:1}},{key:'list',value:[1,2]}]),/dados anteriores/);
 assert.equal(db.getItem('watch'),'old');assert.equal(db.getItem('list'),'oldlist')
})
test('rollback also removes freshly-created keys',()=>{
 const db=fakeStore({list:'old'},'list');
 assert.throws(()=>commitJsonBatch(db,[{key:'new',value:1},{key:'list',value:2}]));
 assert.equal(db.getItem('new'),null);assert.equal(db.getItem('list'),'old')
})
test('duplicate keys are rejected without mutation',()=>{
 const db=fakeStore();assert.throws(()=>commitJsonBatch(db,[{key:'a',value:1},{key:'a',value:2}]));assert.equal(db.data.size,0)
})
test('three selectable original sounds and two legacy options exist',()=>{
 for(const style of ['signature','noir','impacto','cinema','aura']){
  const path=join(root,'public',SONIC_FILES[style].slice(1));
  const bytes=readFileSync(path);assert.ok(bytes.length>30000,`${style} missing`)
 }
})
test('audio playback failure is nonblocking in Node',async()=>{assert.equal(await playBrandAudio('signature'),false)})
test('startup has a React crash boundary',()=>assert.match(readFileSync(join(root,'src/main.tsx'),'utf8'),/AppErrorBoundary/))
test('TMDb request has abort deadline',()=>assert.match(readFileSync(join(root,'src/tmdbAuto.ts'),'utf8'),/controller\.abort\(\)/))
test('Android updater and app ID are preserved',()=>{
 const java=readFileSync(join(root,'assets/android/CineVaultUpdaterPlugin.java'),'utf8');assert.match(java,/getPackageArchiveInfo/);assert.match(java,/ApkVerifier/);
 const config=readFileSync(join(root,'capacitor.config.ts'),'utf8');assert.match(config,/com\.cinevault\.pessoal/)
})
