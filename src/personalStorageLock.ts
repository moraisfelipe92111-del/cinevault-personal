const LOCK_NAME = 'cinevault.personal-storage-owner.v1'
export class PersonalStorageLockError extends Error {}

/** Hold the same-origin lock until the native owner closes its connection. */
export function acquirePersonalStorageLock(locks: Pick<LockManager, 'request'> | undefined): Promise<{release(): Promise<void>}> {
  if (!locks || typeof locks.request !== 'function')
    return Promise.reject(new PersonalStorageLockError('Este sistema não disponibilizou a proteção necessária para abrir os dados. Atualize o sistema e o componente de navegação do aparelho.'))
  return new Promise((resolve, reject) => {
    let release: () => void
    const gate = new Promise<void>(done => { release = done })
    try {
      const holding = locks.request(LOCK_NAME, {mode: 'exclusive', ifAvailable: true}, async lock => {
        if (!lock) { reject(new PersonalStorageLockError('Seus dados já estão abertos em outra janela. Feche a outra janela e tente novamente.')); return }
        resolve(Object.freeze({async release() { release(); await holding }}))
        await gate
      })
      void holding.catch(() => reject(new PersonalStorageLockError('Não foi possível proteger a abertura dos dados pessoais.')))
    } catch { reject(new PersonalStorageLockError('Não foi possível proteger a abertura dos dados pessoais.')) }
  })
}
