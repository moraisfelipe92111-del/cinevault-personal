import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Search, Home, Clapperboard, Heart, Shuffle, ChartNoAxesColumn, Star, X, Check, Download, Upload, SlidersHorizontal, ChevronLeft, ImagePlus, RefreshCw, PauseCircle, WifiOff, HardDrive, Trash2, ShieldCheck } from 'lucide-react'
import filmsData from './films.json'
import offlineBundledData from './offlineBundled.json'
import {autoIdentify, type PosterMeta} from './tmdbAuto'
import { availableOffline, scanOffline, downloadAllPosters, clearOfflineImages, requestPersistence, humanBytes, canonicalPosterUrl, type OfflineStatus, type DownloadProgress } from './offlineImages'
import './index.css'
import { exportJsonBackup } from './nativeBackup'
import { Capacitor } from '@capacitor/core'

type Film = typeof filmsData[number]
type Saved = { favorites:number[]; watched:number[]; ratings:Record<string,number> }
const KEY='cinevault.personal.v2'
const PAGE_SIZE=30
const empty:Saved={favorites:[],watched:[],ratings:{}}
function load():Saved { try { const x=JSON.parse(localStorage.getItem(KEY)||'null'); return x&&Array.isArray(x.favorites)&&Array.isArray(x.watched)&&typeof x.ratings==='object'?x:empty }catch{return empty} }
const films=filmsData as Film[]
const priorities=['Todas','S','A','B','C','D']
const normalizeSearch = (value: string | number) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
type SortMode = 'ranking' | 'recentes' | 'antigos' | 'tensao' | 'emocao' | 'imdb'
const sortOptions: {value:SortMode,label:string}[] = [
 {value:'ranking',label:'Ranking personalizado'},
 {value:'recentes',label:'Lançamentos mais recentes'},
 {value:'antigos',label:'Filmes mais antigos'},
 {value:'tensao',label:'Mais tensão primeiro'},
 {value:'emocao',label:'Mais emoção primeiro'},
 {value:'imdb',label:'IMDb (quando disponível)'}
]
const moods=[['Suspense intenso',(f:Film)=>f.tension>=8],['Emocional',(f:Film)=>f.emotion>=7],['Investigação',(f:Film)=>/investigação|mistério/i.test(f.genre)],['Terror',(f:Film)=>/terror/i.test(f.genre)],['Ação',(f:Film)=>/ação/i.test(f.genre)],['Surpreendente',(f:Film)=>/forte|insana/i.test(f.twist)]] as const
const POSTER_KEY='cinevault.posters.v1'
const META_KEY='cinevault.posterMeta.v2'
const UNRESOLVED_KEY='cinevault.posterUnresolved.v1'
function readJsonMap<T>(key:string):Record<string,T>{
  try { const value=JSON.parse(localStorage.getItem(key)||'{}');
    return value && typeof value==='object' && !Array.isArray(value) ? value : {} }
  catch { return {} }
}
function FilmArt({film,large=false,poster,fallbackPoster}:{film:Film,large?:boolean,poster?:string,fallbackPoster?:string}){
 const [failed,setFailed]=useState(false)
 const [fallback,setFallback]=useState(false)
 useEffect(()=>{setFailed(false);setFallback(false)},[poster,fallbackPoster])
 const source=fallback?canonicalPosterUrl(fallbackPoster||'')||fallbackPoster:large?poster:canonicalPosterUrl(poster||'')||poster
 const onImageError=()=>{if(!fallback&&fallbackPoster&&poster!==fallbackPoster)setFallback(true);else setFailed(true)}
 return <div className={'cv-art '+(large?'cv-art-large':'')}>{source&&!failed?<img loading={large?'eager':'lazy'} decoding="async" fetchPriority={large?'high':'auto'} className="cv-poster-img" src={source} alt={`Pôster de ${film.title}`} onError={onImageError}/>:<><span className="cv-art-glow"/><Clapperboard size={large?52:28}/><span className="cv-art-title">{large?'CINEMA':film.title}</span><span className="cv-art-year">{film.year}</span></>}</div>
}

