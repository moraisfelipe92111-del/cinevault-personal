import type { FilesystemPlugin, Directory, Encoding } from '@capacitor/filesystem'

export type PersonalStorageAuthority = Readonly<{format: 'cinevault.personal-sqlite-authority'; version: 1; database: string; sourceSha256: string}>
export type PersonalAuthorityStore = Readonly<{
  read(): Promise<PersonalStorageAuthority | null>
  ensure(sourceSha256: string): Promise<void>
}>

/** A small independent receipt detects loss of the authoritative database. */
export function createPersonalAuthorityStore(database: string, io: {read(): Promise<string | null>; write(text: string): Promise<void>}): PersonalAuthorityStore {
  if (!/^(cinevault_personal|cv2_sqlite_audit_[1-9]\d{0,19}_[1-9]\d{0,5}_(android|ios))$/.test(database))
    throw new Error('Identidade do armazenamento inválida.')
  const read = async (): Promise<PersonalStorageAuthority | null> => {
    const raw = await io.read()
    if (raw === null) return null
    if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Marcador de armazenamento inválido.')
    let value: unknown
    try { value = JSON.parse(raw) } catch { throw new Error('Marcador de armazenamento inválido.') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Marcador de armazenamento inválido.')
    const item = value as Record<string, unknown>
    if (Object.keys(item).length !== 4 || item.format !== 'cinevault.personal-sqlite-authority' || item.version !== 1 ||
        item.database !== database || typeof item.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sourceSha256))
      throw new Error('Marcador de armazenamento inválido.')
    return Object.freeze({format: 'cinevault.personal-sqlite-authority', version: 1, database, sourceSha256: item.sourceSha256})
  }
  return Object.freeze({read, async ensure(sourceSha256: string) {
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Identidade da origem inválida.')
    const before = await read()
    if (before && before.sourceSha256 !== sourceSha256) throw new Error('O marcador pertence a outra origem de dados.')
    if (!before) await io.write(JSON.stringify({format: 'cinevault.personal-sqlite-authority', version: 1, database, sourceSha256}))
    if ((await read())?.sourceSha256 !== sourceSha256) throw new Error('Não foi possível confirmar o marcador do armazenamento.')
  }})
}

type AuthorityFilesystem = Pick<FilesystemPlugin, 'readdir' | 'readFile' | 'writeFile' | 'rename'>

/** Write to a same-directory temporary file and rename; never delete the receipt. */
export function createFilesystemPersonalAuthority(filesystem: AuthorityFilesystem, directory: Directory, database: string): PersonalAuthorityStore {
  const path = database + '-authority.json'
  return createPersonalAuthorityStore(database, {
    async read() {
      const listing = await filesystem.readdir({directory, path: ''})
      const found = listing.files.find(file => file.name === path)
      if (!found) return null
      if (typeof found.size === 'number' && found.size > 2048) throw new Error('Marcador de armazenamento inválido.')
      const file = await filesystem.readFile({directory, path, encoding: 'utf8' as Encoding})
      if (typeof file.data !== 'string') throw new Error('Marcador de armazenamento ilegível.')
      return file.data
    },
    async write(text) {
      await filesystem.writeFile({directory, path: path + '.pending', encoding: 'utf8' as Encoding, data: text})
      await filesystem.rename({directory, from: path + '.pending', to: path})
    },
  })
}
