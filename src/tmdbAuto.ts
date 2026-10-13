// CineVault 0.4.4 — resolução dos quatro últimos filmes por ID TMDb verificado.
// Não associa filmes somente pela semelhança de gênero, enredo ou ano.
export type CatalogFilm = { id: number; title: string; year: number }
export type TmdbMovie = {
  id: number; title: string; original_title?: string; release_date?: string;
  poster_path?: string | null; backdrop_path?: string | null; overview?: string;
}
export type PosterMeta = {
  tmdbId: number; tmdbTitle: string; year: number;
  posterPath: string; backdropPath: string | null; overview: string;
  confidence: number; checkedAt: string;
}
type SearchLanguage = 'pt-BR' | 'en-US'
type MatchResult = { matched?: TmdbMovie; confidence: number; ambiguous: boolean }
const API = 'https://api.themoviedb.org/3'
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export const normalizeTitle = (text: string): string => text.toLowerCase()
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/\s+/g, ' ')

export function titleVariants(title: string): string[] {
  const inside = [...title.matchAll(/\(([^)]+)\)/g)].map(m => m[1])
  const outside = title.replace(/\s*\([^)]*\)/g, '').trim()
  const raw = [
    ...inside.flatMap(group => group.split(/\s+\/\s+/)),
    outside, title,
    // Taglines and translations after a colon: keep as a fallback, not the primary query.
    ...(outside.includes(':') ? [outside.split(':')[0].trim()] : []),
  ]
  const seen = new Set<string>()
  return raw.map(x => x.trim()).filter(x => {
    const n = normalizeTitle(x)
    if (!n || seen.has(n)) return false
    seen.add(n)
    return true
  })
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prior = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const old = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, prior + (a[i - 1] === b[j - 1] ? 0 : 1))
      prior = old
    }
  }
  return prev[b.length]
}

function titleSimilarity(known: string, actual: string): number {
  if (!known || !actual) return 0
  if (known === actual) return 1
  // Only near-identical spellings qualify. Broad word overlap is unsafe for remakes.
  if (Math.min(known.length, actual.length) < 8) return 0
  const similarity = 1 - editDistance(known, actual) / Math.max(known.length, actual.length)
  return similarity >= 0.94 ? similarity : 0
}

function scoreAgainstTitles(film: CatalogFilm, movie: TmdbMovie, titles: string[]): number {
  if (!movie.poster_path || !movie.release_date) return 0
  const year = Number(movie.release_date.slice(0, 4))
  if (!Number.isFinite(year) || Math.abs(film.year - year) > 1) return 0
  const names = titleVariants(film.title).map(normalizeTitle)
  const actual = titles.map(normalizeTitle).filter(Boolean)
  let similarity = 0
  for (const a of names) for (const b of actual) {
    similarity = Math.max(similarity, titleSimilarity(a, b))
  }
  if (similarity < 0.94) return 0
  // Year + title required. Title equality can tolerate a 1-year release discrepancy.
  return Math.min(1, similarity * (film.year === year ? 1 : 0.96))
}

export function matchScore(film: CatalogFilm, movie: TmdbMovie): number {
  return scoreAgainstTitles(film, movie, [movie.title, movie.original_title || ''])
}

export function selectMatch(film: CatalogFilm, candidates: TmdbMovie[]): MatchResult {
  return chooseByScore(candidates.map(movie => ({ movie, confidence: matchScore(film, movie) })))
}

function chooseByScore(ranked: { movie: TmdbMovie; confidence: number }[]): MatchResult {
  const sorted = ranked.filter(x => x.confidence >= 0.94).sort((a, b) => b.confidence - a.confidence)
  const best = sorted[0]
  if (!best) return { confidence: 0, ambiguous: false }
  const second = sorted.find(x => x.movie.id !== best.movie.id)
  // Treat near-equivalent competing films as ambiguous: never guess a remake.
  if (second && best.confidence - second.confidence < 0.06) {
    return { confidence: best.confidence, ambiguous: true }
  }
  return { matched: best.movie, confidence: best.confidence, ambiguous: false }
}

async function fetchTmdb<T>(path: string, params: URLSearchParams, token: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response
    try {
      res = await fetch(`${API}${path}?${params}`, {
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
        cache: 'no-store',
      })
    } catch {
      if (attempt === 3) throw Error('Sem conexão com o TMDb. Verifique sua internet e retome depois.')
      await pause((attempt + 1) * 1500)
      continue
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 3) throw Error(`TMDb temporariamente indisponível (${res.status}). Retome mais tarde.`)
      const retryAfter = Number(res.headers.get('Retry-After'))
      const seconds = Math.min(15, Math.max(2, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : (2 ** attempt) * 2))
      await pause(seconds * 1000)
      continue
    }
    if (res.status === 401 || res.status === 403) throw Error('Token TMDb inválido ou sem permissão.')
    if (!res.ok) throw Error(`Consulta TMDb falhou (HTTP ${res.status}).`)
    return await res.json() as T
  }
  throw Error('Não foi possível consultar o TMDb.')
}

