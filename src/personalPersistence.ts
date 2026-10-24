import { commitRawBatch, type JsonChange, type JsonStore, type RawStorageChange } from './storageSafety.ts'
import { PERSONAL_STORAGE_KEYS, capturePersonalStorageSnapshot, validatePersonalStorageSnapshot,
  serializePersonalStorageSnapshot, type PersonalStorageSnapshot } from './personalStorageSnapshot.ts'
import type { MigratedPersonalStorage, createPersonalSqliteMigrationRepository } from './personalSqliteMigration.ts'
import { createMediaBackup, validateMediaBackup, serializeMediaBackup, type MediaBackup } from './mediaBackup.ts'
import { emptyMediaProgressSnapshot, validateMediaProgressSnapshot, type MediaProgressSnapshot } from './mediaProgress.ts'
import type { createMediaSqliteRepository, MediaSqliteState } from './mediaSqlite.ts'

export type PersonalReader = Pick<JsonStore, 'getItem'>
type Status = Readonly<{ phase: 'ready' | 'saving' | 'failed' | 'closed'; version: number; pending: number }>
type Operation = (reader: PersonalReader) => readonly JsonChange[]
type MediaOperation = (progress: MediaProgressSnapshot, reader: PersonalReader) => Readonly<{
  changes?: readonly JsonChange[]; progress: MediaProgressSnapshot
}>
type PendingChanges = Readonly<{changes: readonly RawStorageChange[]; progress?: MediaProgressSnapshot}>
export function isCompletePersonalBackup(input: unknown): boolean {
  return input !== null && typeof input === 'object' && !Array.isArray(input) &&
    (input as Record<string, unknown>).format === 'cinevault.personal-storage-snapshot'
}
export function isMediaPersonalBackup(input: unknown): boolean {
  return input !== null && typeof input === 'object' && !Array.isArray(input) &&
    (input as Record<string, unknown>).format === 'sintonema.audiovisual-backup'
}
export type PersonalPersistence = Readonly<{
  kind: 'browser' | 'sqlite'
  mediaEnabled: boolean
  reader: PersonalReader
  getStatus(): Status
  subscribe(listener: () => void): () => void
  update(operation: Operation): Promise<void>
  updateMedia(operation: MediaOperation): Promise<void>
  commitJson(changes: readonly JsonChange[]): Promise<void>
  writeRaw(changes: readonly RawStorageChange[]): Promise<void>
  restoreSnapshot(input: unknown): Promise<void>
  restoreMediaBackup(input: unknown): Promise<void>
  captureSnapshot(): PersonalStorageSnapshot
  captureMediaBackup(): MediaBackup
  getMediaProgress(): MediaProgressSnapshot
  flush(): Promise<void>
  close(): Promise<void>
}>

function checkKey(key: string): void {
  if (!(PERSONAL_STORAGE_KEYS as readonly string[]).includes(key)) throw new Error('Chave de dados pessoais não autorizada.')
}

function rawChanges(input: readonly RawStorageChange[]): readonly RawStorageChange[] {
  if (!Array.isArray(input) || input.length > PERSONAL_STORAGE_KEYS.length) throw new Error('Lote de dados pessoais inválido.')
  const seen = new Set<string>()
  return Object.freeze(Array.from(input, entry => {
    if (!entry || typeof entry !== 'object') throw new Error('Alteração de dados pessoais inválida.')
    const {key, raw} = entry
    checkKey(key)
    if (seen.has(key) || (raw !== null && typeof raw !== 'string')) throw new Error('Alteração de dados pessoais inválida.')
    seen.add(key)
    return Object.freeze({key, raw})
  }))
}

function jsonChanges(input: readonly JsonChange[]): readonly RawStorageChange[] {
  if (!Array.isArray(input)) throw new Error('Lote de dados pessoais inválido.')
  return rawChanges(input.map(({key, value}) => {
    const raw = JSON.stringify(value)
    if (typeof raw !== 'string') throw new Error('Dados pessoais não serializáveis.')
    return {key, raw}
  }))
}

