import type { SonicStyle } from './sonic.ts'

export const EXPERIENCE_KEY = 'cinevault.experience.v1'
export const DISCOVERY_FORMATS = [
  {id:'movies', label:'Filmes'}, {id:'series', label:'Séries'}, {id:'anime', label:'Animes'},
  {id:'reality', label:'Reality shows'}, {id:'documentary', label:'Documentários'},
] as const
export type DiscoveryFormat = typeof DISCOVERY_FORMATS[number]['id']
export type PublicAccess = {version:1; completed:true; formats:DiscoveryFormat[]}
export type ExperiencePreferences = {
  intro:boolean; sound:boolean; updates:boolean; sonic:SonicStyle; volume:number; publicAccess?:PublicAccess
}
export const EXPERIENCE_DEFAULTS:ExperiencePreferences = {intro:true,sound:true,updates:true,sonic:'signature',volume:.60}

export function validateDiscoveryFormats(input:unknown):DiscoveryFormat[] {
  if(!Array.isArray(input)||input.length>DISCOVERY_FORMATS.length||
    input.some(value=>!DISCOVERY_FORMATS.some(option=>option.id===value))||new Set(input).size!==input.length)
    throw new Error('Preferências de exploração inválidas.')
  return [...input] as DiscoveryFormat[]
}

function decodePublicAccess(input:unknown):PublicAccess {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Primeiro acesso inválido.')
  const value=input as Record<string,unknown>
  if(Object.keys(value).length!==3||value.version!==1||value.completed!==true||!Object.hasOwn(value,'formats'))
    throw new Error('Versão de primeiro acesso não suportada.')
  return {version:1,completed:true,formats:validateDiscoveryFormats(value.formats)}
}

/** Legacy defaults and normalization stay compatible; unknown fields remain guarded by the JSON model. */
export function decodeExperiencePreferences(parsed:unknown):ExperiencePreferences {
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {...EXPERIENCE_DEFAULTS}
  const value=parsed as Partial<ExperiencePreferences>
  return {
    intro:value.intro!==false, sound:value.sound!==false, updates:value.updates!==false,
    sonic:(['signature','noir','impacto'] as string[]).includes(String(value.sonic)) ? value.sonic as SonicStyle :
      String(value.sonic)==='aura'?'noir':'signature',
    volume:typeof value.volume==='number'&&Number.isFinite(value.volume)?Math.min(1,Math.max(.15,value.volume)):.65,
    ...(Object.hasOwn(parsed,'publicAccess')?{publicAccess:decodePublicAccess(value.publicAccess)}:{}),
  }
}
