// Bundled and injected into generated dist/ only by the dedicated CI preparation.
import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { runNativeSqliteAudit } from './native-sqlite-audit.mjs'

const context = { ...__CV_SQLITE_AUDIT_CONTEXT__, platform: Capacitor.getPlatform() }
const marker = 'cv2-native-sqlite-marker.json'
const result = 'cv2-native-sqlite-result.json'
const options = { directory: Directory.Cache, encoding: Encoding.UTF8 }
const write = (path, data) => Filesystem.writeFile({ ...options, path, data: JSON.stringify(data) })

async function run() {
  if (!Capacitor.isNativePlatform()) throw Error('Native audit requires Android or iOS')
  const listing = await Filesystem.readdir({ directory: Directory.Cache, path: '' })
  let previous = null
  if (listing.files.some(file => file.name === marker)) {
    const file = await Filesystem.readFile({ ...options, path: marker })
    previous = JSON.parse(file.data)
  }
  const report = await runNativeSqliteAudit({
    sqlite: new SQLiteConnection(CapacitorSQLite), previous, ...context,
  })
  if (report.status === 'ready_for_restart' || report.status === 'ready_for_interruption') await write(marker, report)
  await write(result, report)
  console.log('CINEVAULT_SQLITE_AUDIT ' + JSON.stringify(report))
}

run().catch(async error => {
  const report = { schemaVersion: 2, ...context, status: 'failed', message: String(error?.message ?? error) }
  console.error('CINEVAULT_SQLITE_AUDIT ' + JSON.stringify(report))
  try { await write(result, report) } catch (writeError) { console.error(String(writeError)) }
})
