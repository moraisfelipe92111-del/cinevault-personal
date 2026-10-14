import fs from 'node:fs'
import path from 'node:path'
// Run only after `npx cap add android` and `npx cap sync android`.
const project=path.resolve(process.argv[2]||'.')
const native=path.join(project,'android/app/src/main/res')
const assets=path.join(project,'assets/android')
if(!fs.existsSync(native))throw Error('Android platform not generated; call npx cap add android first.')
let count=0
for(const density of ['mdpi','hdpi','xhdpi','xxhdpi','xxxhdpi']){
  const folder='mipmap-'+density
  for(const filename of ['ic_launcher.png','ic_launcher_round.png','ic_launcher_foreground.png','ic_launcher_background.png']){
    const origin=path.join(assets,folder,filename)
    if(!fs.existsSync(origin))throw Error('Android icon asset missing: '+origin)
    const dest=path.join(native,folder,filename)
    fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(origin,dest);count++
  }
}
console.log('Android launcher assets synced:',count)
