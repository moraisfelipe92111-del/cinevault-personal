import {useDeferredValue, useMemo, useState, useSyncExternalStore} from 'react'
import {BookOpen, Check, ChevronLeft, Clapperboard, ExternalLink, Search, X} from 'lucide-react'
import type {PersonalPersistence} from './personalPersistence.ts'
import {MEDIA_STATUSES, type MediaStatus} from './mediaProgress.ts'
import {editMediaProgress, episodeInputs, type MediaProgressEdit} from './mediaProgressActions.ts'
import {filterPilot, PILOT_FILTERS, pilotKind, validatePilotCatalog, type PilotFilter, type PilotItem} from './mediaPilot.ts'
import pilotData from './mediaPilotData.json'
import './MediaExplorer.css'

const catalog = validatePilotCatalog(pilotData)
const labels: Record<MediaStatus,string> = {want_to_watch:'Quero assistir', watching:'Assistindo', completed:'Concluído', paused:'Pausado', abandoned:'Abandonado'}

function Poster({item}:{item:PilotItem}) {
  const [failed,setFailed]=useState(false)
  return <div className="cv-media-poster">{!failed ? <img loading="lazy" decoding="async" src={item.posterUrl} alt={`Pôster de ${item.media.title}`} onError={()=>setFailed(true)}/> : <><Clapperboard size={30}/><span>{item.media.title}</span></>}</div>
}

