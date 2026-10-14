import fs from 'node:fs'
const file='.github/workflows/android-debug-apk.yml'
if(!fs.existsSync(file))throw Error('Rode dentro do repositório de publicação.')
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'))
if(pkg.version!=='1.0.0')throw Error('A versão 1.0 ainda não foi sincronizada aqui.')
let s=fs.readFileSync(file,'utf8')
if(!s.includes('Assinar e validar APK com chave permanente')||!s.includes('CINEVAULT_DEBUG_KEYSTORE_B64'))throw Error('Workflow não contém o esquema de assinatura auditado.')
if(s.includes('Aplicar ícones CineVault 1.0'))throw Error('Ícones já configurados no workflow.')
const anchor='      - name: Restaurar assinatura permanente\n'
if(!s.includes(anchor))throw Error('Etapa de assinatura não encontrada.')
const version='      - name: Definir versao Android 0.7\n'
if(!s.includes(version))throw Error('Versionamento base 0.7 inesperado. Conferir manualmente.')
s=s.replace(anchor, '      - name: Aplicar ícones CineVault 1.0\n        run: node scripts/apply-android-icons.mjs\n'+anchor)
s=s.replace(version,'      - name: Definir versao Android 1.0\n')
s=s.replaceAll('versionCode 7','versionCode 10').replaceAll('versionName "0.7.0"','versionName "1.0.0"')
s=s.replaceAll('versionCode[[:space:]]+7','versionCode[[:space:]]+10').replaceAll('versionName[[:space:]]+"0.7.0"','versionName[[:space:]]+"1.0.0"')
if(!s.includes('versionCode 10')||!s.includes('versionName "1.0.0"'))throw Error('Versão Android não foi atualizada corretamente.')
fs.copyFileSync(file,file+'.before-v10.bak')
fs.writeFileSync(file,s)
console.log('Workflow preparado para APK 1.0 (build 10). Revise git diff; não publique automaticamente.')
