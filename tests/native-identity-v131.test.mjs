import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
function fixture(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cinevault-android-'))
 const res=path.join(temp,'android/app/src/main/res')
 fs.mkdirSync(path.join(res,'values'),{recursive:true})
 fs.mkdirSync(path.join(res,'mipmap-xxxhdpi'),{recursive:true})
 fs.writeFileSync(path.join(res,'mipmap-xxxhdpi/ic_launcher_foreground.png'),'dummy')
 fs.mkdirSync(path.join(temp,'android/app/src/main'),{recursive:true})
 fs.writeFileSync(path.join(temp,'android/app/src/main/AndroidManifest.xml'),'<activity android:theme="@style/AppTheme.NoActionBarLaunch"/>')
 fs.writeFileSync(path.join(res,'values/styles.xml'),`<resources><style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen"><item name="android:background">@drawable/splash</item></style></resources>`)
 return {temp,res}
}
const run=tmp=>execFileSync(process.execPath,[path.join(root,'scripts/configure-native-identity.mjs'),tmp],{stdio:'pipe'})
test('Android adaptive icon background is dark on all Android launcher modes',()=>{
 const {temp,res}=fixture()
 try{
  run(temp)
  const bg=fs.readFileSync(path.join(res,'values/ic_launcher_background.xml'),'utf8')
  assert.match(bg,/#090A0D/)
  for(const f of ['ic_launcher.xml','ic_launcher_round.xml']){
   const content=fs.readFileSync(path.join(res,'mipmap-anydpi-v26',f),'utf8')
   assert.match(content,/@color\/ic_launcher_background/)
   assert.match(content,/@mipmap\/ic_launcher_foreground/)
  }
 } finally {fs.rmSync(temp,{recursive:true,force:true})}
})
test('Android native splash is dark and uses CineVault C+Play, never Capacitor blue/white',()=>{
 const {temp,res}=fixture()
 try{
  run(temp)
  for(const rel of ['values/styles.xml','values-v31/styles.xml']){
   const theme=fs.readFileSync(path.join(res,rel),'utf8')
   assert.match(theme,/cinevault_launch_background/)
   assert.match(theme,/windowSplashScreenAnimatedIcon/)
   assert.match(theme,/ic_launcher_foreground/)
  }
 } finally {fs.rmSync(temp,{recursive:true,force:true})}
})
test('Native identity configuration is idempotent',()=>{
 const {temp,res}=fixture()
 try{
  run(temp)
  const p=path.join(res,'values/styles.xml'),before=fs.readFileSync(p,'utf8')
  run(temp)
  assert.equal(fs.readFileSync(p,'utf8'),before)
 } finally {fs.rmSync(temp,{recursive:true,force:true})}
})
test('Native updater verifies real APK signature and compares installed signer',()=>{
 const java=fs.readFileSync(path.join(root,'assets/android/CineVaultUpdaterPlugin.java'),'utf8')
 const installer=fs.readFileSync(path.join(root,'scripts/install-android-updater.mjs'),'utf8')
 assert.match(java,/ApkVerifier\.Builder/)
 assert.match(java,/verified\.isVerified\(\)/)
 assert.match(java,/getSignerCertificates\(\)/)
 assert.match(java,/cert\.getEncoded\(\)/)
 assert.match(java,/versionCode\(candidate\)<=versionCode\(installed\)/)
 assert.match(java,/sha256\(apk\)/)
 assert.match(installer,/com\.android\.tools\.build:apksig:8\.13\.0/)
})
