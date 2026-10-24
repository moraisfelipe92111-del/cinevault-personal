/** Configure the real app for an update-compatible device-test APK. */
import fs from 'node:fs'
import path from 'node:path'
import { LOCAL_RELEASE } from '../src/release.ts'

if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' ||
    !process.env.GITHUB_ENV || !process.env.RUNNER_TEMP ||
    !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') ||
    !['refs/heads/main', 'refs/heads/cv2-auditoria-00'].includes(process.env.GITHUB_REF)) {
  throw Error('Preparacao permitida apenas na compilacao CI do aplicativo de teste.')
}

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const pkg = read('package.json')
const lock = read('package-lock.json')
const sqlite = read('node_modules/@capacitor-community/sqlite/package.json')
const nativeValidation = read('planning/cv2-audit/media-persistence.json').nativeValidation
if (nativeValidation?.status !== 'approved' || nativeValidation.protocol !== 7 || nativeValidation.checksPerPlatform !== 40 ||
    nativeValidation.distinctProcessesPerPlatform !== 8 || nativeValidation.verifiedInterruptionsPerPlatform !== 4 ||
    nativeValidation.finalPersonalRevision !== 3 || nativeValidation.finalMediaRevision !== 3 ||
    nativeValidation.pendingDeviceBuildBlocked !== false ||
    !/^[a-f0-9]{40}$/.test(nativeValidation.sourceCommit || '') || !/^[1-9][0-9]*$/.test(String(nativeValidation.runId || ''))) {
  throw Error('A nova persistencia precisa da aprovacao nativa do protocolo 7 antes de gerar um APK de teste.')
}
if (pkg.version !== LOCAL_RELEASE.version || lock.version !== pkg.version ||
    lock.packages[''].version !== pkg.version ||
    !/^\d+\.\d+\.\d+$/.test(LOCAL_RELEASE.version) ||
    !Number.isSafeInteger(LOCAL_RELEASE.build) || LOCAL_RELEASE.build <= 16 ||
    sqlite.version !== '8.1.1') throw Error('Versoes do aplicativo ou SQLite divergentes.')

const appId = 'com.cinevault.pessoal'
const file = 'android/app/build.gradle'
const gradle = fs.readFileSync(file, 'utf8')
if (!/\bapplicationId\s+["']com\.cinevault\.pessoal["']/.test(gradle) ||
    (gradle.match(/\bversionCode\s+\d+/g) || []).length !== 1 ||
    (gradle.match(/\bversionName\s+"[^"]+"/g) || []).length !== 1) {
  throw Error('Configuracao Android inesperada; pacote preservado.')
}
const html = fs.readFileSync('dist/index.html', 'utf8')
if (html.includes('cv2-native-sqlite-audit') || fs.existsSync('dist/cv2-native-sqlite-audit.js')) {
  throw Error('O APK de uso real nao pode conter a sonda de auditoria.')
}
fs.writeFileSync(file, gradle
  .replace(/\bversionCode\s+\d+/, 'versionCode ' + LOCAL_RELEASE.build)
  .replace(/\bversionName\s+"[^"]+"/, 'versionName "' + LOCAL_RELEASE.version + '"'))
const metadata = {
  schemaVersion: 1, purpose: 'android_device_test', appId,
  version: LOCAL_RELEASE.version, build: LOCAL_RELEASE.build,
  sqlitePlugin: sqlite.version, sourceCommit: process.env.GITHUB_SHA,
  sourceRef: process.env.GITHUB_REF,
  validatedIntegrationCommit: nativeValidation.sourceCommit,
  validatedNativeRun: String(nativeValidation.runId),
  nativePersonalSchema: 2,
  nativeProtocol: nativeValidation.protocol, nativeChecksPerPlatform: nativeValidation.checksPerPlatform,
}
fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'cinevault-device-build.json'), JSON.stringify(metadata, null, 2) + '\n')
fs.appendFileSync(process.env.GITHUB_ENV,
  'CV_DEVICE_VERSION=' + metadata.version + '\nCV_DEVICE_BUILD=' + metadata.build + '\n')
console.log(JSON.stringify(metadata, null, 2))
