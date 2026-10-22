import {
  PERSONAL_STORAGE_KEYS, validatePersonalStorageSnapshot, serializePersonalStorageSnapshot,
  type PersonalStorageSnapshot,
} from './personalStorageSnapshot.ts'
import { createPersonalSqliteSnapshotRepository, type SnapshotSqliteConnection } from './personalSqliteSnapshot.ts'
import {
  SQLITE_TEXT_CHUNK_UNITS as CHUNK_UNITS, MAX_PERSONAL_SQLITE_UNITS as MAX_UNITS,
  MAX_PERSONAL_SQLITE_CHUNKS as MAX_CHUNKS,
  splitPersonalSqliteText, digestPersonalSqliteText,
} from './personalSqliteEncoding.ts'

// Preparation only. The caller owns the entire open native connection and all
// source-writer locks. No constructor selects a DB or touches browser storage.
const RECEIPT = 'cv_personal_migration'
const VALUES = 'cv_personal_value'
const CHUNKS = 'cv_personal_value_chunk'
const SCHEMAS = [
  [RECEIPT, `CREATE TABLE ${RECEIPT} (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 1), state TEXT NOT NULL CHECK (state = 'complete'), source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64), current_sha256 TEXT NOT NULL CHECK (length(current_sha256) = 64), revision INTEGER NOT NULL CHECK (revision >= 0), entry_count INTEGER NOT NULL CHECK (entry_count = 6))`],
  [VALUES, `CREATE TABLE ${VALUES} (slot INTEGER PRIMARY KEY CHECK (slot >= 0 AND slot < 6), value_key TEXT NOT NULL, chunk_count INTEGER NOT NULL CHECK (chunk_count > 0), utf16_length INTEGER NOT NULL CHECK (utf16_length > 0), sha256 TEXT NOT NULL CHECK (length(sha256) = 64))`],
  [CHUNKS, `CREATE TABLE ${CHUNKS} (slot INTEGER NOT NULL CHECK (slot >= 0 AND slot < 6), ordinal INTEGER NOT NULL CHECK (ordinal >= 0), payload TEXT NOT NULL, PRIMARY KEY (slot, ordinal)) WITHOUT ROWID`],
] as const

export type MigratedPersonalStorage = Readonly<{
  schemaVersion: 1
  revision: number
  sourceSha256: string
  currentSha256: string
  snapshot: PersonalStorageSnapshot
}>

export type PersonalSqliteChange = Readonly<{
  key: typeof PERSONAL_STORAGE_KEYS[number]
  raw: string | null
}>

class MigrationError extends Error {
  constructor(message: string) { super('Personal SQLite migration: ' + message) }
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MigrationError(message)
}

function row(input: unknown): Record<string, unknown> {
  requireValue(input !== null && typeof input === 'object' && !Array.isArray(input), 'invalid database row')
  return input as Record<string, unknown>
}

function isHash(input: unknown): input is string {
  return typeof input === 'string' && /^[a-f0-9]{64}$/.test(input)
}

