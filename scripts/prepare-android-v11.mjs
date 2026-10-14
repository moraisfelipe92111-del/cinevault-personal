import fs from 'node:fs'
const file='.github/workflows/android-debug-apk.yml'
if(!fs.existsSync(file))throw Error('Workflow do GitHub não encontrado. Execute no repositório de publicação.')
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'))
if(pkg.version!=='1.1.0')throw Error('Sincronize o código 1.1 antes do workflow.')
const s=fs.readFileSync(file,'utf8')
if(!s.includes('CINEVAULT_DEBUG_KEYSTORE_B64')||!s.includes('Assinar e validar APK com chave permanente'))throw Error('Assinatura conhecida ausente; revise manualmente.')
if(!s.includes('versionCode 10')||!s.includes('versionName "1.0.0"')||!s.includes('Aplicar ícones CineVault 1.0'))throw Error('É necessário preparar primeiro workflow 1.0 (build 10).')
const out=s.replaceAll('versionCode 10','versionCode 11').replaceAll('versionCode[[:space:]]+10','versionCode[[:space:]]+11').replaceAll('versionName "1.0.0"','versionName "1.1.0"').replaceAll('versionName[[:space:]]+"1.0.0"','versionName[[:space:]]+"1.1.0"').replace('Definir versao Android 1.0','Definir versao Android 1.1').replace('Aplicar ícones CineVault 1.0','Aplicar ícones CineVault 1.1')
if(out===s||!out.includes('versionCode 11')||!out.includes('versionName "1.1.0"'))throw Error('Não foi possível atualizar versão Android com segurança.')
fs.writeFileSync(file+'.before-v11.bak',s)
fs.writeFileSync(file,out)
console.log('Workflow 1.1/build11 preparado. Confira git diff antes de publicar; a chave e passos de assinatura foram preservados.')
