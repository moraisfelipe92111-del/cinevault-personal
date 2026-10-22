import { commitRawBatch, type JsonChange, type JsonStore, type RawStorageChange } from './storageSafety.ts'
import { PERSONAL_STORAGE_KEYS, capturePersonalStorageSnapshot, validatePersonalStorageSnapshot,
  serializePersonalStorageSnapshot, type PersonalStorageSnapshot } from './personalStorageSnapshot.ts'
import type { MigratedPersonalStorage, createPersonalSqliteMigrationRepository } from './personalSqliteMigration.ts'

export type PersonalReader = Pick<JsonStore, 'getItem'>
type Status = Readonly<{ phase: 'ready' | 'saving' | 'failed' | 'closed'; version: number; pending: number }>
type Operation = (reader: PersonalReader) => readonly JsonChange[]
export function isCompletePersonalBackup(input: unknown): boolean {
  return input !== null && typeof input === 'object' && !Array.isArray(input) &&
    (input as Record<string, unknown>).format === 'cinevault.personal-storage-snapshot'
}
export type PersonalPersistence = Readonly<{
  kind: 'browser' | 'sqlite'
  reader: PersonalReader
  getStatus(): Status
  subscribe(listener: () => void): () => void
  update(operation: Operation): Promise<void>
  commitJson(changes: readonly JsonChange[]): Promise<void>
  writeRaw(changes: readonly RawStorageChange[]): Promise<void>
  restoreSnapshot(input: unknown): Promise<void>
  captureSnapshot(): PersonalStorageSnapshot
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
  commit: (changes: readonly RawStorageChange[]) => Promise<void>): PersonalPersistence {
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
  const enqueue = (operation: () => readonly RawStorageChange[]): Promise<void> => {
    try { assertWritable() } catch (error) { return Promise.reject(error) }
    publish('saving', status.pending + 1)
    const job = tail.then(async () => {
      if (status.phase === 'failed') throw new Error('O salvamento foi interrompido. Reabra seus dados antes de continuar.')
      // User transformations run against the last committed state, in order.
      // Their validation errors do not prevent valid edits in other keys.
      const changes = rawChanges(operation()).filter(entry => reader.getItem(entry.key) !== entry.raw)
      if (!changes.length) return
      try { await commit(changes) }
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
  return Object.freeze({kind, reader,
    getStatus: () => status,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    update(operation) { return enqueue(() => jsonChanges(operation(reader))) },
    commitJson(changes) {
      try { const copied = jsonChanges(changes); return enqueue(() => copied) }
      catch (error) { return Promise.reject(error) }
    },
    writeRaw(changes) {
      try { const copied = rawChanges(changes); return enqueue(() => copied) }
      catch (error) { return Promise.reject(error) }
    },
    restoreSnapshot(input) {
      try { const snapshot = validatePersonalStorageSnapshot(input); return enqueue(() => snapshot.entries) }
      catch (error) { return Promise.reject(error) }
    },
    captureSnapshot() { return capturePersonalStorageSnapshot(reader) },
    async flush() { await tail; if (status.phase === 'failed') assertWritable() },
    async close() { closing = true; await tail; publish('closed', 0); listeners.clear() },
  })
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
