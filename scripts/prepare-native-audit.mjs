import fs from 'node:fs'
import { LOCAL_RELEASE } from '../src/release.ts'

const platform = process.argv[2]
const appId = 'com.cinevault.pessoal'
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const pkg = read('package.json')
const sqlite = read('node_modules/@capacitor-community/sqlite/package.json')
const core = read('node_modules/@capacitor/core/package.json')
const envFile = process.env.GITHUB_ENV

if (!['android', 'ios'].includes(platform) || !envFile)
  throw Error('Este script deve executar na compilacao nativa do GitHub Actions.')

if (
  pkg.version !== LOCAL_RELEASE.version ||
  !/^\d+\.\d+\.\d+$/.test(LOCAL_RELEASE.version) ||
  !Number.isSafeInteger(LOCAL_RELEASE.build) ||
  LOCAL_RELEASE.build <= 0
) throw Error('Versao ou build inconsistente.')

if (sqlite.version !== '8.1.1' || core.version !== '8.5.2')
  throw Error('Versoes nativas diferentes das avaliadas.')

const native = read('node_modules/@capacitor/' + platform + '/package.json')
if (native.version !== core.version)
  throw Error('Plataforma e nucleo Capacitor divergentes.')

if (platform === 'android') {
  const file = 'android/app/build.gradle'
  let content = fs.readFileSync(file, 'utf8')
  if (!/\bapplicationId\s+["']com\.cinevault\.pessoal["']/.test(content))
    throw Error('Identificador Android divergente.')
  const code = /\bversionCode\s+\d+/g
  const name = /\bversionName\s+"[^"]+"/g
  if ((content.match(code) || []).length !== 1 || (content.match(name) || []).length !== 1)
    throw Error('Configuracao de versao Android inesperada.')
  content = content
    .replace(code, 'versionCode ' + LOCAL_RELEASE.build)
    .replace(name, 'versionName "' + LOCAL_RELEASE.version + '"')
  fs.writeFileSync(file, content)
} else {
  const project = fs.readFileSync('ios/App/App.xcodeproj/project.pbxproj', 'utf8')
  if (!/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?com\.cinevault\.pessoal"?;/.test(project))
    throw Error('Identificador iOS divergente.')
}

fs.appendFileSync(envFile,
  'CV_AUDIT_VERSION=' + LOCAL_RELEASE.version + '\n' +
  'CV_AUDIT_BUILD=' + LOCAL_RELEASE.build + '\n'
)
console.log(JSON.stringify({
  platform, appId, release: LOCAL_RELEASE,
  capacitor: core.version, sqlite: sqlite.version,
  scope: 'native_compilation_only'
}, null, 2))
