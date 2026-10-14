/** Configure Android launcher and OS splash from the same CineVault C+Play brand assets.
 * Invoked after `npx cap add android` and after apply-android-icons.mjs.
 * Fail-closed against unexpected Capacitor templates.
 */
import fs from 'node:fs'
import path from 'node:path'

const root=path.resolve(process.argv[2]||'.')
const res=path.join(root,'android/app/src/main/res')
const manifest=path.join(root,'android/app/src/main/AndroidManifest.xml')
const styles=path.join(res,'values/styles.xml')
const foreground=path.join(res,'mipmap-xxxhdpi/ic_launcher_foreground.png')
const BG='#090A0D'
for(const f of [manifest,styles,foreground]){
 if(!fs.existsSync(f))throw Error('Projeto Android incompleto: '+f)
}
if(!fs.readFileSync(manifest,'utf8').includes('@style/AppTheme.NoActionBarLaunch')){
 throw Error('AndroidManifest sem tema de inicializacao esperado.')
}
function write(rel,content){
 const f=path.join(res,rel)
 fs.mkdirSync(path.dirname(f),{recursive:true})
 fs.writeFileSync(f,content)
}
const color='<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">'+BG+'</color>\n</resources>\n'
const nativeColors='<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="cinevault_launch_background">'+BG+'</color>\n</resources>\n'
write('values/ic_launcher_background.xml',color)
write('values/cinevault_native_colors.xml',nativeColors)
const adaptive='<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background" />\n    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n</adaptive-icon>\n'
write('mipmap-anydpi-v26/ic_launcher.xml',adaptive)
write('mipmap-anydpi-v26/ic_launcher_round.xml',adaptive)
let xml=fs.readFileSync(styles,'utf8')
const matcher=/<style\s+name="AppTheme\.NoActionBarLaunch"\s+parent="[^"]+"\s*>[\s\S]*?<\/style>/g
const found=[...xml.matchAll(matcher)]
if(found.length!==1 || !found[0][0].includes('Theme.SplashScreen')){
 throw Error('Tema de splash diferente do template Capacitor 8; revise antes de alterar.')
}
const launchTheme=`<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@color/cinevault_launch_background</item>
        <item name="windowSplashScreenBackground">@color/cinevault_launch_background</item>
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>`
xml=xml.replace(matcher,launchTheme)
fs.writeFileSync(styles,xml)
// Explicit Android 12+ platform attributes. Avoid a white pre-WebView window.
const v31=path.join(res,'values-v31/styles.xml')
if(fs.existsSync(v31)){
 const existing=fs.readFileSync(v31,'utf8')
 if(!existing.includes('cinevault_launch_background'))throw Error('Tema v31 inesperado, preservado: '+v31)
}
write('values-v31/styles.xml',`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:windowSplashScreenBackground">@color/cinevault_launch_background</item>
        <item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
        <item name="android:background">@color/cinevault_launch_background</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>
</resources>
`)
for(const rel of ['values/ic_launcher_background.xml','values/cinevault_native_colors.xml','values/styles.xml','values-v31/styles.xml','mipmap-anydpi-v26/ic_launcher.xml','mipmap-anydpi-v26/ic_launcher_round.xml']){
 const content=fs.readFileSync(path.join(res,rel),'utf8')
 if(!content.includes('cinevault_launch_background')&&!content.includes('ic_launcher_background'))throw Error('XML incorreto: '+rel)
}
console.log('CineVault Android: icone adaptativo preto/dourado e splash escura configurados.')
