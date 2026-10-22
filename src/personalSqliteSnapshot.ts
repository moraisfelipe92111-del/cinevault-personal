import {
  parsePersonalStorageSnapshot, serializePersonalStorageSnapshot,
  type PersonalStorageSnapshot,
} from './personalStorageSnapshot.ts'

// Explicit preparation API only. The caller owns an open, exclusive connection.
// Importing or constructing this repository never opens a DB or reads storage.
export type SnapshotSqliteConnection = {
  execute(statement: string, transaction?: boolean): Promise<unknown>
  run(statement: string, values: (string | number)[], transaction?: boolean): Promise<unknown>
  query(statement: string, values?: (string | number)[]): Promise<{ values?: unknown[] }>
  beginTransaction(): Promise<unknown>
  commitTransaction(): Promise<unknown>
  rollbackTransaction(): Promise<unknown>
  isTransactionActive(): Promise<{ result?: boolean }>
}

const TABLE = 'cv_personal_raw_snapshot'
const CHUNKS = 'cv_personal_raw_snapshot_chunk'
const CHUNK_UNITS = 16384
const MAX_UNITS = 32 * 1024 * 1024
const MAX_CHUNKS = Math.ceil(MAX_UNITS / (CHUNK_UNITS - 1))
const SCHEMAS = [
  [TABLE, `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), format_version INTEGER NOT NULL CHECK (format_version = 1), chunk_count INTEGER NOT NULL CHECK (chunk_count > 0), utf16_length INTEGER NOT NULL CHECK (utf16_length > 0), sha256 TEXT NOT NULL CHECK (length(sha256) = 64))`],
  [CHUNKS, `CREATE TABLE ${CHUNKS} (ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 0), payload TEXT NOT NULL)`],
] as const

class SnapshotStorageError extends Error {
  constructor(message: string) { super('Personal SQLite snapshot: ' + message) }
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SnapshotStorageError(message)
}

function row(input: unknown): Record<string, unknown> {
  requireValue(input !== null && typeof input === 'object' && !Array.isArray(input), 'invalid database row')
  return input as Record<string, unknown>
}

function chunksFor(serialized: string): string[] {
  requireValue(serialized.length <= MAX_UNITS, 'serialized copy exceeds the supported 32 Mi UTF-16 units')
  const chunks: string[] = []
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(start + CHUNK_UNITS, serialized.length)
    // Each native TEXT parameter must contain complete Unicode scalar values.
    // JSON already escapes lone surrogates; do not split a valid pair either.
    const last = serialized.charCodeAt(end - 1), next = serialized.charCodeAt(end)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    chunks.push(serialized.slice(start, end))
    start = end
  }
  return chunks
}

async function digest(serialized: string): Promise<string> {
  requireValue(typeof globalThis.crypto?.subtle?.digest === 'function', 'SHA-256 support is required before database access')
  const bytes = new TextEncoder().encode(serialized)
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('')
}

type StoredCopy = { snapshot: PersonalStorageSnapshot; serialized: string; sha256: string }

