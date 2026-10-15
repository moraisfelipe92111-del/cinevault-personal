import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,statSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join,dirname} from 'node:path'
import {playBrandAudio,stopBrandAudio,SONIC_FILES} from '../src/sonic.ts'
import {LOCAL_RELEASE,parseRelease,newerThanInstalled} from '../src/release.ts'
const base=join(dirname(fileURLToPath(import.meta.url)),'..')
const valid={version:'1.4.0',build:16,title:'Nova versão',notes:['Novidades'],url:'https://github.com/moraisfelipe92111-del/cinevault-personal/releases/download/v1.4.0/CineVault-1.4.0.apk',sha256:'a'.repeat(64),required:false}
test('Signature 1.3.2 increments Android build to 15',()=>{assert.equal(LOCAL_RELEASE.build,15);assert.equal(LOCAL_RELEASE.version,'1.3.2')})
test('offers only valid new official signed APKs',()=>{assert.equal(newerThanInstalled(parseRelease(valid)),true);assert.equal(newerThanInstalled(parseRelease({...valid,build:12})),false)})
test('two original sounds remain intact',()=>{for(const filename of Object.values(SONIC_FILES)){const buf=readFileSync(join(base,'public',filename));assert.ok(buf.length>30000);assert.ok(buf[0]===0x49||buf[0]===0xff)}})
test('audio preview gracefully degrades on browserless runtime',async()=>{assert.equal(await playBrandAudio('cinema',.65),false);stopBrandAudio()})
test('launcher icon retains 512px resolution',()=>{const png=readFileSync(join(base,'public/icon-512.png'));assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),512);assert.equal(png.readUInt32BE(20),512)})
test('PWA retains signature audio assets in precache',()=>{const js=readFileSync(join(base,'scripts/build-sw.mjs'),'utf8');assert.match(js,/\/audio\/cinevault-signature.mp3/);assert.match(js,/\/audio\/cinevault-aura.mp3/)})
test('native installer validates SHA-256, package name, signature and monotonically increasing build',()=>{const java=readFileSync(join(base,'assets/android/CineVaultUpdaterPlugin.java'),'utf8');for(const pattern of [/sha256\(apk\)/,/getPackageArchiveInfo/,/getPackageName\(\)/,/ApkVerifier/,/versionCode\(candidate\)<=versionCode\(installed\)/,/FileProvider\.getUriForFile/,/canRequestPackageInstalls/])assert.match(java,pattern)})
test('manifest updater installer requires user permission and FileProvider',()=>{const js=readFileSync(join(base,'scripts/install-android-updater.mjs'),'utf8');assert.match(js,/REQUEST_INSTALL_PACKAGES/);assert.match(js,/FileProvider/);assert.match(js,/MainActivity/);assert.match(js,/registerPlugin/)})

test('v1.3.2 rejeita atualizacao com mesmo build 15',()=>{
  assert.equal(
    newerThanInstalled(parseRelease({...valid,build:15})),
    false
  )
})
