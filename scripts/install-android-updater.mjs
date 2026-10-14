import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root=process.cwd()
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../assets/android')
const android=path.join(root,'android/app/src/main')
const java=path.join(android,'java/com/cinevault/pessoal')
const main=path.join(java,'MainActivity.java')
const manifest=path.join(android,'AndroidManifest.xml')
const xml=path.join(android,'res/xml/cinevault_update_paths.xml')
for (const f of [main,manifest])if(!fs.existsSync(f))throw Error('Projeto Capacitor não encontrado: '+f)
const cap=fs.readFileSync(path.join(root,'capacitor.config.ts'),'utf8')
if(!cap.includes("appId: 'com.cinevault.pessoal'"))throw Error('AppId não reconhecido. Pare e revise.')
let a=fs.readFileSync(main,'utf8')
if(!a.includes('CineVaultUpdaterPlugin.class')){
 if(!a.includes('extends BridgeActivity'))throw Error('MainActivity diferente do esperado.')
 a=a.replace(/public class MainActivity extends BridgeActivity\s*\{\s*\}/,`public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(CineVaultUpdaterPlugin.class);
    super.onCreate(savedInstanceState);
  }
}`)
 if(!a.includes('CineVaultUpdaterPlugin.class'))throw Error('Não foi possível registrar o plugin nativo.')
 fs.writeFileSync(main,a)
}
fs.copyFileSync(path.join(source,'CineVaultUpdaterPlugin.java'),path.join(java,'CineVaultUpdaterPlugin.java'))
fs.mkdirSync(path.dirname(xml),{recursive:true})
fs.copyFileSync(path.join(source,'cinevault_update_paths.xml'),xml)
let m=fs.readFileSync(manifest,'utf8')
if(!m.includes('android.permission.REQUEST_INSTALL_PACKAGES')){
 m=m.replace(/<application\b/,`<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n    <application`)
}
if(!m.includes('cinevault-updater')){
 const provider=`<provider android:name="androidx.core.content.FileProvider"
    android:authorities="\${applicationId}.cinevault-updater"
    android:exported="false"
    android:grantUriPermissions="true">
    <meta-data android:name="android.support.FILE_PROVIDER_PATHS"
      android:resource="@xml/cinevault_update_paths" />
  </provider>`
 m=m.replace('</application>',`${provider}\n</application>`)
}
if(!m.includes('cinevault_update_paths'))throw Error('FileProvider não configurado.')
fs.writeFileSync(manifest,m)
console.log('Updater Android: plugin Java, FileProvider e permissão sideload preparados.')

// CineVault: verify cryptographic APK signer before requesting system installation.
const gradle=path.join(root,'android/app/build.gradle')
if(!fs.existsSync(gradle))throw Error('Gradle nao localizado: '+gradle)
let gradleText=fs.readFileSync(gradle,'utf8')
const apksig='implementation "com.android.tools.build:apksig:8.13.0"'
if(!gradleText.includes(apksig)){
 fs.appendFileSync(gradle,'\n// CineVault authenticated sideload updater\ndependencies { '+apksig+' }\n')
}