async function search(query: string, language: SearchLanguage, token: string): Promise<TmdbMovie[]> {
  const params = new URLSearchParams({ query, language, include_adult: 'false', page: '1' })
  const result = await fetchTmdb<{ results?: TmdbMovie[] }>('/search/movie', params, token)
  return Array.isArray(result.results) ? result.results : []
}

type AltTitle = { title?: string; iso_3166_1?: string }
async function alternativeTitles(id: number, token: string): Promise<string[]> {
  const result = await fetchTmdb<{ titles?: AltTitle[] }>(`/movie/${id}/alternative_titles`, new URLSearchParams(), token)
  return (result.titles || []).map(x => x.title || '').filter(Boolean)
}

function betterCandidate(existing: TmdbMovie | undefined, incoming: TmdbMovie): TmdbMovie {
  if (!existing) return incoming
  return {
    ...existing, ...incoming,
    // Keep an overview in Portuguese if the result in the other language has none.
    overview: existing.overview || incoming.overview || '',
    poster_path: incoming.poster_path || existing.poster_path,
    backdrop_path: incoming.backdrop_path || existing.backdrop_path,
  }
}

export async function autoIdentify(film: CatalogFilm, token: string): Promise<{ meta?: PosterMeta; reason?: string }> {
  const verified = VERIFIED_FOUR[film.id]
  if (verified && verified.catalogYear === film.year) return identifyVerified(film, token, verified)
  const curated = CURATED[film.id]
  if (curated && curated.year === film.year) return identifyCurated(film, token, curated)
  const names = titleVariants(film.title).slice(0, 5)
  const pool = new Map<number, TmdbMovie>()
  let sawCandidates = false

  // Search both PT-BR and EN-US — TMDb can index the same title differently in each locale.
  // Up to 6 searches, no unbounded loops or blind fuzzy matching.
  const requests: { query: string; language: SearchLanguage }[] = []
  for (const name of names) {
    requests.push({ query: name, language: 'pt-BR' })
    requests.push({ query: name, language: 'en-US' })
  }
  const seenRequests = new Set<string>()
  for (const req of requests) {
    const k = `${req.language}:${normalizeTitle(req.query)}`
    if (seenRequests.has(k) || seenRequests.size >= 8) continue
    seenRequests.add(k)
    const results = await search(req.query, req.language, token)
    if (results.length) sawCandidates = true
    for (const movie of results) pool.set(movie.id, betterCandidate(pool.get(movie.id), movie))
    await pause(180)
  }

  let choice = selectMatch(film, [...pool.values()])
  if (!choice.matched) {
    // Second chance: check TMDb's official alternative titles, but only for plausible
    // candidates of the correct release period. Exact alternative-title equality required.
    const nearYear = [...pool.values()].filter(movie => {
      const y = Number((movie.release_date || '').slice(0, 4))
      return !!movie.poster_path && Number.isFinite(y) && Math.abs(y - film.year) <= 1
    })
    const known = new Set(names.map(normalizeTitle))
    const scored: { movie: TmdbMovie; confidence: number }[] = []
    // Cap requests so an obscure film does not cause hundreds of network calls.
    for (const movie of nearYear.slice(0, 5)) {
      const direct = matchScore(film, movie)
      let score = direct
      if (score < 0.94) {
        const alternatives = await alternativeTitles(movie.id, token)
        if (alternatives.some(x => known.has(normalizeTitle(x)))) {
          score = film.year === Number(movie.release_date?.slice(0, 4)) ? 1 : 0.96
        }
        await pause(180)
      }
      scored.push({ movie, confidence: score })
    }
    const altChoice = chooseByScore(scored)
    if (altChoice.matched || altChoice.ambiguous) choice = altChoice
  }

  if (!choice.matched) {
    return { reason: choice.ambiguous
      ? 'Múltiplas correspondências possíveis (revisão necessária)'
      : sawCandidates ? 'Sem equivalência segura de título e ano no TMDb' : 'Nenhum resultado encontrado nas buscas PT/EN' }
  }
  const movie = choice.matched
  return { meta: {
    tmdbId: movie.id, tmdbTitle: movie.title, year: Number((movie.release_date || '').slice(0, 4)),
    posterPath: movie.poster_path || '', backdropPath: movie.backdrop_path || null,
    overview: movie.overview || '', confidence: choice.confidence, checkedAt: new Date().toISOString(),
  } }
}


