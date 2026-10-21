import type { JsonStore } from './storageSafety.ts'
import {
  PERSONAL_STORAGE_KEYS, capturePersonalStorageSnapshot, assertPersonalStorageUnchanged,
  type PersonalStorageSnapshot,
} from './personalStorageSnapshot.ts'

type Phase = 'active' | 'paused' | 'closed'
const allowedKeys: ReadonlySet<string> = new Set(PERSONAL_STORAGE_KEYS)

/** Coordinates this JavaScript instance only; it is not a cross-tab or database lock. */
export function createPersonalStorageCoordinator(getStore: () => JsonStore) {
  let phase: Phase = 'active'
  let writing = 0
  let owner: object | null = null

  const checkKey = (key: string) => {
    if (!allowedKeys.has(key)) throw new Error('Chave de dados pessoais não autorizada.')
  }
  const assertReadable = () => {
    if (phase === 'closed') throw new Error('O acesso ao armazenamento anterior foi encerrado.')
  }
  const withWriteAccess = (keys: readonly string[], operation: () => void): void => {
    assertReadable()
    if (phase === 'paused') throw new Error('A gravação dos dados pessoais está pausada.')
    for (const key of keys) checkKey(key)
    writing++
    try { operation() } finally { writing-- }
  }
  const store: JsonStore = Object.freeze({
    getItem(key: string): string | null {
      assertReadable()
      checkKey(key)
      return getStore().getItem(key)
    },
    setItem(key: string, value: string): void {
      if (typeof value !== 'string') throw new Error('O valor pessoal precisa ser texto.')
      withWriteAccess([key], () => getStore().setItem(key, value))
    },
    removeItem(key: string): void {
      withWriteAccess([key], () => getStore().removeItem(key))
    },
    withWriteAccess,
  })

  return Object.freeze({
    store,
    get phase(): Phase { return phase },
    pauseWrites() {
      assertReadable()
      if (phase !== 'active') throw new Error('A gravação dos dados pessoais já está pausada.')
      if (writing !== 0) throw new Error('Há uma gravação pessoal em andamento.')
      const ticket = Object.freeze({})
      owner = ticket
      phase = 'paused'
      const requireOwner = () => {
        if (phase !== 'paused' || owner !== ticket) throw new Error('Esta pausa de gravação não está ativa.')
      }
      return Object.freeze({
        captureSnapshot(): PersonalStorageSnapshot {
          requireOwner()
          const snapshot = capturePersonalStorageSnapshot(store)
          requireOwner()
          return snapshot
        },
        assertUnchanged(snapshot: unknown): void {
          requireOwner()
          assertPersonalStorageUnchanged(store, snapshot)
          requireOwner()
        },
        resumeLocalWrites(): void {
          requireOwner()
          owner = null
          phase = 'active'
        },
        // A future cutover must call this only after its durable database marker
        // and new repository are verified. There is deliberately no reopen method.
        closeLegacyAccess(): void {
          requireOwner()
          owner = null
          phase = 'closed'
        },
      })
    },
  })
}

// Creating the shared coordinator performs no reads. Normal app accesses remain
// on localStorage until a separately validated migration is integrated at boot.
export const personalStorageCoordinator = createPersonalStorageCoordinator(() => localStorage)
export const personalStorage = personalStorageCoordinator.store
