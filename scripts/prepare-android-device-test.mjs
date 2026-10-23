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
if (pkg.version !== LOCAL_RELEASE.version || lock.version !== pkg.version ||
    lock.packages[''].version !== pkg.version ||
    !/^\d+\.\d+\.\d+$/.test(LOCAL_RELEASE.version) ||
    !Number.isSafeInteger(LOCAL_RELEASE.build) || LOCAL_RELEASE.build <= 15 ||
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
  validatedIntegrationCommit: '0811feb82724a06614b151b7fbf9f252e4a82fb5',
  validatedNativeRun: '39796669086',
  nativeProtocol: 6, nativeChecksPerPlatform: 28,
}
fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'cinevault-device-build.json'), JSON.stringify(metadata, null, 2) + '\n')
fs.appendFileSync(process.env.GITHUB_ENV,
  'CV_DEVICE_VERSION=' + metadata.version + '\nCV_DEVICE_BUILD=' + metadata.build + '\n')
console.log(JSON.stringify(metadata, null, 2))