// CineVault 0.4.3 — mapeamento de candidatos, NÃO de identificadores TMDb.
// Toda associação é verificada ao vivo pelo TMDb: título + ano + diretor nos créditos.
// NENHUM ID TMDb ou caminho de pôster é inventado ou definido aqui.
type CuratedHint = { year: number; director: string; queries: string[] }
const CURATED: Record<number, CuratedHint> = {
  12: {year: 2008, director: "Na Hong-jin", queries: ["The Chaser"] },
  23: {year: 2015, director: "Joel Edgerton", queries: ["The Gift"] },
  33: {year: 2016, director: "David Mackenzie", queries: ["Hell or High Water"] },
  53: {year: 2016, director: "Denis Villeneuve", queries: ["Arrival"] },
  72: {year: 2012, director: "Scott Derrickson", queries: ["Sinister"] },
  73: {year: 2013, director: "Mike Flanagan", queries: ["Oculus"] },
  75: {year: 2022, director: "Danny Philippou", queries: ["Talk to Me"] },
  78: {year: 2011, director: "Adam Wingard", queries: ["You're Next", "Youre Next"] },
  79: {year: 2019, director: "Matt Bettinelli-Olpin", queries: ["Ready or Not"] },
  81: {year: 2022, director: "Parker Finn", queries: ["Smile"] },
  92: {year: 2017, director: "Jang Hang-jun", queries: ["Forgotten", "기억의 밤"] },
  112: {year: 2020, director: "David Pastor", queries: ["The Occupant", "Hogar"] },
  118: {year: 2012, director: "Thomas Vinterberg", queries: ["The Hunt", "Jagten"] },
  132: {year: 2017, director: "Xavier Legrand", queries: ["Custody", "Jusqu'à la garde"] },
  134: {year: 2016, director: "Paul Verhoeven", queries: ["Elle"] },
  138: {year: 2008, director: "Roger Donaldson", queries: ["The Bank Job"] },
  198: {year: 2019, director: "Sam Mendes", queries: ["1917"] },
  220: {year: 2014, director: "James Marsh", queries: ["The Theory of Everything"] },
  221: {year: 2013, director: "Richard Curtis", queries: ["About Time"] },
  225: {year: 2004, director: "Michel Gondry", queries: ["Eternal Sunshine of the Spotless Mind"] },
  234: {year: 2018, director: "Baltasar Kormákur", queries: ["Adrift"] },
  255: {year: 2021, director: "Ilya Naishuller", queries: ["Nobody"] },
  262: {year: 1987, director: "Paul Michael Glaser", queries: ["The Running Man"] },
  265: {year: 2023, director: "David Fincher", queries: ["The Killer"] },
  268: {year: 2022, director: "Mark Mylod", queries: ["The Menu"] },
  272: {year: 2023, director: "Chloe Domont", queries: ["Fair Play"] },
  281: {year: 2025, director: "Drew Hancock", queries: ["Companion"] },
  290: {year: 2021, director: "Denis Villeneuve", queries: ["Dune"] },
}

type Credit = { job?: string; name?: string }
type MovieDetails = TmdbMovie & { credits?: { crew?: Credit[] } }

// Resolve homônimos por diretor. Se houver dúvida, NÃO vincula capa.
async function identifyCurated(film: CatalogFilm, token: string, hint: CuratedHint): Promise<{ meta?: PosterMeta; reason?: string }> {
  const pool = new Map<number, TmdbMovie>()
  const queries = [...new Set(hint.queries.map(q => q.trim()).filter(Boolean))].slice(0, 3)
  for (const q of queries) {
    for (const language of ['en-US', 'pt-BR'] as const) {
      const results = await search(q, language, token)
      for (const item of results) {
        const releaseYear = Number((item.release_date || '').slice(0, 4))
        if (!item.poster_path || !Number.isFinite(releaseYear) || Math.abs(film.year - releaseYear) > 1) continue
        const recognized = [item.title, item.original_title || ''].some(t =>
          queries.some(query => normalizeTitle(query) === normalizeTitle(t)))
        if (!recognized) continue
        pool.set(item.id, betterCandidate(pool.get(item.id), item))
      }
      await pause(180)
    }
  }
  if (!pool.size) return { reason: 'Busca por título original: nenhum candidato com título, ano e pôster compatíveis.' }

  const matches: MovieDetails[] = []
  // Ordem estável, nunca escolhe pelo primeiro resultado/popularidade.
  // Máximo de 10 consultas aos créditos por título.
  const possibles = [...pool.values()].sort((a, b) => {
    const ya = Number((a.release_date || '').slice(0, 4))
    const yb = Number((b.release_date || '').slice(0, 4))
    return Math.abs(film.year - ya) - Math.abs(film.year - yb)
  }).slice(0, 10)
  for (const movie of possibles) {
    const params = new URLSearchParams({ language: 'pt-BR', append_to_response: 'credits' })
    const details = await fetchTmdb<MovieDetails>(`/movie/${movie.id}`, params, token)
    const people = (details.credits?.crew || []).filter(p => p.job === 'Director')
    const expected = normalizeTitle(hint.director)
    if (people.some(p => normalizeTitle(p.name || '') === expected)) {
      matches.push(details)
    }
    await pause(180)
  }
  if (matches.length !== 1) return { reason: matches.length === 0
    ? `Título e ano encontrados, mas diretor não confirmado no TMDb (esperado: ${hint.director}).`
    : `Mais de um filme com o mesmo título, ano e diretor (${matches.length} opções).` }

  const movie = matches[0]
  const releaseYear = Number((movie.release_date || '').slice(0, 4))
  if (!movie.poster_path || Math.abs(releaseYear - film.year) > 1) return { reason: 'Correspondência recusada: sem pôster ou ano incompatível.' }
  return {meta: {
    tmdbId: movie.id,
    tmdbTitle: movie.title,
    year: releaseYear,
    posterPath: movie.poster_path,
    backdropPath: movie.backdrop_path || null,
    overview: movie.overview || '',
    confidence: releaseYear === film.year ? 1 : 0.98,
    checkedAt: new Date().toISOString(),
  } }
}


