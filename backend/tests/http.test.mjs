import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {request as rawRequest} from 'node:http'
import {spawnSync} from 'node:child_process'
import path from 'node:path'
import {startFixture,jar,catalogue,root} from './http-helpers.mjs'

let server,guest,owner,draft,first,second
before(async()=>{server=await startFixture();guest=jar(server.base);owner=jar(server.base)})
after(async()=>{if(server)await server.stop()})

test('HTTP serves CSP-protected login and refuses private operations before authentication',async()=>{
 const response=await fetch(server.base+'/');const html=await response.text()
 assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/)
 assert.match(html,/Sintonema/);assert.ok(!html.includes(server.fixture.password))
 for(const route of ['dashboard','draft&id=1'])assert.equal((await guest.request(route)).response.status,401)
 for(const route of ['drafts/create','drafts/update','drafts/review','publish','rollback','sessions/revoke'])assert.equal((await guest.request(route,{})).response.status,401)
 assert.equal((await guest.request('publish',{}, {raw:'{"private":"invalid-json"'})).response.status,401)
 assert.equal((await guest.request('setup',{})).response.status,401)
})
test('HTTP session uses HttpOnly SameSite cookie and CSRF; malformed bodies never reveal submitted contents',async()=>{
 const state=await owner.request('session');assert.equal(state.result.data.authenticated,false)
 const cookies=state.response.headers.getSetCookie().join(';');assert.match(cookies,/HttpOnly/i);assert.match(cookies,/SameSite=Strict/i)
 const input={username:server.fixture.username,password:server.fixture.password,code:server.fixture.recoveryCodes[0]}
 assert.equal((await owner.request('login',input,{headers:{'X-CSRF-Token':''}})).response.status,403)
 assert.equal((await owner.request('login',input,{headers:{Origin:'https://attacker.invalid'}})).response.status,403)
 const malformed=await owner.request('login',input,{raw:'{"password":"never-echo-this"'})
 assert.equal(malformed.response.status,422);assert.ok(!malformed.raw.includes('never-echo-this'))
 assert.equal((await owner.request('login',input,{headers:{'Content-Type':'text/plain'}})).response.status,415)
})
test('HTTP login requires both factors and rotates session identifier and CSRF',async()=>{
 const priorCookie=owner.cookie,priorCsrf=owner.csrf
 const input={username:server.fixture.username,password:server.fixture.password,code:server.fixture.recoveryCodes[0]}
 assert.equal((await owner.request('login',{...input,code:''})).response.status,401)
 const result=await owner.request('login',input);assert.equal(result.response.status,200)
 assert.notEqual(owner.cookie,priorCookie);assert.notEqual(owner.csrf,priorCsrf)
 assert.equal((await owner.request('dashboard')).response.status,200)
 assert.equal((await guest.request('catalogue')).response.status,404)
})
test('HTTP draft import is private and publish requires review of the exact content',async()=>{
 const invalid=catalogue();invalid.items[0].categories={}
 assert.equal((await owner.request('drafts/create',{title:'invalid type',catalogue:invalid})).response.status,422)
 const created=await owner.request('drafts/create',{title:'Teste HTTP',catalogue:catalogue()})
 assert.equal(created.response.status,200);draft=created.result.data
 assert.equal((await guest.request('draft&id='+draft.id)).response.status,401)
 assert.equal((await owner.request('publish',{id:draft.id,revision:1,generation:0})).response.status,409)
 const checks={identity:true,metadataRights:true,imageRights:true}
 assert.equal((await owner.request('drafts/review',{id:draft.id,revision:1,digest:draft.digest,checks:{...checks,imageRights:false}})).response.status,422)
 assert.equal((await owner.request('drafts/review',{id:draft.id,revision:1,digest:draft.digest,checks})).response.status,200)
 first=(await owner.request('publish',{id:draft.id,revision:1,generation:0})).result.data
 assert.equal(first.generation,1)
})
test('public catalogue exposes only verified release bytes, cache headers and ETag, without a session cookie',async()=>{
 const response=await fetch(server.base+'/api.php?r=catalogue');const result=await response.json()
 assert.equal(response.status,200);assert.equal(response.headers.getSetCookie().length,0)
 assert.match(response.headers.get('cache-control'),/public, max-age=60/)
 assert.equal(result.data.sha256,createHash('sha256').update(result.data.content,'utf8').digest('hex'))
 for(const privateValue of [server.fixture.password,server.fixture.totpSecret,'password_hash','recoveryCodes'])assert.ok(!JSON.stringify(result).includes(privateValue))
 const cached=await fetch(server.base+'/api.php?r=catalogue',{headers:{'If-None-Match':response.headers.get('etag')}})
 assert.equal(cached.status,304);assert.equal(await cached.text(),'')
 assert.equal(response.headers.get('access-control-allow-origin'),null)
})
test('HTTP stale edits, stale publication generations and changed reviews are refused',async()=>{
 const updated=await owner.request('drafts/update',{id:draft.id,revision:1,title:'Teste HTTP',catalogue:catalogue('Segunda história HTTP')});draft=updated.result.data
 assert.equal(draft.revision,2)
 assert.equal((await owner.request('drafts/update',{id:draft.id,revision:1,title:'old',catalogue:catalogue()})).response.status,409)
 assert.equal((await owner.request('publish',{id:draft.id,revision:2,generation:1})).response.status,409)
 await owner.request('drafts/review',{id:draft.id,revision:2,digest:draft.digest,checks:{identity:true,metadataRights:true,imageRights:true}})
 assert.equal((await owner.request('publish',{id:draft.id,revision:2,generation:0})).response.status,409)
 second=(await owner.request('publish',{id:draft.id,revision:2,generation:1})).result.data
 assert.equal(second.generation,2)
})
test('HTTP rollback reactivates immutable release and increments public generation',async()=>{
 const result=await owner.request('rollback',{releaseId:first.releaseId,generation:2})
 assert.equal(result.response.status,200);assert.equal(result.result.data.generation,3);assert.equal(result.result.data.content,first.content)
 assert.equal((await guest.request('catalogue')).result.data.content,first.content)
})
test('HTTP revocation closes every authenticated session and recovery codes cannot be reused',async()=>{
 const other=jar(server.base);await other.request('session')
 const input={username:server.fixture.username,password:server.fixture.password,code:server.fixture.recoveryCodes[1]}
 assert.equal((await other.request('login',input)).response.status,200)
 assert.equal((await owner.request('sessions/revoke',{})).response.status,200)
 assert.equal((await owner.request('dashboard')).response.status,401);assert.equal((await other.request('dashboard')).response.status,401)
 await other.request('session');assert.equal((await other.request('login',input)).response.status,401)
})
test('HTTP invalid payloads and response failures never acquire administrative access',async()=>{
 const anonymous=jar(server.base);await anonymous.request('session')
 const r=await anonymous.request('login',{username:server.fixture.username,password:'invalid',code:'000000',role:'owner'})
 assert.equal(r.response.status,401)
 assert.equal((await anonymous.request('dashboard')).response.status,401)
 const status=await new Promise((resolve,reject)=>{const request=rawRequest(server.base+'/api.php?r=session',{headers:{Host:'attacker.invalid'}},response=>{response.resume();resolve(response.statusCode)});request.once('error',reject);request.end()})
 assert.equal(status,400)
})

test('private CLI checks configuration, refuses repeated installation and requires explicit owner recovery',()=>{
 const command=path.join(server.directory,'bin/admin.php'),php=process.env.SINTONEMA_PHP||'php'
 const env={...process.env,SINTONEMA_PUBLIC_DIR:path.join(root,'public')}
 const check=spawnSync(php,[command,'check'],{env,encoding:'utf8'})
 assert.equal(check.status,0,check.stderr);assert.equal(JSON.parse(check.stdout).ownerConfigured,true)
 const migration=spawnSync(php,[command,'migrate'],{env,encoding:'utf8'})
 assert.equal(migration.status,1);assert.match(migration.stderr,/banco exclusivo vazio/)
 const recovery=spawnSync(php,[command,'recover-owner'],{env,encoding:'utf8',input:JSON.stringify({username:'felipe_teste',password:server.fixture.password,confirm:'wrong'})})
 assert.equal(recovery.status,1);assert.match(recovery.stderr,/Confirmação/);assert.ok(!recovery.stdout.includes('totpSecret'))
 const key=spawnSync(php,[command,'key'],{env,encoding:'utf8'});assert.equal(key.status,0);assert.equal(Buffer.from(key.stdout.trim(),'base64').length,32)
})
