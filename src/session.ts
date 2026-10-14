/** CineVault 0.8 — transparent, deterministic personal film-night curation. */
export type SessionMood = 'Todos' | 'Suspense intenso' | 'Emocional' | 'Investigação' | 'Terror' | 'Ação' | 'Surpreendente'
export type SessionDuration = 'Qualquer' | '110' | '140'

export type SessionFilm = {
  id: number
  title: string
  genre: string
  director: string
  priority: string
  duration: string
  tension: number
  emotion: number
  twist: string
  year: number
}
export type SessionProfile = {
  watched: readonly number[]
  favorites: readonly number[]
  ratings: Readonly<Record<string, number>>
}
export type SessionOptions = {
  mood: SessionMood
  duration: SessionDuration
  round: number
}
const priorityWeight: Record<string, number> = { S: 42, A: 30, B: 20, C: 10, D: 3 }
const norm = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const tags = (film: SessionFilm) => film.genre.split('/').map(g => norm(g.trim())).filter(Boolean)

export function durationMinutes(duration: string): number | null {
  const match = /\b(\d{2,3})\s*min\b/i.exec(duration)
  if (!match) return null
  const value = Number(match[1])
  return value >= 30 && value <= 360 ? value : null
}

export function matchesMood(film: SessionFilm, mood: SessionMood): boolean {
  const genre = norm(film.genre)
  switch (mood) {
    case 'Todos': return true
    case 'Suspense intenso': return film.tension >= 8
    case 'Emocional': return film.emotion >= 7
    case 'Investigação': return /investigacao|misterio|crime|policial/.test(genre)
    case 'Terror': return /terror|horror/.test(genre)
    case 'Ação': return /acao|aventura/.test(genre)
    case 'Surpreendente': return /forte|insana|imprevisivel|surpreendente/i.test(norm(film.twist))
  }
}

function preferenceGenres<T extends SessionFilm>(catalog: readonly T[], profile: SessionProfile): Map<string, number> {
  const map = new Map<string, number>()
  const favorite = new Set(profile.favorites)
  for (const film of catalog) {
    const rating = profile.ratings[String(film.id)]
    const liked = favorite.has(film.id) || (Number.isFinite(rating) && rating >= 4)
    if (!liked) continue
    for (const tag of tags(film)) map.set(tag, (map.get(tag) || 0) + (favorite.has(film.id) ? 2 : 1))
  }
  return map
}

/** Returns up to 3 varied, unviewed films, without network calls or mutation. */
export function selectSession<T extends SessionFilm>(catalog: readonly T[], profile: SessionProfile, options: SessionOptions, count = 3): T[] {
  if (count < 1 || !Number.isInteger(count)) return []
  const watched = new Set(profile.watched)
  const favorites = new Set(profile.favorites)
  const preferred = preferenceGenres(catalog, profile)
  const maximum = options.duration === 'Qualquer' ? Infinity : Number(options.duration)
  const candidates = catalog.filter(f => {
    if (watched.has(f.id) || !matchesMood(f, options.mood)) return false
    const minutes = durationMinutes(f.duration)
    return maximum === Infinity || (minutes !== null && minutes <= maximum)
  })
  const scored = candidates.map(film => {
    const affinity = tags(film).reduce((sum, tag) => sum + Math.min(12, (preferred.get(tag) || 0) * 3), 0)
    const score = (priorityWeight[film.priority] || 0) + affinity + Math.min(10, film.tension) * 0.7 + Math.min(10, film.emotion) * 0.4 + (favorites.has(film.id) ? 14 : 0)
    return { film, score }
  }).sort((a, b) => b.score - a.score || a.film.id - b.film.id)
  if (!scored.length) return []
  const offset = (Math.max(0, Math.floor(options.round)) * 3) % scored.length
  const rotated = scored.slice(offset).concat(scored.slice(0, offset))
  const result: T[] = []
  const directors = new Set<string>()
  for (const candidate of rotated) {
    if (result.length >= count) break
    const director = norm(candidate.film.director.trim())
    if (director && directors.has(director)) continue
    result.push(candidate.film)
    if (director) directors.add(director)
  }
  for (const candidate of rotated) {
    if (result.length >= count) break
    if (!result.some(f => f.id === candidate.film.id)) result.push(candidate.film)
  }
  return result
}

export function sessionReason(film: SessionFilm, mood: SessionMood): string {
  const prefix: Record<SessionMood, string> = {
    'Todos': 'Um destaque do seu ranking',
    'Suspense intenso': 'Tensão para prender a atenção',
    'Emocional': 'Uma história com carga emocional',
    'Investigação': 'Mistério e pistas para acompanhar',
    'Terror': 'Para uma sessão mais sombria',
    'Ação': 'Ritmo e adrenalina',
    'Surpreendente': 'Uma escolha com potencial de surpreender',
  }
  return `${prefix[mood]} · prioridade ${film.priority} · ${film.duration}`
}
