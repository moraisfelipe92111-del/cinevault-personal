/** Small, synchronous rollback guard for JSON writes. Does not claim power-loss atomicity. */
export interface JsonStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
export type JsonChange = { key: string; value: unknown }

/** Persist a validated import or leave the old values in place when quota/writes fail. */
export function commitJsonBatch(store: JsonStore, changes: readonly JsonChange[]): void {
  const keys = new Set<string>()
  const serialized = changes.map(({key, value}) => {
    if (!key || keys.has(key)) throw new Error('Chave de backup duplicada ou inválida')
    keys.add(key)
    return {key, json: JSON.stringify(value)}
  })
  if (serialized.some(x => typeof x.json !== 'string')) throw new Error('Dados não serializáveis')
  const snapshot = serialized.map(({key}) => ({key, previous: store.getItem(key)}))
  try {
    for (const {key, json} of serialized) store.setItem(key, json)
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
