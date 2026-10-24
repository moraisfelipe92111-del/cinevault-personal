import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'

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
    {status:'approved',protocol:6,checksPerPlatform:28,sourceCommit:'a'.repeat(40),runId:'123'}]){
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