// CineVault 0.4.4 — somente os quatro casos auditados (IDs confirmados em fontes externas).
// Consulta /movie/{id} diretamente, sem confiar em resultados homônimos de /search/movie.
// O ano 2011 de You're Next é o de sua estreia em festival; o TMDb usa 2013.
type VerifiedHint = {
  catalogYear: number
  tmdbId: number
  names: string[]
  releaseYears: number[]
  directors: string[]
}
const VERIFIED_FOUR: Record<number, VerifiedHint> = {
  12: {catalogYear: 2008, tmdbId: 13855, names: ['The Chaser', 'O Caçador', '추격자'], releaseYears: [2008], directors: ['Na Hong-jin', 'Hong-jin Na']},
  78: {catalogYear: 2011, tmdbId: 83899, names: ["You're Next", 'Você é o Próximo'], releaseYears: [2011, 2013], directors: ['Adam Wingard']},
  92: {catalogYear: 2017, tmdbId: 488623, names: ['Forgotten', '기억의 밤', 'Night of Memory'], releaseYears: [2017], directors: ['Jang Hang-jun', 'Chang Hang-jun']},
  255: {catalogYear: 2021, tmdbId: 615457, names: ['Nobody', 'Anônimo'], releaseYears: [2021], directors: ['Ilya Naishuller']},
}

async function identifyVerified(_film: CatalogFilm, token: string, hint: VerifiedHint): Promise<{ meta?: PosterMeta; reason?: string }> {
  // Mantém a verificação da identidade mesmo com ID conhecido, evitando uma capa errada.
  const details = await fetchTmdb<MovieDetails>(`/movie/${hint.tmdbId}`,
    new URLSearchParams({ language: 'en-US', append_to_response: 'credits' }), token)
  if (details.id !== hint.tmdbId) return {reason: 'Identificador TMDb retornado não corresponde ao filme esperado.'}

  const validNames = hint.names.map(normalizeTitle)
  const supplied = [details.title, details.original_title || ''].map(normalizeTitle)
  if (!supplied.some(title => validNames.includes(title))) {
    return {reason: 'Título recebido do TMDb diverge do título oficial previamente verificado.'}
  }

  const releaseYear = Number((details.release_date || '').slice(0, 4))
  if (!Number.isInteger(releaseYear) || !hint.releaseYears.includes(releaseYear)) {
    return {reason: `Ano do TMDb (${details.release_date || 'N/D'}) diferente do esperado.`}
  }
  if (!details.poster_path || !/^\/[A-Za-z0-9_.-]+$/.test(details.poster_path)) {
    return {reason: 'Registro correto localizado, mas não possui pôster válido.'}
  }

  const directors = (details.credits?.crew || []).filter(person => person.job === 'Director')
  // Se os créditos estiverem disponíveis, exigimos diretor correto.
  // Sem créditos disponíveis, validamos apenas ID, título e ano.
  if (directors.length > 0 && !directors.some(person =>
    hint.directors.some(expected => normalizeTitle(person.name || '') === normalizeTitle(expected)))) {
    return {reason: 'Diretor do registro do TMDb não corresponde ao filme esperado.'}
  }

  return {meta: {
    tmdbId: details.id,
    tmdbTitle: details.title,
    year: releaseYear,
    posterPath: details.poster_path,
    backdropPath: details.backdrop_path || null,
    overview: details.overview || '',
    confidence: 1,
    checkedAt: new Date().toISOString(),
  }}
}
