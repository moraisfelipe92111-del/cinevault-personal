import type { JsonStore } from './storageSafety.ts'

// Preparation only: callers must pause all writers before a future migration.
// This module does not access a global store, write data, or open a database.
export const PERSONAL_STORAGE_KEYS = Object.freeze([
  'cinevault.personal.v2',
  'cinevault.pulse.v1',
  'cinevault.posters.v1',
  'cinevault.posterMeta.v2',
  'cinevault.posterUnresolved.v1',
  'cinevault.experience.v1',
] as const)

const FORMAT = 'cinevault.personal-storage-snapshot'
type PersonalStorageKey = typeof PERSONAL_STORAGE_KEYS[number]
type Reader = Pick<JsonStore, 'getItem'>
type Entry = Readonly<{ key: PersonalStorageKey; raw: string | null }>
export type PersonalStorageSnapshot = Readonly<{
  format: typeof FORMAT
  version: 1
  entries: readonly Entry[]
}>

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('Personal storage snapshot: ' + message)
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function freezeSnapshot(entries: Entry[]): PersonalStorageSnapshot {
  const snapshot: PersonalStorageSnapshot = {format: FORMAT, version: 1,
    entries: Object.freeze(entries.map(entry => Object.freeze(entry)))}
  return Object.freeze(snapshot)
}

function readRaw(store: Reader, key: PersonalStorageKey): string | null {
  let raw: unknown
  try { raw = store.getItem(key) }
  catch { throw new Error('Personal storage snapshot: cannot read ' + key) }
  if (raw === null) return null
  requireValue(typeof raw === 'string', 'unexpected storage value for ' + key)
  return raw
}

/** Keep missing keys distinct from empty text, JSON null, or malformed JSON. */
export function capturePersonalStorageSnapshot(store: Reader): PersonalStorageSnapshot {
  const entries = PERSONAL_STORAGE_KEYS.map(key => ({key, raw: readRaw(store, key)}))
  // Detect changes between passes. This is not a lock across tabs or processes.
  for (const entry of entries) {
    requireValue(readRaw(store, entry.key) === entry.raw, 'storage changed during capture: ' + entry.key)
  }
  return freezeSnapshot(entries)
}

/** Validate the envelope only. Never parse, normalize, or filter stored values. */
export function validatePersonalStorageSnapshot(input: unknown): PersonalStorageSnapshot {
  requireValue(hasExactKeys(input, ['format', 'version', 'entries']), 'invalid envelope')
  requireValue(input.format === FORMAT && input.version === 1, 'unsupported format or version')
  const entries = input.entries
  requireValue(Array.isArray(entries) && entries.length === PERSONAL_STORAGE_KEYS.length, 'incomplete key set')
  const copied = PERSONAL_STORAGE_KEYS.map((key, index) => {
    const entry: unknown = entries[index]
    requireValue(hasExactKeys(entry, ['key', 'raw']) && entry.key === key, 'unexpected or repeated key at position ' + index)
    const raw = entry.raw
    if (raw === null) return {key, raw: null}
    requireValue(typeof raw === 'string', 'invalid raw value for ' + key)
    return {key, raw}
  })
  return freezeSnapshot(copied)
}

/** JSON escaping retains every JavaScript UTF-16 code unit, including lone surrogates. */
export function serializePersonalStorageSnapshot(input: unknown): string {
  return JSON.stringify(validatePersonalStorageSnapshot(input))
}

export function parsePersonalStorageSnapshot(serialized: string): PersonalStorageSnapshot {
  requireValue(typeof serialized === 'string', 'serialized snapshot must be text')
  let decoded: unknown
  try { decoded = JSON.parse(serialized) }
  catch { throw new Error('Personal storage snapshot: invalid serialized envelope') }
  return validatePersonalStorageSnapshot(decoded)
}

/** A final comparison is required while the future migration still owns its writer lock. */
export function assertPersonalStorageUnchanged(store: Reader, input: unknown): void {
  const expected = validatePersonalStorageSnapshot(input)
  const current = capturePersonalStorageSnapshot(store)
  for (let index = 0; index < expected.entries.length; index++) {
    const entry = expected.entries[index]
    requireValue(current.entries[index].raw === entry.raw, 'source changed since capture: ' + entry.key)
  }
}
