/** CineVault 0.8 — validate completely before committing any imported state. */
import type { PosterMeta } from './tmdbAuto'
import { parsePulse, type PulseState } from './pulse.ts'

export type SavedBackup = {favorites:number[]; watched:number[]; ratings:Record<string,number>}
export type ParsedBackup = {
  saved: SavedBackup
  posters?: Record<string,string>
  posterMeta?: Record<string,PosterMeta>
  unresolved?: Record<string,string>
  pulse?: PulseState
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const tmdbPoster = /^https:\/\/image\.tmdb\.org\/t\/p\/w500\/[a-zA-Z0-9_\-/.]+$/
const tmdbPath = /^\/[a-zA-Z0-9_\-/.]+$/

/** Accepts legacy personal backups but never partially applies malformed data. */
export function parseBackup(raw: unknown, allowedIds: ReadonlySet<number>): ParsedBackup {
  if (!object(raw) || !Array.isArray(raw.favorites) || !Array.isArray(raw.watched) || !object(raw.ratings)) {
    throw new Error('Estrutura de backup inválida')
  }
  if (raw.version != null && (!Number.isInteger(raw.version) || Number(raw.version) < 1 || Number(raw.version) > 4)) {
    throw new Error('Versão do backup incompatível')
  }
  const optionalMap = (key: 'posters'|'posterMeta'|'unresolved') => {
    const value = raw[key]
    if (value !== undefined && !object(value)) throw new Error(`Campo ${key} inválido`)
    return value as Record<string, unknown> | undefined
  }
  // Validate optional maps before any React state mutation.
  if(raw.version === 4 && raw.pulse === undefined) throw new Error('Dados da experiência ausentes')
  const parsedPulse = raw.pulse === undefined ? undefined : parsePulse(raw.pulse,allowedIds)
  const rawPosters = optionalMap('posters')
  const rawMetadata = optionalMap('posterMeta')
  const rawUnresolved = optionalMap('unresolved')
  const validIds = (values: unknown[]): number[] => [...new Set(values.filter((id): id is number =>
    typeof id === 'number' && Number.isInteger(id) && allowedIds.has(id)))]
  const ratings: Record<string, number> = {}
  for (const [id, value] of Object.entries(raw.ratings)) {
    if (allowedIds.has(Number(id)) && typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5) ratings[id] = value
  }
  const parsed: ParsedBackup = {saved:{favorites:validIds(raw.favorites),watched:validIds(raw.watched),ratings},pulse:parsedPulse}
  if (rawPosters) {
    parsed.posters = {}
    for (const [id, value] of Object.entries(rawPosters)) {
      if (allowedIds.has(Number(id)) && typeof value === 'string' && tmdbPoster.test(value)) parsed.posters[id] = value
    }
  }
  if (rawMetadata) {
    parsed.posterMeta = {}
    for (const [id, value] of Object.entries(rawMetadata)) {
      if (!allowedIds.has(Number(id)) || !object(value) || typeof value.tmdbId !== 'number' || !Number.isFinite(value.tmdbId) || value.tmdbId <= 0 ||
          typeof value.posterPath !== 'string' || !tmdbPath.test(value.posterPath)) continue
      const year = Number(value.year ?? 0)
      const confidence = Number(value.confidence ?? 0)
      if (!Number.isFinite(year) || !Number.isFinite(confidence)) {
        throw new Error('Metadados de pôster com números inválidos')
      }
      const backdropPath = typeof value.backdropPath === 'string' && tmdbPath.test(value.backdropPath) ? value.backdropPath : null
      parsed.posterMeta[id] = {
        tmdbId: value.tmdbId,
        tmdbTitle: String(value.tmdbTitle || '').slice(0,200),
        year,
        posterPath: value.posterPath,
        backdropPath,
        overview: String(value.overview || '').slice(0,3000),
        confidence,
        checkedAt: String(value.checkedAt || ''),
      }
    }
  }
  if (rawUnresolved) {
    parsed.unresolved = {}
    for (const [id, value] of Object.entries(rawUnresolved)) {
      if (allowedIds.has(Number(id)) && typeof value === 'string') parsed.unresolved[id] = value.slice(0,250)
    }
  }
  return parsed
}
