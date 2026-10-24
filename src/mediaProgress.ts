import { episodePosition, parseMediaKey, validateMediaKey, type EpisodePosition, type MediaKey } from './mediaIdentity.ts'

export const MEDIA_STATUSES = Object.freeze(['want_to_watch', 'watching', 'completed', 'paused', 'abandoned'] as const)
export type MediaStatus = typeof MEDIA_STATUSES[number]
export type MediaProgress = Readonly<{key: MediaKey; status: MediaStatus; watchedEpisodes: readonly EpisodePosition[]}>
export type MediaProgressSnapshot = Readonly<{format: 'sintonema.media-progress'; version: 1; entries: readonly MediaProgress[]}>

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('Progresso audiovisual inválido ou incompatível')
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function validateMediaProgress(input: unknown): MediaProgress {
  requireValue(exact(input, ['key', 'status', 'watchedEpisodes']))
  const key = validateMediaKey(input.key), mediaType = parseMediaKey(key).mediaType
  requireValue(typeof input.status === 'string' && (MEDIA_STATUSES as readonly string[]).includes(input.status))
  requireValue(Array.isArray(input.watchedEpisodes) && (mediaType === 'tv' || input.watchedEpisodes.length === 0))
  const positions = Array.from(input.watchedEpisodes, value => {
    requireValue(exact(value, ['season', 'episode']))
    return episodePosition(value.season, value.episode)
  })
  requireValue(new Set(positions.map(value => `${value.season}:${value.episode}`)).size === positions.length)
  // Keep all positions, even when a later/partial catalogue does not know the episode yet.
  return Object.freeze({key, status: input.status as MediaStatus, watchedEpisodes: Object.freeze(positions)})
}

export function validateMediaProgressSnapshot(input: unknown): MediaProgressSnapshot {
  requireValue(exact(input, ['format', 'version', 'entries']) && input.format === 'sintonema.media-progress' && input.version === 1 && Array.isArray(input.entries))
  const entries = Array.from(input.entries, validateMediaProgress)
  requireValue(new Set(entries.map(entry => entry.key)).size === entries.length)
  return Object.freeze({format: 'sintonema.media-progress', version: 1, entries: Object.freeze(entries)})
}

export function emptyMediaProgressSnapshot(): MediaProgressSnapshot {
  return Object.freeze({format: 'sintonema.media-progress', version: 1, entries: Object.freeze([])})
}

export function setMediaStatus(input: unknown, status: MediaStatus): MediaProgress {
  const current = validateMediaProgress(input)
  return validateMediaProgress({...current, status})
}

/** Completing an episode/season never silently declares the whole series completed. */
export function setEpisodeWatched(input: unknown, season: number, episode: number, watched: boolean): MediaProgress {
  const current = validateMediaProgress(input), position = episodePosition(season, episode)
  requireValue(parseMediaKey(current.key).mediaType === 'tv' && typeof watched === 'boolean')
  const exists = current.watchedEpisodes.some(value => value.season === season && value.episode === episode)
  if (exists === watched) return current
  const positions = current.watchedEpisodes.filter(value => value.season !== season || value.episode !== episode)
  if (watched) positions.push(position)
  positions.sort((a, b) => a.season - b.season || a.episode - b.episode)
  return validateMediaProgress({...current, watchedEpisodes: positions})
}

/** Unknown episode counts are unknown; an empty list cannot prove completion. */
export function summarizeSeason(input: unknown, season: number, knownEpisodes: readonly number[] | null) {
  const current = validateMediaProgress(input)
  requireValue(parseMediaKey(current.key).mediaType === 'tv')
  episodePosition(season, 1)
  const watched = current.watchedEpisodes.filter(value => value.season === season)
  if (knownEpisodes === null) return Object.freeze({watched: watched.length, known: null, complete: null})
  requireValue(Array.isArray(knownEpisodes))
  for (const episode of knownEpisodes) episodePosition(season, episode)
  requireValue(new Set(knownEpisodes).size === knownEpisodes.length)
  const watchedNumbers = new Set(watched.map(value => value.episode))
  const watchedCount = knownEpisodes.filter(episode => watchedNumbers.has(episode)).length
  return Object.freeze({watched: watchedCount, known: knownEpisodes.length,
    complete: knownEpisodes.length === 0 ? null : watchedCount === knownEpisodes.length})
}
