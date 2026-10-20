import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { auditIdentity } from './native-sqlite-audit.mjs'

export function injectNativeAudit(html) {
  if ((html.match(/<\/head>/g) || []).length !== 1 || html.includes('cv2-native-sqlite-audit.js'))
    throw Error('Unexpected HTML or audit already injected')
  return html.replace('</head>', '<script type="module" src="/cv2-native-sqlite-audit.js"></script>\n</head>')
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP)
    throw Error('Native audit injection is restricted to GitHub Actions')
  const context = {runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT}
  auditIdentity({...context, platform: 'android'})
  const htmlPath = 'dist/index.html'
  const html = injectNativeAudit(fs.readFileSync(htmlPath, 'utf8'))
  const bundlePath = 'dist/cv2-native-sqlite-audit.js'
  if (fs.existsSync(bundlePath)) throw Error('Audit bundle already exists')
  const { build } = await import('vite')
  const result = await build({
    configFile: false, publicDir: false, logLevel: 'warn',
    define: {__CV_SQLITE_AUDIT_CONTEXT__: JSON.stringify(context)},
    build: {
      write: false, minify: false,
      lib: {
        entry: path.resolve('scripts/native-sqlite-audit-entry.mjs'),
        name: 'CineVaultNativeSqliteAudit', formats: ['iife'],
        fileName: () => 'cv2-native-sqlite-audit.js',
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output)
  if (outputs.length !== 1 || outputs[0].type !== 'chunk')
    throw Error('Audit requires a single self-contained JavaScript bundle')
  fs.writeFileSync(bundlePath, outputs[0].code, {flag: 'wx'})
  fs.writeFileSync(htmlPath, html)
  console.log('SQLite audit injected into generated dist; source application preserved.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
