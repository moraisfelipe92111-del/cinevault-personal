import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {LOCAL_RELEASE} from '../src/release.ts'

const approval={status:'approved',protocol:7,checksPerPlatform:40,distinctProcessesPerPlatform:8,
  verifiedInterruptionsPerPlatform:4,finalPersonalRevision:3,finalMediaRevision:3,
  sourceCommit:'a'.repeat(40),runId:'123',pendingDeviceBuildBlocked:false}

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sintonema-device-approval-'))
  t.after(()=>fs.rmSync(root,{recursive:true}))
  const write=(name,text)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)}
  for(const name of ['scripts/prepare-android-device-test.mjs','src/release.ts','package.json','package-lock.json']){
    write(name,fs.readFileSync(new URL('../'+name,import.meta.url),'utf8'))
  }
  write('node_modules/@capacitor-community/sqlite/package.json',JSON.stringify({version:'8.1.1'}))
  const gradle='applicationId "com.cinevault.pessoal"\nversionCode 16\nversionName "1.3.3"\n'
  write('android/app/build.gradle',gradle);write('dist/index.html','<div id="root"></div>')
  write('planning/cv2-audit/media-persistence.json',JSON.stringify({nativeValidation:approval}))
  const run=(extra={})=>spawnSync(process.execPath,['--experimental-strip-types','scripts/prepare-android-device-test.mjs'],{
    cwd:root,encoding:'utf8',env:{...process.env,CI:'true',GITHUB_ACTIONS:'true',RUNNER_TEMP:root,
      GITHUB_ENV:path.join(root,'workflow-env'),GITHUB_SHA:'b'.repeat(40),GITHUB_REF:'refs/heads/cv2-auditoria-00',...extra},
  })
  return {root,write,run,gradle}
}

test('a requested device build cannot reuse old native approval or mutate Gradle while protocol 7 is pending',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sintonema-device-gate-'))
  t.after(()=>fs.rmSync(root,{recursive:true}))
  const write=(name,text)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)}
  for(const name of ['scripts/prepare-android-device-test.mjs','src/release.ts','package.json','package-lock.json']){
    write(name,fs.readFileSync(new URL('../'+name,import.meta.url),'utf8'))
  }
  write('node_modules/@capacitor-community/sqlite/package.json',JSON.stringify({version:'8.1.1'}))
  const gradle='applicationId "com.cinevault.pessoal"\nversionCode 16\nversionName "1.3.3"\n'
  write('android/app/build.gradle',gradle);write('dist/index.html','<div id="root"></div>')
  for(const nativeValidation of [{status:'pending',protocol:7,checksPerPlatform:40},
    {...approval,protocol:6,checksPerPlatform:28}, {...approval,distinctProcessesPerPlatform:5},
    {...approval,verifiedInterruptionsPerPlatform:2}, {...approval,finalMediaRevision:2},
    {...approval,pendingDeviceBuildBlocked:true}, {...approval,sourceCommit:'not-a-commit'},
    {...approval,runId:'0'}]){
    write('planning/cv2-audit/media-persistence.json',JSON.stringify({nativeValidation}))
    const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/prepare-android-device-test.mjs'],{
      cwd:root,encoding:'utf8',env:{...process.env,CI:'true',GITHUB_ACTIONS:'true',RUNNER_TEMP:root,
        GITHUB_ENV:path.join(root,'workflow-env'),GITHUB_SHA:'b'.repeat(40),GITHUB_REF:'refs/heads/cv2-auditoria-00'},
    })
    assert.equal(result.status,1);assert.match(result.stderr,/protocolo 7/)
    assert.equal(fs.readFileSync(path.join(root,'android/app/build.gradle'),'utf8'),gradle)
    assert.equal(fs.existsSync(path.join(root,'workflow-env')),false)
    assert.equal(fs.existsSync(path.join(root,'cinevault-device-build.json')),false)
  }
})

test('approved native provenance configures the higher device build and is preserved in verification metadata',t=>{
  const {root,run}=fixture(t)
  const first=run();assert.equal(first.status,0,first.stderr)
  const gradle=fs.readFileSync(path.join(root,'android/app/build.gradle'),'utf8')
  assert.match(gradle,new RegExp('versionCode '+LOCAL_RELEASE.build+'\\b'))
  assert.ok(gradle.includes('versionName "'+LOCAL_RELEASE.version+'"'))
  const metadata=JSON.parse(fs.readFileSync(path.join(root,'cinevault-device-build.json'),'utf8'))
  assert.deepEqual({version:metadata.version,build:metadata.build,appId:metadata.appId},
    {version:LOCAL_RELEASE.version,build:LOCAL_RELEASE.build,appId:'com.cinevault.pessoal'})
  assert.equal(metadata.validatedIntegrationCommit,approval.sourceCommit);assert.equal(metadata.validatedNativeRun,approval.runId)
  assert.equal(metadata.nativeProtocol,7);assert.equal(metadata.nativeChecksPerPlatform,40);assert.equal(metadata.nativePersonalSchema,2)
  assert.equal(metadata.sourceCommit,'b'.repeat(40));assert.equal(metadata.sourceRef,'refs/heads/cv2-auditoria-00')
  assert.equal(run().status,0)
  assert.equal(fs.readFileSync(path.join(root,'android/app/build.gradle'),'utf8'),gradle)
})

test('even approved storage cannot distribute an injected audit probe or prepare a device build outside CI',t=>{
  const {root,write,run,gradle}=fixture(t)
  write('dist/index.html','<script src="/cv2-native-sqlite-audit.js"></script>')
  const injected=run();assert.equal(injected.status,1);assert.match(injected.stderr,/sonda/)
  write('dist/index.html','<div id="root"></div>')
  write('dist/cv2-native-sqlite-audit.js','synthetic audit only')
  const file=run();assert.equal(file.status,1);assert.match(file.stderr,/sonda/)
  fs.unlinkSync(path.join(root,'dist/cv2-native-sqlite-audit.js'))
  const outside=run({CI:'false'});assert.equal(outside.status,1);assert.match(outside.stderr,/apenas na compilacao CI/)
  assert.equal(fs.readFileSync(path.join(root,'android/app/build.gradle'),'utf8'),gradle)
  assert.equal(fs.existsSync(path.join(root,'workflow-env')),false)
  assert.equal(fs.existsSync(path.join(root,'cinevault-device-build.json')),false)
})
