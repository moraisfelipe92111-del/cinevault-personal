import type {PersonalPersistence, PersonalReader} from './personalPersistence.ts'
import {PERSONAL_STORAGE_KEYS} from './personalStorageSnapshot.ts'
import {readPersonalJsonModel, updatePersonalJsonModel} from './personalJsonModel.ts'
import {EXPERIENCE_KEY, EXPERIENCE_DEFAULTS, decodeExperiencePreferences, validateDiscoveryFormats} from './experiencePreferences.ts'
import type {MediaProgressSnapshot} from './mediaProgress.ts'
import type {PilotFilter} from './mediaPilot.ts'
import type {DiscoveryFormat} from './experiencePreferences.ts'

export function discoveryDestination(format:DiscoveryFormat):{mode:'movies'|'series';filter:PilotFilter} {
  const filters:Record<DiscoveryFormat,PilotFilter>={movies:'Todos',series:'Ficção',anime:'Animes',reality:'Realities',documentary:'Documentários'}
  return {mode:format==='movies'?'movies':'series',filter:filters[format]}
}

/** Only a confirmed, completely absent personal state is a new library. No JSON parsing or default writes. */
export function needsFirstAccess(reader:PersonalReader, progress:MediaProgressSnapshot):boolean {
  return PERSONAL_STORAGE_KEYS.every(key=>reader.getItem(key)===null)&&progress.entries.length===0
}

export function readDiscoveryPreferences(reader:PersonalReader) {
  return readPersonalJsonModel(reader,EXPERIENCE_KEY,decodeExperiencePreferences,()=>({...EXPERIENCE_DEFAULTS}))
}

export function completeFirstAccess(persistence:PersonalPersistence, input:unknown):Promise<void> {
  const formats=validateDiscoveryFormats(input)
  return persistence.update(reader=>{
    if(!needsFirstAccess(reader,persistence.getMediaProgress())) {
      const model=readDiscoveryPreferences(reader),current=model.value.publicAccess
      if(!model.blocked&&current&&JSON.stringify(current.formats)===JSON.stringify(formats))return []
      throw new Error('Sua biblioteca mudou. Reabra seus dados antes de continuar.')
    }
    return [{key:EXPERIENCE_KEY,value:{...EXPERIENCE_DEFAULTS,publicAccess:{version:1,completed:true,formats}}}]
  })
}

export function saveDiscoveryPreferences(persistence:PersonalPersistence, input:unknown):Promise<void> {
  const formats=validateDiscoveryFormats(input)
  return persistence.update(reader=>updatePersonalJsonModel(reader,EXPERIENCE_KEY,
    decodeExperiencePreferences,()=>({...EXPERIENCE_DEFAULTS}),previous=>({...previous,
      publicAccess:{version:1 as const,completed:true as const,formats}})))
}
