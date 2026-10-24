import { validatePersonalStorageSnapshot, type PersonalStorageSnapshot } from './personalStorageSnapshot.ts'
import { emptyMediaProgressSnapshot, validateMediaProgressSnapshot, type MediaProgressSnapshot } from './mediaProgress.ts'

/** Preparation format only. The production importer and six native keys are not changed here. */
export type MediaBackup = Readonly<{
  format: 'sintonema.audiovisual-backup'
  version: 1
  legacy: PersonalStorageSnapshot
  progress: MediaProgressSnapshot
}>
const MAX_BACKUP_CODE_UNITS = 32 * 1024 * 1024

/** Preserve all six original raw strings, including malformed JSON and unknown fields. */
export function createMediaBackup(legacy: unknown, progress: unknown = emptyMediaProgressSnapshot()): MediaBackup {
  return Object.freeze({format: 'sintonema.audiovisual-backup', version: 1,
    legacy: validatePersonalStorageSnapshot(legacy), progress: validateMediaProgressSnapshot(progress)})
}

/** Unknown versions/fields reject the whole envelope; no filtered backup is returned. */
export function validateMediaBackup(input: unknown): MediaBackup {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Backup audiovisual inválido')
  const value = input as Record<string, unknown>, keys = ['format', 'version', 'legacy', 'progress']
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
    value.format !== 'sintonema.audiovisual-backup' || value.version !== 1) throw new Error('Backup audiovisual inválido ou incompatível')
  return createMediaBackup(value.legacy, value.progress)
}

export function serializeMediaBackup(input: unknown): string {
  const text = JSON.stringify(validateMediaBackup(input))
  if (text.length > MAX_BACKUP_CODE_UNITS) throw new Error('Backup audiovisual acima do limite')
  return text
}

export function parseMediaBackup(text: string): MediaBackup {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_CODE_UNITS) throw new Error('Backup audiovisual inválido ou acima do limite')
  let input: unknown
  try { input = JSON.parse(text) } catch { throw new Error('Backup audiovisual ilegível') }
  return validateMediaBackup(input)
}