function persistence(kind: PersonalPersistence['kind'], read: (key: string) => string | null,
  commit: (changes: readonly RawStorageChange[], progress?: MediaProgressSnapshot) => Promise<void>,
  readProgress?: () => MediaProgressSnapshot): PersonalPersistence {
  let status: Status = Object.freeze({phase: 'ready', version: 0, pending: 0})
  let tail: Promise<void> = Promise.resolve(), closing = false
  const listeners = new Set<() => void>()
  const publish = (phase: Status['phase'], pending = status.pending, version = status.version) => {
    status = Object.freeze({phase, pending, version})
    for (const listener of listeners) { try { listener() } catch { /* A view cannot invalidate a committed write. */ } }
  }
  const reader: PersonalReader = Object.freeze({getItem(key: string) {
    checkKey(key)
    if (status.phase === 'closed') throw new Error('Esta sessão de dados foi encerrada.')
    return read(key)
  }})
  const assertWritable = () => {
    if (closing || status.phase === 'closed') throw new Error('Esta sessão de dados foi encerrada.')
    if (status.phase === 'failed') throw new Error('O salvamento foi interrompido. Reabra seus dados antes de continuar.')
  }
  const currentProgress = () => {
    if (status.phase === 'closed') throw new Error('Esta sessão de dados foi encerrada.')
    return readProgress ? readProgress() : emptyMediaProgressSnapshot()
  }
  const enqueue = (operation: () => PendingChanges): Promise<void> => {
    try { assertWritable() } catch (error) { return Promise.reject(error) }
    publish('saving', status.pending + 1)
    const job = tail.then(async () => {
      if (status.phase === 'failed') throw new Error('O salvamento foi interrompido. Reabra seus dados antes de continuar.')
      // User transformations run against the last committed state, in order.
      // Their validation errors do not prevent valid edits in other keys.
      const request = operation()
      const changes = rawChanges(request.changes).filter(entry => reader.getItem(entry.key) !== entry.raw)
      const progress = request.progress === undefined ? undefined : validateMediaProgressSnapshot(request.progress)
      if (progress && !readProgress) throw new Error('O progresso audiovisual ainda não está disponível nesta sessão. Mantenha a cópia completa para restaurar em uma versão compatível.')
      if (!changes.length && (progress === undefined || JSON.stringify(progress) === JSON.stringify(currentProgress()))) return
      try { await commit(changes, progress) }
      catch {
        publish('failed')
        throw new Error('Não foi possível confirmar o salvamento. Reabra seus dados para conferir a última gravação.')
      }
      publish('saving', status.pending, status.version + 1)
    }).finally(() => {
      const pending = status.pending - 1
      publish(status.phase === 'failed' ? 'failed' : pending ? 'saving' : 'ready', pending)
    })
    tail = job.catch(() => {})
    return job
  }
  return Object.freeze({kind, reader, mediaEnabled: Boolean(readProgress),
    getStatus: () => status,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    update(operation) { return enqueue(() => ({changes: jsonChanges(operation(reader))})) },
    updateMedia(operation) {
      if (!readProgress) return Promise.reject(new Error('O progresso audiovisual ainda não está disponível nesta sessão.'))
      return enqueue(() => {
        const request = operation(currentProgress(), reader)
        return {changes: jsonChanges(request.changes ?? []), progress: validateMediaProgressSnapshot(request.progress)}
      })
    },
    commitJson(changes) {
      try { const copied = jsonChanges(changes); return enqueue(() => ({changes: copied})) }
      catch (error) { return Promise.reject(error) }
    },
    writeRaw(changes) {
      try { const copied = rawChanges(changes); return enqueue(() => ({changes: copied})) }
      catch (error) { return Promise.reject(error) }
    },
    restoreSnapshot(input) {
      try { const snapshot = validatePersonalStorageSnapshot(input); return enqueue(() => ({changes: snapshot.entries})) }
      catch (error) { return Promise.reject(error) }
    },
    restoreMediaBackup(input) {
      try {
        const backup = validateMediaBackup(input)
        if (!readProgress && backup.progress.entries.length) throw new Error('Esta sessão ainda não pode restaurar progresso audiovisual. O arquivo deve ser mantido para uma versão compatível.')
        return enqueue(() => ({changes: backup.legacy.entries, ...(readProgress ? {progress: backup.progress} : {})}))
      } catch (error) { return Promise.reject(error) }
    },
    captureSnapshot() { return capturePersonalStorageSnapshot(reader) },
    captureMediaBackup() { return createMediaBackup(capturePersonalStorageSnapshot(reader), currentProgress()) },
    getMediaProgress: currentProgress,
    async flush() { await tail; if (status.phase === 'failed') assertWritable() },
    async close() { closing = true; await tail; publish('closed', 0); listeners.clear() },
  })
}

