import { commitJsonBatch, type JsonChange, type JsonStore } from './storageSafety.ts'

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