export function createPersonalSqliteMigrationRepository(db: SnapshotSqliteConnection) {
  let busy = false
  let failed = false
  let owner: object | null = null

  async function exclusive<T>(operation: () => Promise<T>, ticket: object | null = null): Promise<T> {
    requireValue(!busy, 'another migration operation is in progress')
    requireValue(!failed, 'close and reopen the connection before retrying')
    requireValue(owner === ticket, 'another prepared migration owns the connection')
    busy = true
    try { return await operation() } finally { busy = false }
  }

  async function rows(sql: string, values: (string | number)[] = []): Promise<unknown[]> {
    const result = await db.query(sql, values)
    requireValue(Array.isArray(result?.values), 'database query did not return rows')
    return result.values
  }

  async function schemaExists(): Promise<boolean> {
    const counts: number[] = []
    for (const [name, sql] of SCHEMAS) {
      const objects = await rows('SELECT type, name, sql FROM main.sqlite_master WHERE tbl_name = ? ORDER BY type, name', [name])
      counts.push(objects.length)
      if (objects.length) {
        const object = row(objects[0])
        requireValue(objects.length === 1 && object.type === 'table' && object.name === name && object.sql === sql,
          'unexpected migration schema or related object')
      }
    }
    if (counts.every(count => count === 0)) return false
    requireValue(counts.every(count => count === 1), 'incomplete migration schema; refusing repair or replacement')
    return true
  }

  async function readValues(): Promise<PersonalStorageSnapshot> {
    const headers = await rows(`SELECT slot, value_key, chunk_count, utf16_length, sha256 FROM main.${VALUES} ORDER BY slot`)
    requireValue(headers.length === PERSONAL_STORAGE_KEYS.length, 'missing or extra personal value headers')
    const totals = await rows(`SELECT COUNT(*) AS total FROM main.${CHUNKS}`)
    requireValue(totals.length === 1, 'missing personal chunk count')
    const entries = []
    let allChunks = 0, totalUnits = 0
    for (let slot = 0; slot < PERSONAL_STORAGE_KEYS.length; slot++) {
      const header = row(headers[slot]), key = PERSONAL_STORAGE_KEYS[slot]
      const count = header.chunk_count, length = header.utf16_length, hash = header.sha256
      requireValue(header.slot === slot && header.value_key === key &&
        typeof count === 'number' && Number.isSafeInteger(count) && count > 0 && count <= MAX_CHUNKS &&
        typeof length === 'number' && Number.isSafeInteger(length) && length > 0 && length <= MAX_UNITS &&
        count >= Math.ceil(length / CHUNK_UNITS) && count <= Math.ceil(length / (CHUNK_UNITS - 1)) &&
        isHash(hash), 'invalid personal value header')
      allChunks += count
      totalUnits += length
      requireValue(totalUnits <= MAX_UNITS, 'personal values exceed the supported size')
      const chunks: string[] = []
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const found = await rows(`SELECT slot, ordinal, payload FROM main.${CHUNKS} WHERE slot = ? AND ordinal = ?`, [slot, ordinal])
        requireValue(found.length === 1, 'personal chunk sequence is incomplete')
        const chunk = row(found[0])
        requireValue(chunk.slot === slot && chunk.ordinal === ordinal && typeof chunk.payload === 'string' &&
          chunk.payload.length > 0 && chunk.payload.length <= CHUNK_UNITS, 'invalid personal value chunk')
        chunks.push(chunk.payload)
      }
      const serialized = chunks.join('')
      requireValue(serialized.length === length && await digestPersonalSqliteText(serialized) === hash, 'personal value integrity mismatch')
      let raw: unknown
      try { raw = JSON.parse(serialized) } catch { throw new MigrationError('invalid personal value encoding') }
      requireValue((raw === null || typeof raw === 'string') && JSON.stringify(raw) === serialized, 'unsupported personal value encoding')
      entries.push({key, raw})
    }
    requireValue(row(totals[0]).total === allChunks, 'missing or extra personal value chunks')
    return validatePersonalStorageSnapshot({format: 'cinevault.personal-storage-snapshot', version: 1, entries})
  }

  async function readReceipt() {
    const found = await rows(`SELECT id, schema_version, state, source_sha256, current_sha256, revision, entry_count FROM main.${RECEIPT}`)
    requireValue(found.length === 1, 'missing or repeated migration completion marker')
    const receipt = row(found[0])
    const source = receipt.source_sha256, current = receipt.current_sha256, revision = receipt.revision
    requireValue(receipt.id === 1 && receipt.schema_version === 1 && receipt.state === 'complete' &&
      receipt.entry_count === PERSONAL_STORAGE_KEYS.length && isHash(source) && isHash(current) &&
      typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0, 'invalid migration completion marker')
    requireValue(revision !== 0 || source === current, 'initial revision does not match the preserved source')
    return Object.freeze({schemaVersion: 1 as const, revision, sourceSha256: source, currentSha256: current})
  }

  async function readInside(): Promise<MigratedPersonalStorage | null> {
    if (!await schemaExists()) return null
    const receipt = await readReceipt()
    const snapshot = await readValues()
    requireValue(await digestPersonalSqliteText(serializePersonalStorageSnapshot(snapshot)) === receipt.currentSha256, 'committed personal state digest mismatch')
    return Object.freeze({...receipt, snapshot})
  }

  async function abort(error: unknown, owned: boolean): Promise<never> {
    failed = true
    owner = null
    if (owned) {
      try { if ((await db.isTransactionActive()).result === true) await db.rollbackTransaction() } catch { /* Preserve primary failure. */ }
    }
    if (error instanceof MigrationError) throw error
    throw new MigrationError('storage operation failed; close and reopen before retrying')
  }

  async function transaction<T>(operation: () => Promise<T>): Promise<T> {
    let owned = false
    try {
      requireValue((await db.isTransactionActive()).result === false, 'another transaction is already active')
      await db.beginTransaction()
      owned = true
      requireValue((await db.isTransactionActive()).result === true, 'transaction did not begin')
      const result = await operation()
      await db.commitTransaction()
      requireValue((await db.isTransactionActive()).result === false, 'transaction did not commit')
      owned = false
      return result
    } catch (error) { return abort(error, owned) }
  }

  async function verifyOriginal(state: MigratedPersonalStorage): Promise<void> {
    const original = await createPersonalSqliteSnapshotRepository(db).read()
    requireValue(original !== null && await digestPersonalSqliteText(serializePersonalStorageSnapshot(original)) === state.sourceSha256,
      'preserved original does not match the migration marker')
  }

  function validateChanges(input: unknown, expectedRevision: number): readonly PersonalSqliteChange[] {
    requireValue(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'invalid expected revision')
    requireValue(Array.isArray(input) && input.length > 0 && input.length <= PERSONAL_STORAGE_KEYS.length, 'invalid write batch')
    const seen = new Set<string>()
    let totalUnits = 0
    const copied = Array.from(input, value => {
      const entry = row(value)
      const requested = entry.key, raw = entry.raw
      const key = PERSONAL_STORAGE_KEYS.find(candidate => candidate === requested)
      requireValue(Object.keys(entry).length === 2 && Object.hasOwn(entry, 'key') && Object.hasOwn(entry, 'raw') && key !== undefined &&
        !seen.has(key) && (raw === null || typeof raw === 'string'), 'invalid or repeated personal write key')
      seen.add(key)
      const text = JSON.stringify(raw)
      totalUnits += text.length
      requireValue(totalUnits <= MAX_UNITS, 'write batch exceeds the supported size')
      splitPersonalSqliteText(text)
      return Object.freeze({key, raw})
    })
    return Object.freeze(copied)
  }

  function prepareWrite(input: unknown, expectedRevision: number) {
    return exclusive(async () => {
      // Copy every caller-owned value synchronously, before hashing or native I/O.
      const changes = validateChanges(input, expectedRevision)
      const encoded = []
      for (const entry of changes) {
        const text = JSON.stringify(entry.raw)
        encoded.push({...entry, text, chunks: splitPersonalSqliteText(text), hash: await digestPersonalSqliteText(text)})
      }
      let owned = false
      try {
        // This separate read never joins or ends another owner's transaction.
        const original = await createPersonalSqliteSnapshotRepository(db).read()
        requireValue(original !== null, 'preserved original is missing; refusing personal writes')
        const sourceHash = await digestPersonalSqliteText(serializePersonalStorageSnapshot(original))
        requireValue((await db.isTransactionActive()).result === false, 'another transaction is already active')
        await db.beginTransaction()
        owned = true
        requireValue((await db.isTransactionActive()).result === true, 'write transaction did not begin')
        const before = await readInside()
        requireValue(before !== null, 'migration is not complete; refusing personal writes')
        requireValue(before.sourceSha256 === sourceHash, 'preserved original does not match the migration marker')
        requireValue(before.revision === expectedRevision, 'stale personal revision; read the committed database before retrying')
        const changed = encoded.filter(entry => before.snapshot.entries[PERSONAL_STORAGE_KEYS.indexOf(entry.key)].raw !== entry.raw)
        const snapshot = validatePersonalStorageSnapshot({...before.snapshot, entries: before.snapshot.entries.map(entry => {
          const update = changed.find(value => value.key === entry.key)
          return update ? {key: entry.key, raw: update.raw} : entry
        })})
        const serialized = serializePersonalStorageSnapshot(snapshot)
        splitPersonalSqliteText(serialized)
        const currentHash = await digestPersonalSqliteText(serialized)
        requireValue(changed.length === 0 || expectedRevision < Number.MAX_SAFE_INTEGER, 'personal revision would overflow')
        const revision = expectedRevision + (changed.length ? 1 : 0)
        for (const value of changed) {
          const slot = PERSONAL_STORAGE_KEYS.indexOf(value.key)
          await db.run(`DELETE FROM main.${CHUNKS} WHERE slot = ?`, [slot], false)
          await db.run(`UPDATE main.${VALUES} SET chunk_count = ?, utf16_length = ?, sha256 = ? WHERE slot = ? AND value_key = ?`,
            [value.chunks.length, value.text.length, value.hash, slot, value.key], false)
          for (let ordinal = 0; ordinal < value.chunks.length; ordinal++) {
            await db.run(`INSERT INTO main.${CHUNKS} (slot, ordinal, payload) VALUES (?, ?, ?)`, [slot, ordinal, value.chunks[ordinal]], false)
          }
        }
        if (changed.length) {
          requireValue(serializePersonalStorageSnapshot(await readValues()) === serialized, 'personal write read-back mismatch')
          // Compare-and-swap is checked by reading the receipt, not by assuming
          // a particular plugin-specific affected-row response shape.
          await db.run(`UPDATE main.${RECEIPT} SET current_sha256 = ?, revision = ? WHERE id = ? AND revision = ? AND current_sha256 = ? AND source_sha256 = ?`,
            [currentHash, revision, 1, expectedRevision, before.currentSha256, sourceHash], false)
        }
        const matches = (state: MigratedPersonalStorage | null): state is MigratedPersonalStorage =>
          state !== null && state.sourceSha256 === sourceHash && state.currentSha256 === currentHash && state.revision === revision
        const pending = await readReceipt()
        requireValue(pending.sourceSha256 === sourceHash && pending.currentSha256 === currentHash && pending.revision === revision,
          'personal revision update was not applied')
        requireValue((await db.isTransactionActive()).result === true, 'prepared write lost its transaction')
        const ticket = Object.freeze({})
        owner = ticket
        return Object.freeze({
          baseRevision: expectedRevision, revision, currentSha256: currentHash,
          changedKeys: Object.freeze(changed.map(entry => entry.key)),
          commit(): Promise<MigratedPersonalStorage> {
            return exclusive(async () => {
              try {
                requireValue((await db.isTransactionActive()).result === true, 'prepared write is no longer active')
                requireValue(matches(await readInside()), 'prepared personal write changed before commit')
                await db.commitTransaction()
                requireValue((await db.isTransactionActive()).result === false, 'personal write transaction did not commit')
                owned = false
                owner = null
                const committed = await transaction(readInside)
                requireValue(matches(committed), 'committed personal write read-back mismatch')
                await verifyOriginal(committed)
                return committed
              } catch (error) { return abort(error, owned) }
            }, ticket)
          },
          rollback(): Promise<void> {
            return exclusive(async () => {
              try {
                requireValue((await db.isTransactionActive()).result === true, 'prepared write is no longer active')
                await db.rollbackTransaction()
                requireValue((await db.isTransactionActive()).result === false, 'prepared personal write did not roll back')
                owned = false
                owner = null
              } catch (error) { return abort(error, owned) }
            }, ticket)
          },
        })
      } catch (error) { return abort(error, owned) }
    })
  }

  return Object.freeze({
    prepareWrite,
    async writeBatch(input: unknown, expectedRevision: number): Promise<MigratedPersonalStorage> {
      const prepared = await prepareWrite(input, expectedRevision)
      return prepared.commit()
    },
    read(): Promise<MigratedPersonalStorage | null> {
      return exclusive(async () => {
        try {
          const state = await transaction(readInside)
          if (state) await verifyOriginal(state)
          return state
        } catch (error) { return abort(error, false) }
      })
    },
    prepare(input: unknown) {
      return exclusive(async () => {
        // Own the validated copy before yielding. Do not parse any raw JSON value.
        const snapshot = validatePersonalStorageSnapshot(input)
        const serialized = serializePersonalStorageSnapshot(snapshot)
        splitPersonalSqliteText(serialized)
        const sourceHash = await digestPersonalSqliteText(serialized)
        const encoded = []
        for (const entry of snapshot.entries) {
          const text = JSON.stringify(entry.raw)
          encoded.push({key: entry.key, text, chunks: splitPersonalSqliteText(text), hash: await digestPersonalSqliteText(text)})
        }
        let owned = false
        try {
          const existing = await transaction(readInside)
          requireValue(existing === null, 'database is already authoritative; refusing a second migration')
          // The durable original is committed separately before creating any target rows.
          const originals = createPersonalSqliteSnapshotRepository(db)
          const original = await originals.read()
          if (original === null) await originals.preserve(snapshot)
          else requireValue(serializePersonalStorageSnapshot(original) === serialized, 'preserved original differs; replacement refused')
          requireValue((await db.isTransactionActive()).result === false, 'another transaction is already active')
          await db.beginTransaction()
          owned = true
          requireValue((await db.isTransactionActive()).result === true, 'migration transaction did not begin')
          for (const [name, sql] of SCHEMAS) await db.execute(sql.replace(`CREATE TABLE ${name}`, `CREATE TABLE main.${name}`), false)
          for (let slot = 0; slot < encoded.length; slot++) {
            const value = encoded[slot]
            await db.run(`INSERT INTO main.${VALUES} (slot, value_key, chunk_count, utf16_length, sha256) VALUES (?, ?, ?, ?, ?)`,
              [slot, value.key, value.chunks.length, value.text.length, value.hash], false)
            for (let ordinal = 0; ordinal < value.chunks.length; ordinal++) {
              await db.run(`INSERT INTO main.${CHUNKS} (slot, ordinal, payload) VALUES (?, ?, ?)`, [slot, ordinal, value.chunks[ordinal]], false)
            }
          }
          requireValue(serializePersonalStorageSnapshot(await readValues()) === serialized, 'target values differ from the preserved original')
          await db.run(`INSERT INTO main.${RECEIPT} (id, schema_version, state, source_sha256, current_sha256, revision, entry_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [1, 1, 'complete', sourceHash, sourceHash, 0, PERSONAL_STORAGE_KEYS.length], false)
          const pending = await readReceipt()
          requireValue(pending?.sourceSha256 === sourceHash && pending.currentSha256 === sourceHash && pending.revision === 0,
            'uncommitted migration marker or values are incomplete')
          requireValue((await db.isTransactionActive()).result === true, 'prepared migration lost its transaction')
          const ticket = Object.freeze({})
          owner = ticket
          return Object.freeze({
            schemaVersion: 1 as const, sourceSha256: sourceHash, entryCount: PERSONAL_STORAGE_KEYS.length,
            commit(assertSourceUnchanged: () => unknown): Promise<MigratedPersonalStorage> {
              return exclusive(async () => {
                try {
                  requireValue(owner === ticket && (await db.isTransactionActive()).result === true, 'prepared transaction is no longer active')
                  const state = await readInside()
                  requireValue(state?.currentSha256 === sourceHash && state.sourceSha256 === sourceHash && state.revision === 0,
                    'prepared migration changed before commit')
                  let verified: unknown
                  try { verified = assertSourceUnchanged() } catch { throw new MigrationError('source verification failed; migration was not committed') }
                  if (verified instanceof Promise) void verified.catch(() => {})
                  requireValue(verified === undefined, 'source verification must finish synchronously before commit')
                  await db.commitTransaction()
                  requireValue((await db.isTransactionActive()).result === false, 'migration transaction did not commit')
                  owned = false
                  owner = null
                  const committed = await transaction(readInside)
                  requireValue(committed?.currentSha256 === sourceHash && committed.sourceSha256 === sourceHash && committed.revision === 0,
                    'committed migration read-back mismatch')
                  await verifyOriginal(committed)
                  return committed
                } catch (error) { return abort(error, owned) }
              }, ticket)
            },
            rollback(): Promise<void> {
              return exclusive(async () => {
                try {
                  requireValue(owner === ticket && (await db.isTransactionActive()).result === true, 'prepared transaction is no longer active')
                  await db.rollbackTransaction()
                  requireValue((await db.isTransactionActive()).result === false, 'prepared migration did not roll back')
                  owned = false
                  owner = null
                } catch (error) { return abort(error, owned) }
              }, ticket)
            },
          })
        } catch (error) { return abort(error, owned) }
      })
    },
  })
}
