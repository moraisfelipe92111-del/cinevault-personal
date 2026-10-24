/** Typed identities are additive: the existing movie IDs keep their namespace. */
export type MediaSource = 'local' | 'tmdb'
export type MediaType = 'movie' | 'tv'
export type MediaKey = `${MediaSource}:${MediaType}:${number}`
export type MediaIdentity = Readonly<{ source: MediaSource; mediaType: MediaType; id: number }>
export type EpisodePosition = Readonly<{ season: number; episode: number }>

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function mediaKey(source: MediaSource, mediaType: MediaType, id: number): MediaKey {
  if ((source !== 'local' && source !== 'tmdb') || (mediaType !== 'movie' && mediaType !== 'tv') || !positiveInteger(id)) {
    throw new Error('Identidade audiovisual inválida')
  }
  return `${source}:${mediaType}:${id}`
}

/** Refuse coercion and alternate spellings: one identity has one serialized key. */
export function parseMediaKey(value: unknown): MediaIdentity {
  if (typeof value !== 'string') throw new Error('Identidade audiovisual inválida')
  const match = /^(local|tmdb):(movie|tv):([1-9][0-9]*)$/.exec(value)
  if (!match || !positiveInteger(Number(match[3]))) throw new Error('Identidade audiovisual inválida')
  const source = match[1] as MediaSource, mediaType = match[2] as MediaType, id = Number(match[3])
  if (mediaKey(source, mediaType, id) !== value) throw new Error('Identidade audiovisual inválida')
  return Object.freeze({source, mediaType, id})
}

export function validateMediaKey(value: unknown): MediaKey {
  const identity = parseMediaKey(value)
  return mediaKey(identity.source, identity.mediaType, identity.id)
}

export function legacyMovieKey(id: number): MediaKey { return mediaKey('local', 'movie', id) }

export function episodePosition(season: unknown, episode: unknown): EpisodePosition {
  if (typeof season !== 'number' || !Number.isSafeInteger(season) || season < 0 || Object.is(season, -0) || !positiveInteger(episode)) {
    throw new Error('Temporada ou episódio inválido')
  }
  return Object.freeze({season, episode})
}

/** Episode positions are scoped to a series; season zero can represent specials. */
export function episodeKey(series: MediaKey, season: number, episode: number): string {
  const key = validateMediaKey(series)
  if (parseMediaKey(key).mediaType !== 'tv') throw new Error('Episódios exigem uma série')
  const position = episodePosition(season, episode)
  return `${key}:season:${position.season}:episode:${position.episode}`
}
