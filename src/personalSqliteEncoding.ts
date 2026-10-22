// Shared native TEXT encoding; no storage or browser API is accessed at import.
export const SQLITE_TEXT_CHUNK_UNITS = 16384
export const MAX_PERSONAL_SQLITE_UNITS = 32 * 1024 * 1024
export const MAX_PERSONAL_SQLITE_CHUNKS = Math.ceil(MAX_PERSONAL_SQLITE_UNITS / (SQLITE_TEXT_CHUNK_UNITS - 1))

export function splitPersonalSqliteText(serialized: string): string[] {
  if (serialized.length > MAX_PERSONAL_SQLITE_UNITS) throw new Error('Personal SQLite data exceeds the supported 32 Mi UTF-16 units')
  const chunks: string[] = []
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(start + SQLITE_TEXT_CHUNK_UNITS, serialized.length)
    const last = serialized.charCodeAt(end - 1), next = serialized.charCodeAt(end)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    chunks.push(serialized.slice(start, end))
    start = end
  }
  return chunks
}

export async function digestPersonalSqliteText(serialized: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') throw new Error('SHA-256 support is required before database access')
  const bytes = new TextEncoder().encode(serialized)
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('')
}
