import { createPersonalSqliteMigrationRepository, type MigratedPersonalStorage } from './personalSqliteMigration.ts'
import type { SnapshotSqliteConnection } from './personalSqliteSnapshot.ts'
import { PERSONAL_STORAGE_KEYS, validatePersonalStorageSnapshot, serializePersonalStorageSnapshot } from './personalStorageSnapshot.ts'
import { createMediaBackup, serializeMediaBackup, type MediaBackup } from './mediaBackup.ts'
import { validateMediaProgressSnapshot, type MediaProgressSnapshot } from './mediaProgress.ts'
import { splitPersonalSqliteText, digestPersonalSqliteText, SQLITE_TEXT_CHUNK_UNITS as CHUNK_UNITS,
  MAX_PERSONAL_SQLITE_UNITS as MAX_UNITS, MAX_PERSONAL_SQLITE_CHUNKS as MAX_CHUNKS } from './personalSqliteEncoding.ts'
import type { RawStorageChange } from './storageSafety.ts'

const RECEIPT = 'cv_media_revision', VALUES = 'cv_media_value', CHUNKS = 'cv_media_value_chunk'
const SLOT_KEYS = [...PERSONAL_STORAGE_KEYS, 'sintonema.media-progress.v1'] as const
const SCHEMAS = [
  [RECEIPT, `CREATE TABLE ${RECEIPT} (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 2), state TEXT NOT NULL CHECK (state = 'complete'), source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64), origin_sha256 TEXT NOT NULL CHECK (length(origin_sha256) = 64), parent_revision INTEGER NOT NULL CHECK (parent_revision >= 0), current_sha256 TEXT NOT NULL CHECK (length(current_sha256) = 64), revision INTEGER NOT NULL CHECK (revision >= 0), entry_count INTEGER NOT NULL CHECK (entry_count = 7))`],
  [VALUES, `CREATE TABLE ${VALUES} (slot INTEGER PRIMARY KEY CHECK (slot >= 0 AND slot < 7), value_key TEXT NOT NULL, chunk_count INTEGER NOT NULL CHECK (chunk_count > 0), utf16_length INTEGER NOT NULL CHECK (utf16_length > 0), sha256 TEXT NOT NULL CHECK (length(sha256) = 64))`],
  [CHUNKS, `CREATE TABLE ${CHUNKS} (slot INTEGER NOT NULL CHECK (slot >= 0 AND slot < 7), ordinal INTEGER NOT NULL CHECK (ordinal >= 0), payload TEXT NOT NULL, PRIMARY KEY (slot, ordinal)) WITHOUT ROWID`],
] as const
export type MediaSqliteState = Readonly<{
  schemaVersion: 2; revision: number; sourceSha256: string; originSha256: string
  parentRevision: number; currentSha256: string; backup: MediaBackup
}>
export type MediaSqliteBatch = Readonly<{changes: readonly RawStorageChange[]; progress?: MediaProgressSnapshot}>
class MediaSqliteError extends Error {
  constructor(message: string) { super('Media SQLite: ' + message) }
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MediaSqliteError(message)
}
function row(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid database row')
  return value as Record<string, unknown>
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const rawSlots = (backup: MediaBackup) => [...backup.legacy.entries.map(entry => entry.raw), JSON.stringify(backup.progress)]

/** No I/O until called. The v1 tables become the immutable, verified upgrade origin. */
export function createMediaSqliteRepository(db: SnapshotSqliteConnection) {
  const legacy = createPersonalSqliteMigrationRepository(db)
  let busy = false, failed = false, seen = false
  let owner: object | null = null
  async function exclusive<T>(operation: () => Promise<T>, ticket: object | null = null): Promise<T> {
    requireValue(!busy, 'another operation is in progress')
    requireValue(!failed, 'close and reopen the connection before retrying')
    requireValue(owner === ticket, 'another prepared operation owns the connection')
    busy = true
    try { return await operation() } finally { busy = false }
  }
  async function rows(sql: string, values: (string | number)[] = []): Promise<unknown[]> {
    const result = await db.query(sql, values)
    requireValue(Array.isArray(result?.values), 'database query did not return rows')
    return result.values
  }
  async function abort(error: unknown, rollback?: () => Promise<unknown>): Promise<never> {
    failed = true; owner = null
    if (rollback) { try { await rollback() } catch { /* Preserve the primary error; reopening is mandatory. */ } }
    if (error instanceof MediaSqliteError) throw error
    throw new MediaSqliteError('storage operation failed; close and reopen before retrying')
  }
  const rollbackOwned = async () => {
    if ((await db.isTransactionActive()).result === true) await db.rollbackTransaction()
  }
  async function transaction<T>(operation: () => Promise<T>): Promise<T> {
    let owned = false
    try {
      requireValue((await db.isTransactionActive()).result === false, 'another transaction is active')
      await db.beginTransaction(); owned = true
      requireValue((await db.isTransactionActive()).result === true, 'transaction did not begin')
      const result = await operation()
      await db.commitTransaction()
      requireValue((await db.isTransactionActive()).result === false, 'transaction did not commit')
      owned = false
      return result
    } catch (error) { return abort(error, owned ? rollbackOwned : undefined) }
  }
  async function schemaExists(): Promise<boolean> {
    const counts = []
    for (const [name, sql] of SCHEMAS) {
      const objects = await rows('SELECT type, name, sql FROM main.sqlite_master WHERE tbl_name = ? ORDER BY type, name', [name])
      counts.push(objects.length)
      if (objects.length) {
        const object = row(objects[0])
        requireValue(objects.length === 1 && object.type === 'table' && object.name === name && object.sql === sql,
          'unexpected schema or related object; replacement refused')
      }
    }
    if (counts.every(count => count === 0)) return false
    requireValue(counts.every(count => count === 1), 'incomplete schema; repair refused')
    return true
  }
  async function readReceipt() {
    const found = await rows(`SELECT id, schema_version, state, source_sha256, origin_sha256, parent_revision, current_sha256, revision, entry_count FROM main.${RECEIPT}`)
    requireValue(found.length === 1, 'missing or repeated completion marker')
    const item = row(found[0])
    requireValue(item.id === 1 && item.schema_version === 2 && item.state === 'complete' && item.entry_count === 7 &&
      hash(item.source_sha256) && hash(item.origin_sha256) && hash(item.current_sha256) &&
      revision(item.parent_revision) && revision(item.revision), 'invalid completion marker')
    requireValue(item.revision !== 0 || item.current_sha256 === item.origin_sha256, 'initial revision differs from the origin')
    return Object.freeze({schemaVersion: 2 as const, sourceSha256: item.source_sha256, originSha256: item.origin_sha256,
      parentRevision: item.parent_revision, currentSha256: item.current_sha256, revision: item.revision})
  }
  async function readValues(): Promise<MediaBackup> {
    const headers = await rows(`SELECT slot, value_key, chunk_count, utf16_length, sha256 FROM main.${VALUES} ORDER BY slot`)
    const totals = await rows(`SELECT COUNT(*) AS total FROM main.${CHUNKS}`)
    requireValue(headers.length === 7 && totals.length === 1, 'missing value headers or chunk count')
    const values: (string | null)[] = []
    let allChunks = 0, units = 0
    for (let slot = 0; slot < 7; slot++) {
      const header = row(headers[slot]), count = header.chunk_count, length = header.utf16_length
      requireValue(header.slot === slot && header.value_key === SLOT_KEYS[slot] && hash(header.sha256) &&
        typeof count === 'number' && Number.isSafeInteger(count) && count > 0 && count <= MAX_CHUNKS &&
        typeof length === 'number' && Number.isSafeInteger(length) && length > 0 && length <= MAX_UNITS &&
        count >= Math.ceil(length / CHUNK_UNITS) && count <= Math.ceil(length / (CHUNK_UNITS - 1)), 'invalid value header')
      units += length; allChunks += count
      requireValue(units <= MAX_UNITS, 'values exceed the supported size')
      const chunks = []
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const found = await rows(`SELECT slot, ordinal, payload FROM main.${CHUNKS} WHERE slot = ? AND ordinal = ?`, [slot, ordinal])
        requireValue(found.length === 1, 'missing value chunk')
        const chunk = row(found[0])
        requireValue(chunk.slot === slot && chunk.ordinal === ordinal && typeof chunk.payload === 'string' &&
          chunk.payload.length > 0 && chunk.payload.length <= CHUNK_UNITS, 'invalid value chunk')
        chunks.push(chunk.payload)
      }
      const text = chunks.join('')
      requireValue(text.length === length && await digestPersonalSqliteText(text) === header.sha256, 'value integrity mismatch')
      let raw: unknown
      try { raw = JSON.parse(text) } catch { throw new MediaSqliteError('invalid value encoding') }
      requireValue((raw === null || typeof raw === 'string') && JSON.stringify(raw) === text, 'noncanonical value encoding')
      values.push(raw as string | null)
    }
    requireValue(row(totals[0]).total === allChunks && typeof values[6] === 'string', 'missing or extra chunks or progress')
    let progress: unknown
    try { progress = JSON.parse(values[6]) } catch { throw new MediaSqliteError('invalid progress encoding') }
    const backup = createMediaBackup({format: 'cinevault.personal-storage-snapshot', version: 1,
      entries: PERSONAL_STORAGE_KEYS.map((key, slot) => ({key, raw: values[slot]}))}, progress)
    requireValue(JSON.stringify(backup.progress) === values[6], 'noncanonical progress encoding')
    return backup
  }
  async function readInside(): Promise<MediaSqliteState | null> {
    if (!await schemaExists()) return null
    const receipt = await readReceipt(), backup = await readValues()
    requireValue(await digestPersonalSqliteText(serializeMediaBackup(backup)) === receipt.currentSha256, 'state integrity mismatch')
    return Object.freeze({...receipt, backup})
  }
  async function verifyParent(state: MediaSqliteState): Promise<void> {
    const original = await legacy.read()
    requireValue(original !== null && original.sourceSha256 === state.sourceSha256 && original.revision === state.parentRevision &&
      await digestPersonalSqliteText(serializeMediaBackup(createMediaBackup(original.snapshot))) === state.originSha256,
      'frozen legacy origin is missing or changed')
  }
  async function committedRead(): Promise<MediaSqliteState | null> {
    const state = await transaction(readInside)
    requireValue(!seen || state !== null, 'authoritative state disappeared')
    if (state) { await verifyParent(state); seen = true }
    return state
  }
  async function encode(backup: MediaBackup) {
    serializeMediaBackup(backup)
    let units = 0
    const encoded = []
    for (const raw of rawSlots(backup)) {
      const text = JSON.stringify(raw)
      units += text.length
      requireValue(units <= MAX_UNITS, 'values exceed the supported size')
      encoded.push({text, chunks: splitPersonalSqliteText(text), hash: await digestPersonalSqliteText(text)})
    }
    return encoded
  }
  async function insertChunks(slot: number, chunks: readonly string[]) {
    for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
      await db.run(`INSERT INTO main.${CHUNKS} (slot, ordinal, payload) VALUES (?, ?, ?)`, [slot, ordinal, chunks[ordinal]], false)
    }
  }
  const same = (state: MediaSqliteState | null, expected: MediaSqliteState): state is MediaSqliteState =>
    state !== null && state.schemaVersion === 2 && state.revision === expected.revision && state.sourceSha256 === expected.sourceSha256 &&
    state.originSha256 === expected.originSha256 && state.parentRevision === expected.parentRevision && state.currentSha256 === expected.currentSha256 &&
    serializeMediaBackup(state.backup) === serializeMediaBackup(expected.backup)

  const repository = Object.freeze({
    read(): Promise<MediaSqliteState | null> {
      return exclusive(async () => { try { return await committedRead() } catch (error) { return abort(error) } })
    },
    prepareUpgrade(input: MigratedPersonalStorage) {
      return exclusive(async () => {
        const snapshot = validatePersonalStorageSnapshot(input?.snapshot)
        requireValue(input.schemaVersion === 1 && revision(input.revision) && hash(input.sourceSha256) && hash(input.currentSha256), 'invalid upgrade origin')
        const origin = Object.freeze({...input, snapshot}), backup = createMediaBackup(snapshot)
        const encoded = await encode(backup), originHash = await digestPersonalSqliteText(serializeMediaBackup(backup))
        const expected: MediaSqliteState = Object.freeze({schemaVersion: 2, revision: 0, sourceSha256: origin.sourceSha256,
          originSha256: originHash, parentRevision: origin.revision, currentSha256: originHash, backup})
        let rollback: (() => Promise<void>) | undefined
        try {
          requireValue(!seen && await transaction(readInside) === null, 'already authoritative; second upgrade refused')
          const before = await legacy.read()
          requireValue(before !== null && before.revision === origin.revision && before.sourceSha256 === origin.sourceSha256 &&
            before.currentSha256 === origin.currentSha256 && serializePersonalStorageSnapshot(before.snapshot) === serializePersonalStorageSnapshot(snapshot), 'upgrade origin changed')
          // Borrow the v1 no-op lease: it validates the exact source in the same
          // transaction and owns both rollback and commit of the new v2 tables.
          const lease = await legacy.prepareWrite([snapshot.entries[0]], origin.revision)
          rollback = () => lease.rollback()
          requireValue(lease.changedKeys.length === 0 && lease.currentSha256 === origin.currentSha256 && lease.revision === origin.revision, 'upgrade did not retain its origin')
          requireValue(!await schemaExists(), 'upgrade target already exists')
          for (const [name, sql] of SCHEMAS) await db.execute(sql.replace(`CREATE TABLE ${name}`, `CREATE TABLE main.${name}`), false)
          for (let slot = 0; slot < encoded.length; slot++) {
            const value = encoded[slot]
            await db.run(`INSERT INTO main.${VALUES} (slot, value_key, chunk_count, utf16_length, sha256) VALUES (?, ?, ?, ?, ?)`,
              [slot, SLOT_KEYS[slot], value.chunks.length, value.text.length, value.hash], false)
            await insertChunks(slot, value.chunks)
          }
          await db.run(`INSERT INTO main.${RECEIPT} (id, schema_version, state, source_sha256, origin_sha256, parent_revision, current_sha256, revision, entry_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [1, 2, 'complete', expected.sourceSha256, originHash, origin.revision, originHash, 0, 7], false)
          requireValue(same(await readInside(), expected) && (await db.isTransactionActive()).result === true, 'incomplete prepared upgrade')
          const ticket = Object.freeze({}); owner = ticket
          return Object.freeze({originSha256: originHash, parentRevision: origin.revision, revision: 0,
            commit(): Promise<MediaSqliteState> {
              return exclusive(async () => {
                try {
                  requireValue((await db.isTransactionActive()).result === true && same(await readInside(), expected), 'prepared upgrade changed')
                  await lease.commit(); rollback = undefined; owner = null
                  const committed = await committedRead()
                  requireValue(same(committed, expected), 'upgrade commit read-back mismatch')
                  return committed
                } catch (error) { return abort(error, rollback) }
              }, ticket)
            },
            rollback(): Promise<void> {
              return exclusive(async () => {
                try {
                  await lease.rollback(); rollback = undefined; owner = null
                  requireValue((await db.isTransactionActive()).result === false, 'upgrade did not roll back')
                } catch (error) { return abort(error, rollback) }
              }, ticket)
            },
          })
        } catch (error) { return abort(error, rollback) }
      })
    },
    prepareWrite(input: MediaSqliteBatch, expectedRevision: number) {
      return exclusive(async () => {
        requireValue(revision(expectedRevision), 'invalid expected revision')
        const request = row(input)
        requireValue(Object.keys(request).every(key => key === 'changes' || key === 'progress') &&
          Array.isArray(request.changes) && request.changes.length <= 6, 'invalid batch')
        const keys = new Set<string>()
        const changes = Array.from(request.changes, value => {
          const item = row(value), key = item.key, raw = item.raw
          requireValue(Object.keys(item).length === 2 && Object.hasOwn(item, 'key') && Object.hasOwn(item, 'raw') &&
            typeof key === 'string' && (PERSONAL_STORAGE_KEYS as readonly string[]).includes(key) && !keys.has(key) &&
            (raw === null || typeof raw === 'string'), 'invalid or repeated key')
          keys.add(key); splitPersonalSqliteText(JSON.stringify(raw))
          return Object.freeze({key, raw: raw as string | null})
        })
        const progress = request.progress === undefined ? undefined : validateMediaProgressSnapshot(request.progress)
        if (progress) splitPersonalSqliteText(JSON.stringify(progress))
        let owned = false
        try {
          // Verify the frozen v1 origin before opening the new prepared transaction.
          const parent = await legacy.read()
          requireValue(parent !== null, 'frozen legacy origin missing')
          const originHash = await digestPersonalSqliteText(serializeMediaBackup(createMediaBackup(parent.snapshot)))
          requireValue((await db.isTransactionActive()).result === false, 'another transaction is active')
          await db.beginTransaction(); owned = true
          requireValue((await db.isTransactionActive()).result === true, 'write transaction did not begin')
          const before = await readInside()
          requireValue(before !== null && before.sourceSha256 === parent.sourceSha256 && before.parentRevision === parent.revision &&
            before.originSha256 === originHash, 'origin or authoritative state missing or changed')
          requireValue(before.revision === expectedRevision, 'stale media revision')
          const snapshot = validatePersonalStorageSnapshot({...before.backup.legacy, entries: before.backup.legacy.entries.map(entry =>
            changes.find(change => change.key === entry.key) || entry)})
          const backup = createMediaBackup(snapshot, progress ?? before.backup.progress), encoded = await encode(backup)
          const oldSlots = rawSlots(before.backup), nextSlots = rawSlots(backup)
          const slots = nextSlots.flatMap((raw, slot) => raw === oldSlots[slot] ? [] : [slot])
          requireValue(slots.length === 0 || expectedRevision < Number.MAX_SAFE_INTEGER, 'revision would overflow')
          const nextRevision = expectedRevision + (slots.length ? 1 : 0)
          const currentHash = await digestPersonalSqliteText(serializeMediaBackup(backup))
          for (const slot of slots) {
            const value = encoded[slot]
            await db.run(`DELETE FROM main.${CHUNKS} WHERE slot = ?`, [slot], false)
            await db.run(`UPDATE main.${VALUES} SET chunk_count = ?, utf16_length = ?, sha256 = ? WHERE slot = ? AND value_key = ?`,
              [value.chunks.length, value.text.length, value.hash, slot, SLOT_KEYS[slot]], false)
            await insertChunks(slot, value.chunks)
          }
          if (slots.length) {
            await db.run(`UPDATE main.${RECEIPT} SET current_sha256 = ?, revision = ? WHERE id = ? AND revision = ? AND current_sha256 = ? AND origin_sha256 = ?`,
              [currentHash, nextRevision, 1, expectedRevision, before.currentSha256, before.originSha256], false)
          }
          const expected: MediaSqliteState = Object.freeze({...before, backup, currentSha256: currentHash, revision: nextRevision})
          requireValue(same(await readInside(), expected) && (await db.isTransactionActive()).result === true, 'prepared write read-back mismatch')
          const ticket = Object.freeze({}); owner = ticket
          return Object.freeze({baseRevision: expectedRevision, revision: nextRevision, currentSha256: currentHash, changedSlots: Object.freeze(slots),
            commit(): Promise<MediaSqliteState> {
              return exclusive(async () => {
                try {
                  requireValue((await db.isTransactionActive()).result === true && same(await readInside(), expected), 'prepared write changed')
                  await db.commitTransaction()
                  requireValue((await db.isTransactionActive()).result === false, 'write did not commit')
                  owned = false; owner = null
                  const committed = await committedRead()
                  requireValue(same(committed, expected), 'write commit read-back mismatch')
                  return committed
                } catch (error) { return abort(error, owned ? rollbackOwned : undefined) }
              }, ticket)
            },
            rollback(): Promise<void> {
              return exclusive(async () => {
                try {
                  requireValue((await db.isTransactionActive()).result === true, 'prepared write is no longer active')
                  await db.rollbackTransaction()
                  requireValue((await db.isTransactionActive()).result === false, 'write did not roll back')
                  owned = false; owner = null
                } catch (error) { return abort(error, owned ? rollbackOwned : undefined) }
              }, ticket)
            },
          })
        } catch (error) { return abort(error, owned ? rollbackOwned : undefined) }
      })
    },
    async writeBatch(input: MediaSqliteBatch, expectedRevision: number): Promise<MediaSqliteState> {
      const prepared = await repository.prepareWrite(input, expectedRevision)
      return prepared.commit()
    },
  })
  return repository
}