export default function App(){
 const [saved,setSaved]=useState<Saved>(load)
 const [posters,setPosters]=useState<Record<string,string>>(()=>readJsonMap<string>(POSTER_KEY))
 const [posterMeta,setPosterMeta]=useState<Record<string,PosterMeta>>(()=>readJsonMap<PosterMeta>(META_KEY))
 const [unresolved,setUnresolved]=useState<Record<string,string>>(()=>readJsonMap<string>(UNRESOLVED_KEY))
 const [tmdbToken,setTmdbToken]=useState('')
 // Browsers keep these files under the local origin, without storing an API token.
 const bundledPosters = offlineBundledData as Record<string,string>
 const [offlineStatus,setOfflineStatus]=useState<OfflineStatus|null>(null)
 const [offlineProgress,setOfflineProgress]=useState<DownloadProgress>({running:false,done:0,total:0,added:0,failed:0,current:''})
 const pauseOffline=useRef(false)
 const offlineBusy=useRef(false)
 const refreshOffline=async()=>{
  try {setOfflineStatus(await scanOffline(posters))}
  catch {setNotice('Não foi possível verificar o armazenamento de imagens. Confira o espaço disponível.')}
 }
 const startOffline=async()=>{
  if(offlineBusy.current)return
  offlineBusy.current=true;pauseOffline.current=false
  try {
   const result=await downloadAllPosters(posters,()=>pauseOffline.current,setOfflineProgress)
   setOfflineProgress(result)
   await refreshOffline()
   setNotice(pauseOffline.current?`Download pausado: ${result.done} capas verificadas. Você pode continuar depois.`:`Download concluído: ${result.added} novas capas armazenadas; ${result.failed} falhas. Revise os indicadores.`)
  }catch(err){setNotice(err instanceof Error?err.message:'Falha ao baixar imagens.');setOfflineProgress(p=>({...p,running:false}))}
  finally{offlineBusy.current=false}
 }
 const removeOffline=async()=>{
  if(offlineBusy.current)return
  if(!window.confirm('Apagar as capas baixadas deste navegador? Seus favoritos, assistidos e vínculos TMDb serão mantidos.'))return
  try{await clearOfflineImages();await refreshOffline();setNotice('Capas baixadas removidas. Dados da biblioteca preservados.')}catch{setNotice('Falha ao limpar o cache offline.')}
 }
 const persistOffline=async()=>{
  try{setNotice(await requestPersistence()?'Proteção contra limpeza automática de armazenamento ativada.':'O navegador não concedeu armazenamento persistente. Mantenha backups.');await refreshOffline()}catch{setNotice('Não foi possível solicitar armazenamento persistente.')}
 }

 const [autoProgress,setAutoProgress]=useState({running:false, done:0,total:0,matched:0,missed:0,current:''})
 const stopPosterRun=useRef(false)
 const runningPosters=useRef(false)
 useEffect(()=>{try{localStorage.setItem(POSTER_KEY,JSON.stringify(posters))}catch{setNotice('Não foi possível salvar os vínculos dos pôsteres.')}},[posters])
 useEffect(()=>{try{localStorage.setItem(META_KEY,JSON.stringify(posterMeta))}catch{setNotice('Não foi possível salvar os metadados TMDb.')}},[posterMeta])
 useEffect(()=>{try{localStorage.setItem(UNRESOLVED_KEY,JSON.stringify(unresolved))}catch{setNotice('Não foi possível salvar os itens pendentes.')}},[unresolved])
 const autoPosters=async(retryPending=false)=>{
  if(runningPosters.current)return
  if(!tmdbToken.trim()){setNotice('Cole seu API Read Access Token do TMDb nas configurações das capas.');return}
  const pending=films.filter(f=>!posters[f.id] && (retryPending || !unresolved[f.id]))
  if(!pending.length){setNotice('Não há filmes novos a identificar. Use "Reprocessar pendentes" para revisar os não encontrados.');return}
  runningPosters.current=true;stopPosterRun.current=false
  let done=0,matched=0,missed=0
  setAutoProgress({running:true,done:0,total:pending.length,matched:0,missed:0,current:''})
  let fatal=''
  for(const f of pending){
   if(stopPosterRun.current)break
   setAutoProgress(p=>({...p,current:f.title}))
   try {
    const result=await autoIdentify(f,tmdbToken.trim())
    if(result.meta){
     const m=result.meta
     setPosters(old=>({...old,[f.id]:`https://image.tmdb.org/t/p/w500${m.posterPath}`}))
     setPosterMeta(old=>({...old,[f.id]:m}))
     setUnresolved(old=>{const next={...old};delete next[f.id];return next})
     matched++
    }else{
     setUnresolved(old=>({...old,[f.id]:result.reason||'Não identificado'}))
     missed++
    }
   }catch(err){
    fatal=err instanceof Error?err.message:'Falha na comunicação com TMDb.'
    break
   }
   done++;setAutoProgress(p=>({...p,done,matched,missed}))
   // A gentle request cadence avoids flooding the public TMDb API.
   await new Promise(resolve=>setTimeout(resolve,410))
  }
  runningPosters.current=false
  setAutoProgress(p=>({...p,running:false,current:''}))
  if(fatal)setNotice(`${fatal} As capas concluídas foram mantidas; é possível retomar.`)
  else if(stopPosterRun.current)setNotice(`Pausado: ${matched} novos pôsteres vinculados nesta execução. Pode retomar depois.`)
  else setNotice(`Identificação concluída: ${matched} capas novas; ${missed} casos pendentes para revisão.`)
 }

 const [sortMode,setSortMode]=useState<SortMode>('ranking'),[onlyFavorites,setOnlyFavorites]=useState(false)
 const [limit,setLimit]=useState(PAGE_SIZE)
 const dialogRef=useRef<HTMLDivElement>(null)
 const closeRef=useRef<HTMLButtonElement>(null)
 const [tab,setTab]=useState('Início'),[query,setQuery]=useState(''),[priority,setPriority]=useState('Todas'),[genre,setGenre]=useState('Todos'),[hideWatched,setHideWatched]=useState(false),[selected,setSelected]=useState<Film|null>(null),[random,setRandom]=useState<Film|null>(null),[mood,setMood]=useState('Todos'),[listMode,setListMode]=useState<'Favoritos'|'Assistidos'>('Favoritos'),[notice,setNotice]=useState('')
 useEffect(()=>{try{localStorage.setItem(KEY,JSON.stringify(saved))}catch{setNotice('Não foi possível salvar os dados neste navegador. Exporte um backup.')}},[saved])
 useEffect(()=>{void refreshOffline()},[posters])
 useEffect(()=>{setLimit(PAGE_SIZE)},[query,priority,genre,hideWatched,onlyFavorites,sortMode])
 useEffect(()=>{if(!selected)return;const previous=document.activeElement as HTMLElement|null;closeRef.current?.focus();const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setSelected(null);if(event.key==='Tab'&&dialogRef.current){const elements=[...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])')];if(!elements.length)return;const first=elements[0],last=elements[elements.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}}};document.addEventListener('keydown',onKey);const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',onKey);document.body.style.overflow=previousOverflow;previous?.focus()}},[selected])
 const genres=useMemo(()=>['Todos',...Array.from(new Set(films.flatMap(f=>f.genre.split('/').map(s=>s.trim())))).sort((a,b)=>a.localeCompare(b,'pt-BR'))],[])
 const visible=useMemo(()=>{
  const normalizedQuery=normalizeSearch(query.trim());
  const favoriteSet=new Set(saved.favorites), watchedSet=new Set(saved.watched)
  const filtered=films.filter(f=>{
   const text=normalizeSearch([f.title,f.genre,f.director,f.actors,f.year].join(' '))
   return text.includes(normalizedQuery)
    && (priority==='Todas'||f.priority===priority)
    && (genre==='Todos'||f.genre.includes(genre))
    && (!hideWatched||!watchedSet.has(f.id))
    && (!onlyFavorites||favoriteSet.has(f.id))
  })
  if(sortMode==='ranking')return filtered
  return [...filtered].sort((a,b)=>{
   if(sortMode==='recentes')return b.year-a.year||a.id-b.id
   if(sortMode==='antigos')return a.year-b.year||a.id-b.id
   if(sortMode==='tensao')return b.tension-a.tension||a.id-b.id
   if(sortMode==='emocao')return b.emotion-a.emotion||a.id-b.id
   if(sortMode==='imdb')return (parseFloat(b.imdb)||-1)-(parseFloat(a.imdb)||-1)||a.id-b.id
   return a.id-b.id
  })
 },[query,priority,genre,hideWatched,onlyFavorites,sortMode,saved.favorites,saved.watched])
 const related=useMemo(()=>{
  if(!selected)return [] as Film[]
  const firstGenre=selected.genre.split('/')[0].trim()
  return films.filter(f=>f.id!==selected.id && !saved.watched.includes(f.id))
   .sort((a,b)=>Number(b.genre.includes(firstGenre))-Number(a.genre.includes(firstGenre))||a.id-b.id)
   .slice(0,3)
 },[selected,saved.watched])
 const featured=films.find(f=>!saved.watched.includes(f.id))||films[0]
 const favorites=new Set(saved.favorites), watched=new Set(saved.watched)
 const toggle=(key:'favorites'|'watched',id:number)=>setSaved(old=>({...old,[key]:old[key].includes(id)?old[key].filter(n=>n!==id):[...old[key],id]}))
 const rate=(id:number,n:number)=>setSaved(old=>({...old,ratings:{...old.ratings,[id]:n}}))
 const choose=()=>{const rule=moods.find(m=>m[0]===mood)?.[1];const pool=films.filter(f=>!watched.has(f.id)&&(!rule||rule(f)));const weights:{[key:string]:number}={S:6,A:4,B:2,C:1,D:0.5};const total=pool.reduce((sum,f)=>sum+(weights[f.priority]||1),0);let pick=Math.random()*total;const chosen=pool.find(f=>(pick-=(weights[f.priority]||1))<=0)||pool[pool.length-1];setRandom(chosen||null);if(!pool.length)setNotice('Nenhum filme não assistido nessa categoria.')}
 const exportPending=()=>{const pendingFilms=films.filter(f=>!posters[f.id]);const report={generatedAt:new Date().toISOString(),total:pendingFilms.length,films:pendingFilms.map(f=>({id:f.id,title:f.title,year:f.year,reason:unresolved[f.id]||'Ainda não processado'}))};const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='cinevault-filmes-pendentes.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice('Relatório de pendentes preparado para download.')}
 const exportBackup=async()=>{
  try {
   await exportJsonBackup({version:3,exportedAt:new Date().toISOString(),...saved,posters,posterMeta,unresolved})
   setNotice(Capacitor.isNativePlatform()?'Escolha um destino no compartilhamento para guardar seu backup.':'Backup preparado para download.')
  } catch {
   setNotice('Não foi possível exportar o backup. Tente novamente ou confira as permissões de compartilhamento.')
  }
 }
 const importBackup=async(file?:File)=>{if(!file)return;try{if(file.size>5*1024*1024)throw Error('Arquivo muito grande');const raw=JSON.parse(await file.text());if(!Array.isArray(raw.favorites)||!Array.isArray(raw.watched)||typeof raw.ratings!=='object'||!raw.ratings)throw Error('Formato inválido');const ids=new Set(films.map(f=>f.id));const valid=(a:unknown[])=>[...new Set(a.filter((n):n is number=>typeof n==='number'&&Number.isInteger(n)&&ids.has(n)))];const ratings:Record<string,number>={};for(const [k,v] of Object.entries(raw.ratings)){if(ids.has(Number(k))&&typeof v==='number'&&v>=1&&v<=5)ratings[k]=v}setSaved({favorites:valid(raw.favorites),watched:valid(raw.watched),ratings});
  if(raw.posters&&typeof raw.posters==='object'&&!Array.isArray(raw.posters)){
   const clean:Record<string,string>={};
   for(const [k,v] of Object.entries(raw.posters)) if(ids.has(Number(k))&&typeof v==='string'&&/^https:\/\/image\.tmdb\.org\/t\/p\/w500\/[a-zA-Z0-9_\-/.]+$/.test(v)) clean[k]=v;
   setPosters(clean)
  }
  if(raw.posterMeta&&typeof raw.posterMeta==='object'&&!Array.isArray(raw.posterMeta)){
   const clean:Record<string,PosterMeta>={};
   for(const [k,v] of Object.entries(raw.posterMeta)){
    const m=v as Partial<PosterMeta>;
    if(ids.has(Number(k))&&m&&typeof m.tmdbId==='number'&&typeof m.posterPath==='string'&&/^\/[a-zA-Z0-9_\-/.]+$/.test(m.posterPath)){
     clean[k]={tmdbId:m.tmdbId,tmdbTitle:String(m.tmdbTitle||'').slice(0,200),year:Number(m.year||0),posterPath:m.posterPath,backdropPath:typeof m.backdropPath==='string'&&/^\/[a-zA-Z0-9_\-/.]+$/.test(m.backdropPath)?m.backdropPath:null,overview:String(m.overview||'').slice(0,3000),confidence:Number(m.confidence||0),checkedAt:String(m.checkedAt||'')}
    }
   }
   setPosterMeta(clean)
  }
  if(raw.unresolved&&typeof raw.unresolved==='object'&&!Array.isArray(raw.unresolved)){
   const clean:Record<string,string>={};
   for(const [k,v] of Object.entries(raw.unresolved)) if(ids.has(Number(k))&&typeof v==='string')clean[k]=v.slice(0,250);
   setUnresolved(clean)
  }
  setNotice('Backup restaurado com sucesso.')}catch{setNotice('Não foi possível importar: backup inválido.')}}
 const cards=(items:Film[])=><div className="film-grid">{items.map(f=><button key={f.id} className="film-card" onClick={()=>setSelected(f)}><FilmArt film={f} poster={bundledPosters[f.id]||posters[f.id]}/><div className="film-info"><span className="rating"><Star size={12} fill="currentColor"/> #{f.id} · PRIORIDADE {f.priority}</span><strong>{f.title}</strong><small>{f.year} · {f.genre}</small>{watched.has(f.id)&&<span className="watched-label"><Check size={12}/> Assistido</span>}</div></button>)}</div>
 return <div className="app cv-v2 cv-v021" translate="no"><header className="top"><div><span className="eyebrow">SUA EXPERIÊNCIA DE CINEMA</span><h1>CINE<span>VAULT</span><i>.</i></h1></div><button className="avatar" aria-label="Abrir minha lista" onClick={()=>setTab('Minha lista')}>CV</button></header><main>
 {tab==='Início'&&<><div className="section-heading"><span>ESCOLHA DA NOITE</span><span className="gold">✦ PARA VOCÊS</span></div><motion.section initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} className="hero"><div className="hero-art"><FilmArt film={featured} large poster={bundledPosters[featured.id] || (posterMeta[featured.id]?.backdropPath?`https://image.tmdb.org/t/p/w780${posterMeta[featured.id].backdropPath}`:posters[featured.id])} fallbackPoster={bundledPosters[featured.id]||posters[featured.id]}/></div><div className="hero-shade"/><div className="hero-content"><span className="pill">#{featured.id} NO RANKING · {featured.priority}</span><h2>{featured.title}</h2><div className="hero-meta">{featured.year} · {featured.genre}</div><p>{featured.reason}</p><button className="primary" onClick={e=>{e.stopPropagation();setSelected(featured)}}>Ver detalhes</button></div></motion.section><div className="cv-home-summary"><div><strong>{films.length-saved.watched.length}</strong><span>Para descobrir</span></div><div><strong>{saved.favorites.length}</strong><span>Favoritos</span></div><div><strong>{Math.round(100*saved.watched.length/films.length)}%</strong><span>Assistidos</span></div></div><div className="section-title"><div><span className="eyebrow">CURADORIA PERSONALIZADA</span><h2>Prioridade máxima</h2></div><span className="count">{films.filter(f=>f.priority==='S').length} filmes</span></div>{cards(films.filter(f=>f.priority==='S'&&!watched.has(f.id)).slice(0,8))}<button className="cv-wide" onClick={()=>{setTab('Biblioteca');setPriority('S');window.scrollTo(0,0)}}>Ver todos da prioridade S →</button></>}
 {tab==='Biblioteca'&&<><div className="section-title"><div><span className="eyebrow">CATÁLOGO COMPLETO</span><h2>Biblioteca de filmes</h2></div><span className="count">{visible.length} / {films.length}</span></div><div className="search"><Search size={18}/><input aria-label="Buscar filmes" placeholder="Buscar filme, diretor, ator ou ano..." value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button onClick={()=>setQuery('')} aria-label="Limpar"><X size={17}/></button>}</div><div className="cv-filter-label"><SlidersHorizontal size={16}/> Prioridade</div><div className="chips">{priorities.map(p=><button key={p} className={priority===p?'active':''} onClick={()=>setPriority(p)}>{p}</button>)}</div><div className="cv-filter-label">Gênero</div><select className="cv-select" value={genre} onChange={e=>setGenre(e.target.value)}>{genres.map(g=><option key={g}>{g}</option>)}</select><label className="cv-check"><input type="checkbox" checked={hideWatched} onChange={e=>setHideWatched(e.target.checked)}/> Ocultar filmes já assistidos</label><div className="cv-library-tools"><label className="cv-fav-filter"><input type="checkbox" checked={onlyFavorites} onChange={e=>setOnlyFavorites(e.target.checked)}/><Heart size={15}/> Apenas favoritos</label><label className="cv-sort-label">Ordenar<select aria-label="Ordenar filmes" value={sortMode} onChange={e=>setSortMode(e.target.value as SortMode)}>{sortOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>{(query||priority!=='Todas'||genre!=='Todos'||hideWatched||onlyFavorites||sortMode!=='ranking')&&<div className="cv-filter-footer"><span>{visible.length} filmes encontrados</span><button onClick={()=>{setQuery('');setPriority('Todas');setGenre('Todos');setHideWatched(false);setOnlyFavorites(false);setSortMode('ranking')}}>Limpar filtros <X size={13}/></button></div>}{cards(visible.slice(0,limit))}{visible.length>limit&&<button className="cv-wide" onClick={()=>setLimit(n=>n+PAGE_SIZE)}>Carregar mais filmes ({Math.min(PAGE_SIZE,visible.length-limit)} de {visible.length-limit} restantes)</button>}{!visible.length&&<p className="empty">Nenhum filme encontrado. Ajuste os filtros.</p>}</>}
 {tab==='Minha lista'&&<><div className="section-title"><div><span className="eyebrow">SEU ESPAÇO</span><h2>Minha lista</h2></div></div><div className="chips">{(['Favoritos','Assistidos'] as const).map(m=><button key={m} className={listMode===m?'active':''} onClick={()=>setListMode(m)}>{m} ({saved[m==='Favoritos'?'favorites':'watched'].length})</button>)}</div>{cards(films.filter(f=>(listMode==='Favoritos'?favorites:watched).has(f.id)))}{!(listMode==='Favoritos'?saved.favorites:saved.watched).length&&<p className="empty">Sua lista está vazia. Abra um filme e marque como {listMode==='Favoritos'?'favorito':'assistido'}.</p>}<h3>Segurança dos seus dados</h3><p className="muted">Os dados ficam neste navegador. Exporte um backup para não perder suas marcações ao limpar os dados do Chrome ou trocar de celular.</p><div className="cv-backup"><button onClick={()=>void exportBackup()}><Download size={17}/> Exportar backup</button><label><Upload size={17}/> Importar backup<input type="file" accept="application/json,.json" onChange={e=>{void importBackup(e.target.files?.[0]);e.target.value=''}}/></label></div></>}
 {tab==='Escolher'&&<div className="picker"><Shuffle size={42}/><span className="eyebrow">NÃO SABE O QUE ASSISTIR?</span><h2>Deixe o cinema escolher.</h2><p>Sorteio entre filmes que você ainda não marcou como assistidos.</p><select className="cv-select" value={mood} onChange={e=>setMood(e.target.value)}><option>Todos</option>{moods.map(([name])=><option key={name}>{name}</option>)}</select><button className="primary" onClick={choose}>Sortear um filme</button>{random&&<button className="random-result" onClick={()=>setSelected(random)}><FilmArt film={random} poster={bundledPosters[random.id]||posters[random.id]}/><strong>{random.title}</strong><span>Ver detalhes →</span></button>}</div>}
 {tab==='Estatísticas'&&<><div className="section-title"><div><span className="eyebrow">SEU HISTÓRICO</span><h2>Estatísticas</h2></div></div><div className="stats"><div><strong>{films.length}</strong><span>Na biblioteca</span></div><div><strong>{saved.watched.length}</strong><span>Assistidos</span></div><div><strong>{saved.favorites.length}</strong><span>Favoritos</span></div></div><div className="cv-progress"><div style={{width:`${100*saved.watched.length/films.length}%`}}/></div><p className="muted">{Math.round(100*saved.watched.length/films.length)}% da biblioteca assistida · {Object.keys(saved.ratings).length} avaliações pessoais</p><h3>Prioridades</h3><div className="cv-priority-list">{priorities.slice(1).map(p=><div key={p}><b>{p}</b><span>{films.filter(f=>f.priority===p).length} filmes</span></div>)}</div><section className="cv-offline">
 <div className="cv-auto-heading"><WifiOff size={21}/><h3>Biblioteca offline</h3></div>
 <p>{Capacitor.isNativePlatform()?'A biblioteca de filmes já funciona no APK. As capas vinculadas continuam sendo carregadas pela internet até incluirmos o pacote de imagens em uma atualização futura.':'Opcional: baixe as capas identificadas para continuar vendo os pôsteres sem internet neste navegador. Os dados pessoais ficam separados do cache de imagens.'}</p>
 <div className="cv-offline-summary"><div><strong>{Object.keys(bundledPosters).length||offlineStatus?.cached||0} / {films.length}</strong><span>capas no aparelho</span></div><div><strong>{humanBytes(offlineStatus?.usedBytes)}</strong><span>ocupação estimada do site*</span></div></div>
 <div className="cv-auto-track"><div style={{width:`${Math.round(100*(Object.keys(bundledPosters).length||offlineStatus?.cached||0)/films.length)}%`}}/></div>
 <small>* Inclui outros dados do site e pode superestimar imagens de servidores externos. Armazenamento do navegador não é o mesmo do futuro APK.</small>
 {offlineProgress.total>0&&<div className="cv-auto-status" role="status"><strong>{offlineProgress.running?'Baixando capas…':'Último download'}</strong><span>{offlineProgress.done} de {offlineProgress.total} verificadas · {offlineProgress.added} novas · {offlineProgress.failed} falhas</span><div className="cv-auto-track"><div style={{width:`${Math.round(100*offlineProgress.done/offlineProgress.total)}%`}}/></div></div>}
 <div className="cv-offline-actions"><button disabled={!availableOffline()||offlineProgress.running||(!offlineStatus?.total&&!Object.keys(bundledPosters).length)} onClick={()=>void startOffline()}><Download size={17}/> {offlineStatus?.cached?'Continuar / verificar downloads':'Baixar todas as capas'}</button>{offlineProgress.running&&<button className="cv-stop" onClick={()=>{pauseOffline.current=true}}><PauseCircle size={17}/> Pausar após capa atual</button>}<button disabled={offlineProgress.running} onClick={()=>void refreshOffline()}><RefreshCw size={17}/> Atualizar contagem</button><button disabled={offlineProgress.running} onClick={()=>void persistOffline()}><ShieldCheck size={17}/> Proteger armazenamento</button><button disabled={offlineProgress.running} onClick={()=>void removeOffline()}><Trash2 size={17}/> Remover capas baixadas</button></div>
 {!availableOffline()&&!Capacitor.isNativePlatform()&&<p role="alert">O armazenamento offline não está disponível neste navegador.</p>}
 <p className="cv-offline-info"><HardDrive size={16}/> {Capacitor.isNativePlatform()?'Imagens offline serão adicionadas em uma futura atualização do APK, sem necessidade de cadastrar novamente os filmes.':'Para levar as 317 imagens dentro do APK, usaremos posteriormente o exportador de capas do Termux, já incluído no projeto.'}</p>
 </section><section className="cv-auto"><div className="cv-auto-heading"><ImagePlus size={21}/><h3>Capas automáticas</h3></div><p>Os 317 pôsteres foram identificados no TMDb. Novas consultas usam título original, ano e diretor para evitar imagens incorretas. A identificação exige internet; as capas baixadas poderão ser exibidas offline.</p><div className="cv-auto-metrics"><span><b>{Object.keys(posters).length}</b> com capa</span><span><b>{Object.keys(unresolved).filter(id=>!posters[id]).length}</b> pendentes</span><span><b>{films.length-Object.keys(posters).length}</b> sem capa</span></div><label>API Read Access Token do TMDb<input type="password" value={tmdbToken} autoComplete="off" spellCheck={false} onChange={e=>setTmdbToken(e.target.value)} placeholder="Cole o token do TMDb" /></label><small>Token usado apenas nesta sessão e enviado diretamente ao TMDb para consulta. Não fica salvo nem é incluído no backup. Mantenha esta aba aberta durante a identificação.</small><div className="cv-auto-buttons"><button disabled={autoProgress.running} onClick={()=>void autoPosters(false)}><ImagePlus size={17}/> Identificar capas automaticamente</button><button disabled={autoProgress.running} onClick={()=>void autoPosters(true)}><RefreshCw size={17}/> Resolver pendentes por diretor</button><button disabled={autoProgress.running} onClick={exportPending}><Download size={17}/> Exportar lista de pendentes</button>{autoProgress.running&&<button className="cv-stop" onClick={()=>{stopPosterRun.current=true}}><PauseCircle size={17}/> Pausar após filme atual</button>}</div>{autoProgress.total>0&&<div className="cv-auto-status" role="status"><strong>{autoProgress.running?'Buscando capas…':'Última execução'}</strong><span>{autoProgress.done} de {autoProgress.total} concluídos · {autoProgress.matched} associados · {autoProgress.missed} pendentes</span><div className="cv-auto-track"><div style={{width:`${Math.round(100*autoProgress.done/autoProgress.total)}%`}}/></div><small>{autoProgress.current||'O catálogo continua disponível durante o processamento.'}</small></div>}<img className="cv-auto-brand" alt="TMDb" loading="lazy" src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"/><p className="cv-auto-legal">Imagens e sinopses: TMDb. Este produto utiliza a API do TMDb, mas não é endossado nem certificado pelo TMDb. <a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer">The Movie Database</a>.</p></section></>}
 </main><nav className="bottom">{[{label:'Início',icon:Home},{label:'Biblioteca',icon:Clapperboard},{label:'Minha lista',icon:Heart},{label:'Escolher',icon:Shuffle},{label:'Estatísticas',icon:ChartNoAxesColumn}].map(({label,icon:Icon})=><button key={label} className={tab===label?'current':''} onClick={()=>{setTab(label);window.scrollTo(0,0)}}><Icon size={21} strokeWidth={tab===label?2.5:1.8}/><span translate="no">{label}</span></button>)}</nav>
 {selected&&<div className="overlay" onClick={()=>setSelected(null)}><motion.div initial={{y:50,opacity:0}} animate={{y:0,opacity:1}} className="detail" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Detalhes do filme" onClick={e=>e.stopPropagation()}><div className="cv-detail-banner" aria-hidden="true">{(posterMeta[selected.id]?.backdropPath||posters[selected.id])&&<img loading="lazy" src={posterMeta[selected.id]?.backdropPath?`https://image.tmdb.org/t/p/w780${posterMeta[selected.id].backdropPath}`:posters[selected.id]} alt=""/>}<div className="cv-detail-banner-shade"/></div><button ref={closeRef} className="close" aria-label="Fechar" onClick={()=>setSelected(null)}><X/></button><div className="detail-top"><FilmArt film={selected} poster={bundledPosters[selected.id]||posters[selected.id]}/><div><span className="pill">#{selected.id} · PRIORIDADE {selected.priority}</span><h2>{selected.title}</h2><p>{selected.year} · {selected.duration}</p><span className="gold">{selected.stars}</span></div></div><p>{selected.reason}</p><div className="cv-meta"><div><b>Gênero</b><span>{selected.genre}</span></div><div><b>Diretor</b><span>{selected.director}</span></div><div><b>Elenco</b><span>{selected.actors}</span></div><div><b>Ritmo</b><span>{selected.pace}</span></div><div><b>Reviravolta</b><span>{selected.twist}</span></div><div><b>IMDb / Rotten Tomatoes / Letterboxd</b><span>{selected.imdb} · {selected.rt} · {selected.letterboxd}</span></div></div><section className="cv-poster-tool"><h3><ImagePlus size={17}/> Imagens automáticas</h3><p>{posters[selected.id]?'Pôster identificado automaticamente e vinculado ao catálogo.':'Este filme ainda não tem pôster identificado. Abra Estatísticas → Capas automáticas para processar a biblioteca toda, sem vincular filme por filme.'}</p>{posterMeta[selected.id]?.overview&&<><h4>Sinopse (TMDb)</h4><p>{posterMeta[selected.id].overview}</p></>}{unresolved[selected.id]&&<small>Última tentativa: {unresolved[selected.id]}</small>}</section><div className="detail-stats"><span>Tensão <b>{selected.tension}/10</b></span><span>Emoção <b>{selected.emotion}/10</b></span></div><div className="cv-user-rating"><b>Sua avaliação</b><div>{[1,2,3,4,5].map(n=><button key={n} aria-label={`Avaliar ${n} estrelas`} onClick={()=>rate(selected.id,n)}><Star size={23} fill={(saved.ratings[selected.id]||0)>=n?'currentColor':'none'}/></button>)}</div></div><div className="actions"><button onClick={()=>toggle('favorites',selected.id)}><Heart size={18} fill={favorites.has(selected.id)?'currentColor':'none'}/>{favorites.has(selected.id)?'Favoritado':'Favoritar'}</button><button onClick={()=>toggle('watched',selected.id)}>{watched.has(selected.id)?'✓ Assistido':'Marcar assistido'}</button></div><section className="cv-related"><h3>Na mesma linha</h3><p>Outros filmes do seu ranking que podem combinar com esta escolha.</p><div className="cv-related-list">{related.map(f=><button key={f.id} onClick={()=>setSelected(f)}><FilmArt film={f} poster={bundledPosters[f.id]||posters[f.id]}/><span>{f.title}</span><small>#{f.id} · {f.priority}</small></button>)}</div></section><button className="cv-wide" onClick={()=>setSelected(null)}><ChevronLeft size={16}/> Voltar</button></motion.div></div>}
 {notice&&<button className="cv-toast" role="status" onClick={()=>setNotice('')}>{notice} · Fechar</button>}
 </div>
}
