import { createPersonalSqliteMigrationRepository } from './personalSqliteMigration.ts'
import { createSqlitePersonalPersistence, type PersonalPersistence } from './personalPersistence.ts'
import type { createPersonalStorageCoordinator } from './personalStorage.ts'
import type { SnapshotSqliteConnection } from './personalSqliteSnapshot.ts'
import type { PersonalAuthorityStore } from './personalStorageAuthority.ts'

/** No I/O until open(). The platform owns the cross-context lock and connection. */
export function createPersonalStorageBootstrap(legacy: ReturnType<typeof createPersonalStorageCoordinator>, authority: PersonalAuthorityStore) {
  let pause: ReturnType<typeof legacy.pauseWrites> | null = null
  let busy = false
  return Object.freeze({
    async open(db: SnapshotSqliteConnection): Promise<PersonalPersistence> {
      if (busy) throw new Error('A abertura dos dados pessoais já está em andamento.')
      busy = true
      try {
        if (legacy.phase === 'active') pause = legacy.pauseWrites()
        else if (legacy.phase === 'paused' && !pause) throw new Error('Outra operação pausou os dados pessoais.')
        const marker = await authority.read()
        const repository = createPersonalSqliteMigrationRepository(db)
        let state = await repository.read()
        if (state === null) {
          if (marker) throw new Error('O banco confirmado não está disponível. A cópia anterior não será usada automaticamente.')
          if (!pause || legacy.phase !== 'paused') throw new Error('A origem da migração não está disponível.')
          const snapshot = pause.captureSnapshot()
          const prepared = await repository.prepare(snapshot)
          state = await prepared.commit(() => pause!.assertUnchanged(snapshot))
        }
        if (marker && marker.sourceSha256 !== state.sourceSha256) throw new Error('O banco não corresponde ao marcador do armazenamento.')
        await authority.ensure(state.sourceSha256)
        const session = createSqlitePersonalPersistence(repository, state)
        if (legacy.phase === 'paused') pause!.closeLegacyAccess()
        return session
      } finally { busy = false }
    },
  })
}
