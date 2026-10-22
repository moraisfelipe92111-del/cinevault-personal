import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { personalStorage, personalStorageCoordinator } from './personalStorage.ts'
import { createBrowserPersonalPersistence, type PersonalPersistence } from './personalPersistence.ts'
import { createPersonalStorageBootstrap } from './personalStorageBootstrap.ts'
import { acquirePersonalStorageLock } from './personalStorageLock.ts'
import { createFilesystemPersonalAuthority } from './personalStorageAuthority.ts'

// The display brand can change without changing this private native database.
const DATABASE = 'cinevault_personal'
let bootstrap: ReturnType<typeof createPersonalStorageBootstrap> | null = null

export type OpenPersonalStorage = Readonly<{persistence: PersonalPersistence; close(): Promise<void>}>

export async function openPersonalStorage(): Promise<OpenPersonalStorage> {
  if (!Capacitor.isNativePlatform()) {
    const persistence = createBrowserPersonalPersistence(personalStorage)
    return Object.freeze({persistence, close: () => persistence.close()})
  }
  const lock = await acquirePersonalStorageLock(navigator.locks)
  let closeConnection: (() => Promise<void>) | null = null
  try {
    // Do not load the native SQLite implementation on the browser path.
    const {CapacitorSQLite, SQLiteConnection} = await import('@capacitor-community/sqlite')
    if (!bootstrap) bootstrap = createPersonalStorageBootstrap(personalStorageCoordinator,
      createFilesystemPersonalAuthority(Filesystem, Directory.Data, DATABASE))
    const manager = new SQLiteConnection(CapacitorSQLite)
    const db = await manager.createConnection(DATABASE, false, 'no-encryption', 1, false)
    closeConnection = () => manager.closeConnection(DATABASE, false)
    await db.open()
    const persistence = await bootstrap.open(db)
    let closed = false
    return Object.freeze({persistence, async close() {
      if (closed) return
      await persistence.close()
      await closeConnection!()
      closed = true
      await lock.release()
    }})
  } catch {
    // Never select a legacy fallback after a database read or commit failure.
    try { if (closeConnection) await closeConnection() } catch { /* Keep the sanitized primary opening failure. */ }
    await lock.release()
    throw new Error('Não foi possível abrir seus dados com segurança. Eles não foram substituídos. Confira o espaço disponível e tente novamente.')
  }
}
