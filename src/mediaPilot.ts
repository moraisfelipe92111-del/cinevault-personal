import {createMediaCatalog, validateMediaRecord, type MediaCatalog, type MediaRecord} from './mediaCatalog.ts'
import {parseMediaKey, validateMediaKey, type MediaKey} from './mediaIdentity.ts'
import {validateMediaProgressSnapshot, type MediaProgressSnapshot} from './mediaProgress.ts'

export const PILOT_FILTERS = ['Todos', 'Ficção', 'Animes', 'Realities', 'Documentários', 'Acompanhando'] as const
export type PilotFilter = typeof PILOT_FILTERS[number]
export type PilotItem = Readonly<{media: MediaRecord; sourceUrl: string; posterUrl: string; summary: string}>
export type PilotCatalog = Readonly<{items: readonly PilotItem[]; media: MediaCatalog; reviewedAt: string; licenseUrl: string}>

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('Catálogo piloto inválido ou não revisado.')
}
function exact(input: unknown, fields: readonly string[]): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).length === fields.length && fields.every(key => Object.hasOwn(input, key))
}

/** Reviewed data is packaged locally. No API call, credentials or personal data at import time. */
export function validatePilotCatalog(input: unknown): PilotCatalog {
  requireValue(exact(input, ['format','version','source','license','licenseUrl','reviewedAt','entries']))
  requireValue(input.format === 'sintonema.media-pilot' && input.version === 1 && input.source === 'TVmaze')
  requireValue(input.license === 'CC-BY-SA-4.0' && input.licenseUrl === 'https://creativecommons.org/licenses/by-sa/4.0/')
  requireValue(typeof input.reviewedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.reviewedAt) &&
    new Date(input.reviewedAt).toISOString().slice(0,10) === input.reviewedAt)
  requireValue(Array.isArray(input.entries) && input.entries.length > 0 && input.entries.length <= 100)
  const items = Object.freeze(Array.from(input.entries, value => {
    requireValue(exact(value, ['media','sourceUrl','posterUrl','summary']))
    const media = validateMediaRecord(value.media), identity = parseMediaKey(media.key)
    requireValue(identity.source === 'tvmaze' && identity.mediaType === 'tv' && media.legacyMovieId === null && media.aliases.length === 0)
    requireValue(typeof value.sourceUrl === 'string' &&
      new RegExp('^https://www\\.tvmaze\\.com/shows/'+identity.id+'/[a-z0-9-]+$').test(value.sourceUrl))
    requireValue(typeof value.posterUrl === 'string' && /^https:\/\/static\.tvmaze\.com\/uploads\/images\/medium_portrait\/[0-9]+\/[0-9]+\.jpg$/.test(value.posterUrl))
    requireValue(typeof value.summary === 'string' && value.summary.trim().length > 0 && value.summary.length <= 700 && !/[<>]/.test(value.summary))
    return Object.freeze({media, sourceUrl: value.sourceUrl, posterUrl: value.posterUrl, summary: value.summary})
  }))
  const media = createMediaCatalog(items.map(item => item.media))
  return Object.freeze({items, media, reviewedAt: input.reviewedAt, licenseUrl: input.licenseUrl})
}

export function pilotKind(media: MediaRecord): string {
  if (media.classifications.includes('anime')) return 'Anime'
  if (media.classifications.includes('reality')) return 'Reality'
  if (media.classifications.includes('documentary')) return 'Documentário'
  return 'Série'
}
const fold = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g,'')

/** Categories overlap, but each canonical record is returned at most once. */
export function filterPilot(catalog: PilotCatalog, query: string, filter: PilotFilter, progress: MediaProgressSnapshot): readonly PilotItem[] {
  requireValue((PILOT_FILTERS as readonly string[]).includes(filter) && typeof query === 'string')
  const saved = new Set(validateMediaProgressSnapshot(progress).entries.map(entry => entry.key)), search = fold(query)
  return Object.freeze(catalog.items.filter(item => {
    const {media} = item, c = media.classifications
    const category = filter === 'Todos' || (filter === 'Ficção' && !c.includes('reality') && !c.includes('documentary')) ||
      (filter === 'Animes' && c.includes('anime')) || (filter === 'Realities' && c.includes('reality')) ||
      (filter === 'Documentários' && c.includes('documentary')) || (filter === 'Acompanhando' && saved.has(media.key))
    return category && (!search || fold(media.title+' '+media.year+' '+pilotKind(media)+' '+item.summary).includes(search))
  }))
}

export function isPilotKey(catalog: PilotCatalog, key: MediaKey): boolean {
  return catalog.media.get(validateMediaKey(key)) !== null
}
