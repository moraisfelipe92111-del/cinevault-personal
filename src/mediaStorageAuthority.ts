import { createPersonalAuthorityStore, createFilesystemAuthorityIO, type PersonalStorageAuthority } from './personalStorageAuthority.ts'
import type { FilesystemPlugin, Directory } from '@capacitor/filesystem'

export type MediaStorageAuthority = Readonly<{
  format: 'cinevault.personal-sqlite-authority'
  version: 2
  database: string
  sourceSha256: string
  mediaState: 'reserved' | 'complete'
  mediaOriginSha256: string
  mediaParentRevision: number
}>
export type MediaAuthorityStore = Readonly<{
  read(): Promise<PersonalStorageAuthority | MediaStorageAuthority | null>
  ensureLegacy(sourceSha256: string): Promise<void>
  reserve(sourceSha256: string, originSha256: string, parentRevision: number): Promise<void>
  confirm(sourceSha256: string, originSha256: string, parentRevision: number): Promise<void>
}>
type AuthorityIO = {read(): Promise<string | null>; write(text: string): Promise<void>}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('Marcador audiovisual inválido ou incompatível.')
}

/** Reserve before the first media transaction; expose UI only after confirmation. */
export function createMediaAuthorityStore(database: string, io: AuthorityIO): MediaAuthorityStore {
  const legacy = createPersonalAuthorityStore(database, io)
  const read = async (): Promise<PersonalStorageAuthority | MediaStorageAuthority | null> => {
    const text = await io.read()
    if (text === null) return null
    requireValue(typeof text === 'string' && text.length <= 2048)
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new Error('Marcador audiovisual ilegível.') }
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value))
    const item = value as Record<string, unknown>
    const keys = item.version === 1 ? ['format', 'version', 'database', 'sourceSha256'] :
      ['format', 'version', 'database', 'sourceSha256', 'mediaState', 'mediaOriginSha256', 'mediaParentRevision']
    requireValue(Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key)) &&
      item.format === 'cinevault.personal-sqlite-authority' && item.database === database && hash(item.sourceSha256))
    if (item.version === 1) return Object.freeze({format: 'cinevault.personal-sqlite-authority', version: 1, database, sourceSha256: item.sourceSha256})
    requireValue(item.version === 2 && (item.mediaState === 'reserved' || item.mediaState === 'complete') &&
      hash(item.mediaOriginSha256) && typeof item.mediaParentRevision === 'number' &&
      Number.isSafeInteger(item.mediaParentRevision) && item.mediaParentRevision >= 0)
    return Object.freeze({format: 'cinevault.personal-sqlite-authority', version: 2, database, sourceSha256: item.sourceSha256,
      mediaState: item.mediaState, mediaOriginSha256: item.mediaOriginSha256, mediaParentRevision: item.mediaParentRevision})
  }
  const matches = (item: MediaStorageAuthority, source: string, origin: string, parent: number) =>
    item.sourceSha256 === source && item.mediaOriginSha256 === origin && item.mediaParentRevision === parent
  const change = async (source: string, origin: string, parent: number, complete: boolean) => {
    requireValue(hash(source) && hash(origin) && Number.isSafeInteger(parent) && parent >= 0)
    const before = await read()
    requireValue(before !== null && before.sourceSha256 === source)
    if (before.version === 2) {
      requireValue(matches(before, source, origin, parent))
      requireValue(complete || before.mediaState === 'reserved')
    } else requireValue(!complete)
    const mediaState = complete ? 'complete' : 'reserved'
    if (before.version !== 2 || before.mediaState !== mediaState) {
      await io.write(JSON.stringify({format: 'cinevault.personal-sqlite-authority', version: 2, database,
        sourceSha256: source, mediaState, mediaOriginSha256: origin, mediaParentRevision: parent}))
    }
    const after = await read()
    requireValue(after?.version === 2 && matches(after, source, origin, parent) && after.mediaState === mediaState)
  }
  return Object.freeze({read,
    async ensureLegacy(source) {
      const before = await read()
      requireValue(before === null || before.version === 1)
      await legacy.ensure(source)
    },
    reserve: (source, origin, parent) => change(source, origin, parent, false),
    confirm: (source, origin, parent) => change(source, origin, parent, true),
  })
}

export function createFilesystemMediaAuthority(filesystem: Pick<FilesystemPlugin, 'readdir' | 'readFile' | 'writeFile' | 'rename'>,
  directory: Directory, database: string): MediaAuthorityStore {
  return createMediaAuthorityStore(database, createFilesystemAuthorityIO(filesystem, directory, database))
}
