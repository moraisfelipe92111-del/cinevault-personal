import { useEffect, useState } from 'react'

type FilmInfo = {
  tmdbId?: number
  originalTitle?: string
  overviewTmdb?: string
  tmdbVoteAverage?: number | null
  tmdbVoteCount?: number | null
  personalized?: boolean
}
type FilmDetails = Record<string, FilmInfo>

let cached: FilmDetails | null = null
let pending: Promise<FilmDetails> | null = null

// O JSON de centenas de sinopses sai do bundle inicial e só é buscado ao abrir a ficha.
function loadDetails(): Promise<FilmDetails> {
  if (cached) return Promise.resolve(cached)
  if (!pending) {
    pending = import('./filmDetails.json')
      .then(mod => {
        cached = mod.default as FilmDetails
        return cached
      })
      .catch((error: unknown) => {
        pending = null
        throw error
      })
  }
  return pending
}

export function Cv2FilmDetails({filmId}: {filmId:number}) {
  const [info, setInfo] = useState<FilmInfo | null>(() => cached?.[String(filmId)] ?? null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (filmId <= 317) return
    let active = true
    setInfo(cached?.[String(filmId)] ?? null)
    setFailed(false)
    void loadDetails().then(data => {
      if (active) setInfo(data[String(filmId)] ?? null)
    }).catch(() => {
      if (active) setFailed(true)
    })
    return () => { active = false }
  }, [filmId])
  if (filmId <= 317) return null
  if (failed) return <p className="muted">Não foi possível carregar os detalhes adicionais deste filme.</p>
  if (!info) return <p className="muted" role="status">Carregando dados do filme…</p>
  const rating = typeof info.tmdbVoteAverage === 'number' && Number.isFinite(info.tmdbVoteAverage)
    ? info.tmdbVoteAverage.toFixed(1) : null
  return <section className="cv2-movie-details" aria-label="Informações adicionais do filme">
    <h3>Sinopse</h3>
    <p>{info.overviewTmdb?.trim() || 'Sinopse em português ainda não disponível.'}</p>
    {info.originalTitle && <p><b>Título original:</b> {info.originalTitle}</p>}
    {rating && <p><b>Avaliação pública TMDb:</b> {rating}/10 · <small>Não representa sua nota pessoal</small></p>}
    <p className="cv2-source">Informações fornecidas pelo TMDb; este produto não é endossado pelo TMDb.</p>
  </section>
}
