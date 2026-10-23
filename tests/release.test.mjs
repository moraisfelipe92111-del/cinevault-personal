import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRelease, newerThanInstalled, LOCAL_RELEASE, fetchLatestRelease } from '../src/release.ts'
const GOOD={version:'1.3.0',build:13,title:'Novidades no CineVault',notes:['Nova experiência'],required:false,sha256:'a'.repeat(64),url:'https://github.com/moraisfelipe92111-del/cinevault-personal/releases/download/v1.3.0/CineVault-1.3.0.apk'}
const fakeFetch=content=>async()=>({ok:true,text:async()=>JSON.stringify(content)})
test('v1.3.3 uses monotonic build16',()=>{assert.equal(LOCAL_RELEASE.build,16);assert.equal(LOCAL_RELEASE.version,'1.3.3')})
test('official version with hash is accepted',()=>assert.equal(parseRelease(GOOD)?.sha256,'a'.repeat(64)))
test('same or older build is not an update',()=>{assert.equal(newerThanInstalled(parseRelease({...GOOD,build:12})),false);assert.equal(newerThanInstalled(parseRelease({...GOOD,build:13}),13),false)})
test('blocks untrusted domains',()=>assert.equal(parseRelease({...GOOD,url:'https://attacker.example/CineVault.apk'}),null))
test('blocks lookalike github domains',()=>assert.equal(parseRelease({...GOOD,url:GOOD.url.replace('github.com/','github.com.attacker/') }),null))
test('blocks other repositories',()=>assert.equal(parseRelease({...GOOD,url:GOOD.url.replace('cinevault-personal','another-app')}),null))
test('blocks mismatched version tags',()=>assert.equal(parseRelease({...GOOD,url:GOOD.url.replace('v1.3.0/','v1.2.0/')}),null))
test('blocks release page instead of APK',()=>assert.equal(parseRelease({...GOOD,url:'https://github.com/moraisfelipe92111-del/cinevault-personal/releases/tag/v1.3.0'}),null))
test('blocks absent or invalid sha256',()=>{assert.equal(parseRelease({...GOOD,sha256:''}),null);assert.equal(parseRelease({...GOOD,sha256:'z'.repeat(64)}),null)})
test('blocks appended query parameters',()=>assert.equal(parseRelease({...GOOD,url:GOOD.url+'?foo=bar'}),null))
test('blocks unsafe release notes',()=>assert.equal(parseRelease({...GOOD,notes:['x'.repeat(201)]}),null))
test('blocks invalid version',()=>assert.equal(parseRelease({...GOOD,version:'broken'}),null))
test('network outage never blocks app',async()=>assert.equal(await fetchLatestRelease(async()=>{throw new Error('offline')}),null))
test('no update while installed build is newer',async()=>assert.equal(await fetchLatestRelease(fakeFetch({...GOOD,build:12}),12),null))
test('available update is offered',async()=>assert.equal((await fetchLatestRelease(fakeFetch(GOOD),12))?.build,13))
test('manifest size is capped',async()=>assert.equal(await fetchLatestRelease(async()=>({ok:true,text:async()=>('X'.repeat(8300))})),null))
