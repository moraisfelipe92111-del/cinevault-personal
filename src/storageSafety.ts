/** Small, synchronous rollback guard for JSON writes. Does not claim power-loss atomicity. */
export interface JsonStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Optional synchronous guard covering the entire batch, including rollback. */
  withWriteAccess?(keys: readonly string[], operation: () => void): void
}
export type JsonChange = { key: string; value: unknown }
export type RawStorageChange = Readonly<{ key: string; raw: string | null }>

/** Persist a validated import or leave the old values in place when quota/writes fail. */
export function commitJsonBatch(store: JsonStore, changes: readonly JsonChange[]): void {
  const keys = new Set<string>()
  const serialized = changes.map(({key, value}) => {
    if (!key || keys.has(key)) throw new Error('Chave de backup duplicada ou inválida')
    keys.add(key)
    return {key, json: JSON.stringify(value)}
  })
  if (serialized.some(x => typeof x.json !== 'string')) throw new Error('Dados não serializáveis')
  commitRawBatch(store, serialized.map(({key, json}) => ({key, raw: json})))
}

/** Native callers use a real SQLite transaction instead of this legacy rollback. */
export function commitRawBatch(store: JsonStore, changes: readonly RawStorageChange[]): void {
  const keys = new Set<string>()
  const copied = changes.map(({key, raw}) => {
    if (!key || keys.has(key) || (raw !== null && typeof raw !== 'string')) throw new Error('Alteração de dados inválida')
    keys.add(key)
    return {key, raw}
  })
  const apply = () => {
    const snapshot = copied.map(({key}) => ({key, previous: store.getItem(key)}))
    try {
      for (const {key, raw} of copied) {
        if (raw === null) store.removeItem(key)
        else store.setItem(key, raw)
      }
    } catch {
      let rollbackFailed = false
      for (const {key, previous} of snapshot) {
        try { if (previous === null) store.removeItem(key); else store.setItem(key, previous) }
        catch { rollbackFailed = true }
      }
      throw new Error(rollbackFailed
        ? 'Falha ao salvar e ao restaurar parte dos dados. Não feche o app; exporte o backup atual.'
        : 'Sem espaço para restaurar o backup. Os dados anteriores foram mantidos.')
    }
  }
  if (typeof store.withWriteAccess === 'function') store.withWriteAccess(copied.map(item => item.key), apply)
  else apply()
}