export default function MediaExplorer({persistence,notify}:{persistence:PersonalPersistence;notify:(message:string)=>void}) {
  const state=useSyncExternalStore(persistence.subscribe,persistence.getStatus,persistence.getStatus)
  const [query,setQuery]=useState(''),[filter,setFilter]=useState<PilotFilter>('Todos'),[selected,setSelected]=useState<PilotItem|null>(null)
  const [season,setSeason]=useState('1'),[episode,setEpisode]=useState('1'),[busy,setBusy]=useState(false)
  const deferred=useDeferredValue(query), progress=persistence.getMediaProgress()
  const visible=useMemo(()=>filterPilot(catalog,deferred,filter,progress),[deferred,filter,progress])
  const current=selected ? progress.entries.find(entry=>entry.key===selected.media.key) : undefined
  const position=(()=>{try{return episodeInputs(season,episode)}catch{return null}})()
  const alreadyWatched=Boolean(position&&current?.watchedEpisodes.some(p=>p.season===position.season&&p.episode===position.episode))
  const disabled=busy||state.phase!=='ready'||!persistence.mediaEnabled
  const save=async(edit:MediaProgressEdit)=>{
    if(!selected||disabled)return
    const key=selected.media.key
    setBusy(true)
    try{await persistence.updateMedia(snapshot=>({progress:editMediaProgress(snapshot,key,edit)}));notify('Acompanhamento salvo.')}
    catch(error){notify(error instanceof Error?error.message:'Não foi possível salvar o acompanhamento.')}
    finally{setBusy(false)}
  }
  const source=async(url:string)=>{
    try{const {Browser}=await import('@capacitor/browser');await Browser.open({url})}
    catch{notify('Não foi possível abrir a fonte agora.')}
  }
  return <section className="cv-media" aria-label="Séries e programas">
    {selected ? <>
      <button className="cv-media-back" onClick={()=>setSelected(null)}><ChevronLeft size={18}/> Voltar ao catálogo</button>
      <div className="cv-media-detail"><Poster key={selected.media.key} item={selected}/><div><span className="eyebrow">{pilotKind(selected.media)}</span><h2>{selected.media.title}</h2><p className="muted">{selected.media.year} · Episódios e temporadas</p><p>{selected.summary}</p><button className="cv-media-source" onClick={()=>void source(selected.sourceUrl)}>Ficha no TVmaze <ExternalLink size={14}/></button></div></div>
      <section className="cv-media-progress" aria-label={`Acompanhar ${selected.media.title}`}>
        <header><BookOpen size={21}/><div><h3>Sua próxima história</h3><p>Guarde onde parou e acompanhe no seu ritmo.</p></div></header>
        {!persistence.mediaEnabled&&<p className="cv-media-note" role="status">O acompanhamento de séries está disponível no aplicativo. Você pode explorar os títulos neste navegador.</p>}
        <label>Seu acompanhamento<select aria-label="Seu acompanhamento" disabled={disabled} value={current?.status??''} onChange={event=>void save({type:'status',status:event.target.value as MediaStatus})}>
          <option value="" disabled>Escolher estado</option>{MEDIA_STATUSES.map(status=><option key={status} value={status}>{labels[status]}</option>)}
        </select></label>
        <form onSubmit={event=>{event.preventDefault();if(position)void save({type:'episode',...position,watched:!alreadyWatched})}}>
          <fieldset disabled={disabled}><legend>Episódios que você assistiu</legend><div className="cv-media-episode-fields"><label>Temporada<input aria-label="Temporada" type="number" min="0" step="1" required value={season} onChange={event=>setSeason(event.target.value)}/></label><label>Episódio<input aria-label="Episódio" type="number" min="1" step="1" required value={episode} onChange={event=>setEpisode(event.target.value)}/></label></div>
          <button className="primary" disabled={!position} type="submit">{alreadyWatched?<X size={16}/>:<Check size={16}/>} {alreadyWatched?'Desmarcar episódio':'Marcar episódio'}</button></fieldset>
        </form>
        <p className="cv-media-note">Temporada 0 representa especiais. Marcar episódios não conclui a série inteira; escolha “Concluído” quando quiser encerrar seu acompanhamento.</p>
        <div className="cv-media-watched" aria-live="polite"><strong>{current?.watchedEpisodes.length??0} episódios marcados</strong><div>{current?.watchedEpisodes.slice(-8).map(p=><span key={`${p.season}:${p.episode}`}>T{p.season} · E{p.episode}</span>)}</div>{(current?.watchedEpisodes.length??0)>8&&<small>Oito marcações exibidas. Todas permanecem guardadas na cópia completa.</small>}</div>
        {current&&<button className="cv-media-remove" disabled={disabled} onClick={()=>{if(window.confirm(`Remover o acompanhamento e as marcações de ${selected.media.title}?`))void save({type:'remove'})}}>Remover acompanhamento</button>}
        {busy&&<p role="status">Salvando acompanhamento…</p>}
      </section>
    </> : <>
      <div className="section-title"><div><span className="eyebrow">MAIS HISTÓRIAS PARA DESCOBRIR</span><h2>Séries e programas</h2></div><span className="count">{catalog.items.length} títulos</span></div>
      <p className="cv-media-intro">Crime, fantasia, desafios e natureza. Um primeiro lote para explorar e acompanhar, episódio por episódio.</p>
      <div className="search"><Search size={18}/><input aria-label="Buscar séries e programas" placeholder="Buscar título, ano ou assunto…" value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button aria-label="Limpar busca de séries" onClick={()=>setQuery('')}><X size={17}/></button>}</div>
      <div className="chips" role="group" aria-label="Categorias de séries">{PILOT_FILTERS.map(value=><button key={value} className={filter===value?'active':''} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{value}</button>)}</div>
      <div className="cv-media-grid">{visible.map(item=>{const saved=progress.entries.find(p=>p.key===item.media.key);return <button className="cv-media-card" key={item.media.key} onClick={()=>{setSelected(item);setSeason('1');setEpisode('1')}}><Poster item={item}/><div><small>{pilotKind(item.media)} · {item.media.year}</small><strong>{item.media.title}</strong>{saved&&<span className="cv-media-state">{labels[saved.status]}</span>}</div></button>})}</div>
      {!visible.length&&<p className="empty">Nenhum título com esses filtros. Experimente outra busca ou categoria.</p>}
    </>}
    <footer className="cv-media-credit"><span>Dados: <button onClick={()=>void source('https://www.tvmaze.com/')}>TVmaze <ExternalLink size={12}/></button> · <button onClick={()=>void source(catalog.licenseUrl)}>CC BY-SA 4.0</button></span><small>Identidades e categorias revisadas em {catalog.reviewedAt.split('-').reverse().join('/')}. Sem notas pessoais atribuídas aos títulos.</small><small>Seu acompanhamento entra em “Exportar cópia completa”, na Minha lista.</small></footer>
  </section>
}
