import type { PersonalReader } from './personalPersistence.ts'
import type { JsonChange } from './storageSafety.ts'

function equivalent(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && !Number.isFinite(a)) return false
  if (a === b && (a === null || typeof a !== 'object')) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const left = Object.keys(a), right = Object.keys(b)
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) &&
    equivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** A filtered/normalized projection is visible but never silently written back. */
export function readPersonalJsonModel<T>(reader: PersonalReader, key: string, decode: (value: unknown) => T, empty: () => T) {
  try {
    const raw = reader.getItem(key)
    if (raw === null) return {value: empty(), blocked: false}
    const original: unknown = JSON.parse(raw)
    const value = decode(original)
    return {value, blocked: !equivalent(original, value)}
  } catch { return {value: empty(), blocked: true} }
}

export function updatePersonalJsonModel<T>(reader: PersonalReader, key: string, decode: (value: unknown) => T,
  empty: () => T, update: (previous: T) => T): readonly JsonChange[] {
  const current = readPersonalJsonModel(reader, key, decode, empty)
  if (current.blocked) throw new Error('Há dados preservados que precisam de revisão. Exporte uma cópia completa antes de restaurar um backup válido.')
  const previous = JSON.parse(JSON.stringify(current.value)) as unknown
  const next = update(current.value)
  if (!equivalent(next, decode(next))) throw new Error('A alteração contém dados que não puderam ser confirmados.')
  return equivalent(next, previous) ? [] : [{key, value: next}]
}