export function createPersonalSqliteSnapshotRepository(db: SnapshotSqliteConnection) {
  let busy = false
  let failed = false

  async function rows(statement: string, values: (string | number)[] = []): Promise<unknown[]> {
    const result = await db.query(statement, values)
    requireValue(Array.isArray(result?.values), 'database query did not return rows')
    return result.values
  }

  async function readInsideTransaction(): Promise<StoredCopy | null> {
    const definitions: number[] = []
    for (const [name, sql] of SCHEMAS) {
      const objects = await rows('SELECT type, name, sql FROM main.sqlite_master WHERE tbl_name = ? ORDER BY type, name', [name])
      definitions.push(objects.length)
      if (objects.length) {
        const object = row(objects[0])
        requireValue(objects.length === 1 && object.type === 'table' && object.name === name && object.sql === sql,
          'unexpected snapshot schema or related object')
      }
    }
    if (definitions.every(count => count === 0)) return null
    requireValue(definitions.every(count => count === 1), 'incomplete snapshot schema')
    const metadata = await rows(`SELECT id, format_version, chunk_count, utf16_length, sha256 FROM main.${TABLE}`)
    requireValue(metadata.length === 1, 'missing or repeated snapshot metadata')
    const meta = row(metadata[0])
    const count = meta.chunk_count, length = meta.utf16_length, hash = meta.sha256
    requireValue(meta.id === 1 && meta.format_version === 1 &&
      typeof count === 'number' && Number.isSafeInteger(count) && count > 0 && count <= MAX_CHUNKS &&
      typeof length === 'number' && Number.isSafeInteger(length) && length > 0 && length <= MAX_UNITS &&
      count >= Math.ceil(length / CHUNK_UNITS) && count <= Math.ceil(length / (CHUNK_UNITS - 1)) &&
      typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'invalid snapshot metadata')
    const totals = await rows(`SELECT COUNT(*) AS total FROM main.${CHUNKS}`)
    requireValue(totals.length === 1 && row(totals[0]).total === count, 'missing or extra snapshot chunks')
    const chunks: string[] = []
    let units = 0
    for (let ordinal = 0; ordinal < count; ordinal++) {
      // Bounded rows avoid Android CursorWindow limits and oversized bridge replies.
      const values = await rows(`SELECT ordinal, payload FROM main.${CHUNKS} WHERE ordinal = ?`, [ordinal])
      requireValue(values.length === 1, 'snapshot chunk sequence is incomplete')
      const chunk = row(values[0])
      requireValue(chunk.ordinal === ordinal && typeof chunk.payload === 'string' &&
        chunk.payload.length > 0 && chunk.payload.length <= CHUNK_UNITS, 'invalid snapshot chunk')
      chunks.push(chunk.payload)
      units += chunk.payload.length
    }
    requireValue(units === length, 'snapshot length mismatch')
    const serialized = chunks.join('')
    requireValue(await digest(serialized) === hash, 'snapshot digest mismatch')
    const snapshot = parsePersonalStorageSnapshot(serialized)
    requireValue(serializePersonalStorageSnapshot(snapshot) === serialized, 'noncanonical snapshot envelope')
    return {snapshot, serialized, sha256: hash}
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
    } catch (error) {
      // A rejected/uncertain native call requires a fresh connection before retry.
      failed = true
      if (owned) {
        try {
          if ((await db.isTransactionActive()).result === true) await db.rollbackTransaction()
        } catch { /* Keep the primary failure; never reuse this repository. */ }
      }
      if (error instanceof SnapshotStorageError) throw error
      // Native errors may echo bound private values. Do not expose those messages.
      throw new SnapshotStorageError('database operation failed; close and reopen the connection before retrying')
    }
  }

  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    requireValue(!busy, 'another snapshot operation is in progress')
    requireValue(!failed, 'close and reopen the connection before retrying')
    busy = true
    try { return await operation() } finally { busy = false }
  }

  return Object.freeze({
    read(): Promise<PersonalStorageSnapshot | null> {
      return exclusive(async () => (await transaction(readInsideTransaction))?.snapshot ?? null)
    },
    preserve(input: unknown): Promise<'preserved' | 'already_preserved'> {
      return exclusive(async () => {
        // Validate and detach before the first await or any database access.
        const serialized = serializePersonalStorageSnapshot(input)
        const chunks = chunksFor(serialized)
        const hash = await digest(serialized)
        const outcome = await transaction(async () => {
          const existing = await readInsideTransaction()
          if (existing) {
            requireValue(existing.serialized === serialized && existing.sha256 === hash, 'existing snapshot differs; replacement refused')
            return 'already_preserved' as const
          }
          for (const [name, sql] of SCHEMAS) await db.execute(sql.replace(`CREATE TABLE ${name}`, `CREATE TABLE main.${name}`), false)
          await db.run(`INSERT INTO main.${TABLE} (id, format_version, chunk_count, utf16_length, sha256) VALUES (?, ?, ?, ?, ?)`,
            [1, 1, chunks.length, serialized.length, hash], false)
          for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
            await db.run(`INSERT INTO main.${CHUNKS} (ordinal, payload) VALUES (?, ?)`, [ordinal, chunks[ordinal]], false)
          }
          const written = await readInsideTransaction()
          requireValue(written?.serialized === serialized, 'snapshot read-back mismatch before commit')
          return 'preserved' as const
        })
        // A second transaction verifies committed data, not our uncommitted writes.
        await transaction(async () => {
          const committed = await readInsideTransaction()
          requireValue(committed?.serialized === serialized, 'snapshot read-back mismatch after commit')
        })
        return outcome
      })
    },
  })
}
