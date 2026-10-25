import {isCompletePersonalBackup,isMediaPersonalBackup,type PersonalPersistence} from './personalPersistence.ts'
import {createAsyncJsonMapStorage} from './jsonMapStorage.ts'
import {parseBackup} from './backupValidation.ts'
import {PULSE_KEY} from './pulse.ts'

/** Welcome and library imports share validation, durable acknowledgement and map-guard handling. */
export async function restoreLibraryBackup(persistence:PersonalPersistence, input:unknown, bytes:number,
  knownIds:ReadonlySet<number>, maps=createAsyncJsonMapStorage(persistence)):Promise<string> {
  if(!Number.isSafeInteger(bytes)||bytes<0||bytes>96*1024*1024)throw new Error('Arquivo de backup muito grande.')
  if(isMediaPersonalBackup(input)) {
    await maps.restoreMediaBackup(input)
    return 'Cópia completa restaurada, incluindo acompanhamentos, preferências e dados preservados.'
  }
  if(isCompletePersonalBackup(input)) {
    await maps.restoreSnapshot(input)
    return 'Cópia completa restaurada. Dados não interpretados continuam preservados para revisão.'
  }
  if(bytes>5*1024*1024)throw new Error('Arquivo de backup de biblioteca muito grande.')
  const result=parseBackup(input,knownIds)
  await maps.restore([
    {key:'cinevault.personal.v2',value:result.saved},
    ...(result.pulse?[{key:PULSE_KEY,value:result.pulse}]:[]),
    ...(result.posters?[{key:'cinevault.posters.v1',value:result.posters}]:[]),
    ...(result.posterMeta?[{key:'cinevault.posterMeta.v2',value:result.posterMeta}]:[]),
    ...(result.unresolved?[{key:'cinevault.posterUnresolved.v1',value:result.unresolved}]:[]),
  ])
  return `Backup restaurado: ${Object.keys(result.posters||{}).length} vínculos de capas identificados. Confira a Biblioteca.`
}
