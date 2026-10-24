import { createPersonalStorageBootstrap } from './personalStorageBootstrap.ts'
import { createPersonalSqliteMigrationRepository } from './personalSqliteMigration.ts'
import { createMediaSqliteRepository } from './mediaSqlite.ts'
import { createMediaBackup, serializeMediaBackup } from './mediaBackup.ts'
import { digestPersonalSqliteText } from './personalSqliteEncoding.ts'
import { createSqliteMediaPersonalPersistence, type PersonalPersistence } from './personalPersistence.ts'
import type { SnapshotSqliteConnection } from './personalSqliteSnapshot.ts'
import type { createPersonalStorageCoordinator } from './personalStorage.ts'
import type { MediaAuthorityStore } from './mediaStorageAuthority.ts'

/** v2 never falls back to v1 after its independent completion receipt exists. */
export function createMediaStorageBootstrap(legacy: ReturnType<typeof createPersonalStorageCoordinator>, authority: MediaAuthorityStore) {
  let busy = false
  let oldBootstrapAttempted = false
  let pause: ReturnType<typeof legacy.pauseWrites> | null = null
  const oldBootstrap = createPersonalStorageBootstrap(legacy, {
    async read() {
      const marker = await authority.read()
      if (marker?.version === 2) throw new Error('O armazenamento audiovisual já foi reservado.')
      return marker
    },
    ensure: source => authority.ensureLegacy(source),
  })
  const closeLegacy = () => {
    if (legacy.phase === 'active') pause = legacy.pauseWrites()
    if (legacy.phase === 'paused') {
      if (!pause) throw new Error('Outra operação pausou os dados pessoais.')
      pause.closeLegacyAccess()
    }
  }
  return Object.freeze({
    async open(db: SnapshotSqliteConnection): Promise<PersonalPersistence> {
      if (busy) throw new Error('A abertura audiovisual já está em andamento.')
      busy = true
      try {
        // Malformed or denied independent receipts stop before touching the DB.
        const marker = await authority.read(), repository = createMediaSqliteRepository(db)
        if (legacy.phase === 'paused' && !pause && !oldBootstrapAttempted) throw new Error('Outra operação pausou os dados pessoais.')
        let state = await repository.read()
        if (state) {
          if (marker?.version !== 2 || marker.sourceSha256 !== state.sourceSha256 || marker.mediaOriginSha256 !== state.originSha256 ||
              marker.mediaParentRevision !== state.parentRevision) throw new Error('O banco audiovisual não corresponde ao seu marcador.')
        } else {
          if (marker?.version === 2 && marker.mediaState === 'complete') throw new Error('O banco audiovisual confirmado não está disponível. A origem antiga não será usada automaticamente.')
          if (marker?.version !== 2) {
            oldBootstrapAttempted = true
            const oldSession = await oldBootstrap.open(db)
            await oldSession.close()
          }
          const parent = await createPersonalSqliteMigrationRepository(db).read()
          if (!parent) throw new Error('A origem confirmada da atualização não está disponível.')
          const origin = await digestPersonalSqliteText(serializeMediaBackup(createMediaBackup(parent.snapshot)))
          await authority.reserve(parent.sourceSha256, origin, parent.revision)
          const prepared = await repository.prepareUpgrade(parent)
          state = await prepared.commit()
        }
        await authority.confirm(state.sourceSha256, state.originSha256, state.parentRevision)
        closeLegacy()
        return createSqliteMediaPersonalPersistence(repository, state)
      } finally { busy = false }
    },
  })
}
