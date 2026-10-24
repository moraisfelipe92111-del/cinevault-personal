import { commitJsonBatch, type JsonChange, type JsonStore } from './storageSafety.ts'
import type { PersonalPersistence } from './personalPersistence.ts'
import { readPersonalJsonModel } from './personalJsonModel.ts'

/** Keep unreadable maps untouched until a validated restore has been persisted. */
export function createJsonMapStorage(getStore: () => JsonStore) {
  const blocked = new Set<string>()

  return {
    read<T>(key: string): Record<string, T> {
      try {
        const raw = getStore().getItem(key)
        if (raw === null) return {}
        const value: unknown = JSON.parse(raw)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Mapa JSON inválido')
        }
        return value as Record<string, T>
      } catch {
        blocked.add(key)
        return {}
      }
    },
    write(key: string, value: Record<string, unknown>): boolean {
      if (blocked.has(key)) return false
      getStore().setItem(key, JSON.stringify(value))
      return true
    },
    hasBlocked(): boolean {
      return blocked.size > 0
    },
    restore(changes: readonly JsonChange[]): void {
      commitJsonBatch(getStore(), changes)
      for (const {key} of changes) blocked.delete(key)
    },
  }
}

/** The UI sees maps only after a durable commit; restores clear guards afterward. */
export function createAsyncJsonMapStorage(persistence: PersonalPersistence) {
  const blocked = new Set<string>()
  const decode = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Mapa inválido')
    return value as Record<string, unknown>
  }
  const read = <T>(key: string): Record<string, T> => {
    const model = readPersonalJsonModel(persistence.reader, key, decode, () => ({}))
    if (model.blocked) blocked.add(key)
    return model.value as Record<string, T>
  }
  return Object.freeze({read,
    hasBlocked: () => blocked.size > 0,
    update(keys: readonly string[], transform: (maps: Record<string, Record<string, unknown>>) => readonly JsonChange[]) {
      return persistence.update(reader => {
        const maps: Record<string, Record<string, unknown>> = {}
        for (const key of keys) {
          if (blocked.has(key)) throw new Error('Há dados de capas preservados que precisam ser restaurados antes de novas alterações.')
          const model = readPersonalJsonModel(reader, key, decode, () => ({}))
          if (model.blocked) { blocked.add(key); throw new Error('Dados de capas inválidos; conteúdo original preservado.') }
          maps[key] = model.value
        }
        const changes = transform(maps)
        if (changes.some(change => !keys.includes(change.key))) throw new Error('Lote de capas inesperado.')
        return changes
      })
    },
    async restore(changes: readonly JsonChange[]) {
      await persistence.commitJson(changes)
      for (const {key} of changes) blocked.delete(key)
    },
    async restoreSnapshot(input: unknown) {
      await persistence.restoreSnapshot(input)
      blocked.clear()
    },
    async restoreMediaBackup(input: unknown) {
      await persistence.restoreMediaBackup(input)
      blocked.clear()
    },
  })
}
