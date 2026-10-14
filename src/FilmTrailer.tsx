import { useState } from 'react'
import { Play, X, Film } from 'lucide-react'
import trailerCatalog from './trailerCatalog.json'
import './film-trailer.css'

type Trailer = {
  tmdbId:number
  youtubeVideoId:string
  title:string
  provider:'YouTube'
  type:'Trailer'
  language:string
  region:string
  official:boolean
  dubbedStatus:'indicated_by_title'|'unknown'
  subtitlesIndicated:boolean
  checkedAt:string
}
const trailers=trailerCatalog as Record<string,Trailer|null>
const YOUTUBE_ID=/^[A-Za-z0-9_-]{11}$/

/** An embedded OFFICIAL YouTube player, loaded only on explicit user interaction.
 * This module never downloads/rehosts video or injects any third-party API keys.
 */
export function FilmTrailer({filmId,filmTitle}:{filmId:number,filmTitle:string}){
  const [open,setOpen]=useState(false)
  const trailer=trailers[String(filmId)]
  const usable=!!trailer && trailer.provider==='YouTube' && YOUTUBE_ID.test(trailer.youtubeVideoId)
  const lang=trailer?.language==='pt' ? trailer.region==='BR'?'Português brasileiro':'Português' : trailer?.language==='en'?'Idioma original / inglês':'Idioma não confirmado'
  return <section className="cv-trailer" aria-label={`Trailer de ${filmTitle}`}>
    <div className="cv-trailer-heading"><Film size={18}/><h3>Trailer</h3></div>
    {!usable ? <p className="cv-trailer-note">Trailer incorporável ainda não encontrado automaticamente para este filme.</p> : <>
      {!open && <button className="cv-trailer-watch" type="button" onClick={()=>setOpen(true)}>
        <Play size={18} fill="currentColor"/> Assistir ao trailer no CineVault
      </button>}
      <div className="cv-trailer-metadata">
        <span>{trailer.official?'Oficial segundo o TMDb':'Origem oficial não confirmada'}</span>
        <span>{trailer.dubbedStatus==='indicated_by_title'?'Dublagem indicada no título':trailer.subtitlesIndicated?'Legendado (indicado)':'Idioma: '+lang}</span>
      </div>
      {open && <div className="cv-trailer-player-area">
        <div className="cv-trailer-ratio">
          <iframe
            key={trailer.youtubeVideoId}
            title={`Trailer de ${filmTitle} — YouTube`}
            src={`https://www.youtube.com/embed/${trailer.youtubeVideoId}?playsinline=1&hl=pt-BR&rel=0`}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
        <button className="cv-trailer-close" type="button" onClick={()=>setOpen(false)}><X size={16}/> Fechar player</button>
        <p className="cv-trailer-note">Se o canal não permitir reprodução incorporada, o vídeo pode não abrir. O CineVault não contorna essa restrição.</p>
      </div>}
      <p className="cv-trailer-source">Fonte do vídeo: YouTube · referência de metadados: TMDb</p>
    </>}
  </section>
}
