import { legacyMovieKey, mediaKey, parseMediaKey, validateMediaKey, type MediaKey } from './mediaIdentity.ts'

export const MEDIA_CLASSIFICATIONS = Object.freeze([
  'anime', 'animation', 'documentary', 'reality', 'competition', 'telenovela', 'miniseries', 'short', 'special',
] as const)
export type MediaClassification = typeof MEDIA_CLASSIFICATIONS[number]
export type MediaRecord = Readonly<{
  key: MediaKey
  aliases: readonly MediaKey[]
  title: string
  year: number | null
  classifications: readonly MediaClassification[]
  runtimeMinutes: number | null
  runtimeScope: 'movie' | 'episode'
  legacyMovieId: number | null
}>
export type MediaCatalog = Readonly<{
  records: readonly MediaRecord[]
  get: (key: MediaKey) => MediaRecord | null
  getLegacyMovie: (id: number) => MediaRecord | null
  byClassification: (classification: MediaClassification) => readonly MediaRecord[]
}>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('Registro audiovisual inválido ou ambíguo')
}

/** The importer must supply reviewed classifications; titles never imply them. */
export function validateMediaRecord(input: unknown): MediaRecord {
  const keys = ['key', 'aliases', 'title', 'year', 'classifications', 'runtimeMinutes', 'runtimeScope', 'legacyMovieId']
  requireValue(record(input) && Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key)))
  const key = validateMediaKey(input.key), identity = parseMediaKey(key)
  requireValue(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 1000)
  requireValue(input.year === null || (typeof input.year === 'number' && Number.isInteger(input.year) && input.year >= 1800 && input.year <= 9999))
  requireValue(input.runtimeMinutes === null || (typeof input.runtimeMinutes === 'number' && Number.isFinite(input.runtimeMinutes) && input.runtimeMinutes > 0 && input.runtimeMinutes <= 10000))
  const runtimeScope = identity.mediaType === 'movie' ? 'movie' : 'episode'
  requireValue(input.runtimeScope === runtimeScope)
  requireValue(Array.isArray(input.aliases) && Array.isArray(input.classifications))
  const aliases = Array.from(input.aliases, validateMediaKey)
  requireValue(new Set([key, ...aliases]).size === aliases.length + 1)
  requireValue(aliases.every(alias => parseMediaKey(alias).mediaType === identity.mediaType))
  const classifications = Array.from(input.classifications, value => {
    requireValue(typeof value === 'string' && (MEDIA_CLASSIFICATIONS as readonly string[]).includes(value))
    return value as MediaClassification
  })
  requireValue(new Set(classifications).size === classifications.length)
  const legacy = input.legacyMovieId
  requireValue(legacy === null || (typeof legacy === 'number' && legacyMovieKey(legacy) === key))
  // Local identities are reserved for the preserved catalogue until a separate allocator exists.
  requireValue(identity.source !== 'local' || (identity.mediaType === 'movie' && legacy === identity.id))
  requireValue(aliases.every(alias => parseMediaKey(alias).source !== 'local'))
  return Object.freeze({key, aliases: Object.freeze(aliases), title: input.title, year: input.year as number | null,
    classifications: Object.freeze(classifications), runtimeMinutes: input.runtimeMinutes as number | null,
    runtimeScope, legacyMovieId: legacy as number | null})
}

/** A canonical work can belong to several categories without becoming several records. */
export function createMediaCatalog(input: readonly unknown[]): MediaCatalog {
  requireValue(Array.isArray(input))
  const records = Object.freeze(Array.from(input, validateMediaRecord)), index = new Map<MediaKey, MediaRecord>()
  for (const item of records) {
    for (const key of [item.key, ...item.aliases]) {
      requireValue(!index.has(key))
      index.set(key, item)
    }
  }
  return Object.freeze({records,
    get: (key: MediaKey) => index.get(validateMediaKey(key)) ?? null,
    getLegacyMovie: (id: number) => index.get(legacyMovieKey(id)) ?? null,
    byClassification: (classification: MediaClassification) => {
      requireValue((MEDIA_CLASSIFICATIONS as readonly string[]).includes(classification))
      return Object.freeze(records.filter(item => item.classifications.includes(classification)))
    }})
}

/** Add an index over the old catalogue. Never rewrite a film or guess an external ID/category. */
export function adaptLegacyMovieCatalog(films: readonly unknown[], reviewedTmdbIds: Readonly<Record<string, number>>): MediaCatalog {
  requireValue(Array.isArray(films) && record(reviewedTmdbIds))
  const localIds = new Set<number>()
  const items = Array.from(films, film => {
    requireValue(record(film) && typeof film.id === 'number' && typeof film.title === 'string' && typeof film.duration === 'string')
    const key = legacyMovieKey(film.id)
    requireValue(!localIds.has(film.id)); localIds.add(film.id)
    const linked = Object.hasOwn(reviewedTmdbIds, String(film.id)) ? reviewedTmdbIds[String(film.id)] : undefined
    const match = /^([1-9][0-9]*) min$/.exec(film.duration)
    return {key, aliases: linked === undefined ? [] : [mediaKey('tmdb', 'movie', linked)], title: film.title,
      year: film.year, classifications: [], runtimeMinutes: match ? Number(match[1]) : null,
      runtimeScope: 'movie', legacyMovieId: film.id}
  })
  for (const id of Object.keys(reviewedTmdbIds)) {
    requireValue(/^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)) && localIds.has(Number(id)))
  }
  return createMediaCatalog(items)
}
