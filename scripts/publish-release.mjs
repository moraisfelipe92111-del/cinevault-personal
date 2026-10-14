/** Publish latest.json only *after* an APK has been independently verified and published. */
import fs from 'node:fs'
import {createHash} from 'node:crypto'
const [apkPath, version, buildString]=process.argv.slice(2)
if(!apkPath||!/^\d+\.\d+\.\d+$/.test(version||'')||!/^\d+$/.test(buildString||''))throw Error('Uso: node scripts/publish-release.mjs <APK> 1.2.0 12')
const build=Number(buildString)
if(!Number.isSafeInteger(build)||build<=0)throw Error('VersionCode inválido')
const bytes=fs.readFileSync(apkPath)
if(bytes.length<100000)throw Error('APK muito pequeno.')
const sha256=createHash('sha256').update(bytes).digest('hex')
const url=`https://github.com/moraisfelipe92111-del/cinevault-personal/releases/download/v${version}/CineVault-${version}.apk`
const obj={version,build,title:`CineVault ${version} disponível`,notes:['Atualização segura pelo próprio aplicativo','Correções e melhorias da experiência'],url,sha256,required:false}
fs.mkdirSync('releases',{recursive:true})
fs.writeFileSync('releases/latest.json',JSON.stringify(obj,null,2)+'\n')
console.log('Manifesto gerado. SHA-256:',sha256)
console.log('ATENÇÃO: somente envie latest.json ao GitHub DEPOIS de publicar o APK na release correspondente e verificar seu certificado.')