/** Seven native slots share one revision; the six legacy reads retain their exact contract. */
export function createSqliteMediaPersonalPersistence(
  repository: Pick<ReturnType<typeof createMediaSqliteRepository>, 'writeBatch'>, initial: MediaSqliteState,
): PersonalPersistence {
  let current = Object.freeze({...initial, backup: validateMediaBackup(initial.backup)})
  if (current.schemaVersion !== 2 || !Number.isSafeInteger(current.revision) || current.revision < 0 ||
      !Number.isSafeInteger(current.parentRevision) || current.parentRevision < 0 ||
      ![current.sourceSha256, current.originSha256, current.currentSha256].every(hash => /^[a-f0-9]{64}$/.test(hash)))
    throw new Error('Estado audiovisual não confirmado.')
  return persistence('sqlite', key => current.backup.legacy.entries.find(entry => entry.key === key)!.raw,
    async (changes, progress) => {
      const before = current
      const expected = createMediaBackup({...before.backup.legacy, entries: before.backup.legacy.entries.map(entry =>
        changes.find(change => change.key === entry.key) || entry)}, progress ?? before.backup.progress)
      const result = await repository.writeBatch({changes, ...(progress ? {progress} : {})}, before.revision)
      if (result.schemaVersion !== 2 || result.revision !== before.revision + 1 || result.sourceSha256 !== before.sourceSha256 ||
          result.originSha256 !== before.originSha256 || result.parentRevision !== before.parentRevision ||
          !/^[a-f0-9]{64}$/.test(result.currentSha256) || serializeMediaBackup(result.backup) !== serializeMediaBackup(expected))
        throw new Error('Resposta audiovisual não confirmada.')
      current = Object.freeze({...result, backup: validateMediaBackup(result.backup)})
    }, () => current.backup.progress)
}

/** Lazy browser path: retains the shared legacy guard and existing rollback behavior. */
export function createBrowserPersonalPersistence(store: JsonStore): PersonalPersistence {
  return persistence('browser', key => store.getItem(key), async changes => { commitRawBatch(store, changes) })
}

/** Read cache advances only after the repository confirms the durable transaction. */
export function createSqlitePersonalPersistence(
  repository: Pick<ReturnType<typeof createPersonalSqliteMigrationRepository>, 'writeBatch'>,
  initial: MigratedPersonalStorage,
): PersonalPersistence {
  let current = Object.freeze({...initial, snapshot: validatePersonalStorageSnapshot(initial.snapshot)})
  if (current.schemaVersion !== 1 || !Number.isSafeInteger(current.revision) || current.revision < 0 ||
      !/^[a-f0-9]{64}$/.test(current.sourceSha256) || !/^[a-f0-9]{64}$/.test(current.currentSha256))
    throw new Error('Estado pessoal não confirmado.')
  return persistence('sqlite', key => current.snapshot.entries.find(entry => entry.key === key)!.raw, async changes => {
    const before = current
    const expected = validatePersonalStorageSnapshot({...before.snapshot, entries: before.snapshot.entries.map(entry =>
      changes.find(change => change.key === entry.key) || entry)})
    const result = await repository.writeBatch(changes, before.revision)
    if (result.schemaVersion !== 1 || result.sourceSha256 !== before.sourceSha256 || result.revision !== before.revision + 1 ||
        serializePersonalStorageSnapshot(result.snapshot) !== serializePersonalStorageSnapshot(expected))
      throw new Error('Resposta de gravação não confirmada.')
    current = Object.freeze({...result, snapshot: validatePersonalStorageSnapshot(result.snapshot)})
  })
}
