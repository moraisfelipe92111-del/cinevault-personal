import { Suspense, lazy, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Search, Home, Clapperboard, Heart, Shuffle, ChartNoAxesColumn, Star, X, Check, Sparkles, ListOrdered, ListPlus, ArrowUp, ArrowDown, BookOpen, ChevronRight, Download, Upload, SlidersHorizontal, ChevronLeft, ImagePlus, RefreshCw, PauseCircle, WifiOff, HardDrive, Trash2, ShieldCheck } from 'lucide-react'
import filmsData from './films.json'
import offlineBundledData from './offlineBundled.json'
import { buildFilmSearchIndex, personalCurationOnly, countLinkedCovers } from './cv2Performance'
import {autoIdentify, type PosterMeta} from './tmdbAuto'
import { availableOffline, scanOffline, downloadAllPosters, clearOfflineImages, requestPersistence, humanBytes, canonicalPosterUrl, type OfflineStatus, type DownloadProgress } from './offlineImages'
import './index.css'
import { exportJsonBackup } from './nativeBackup'
import { Capacitor } from '@capacitor/core'
import { selectSession, sessionReason, type SessionMood, type SessionDuration } from './session'
import { parseBackup } from './backupValidation'
import { ExperienceLayer } from './experience'
import { Cv2FilmDetails } from './Cv2FilmDetails'
import { PULSE_KEY, EMPTY_PULSE, parsePulse, toggleQueue, moveQueue, markWatched, visitFilm, saveNote, pickDaily, localDay, watchStats, type PulseState } from './pulse'
import { createJsonMapStorage } from './jsonMapStorage'
const FilmTrailer = lazy(() => import('./FilmTrailer').then(module => ({default: module.FilmTrailer})))

type Film = typeof filmsData[number]
type Saved = { favorites:number[]; watched:number[]; ratings:Record<string,number> }
const KEY='cinevault.personal.v2'
const PAGE_SIZE=30
const empty:Saved={favorites:[],watched:[],ratings:{}}
function load(onInvalid:()=>void):Saved {
 try {
  const raw=localStorage.getItem(KEY)
  if(raw===null)return empty
  const x:unknown=JSON.parse(raw)
  if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Dados inválidos')
  const record=x as Record<string,unknown>
  if(!Array.isArray(record.favorites)||!Array.isArray(record.watched)||!record.ratings||typeof record.ratings!=='object'||Array.isArray(record.ratings))throw Error('Dados inválidos')
  const valid=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value)&&films.some(f=>f.id===value)
  const ratings:Record<string,number>={}
  for(const [id,rating] of Object.entries(record.ratings))if(valid(Number(id))&&typeof rating==='number'&&Number.isInteger(rating)&&rating>=1&&rating<=5)ratings[id]=rating
  return {favorites:[...new Set(record.favorites.filter(valid))],watched:[...new Set(record.watched.filter(valid))],ratings}
 } catch {onInvalid();return empty}
}
const films=filmsData as Film[]
const filmsById = new Map<number,Film>(films.map(f=>[f.id,f] as const))
const priorities=['Todas','S','A','B','C','D','N']
const normalizeSearch = (value: string | number) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
const filmSearchIndex = buildFilmSearchIndex(films)
const curatedFilms = personalCurationOnly(films)
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
function FilmArt({film,large=false,poster,fallbackPoster}:{film:Film,large?:boolean,poster?:string,fallbackPoster?:string}){
 const [failed,setFailed]=useState(false)
 const [fallback,setFallback]=useState(false)
 useEffect(()=>{setFailed(false);setFallback(false)},[poster,fallbackPoster])
 const source=fallback?canonicalPosterUrl(fallbackPoster||'')||fallbackPoster:large?poster:canonicalPosterUrl(poster||'')||poster
 const onImageError=()=>{if(!fallback&&fallbackPoster&&poster!==fallbackPoster)setFallback(true);else setFailed(true)}
 return <div className={'cv-art '+(large?'cv-art-large':'')}>{source&&!failed?<img loading={large?'eager':'lazy'} decoding="async" fetchPriority={large?'high':'auto'} className="cv-poster-img" src={source} alt={`Pôster de ${film.title}`} onError={onImageError}/>:<><span className="cv-art-glow"/><Clapperboard size={large?52:28}/><span className="cv-art-title">{large?'CINEMA':film.title}</span><span className="cv-art-year">{film.year}</span></>}</div>
}

export default function App(){
 const blockedStorage=useRef({saved:false,pulse:false})
 const [posterStorage]=useState(()=>createJsonMapStorage(()=>localStorage))
  const [saved,setSaved]=useState<Saved>(()=>load(()=>{blockedStorage.current.saved=true}))
  const [pulse,setPulse]=useState<PulseState>(()=>{
   try{
    const raw=localStorage.getItem(PULSE_KEY)
    return raw===null?{...EMPTY_PULSE}:parsePulse(JSON.parse(raw),new Set(films.map(f=>f.id)))
   }
   catch{blockedStorage.current.pulse=true;return {...EMPTY_PULSE}}
  })
 const [noteDraft,setNoteDraft]=useState('')
 const [posters,setPosters]=useState<Record<string,string>>(()=>posterStorage.read<string>(POSTER_KEY))
 const [catalogPosters,setCatalogPosters]=useState<Record<string,string>>({})
 const [posterMeta,setPosterMeta]=useState<Record<string,PosterMeta>>(()=>posterStorage.read<PosterMeta>(META_KEY))
 const [unresolved,setUnresolved]=useState<Record<string,string>>(()=>posterStorage.read<string>(UNRESOLVED_KEY))
 const [tmdbToken,setTmdbToken]=useState('')
 // Browsers keep these files under the local origin, without storing an API token.
 // URLs oficiais para os novos filmes; imagens realmente empacotadas tem precedencia.
 const bundledPosters = useMemo(() => ({...catalogPosters, ...(offlineBundledData as Record<string,string>)}),[catalogPosters])
 const coverCount = useMemo(() => countLinkedCovers(films, {...posters,...bundledPosters}),[posters,bundledPosters])
 const [offlineStatus,setOfflineStatus]=useState<OfflineStatus|null>(null)
 const [offlineProgress,setOfflineProgress]=useState<DownloadProgress>({running:false,done:0,total:0,added:0,failed:0,current:''})
 const pauseOffline=useRef(false)
 const offlineBusy=useRef(false)
 const refreshOffline=async()=>{
  try {setOfflineStatus(await scanOffline({...bundledPosters,...posters}))}
  catch {setNotice('Não foi possível verificar o armazenamento de imagens. Confira o espaço disponível.')}
 }
 const startOffline=async()=>{
  if(offlineBusy.current)return
  offlineBusy.current=true;pauseOffline.current=false
  try {
   const result=await downloadAllPosters({...bundledPosters,...posters},()=>pauseOffline.current,setOfflineProgress)
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
 useEffect(()=>{
  try {
   if(!posterStorage.write(POSTER_KEY,posters))setNotice('Não foi possível ler os dados locais das capas. Gravação suspensa; importe um backup válido para recuperar.')
  } catch {setNotice('Não foi possível salvar os vínculos dos pôsteres.')}
 },[posters,posterStorage])
 useEffect(()=>{
  try {
   if(!posterStorage.write(META_KEY,posterMeta))setNotice('Não foi possível ler os dados locais das capas. Gravação suspensa; importe um backup válido para recuperar.')
  } catch {setNotice('Não foi possível salvar os metadados TMDb.')}
 },[posterMeta,posterStorage])
 useEffect(()=>{
  try {
   if(!posterStorage.write(UNRESOLVED_KEY,unresolved))setNotice('Não foi possível ler os dados locais das capas. Gravação suspensa; importe um backup válido para recuperar.')
  } catch {setNotice('Não foi possível salvar os itens pendentes.')}
 },[unresolved,posterStorage])
 const autoPosters=async(retryPending=false)=>{
  if(runningPosters.current)return
  if(posterStorage.hasBlocked()){setNotice('Não foi possível ler os dados locais das capas. Importe um backup válido antes de identificar novos pôsteres.');return}
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
 const [tab,setTab]=useState('Início'),[query,setQuery]=useState(''),[priority,setPriority]=useState('Todas'),[genre,setGenre]=useState('Todos'),[hideWatched,setHideWatched]=useState(false),[selected,setSelected]=useState<Film|null>(null),[mood,setMood]=useState<SessionMood>('Todos'),[listMode,setListMode]=useState<'Favoritos'|'Assistidos'|'Fila'>('Favoritos'),[notice,setNotice]=useState('')
 const deferredQuery=useDeferredValue(query)
 const [sessionDuration,setSessionDuration]=useState<SessionDuration>('Qualquer')
 const [sessionRound,setSessionRound]=useState(0)
 const [sessionReady,setSessionReady]=useState(false)
 const [today,setToday]=useState(()=>new Date())
 useEffect(()=>{
  let active=true
  void import('./catalogPosters.json').then(module=>{
   if(active)setCatalogPosters(module.default as Record<string,string>)
  }).catch(()=>{if(active)setNotice('Índice de capas indisponível. Biblioteca e dados pessoais continuam acessíveis.')})
  return ()=>{active=false}
 },[])
 useEffect(()=>{const onFocus=()=>setToday(new Date());window.addEventListener('focus',onFocus);return()=>window.removeEventListener('focus',onFocus)},[])
 useEffect(()=>{if(blockedStorage.current.pulse){setNotice('Diário local inválido: conteúdo original preservado. Importe um backup válido para recuperar.');return}try{localStorage.setItem(PULSE_KEY,JSON.stringify(pulse))}catch{setNotice('Sem espaço para registrar o diário. Exporte um backup.')}},[pulse])
 useEffect(()=>{if(selected){setNoteDraft(pulse.notes[String(selected.id)]||'');setPulse(old=>visitFilm(old,selected.id))}},[selected?.id])
 useEffect(()=>{if(blockedStorage.current.saved){setNotice('Lista local inválida: os dados originais foram preservados. Importe um backup válido.');return}try{localStorage.setItem(KEY,JSON.stringify(saved))}catch{setNotice('Não foi possível salvar os dados neste navegador. Exporte um backup.')}},[saved])
 useEffect(()=>{void refreshOffline()},[posters,bundledPosters])
 useEffect(()=>{setLimit(PAGE_SIZE)},[query,priority,genre,hideWatched,onlyFavorites,sortMode])
 useEffect(()=>{if(!selected)return;const previous=document.activeElement as HTMLElement|null;closeRef.current?.focus();const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setSelected(null);if(event.key==='Tab'&&dialogRef.current){const elements=[...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])')];if(!elements.length)return;const first=elements[0],last=elements[elements.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}}};document.addEventListener('keydown',onKey);const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',onKey);document.body.style.overflow=previousOverflow;previous?.focus()}},[selected])
 const genres=useMemo(()=>['Todos',...Array.from(new Set(films.flatMap(f=>f.genre.split('/').map(s=>s.trim())))).sort((a,b)=>a.localeCompare(b,'pt-BR'))],[])
 const visible=useMemo(()=>{
  const normalizedQuery=normalizeSearch(deferredQuery.trim());
  const favoriteSet=new Set(saved.favorites), watchedSet=new Set(saved.watched)
  const filtered=films.filter(f=>{
   const text=filmSearchIndex.get(f.id)||''
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
 },[deferredQuery,priority,genre,hideWatched,onlyFavorites,sortMode,saved.favorites,saved.watched])
 const related=useMemo(()=>{
  if(!selected)return [] as Film[]
  const firstGenre=selected.genre.split('/')[0].trim()
  const watchedIds=new Set(saved.watched)
  return films.filter(f=>f.id!==selected.id && !watchedIds.has(f.id))
   .sort((a,b)=>Number(b.genre.includes(firstGenre))-Number(a.genre.includes(firstGenre))||a.id-b.id)
   .slice(0,3)
 },[selected,saved.watched])
 const homePicks=useMemo(()=>selectSession(curatedFilms,saved,{mood:'Todos',duration:'Qualquer',round:0}),[saved])
 const todayDisplay=today.toLocaleDateString('pt-BR',{day:'numeric',month:'short'})
 const greeting=today.getHours()<12?'Bom dia':today.getHours()<18?'Boa tarde':'Boa noite'
 const dailyFilm=pickDaily(curatedFilms,saved,localDay(today),pulse.dailyOffset)
 const queueFilms=pulse.queue.map(id=>filmsById.get(id)).filter((f):f is Film=>Boolean(f)&&!saved.watched.includes(f!.id))
 const journey=watchStats(pulse.history,today)
 const recentHistory=[...pulse.history].filter(e=>saved.watched.includes(e.filmId)).sort((a,b)=>b.watchedAt.localeCompare(a.watchedAt)).slice(0,5)
 const featured=curatedFilms.find(f=>!saved.watched.includes(f.id))||curatedFilms[0]
 const favorites=new Set(saved.favorites), watched=new Set(saved.watched)
 const toggle=(key:'favorites'|'watched',id:number)=>{
  const becomingWatched=key==='watched'&&!saved.watched.includes(id)
  setSaved(old=>({...old,[key]:old[key].includes(id)?old[key].filter(n=>n!==id):[...old[key],id]}))
  if(key==='watched')setPulse(old=>markWatched(old,id,becomingWatched,new Date().toISOString()))
 }
 const rate=(id:number,n:number)=>setSaved(old=>({...old,ratings:{...old.ratings,[id]:n}}))
 const sessionPicks=useMemo(()=>selectSession(curatedFilms,saved,{mood,duration:sessionDuration,round:sessionRound}),[saved,mood,sessionDuration,sessionRound])
 const choose=()=>{setSessionRound(n=>sessionReady?n+1:0);setSessionReady(true)}
 const exportPending=()=>{const pendingFilms=films.filter(f=>!posters[f.id]);const report={generatedAt:new Date().toISOString(),total:pendingFilms.length,films:pendingFilms.map(f=>({id:f.id,title:f.title,year:f.year,reason:unresolved[f.id]||'Ainda não processado'}))};const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='cinevault-filmes-pendentes.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice('Relatório de pendentes preparado para download.')}
 const exportBackup=async()=>{
  if(blockedStorage.current.saved||blockedStorage.current.pulse||posterStorage.hasBlocked()){
   setNotice('Há dados locais que não puderam ser lidos. A exportação foi interrompida para evitar um backup incompleto.')
   return
  }
  try {
   await exportJsonBackup({version:4,exportedAt:new Date().toISOString(),...saved,posters,posterMeta,unresolved,pulse})
   setNotice(Capacitor.isNativePlatform()?'Escolha um destino no compartilhamento para guardar seu backup.':'Backup preparado para download.')
  } catch {
   setNotice('Não foi possível exportar o backup. Tente novamente ou confira as permissões de compartilhamento.')
  }
 }
const importBackup=async(file?:File)=>{
  if(!file)return
  try{
   if(file.size>5*1024*1024)throw new Error('Arquivo de backup muito grande.')
   const raw:unknown=JSON.parse(await file.text())
   const result=parseBackup(raw,new Set(films.map(f=>f.id)))
    // Validate, then persist the import as a rollback-protected batch.
    // No silent overwrite of malformed personal state on startup.
    posterStorage.restore([
      {key:KEY,value:result.saved},
      ...(result.pulse?[{key:PULSE_KEY,value:result.pulse}]:[]),
      ...(result.posters?[{key:POSTER_KEY,value:result.posters}]:[]),
      ...(result.posterMeta?[{key:META_KEY,value:result.posterMeta}]:[]),
      ...(result.unresolved?[{key:UNRESOLVED_KEY,value:result.unresolved}]:[]),
    ])
    blockedStorage.current.saved=false
    if(result.pulse)blockedStorage.current.pulse=false
    setSaved(result.saved)
   if(result.pulse)setPulse(result.pulse)
   if(result.posters)setPosters(result.posters)
   if(result.posterMeta)setPosterMeta(result.posterMeta)
   if(result.unresolved)setUnresolved(result.unresolved)
   setNotice(`Backup restaurado: ${Object.keys(result.posters||{}).length} vínculos de capas identificados. Confira a Biblioteca.`)
  }catch(err){setNotice(err instanceof Error?`Falha ao importar: ${err.message}`:'Não foi possível importar: backup inválido.')}
 }
 const cards=(items:Film[])=><div className="film-grid">{items.map(f=><button key={f.id} className="film-card" onClick={()=>setSelected(f)}><FilmArt film={f} poster={bundledPosters[f.id]||posters[f.id]}/><div className="film-info"><span className="rating"><Star size={12} fill="currentColor"/> #{f.id} · {f.priority==='N'?'NOVO · SEM NOTA PESSOAL':`PRIORIDADE ${f.priority}`}</span><strong>{f.title}</strong><small>{f.year} · {f.genre}</small>{watched.has(f.id)&&<span className="watched-label"><Check size={12}/> Assistido</span>}</div></button>)}</div>
 return <div className="app cv-v2 cv-v021 cv-v08 cv-v09 cv-v10" translate="no"><header className="top"><div><span className="eyebrow">SUA EXPERIÊNCIA DE CINEMA</span><h1>CINE<span>VAULT</span><i>.</i></h1></div><div className="cv10-header-tools"><ExperienceLayer/><button className="avatar" aria-label="Abrir minha lista" onClick={()=>setTab('Minha lista')}>CV</button></div></header><main>
 {tab==='Início'&&<><section className="cv-pulse-welcome" aria-label="Seu cinema de hoje">
  <div className="cv-pulse-welcome__orbit" aria-hidden="true"><Clapperboard size={35}/></div>
  <span className="cv-pulse-eyebrow">CINEVAULT · LIVING CINEMA</span>
  <h2>{greeting}. O próximo filme já pode começar.</h2>
  <p>{pulse.queue.length ? `${pulse.queue.length} ${pulse.queue.length===1?'filme na':'filmes na'} sua fila de cinema.` : 'Seu acervo se transforma em novas descobertas a cada sessão.'} Descubra, escolha, assista e registre seus momentos.</p>
  <div className="cv-pulse-actions"><button className="cv-pulse-btn-main" onClick={()=>{setTab('Escolher');window.scrollTo(0,0)}}><Sparkles size={17}/> Criar sessão</button><button className="cv-pulse-btn-ghost" onClick={()=>{setTab('Minha lista');setListMode('Fila');window.scrollTo(0,0)}}><ListOrdered size={17}/> Sua fila ({pulse.queue.length})</button></div>
</section>
<section className="cv-pulse-daily" aria-label="Recomendação do dia">
  <div className="cv-pulse-daily__title"><div><span className="cv-pulse-eyebrow">UMA ESCOLHA QUE MUDA COM VOCÊS</span><h3>Filme do dia</h3></div><span className="cv-pulse-date">{todayDisplay}</span></div>
  {dailyFilm ? <div className="cv-pulse-daily__card"><button className="cv-pulse-daily__movie" onClick={()=>setSelected(dailyFilm)}><FilmArt film={dailyFilm} poster={bundledPosters[dailyFilm.id]||posters[dailyFilm.id]}/><span><b>{dailyFilm.title}</b><small>{dailyFilm.genre} · {dailyFilm.duration}</small><em>Prioridade {dailyFilm.priority} · Ver por que combina</em></span><ChevronRight size={19}/></button><div className="cv-pulse-daily__buttons"><button onClick={()=>setPulse(old=>({...old,dailyOffset:old.dailyOffset+1}))}><RefreshCw size={15}/> Outra sugestão</button><button onClick={()=>setPulse(old=>toggleQueue(old,dailyFilm.id,watched))}><ListPlus size={15}/>{pulse.queue.includes(dailyFilm.id)?'Remover da fila':'Adicionar à fila'}</button></div></div> : <p className="cv-pulse-empty">Vocês já exploraram toda a biblioteca. Hora de revisitar seus favoritos!</p>}
</section><div className="section-heading"><span>ESCOLHA DA NOITE</span><span className="gold">✦ PARA VOCÊS</span></div><section className="hero cv-f2-hero-enter"><div className="hero-art"><FilmArt film={featured} large poster={bundledPosters[featured.id] || (posterMeta[featured.id]?.backdropPath?`https://image.tmdb.org/t/p/w780${posterMeta[featured.id].backdropPath}`:posters[featured.id])} fallbackPoster={bundledPosters[featured.id]||posters[featured.id]}/></div><div className="hero-shade"/><div className="hero-content"><span className="pill">#{featured.id} NO RANKING · {featured.priority}</span><h2>{featured.title}</h2><div className="hero-meta">{featured.year} · {featured.genre}</div><p>{featured.reason}</p><button className="primary" onClick={e=>{e.stopPropagation();setSelected(featured)}}>Ver detalhes</button></div></section><div className="cv-home-summary"><div><strong>{films.length-saved.watched.length}</strong><span>Para descobrir</span></div><div><strong>{saved.favorites.length}</strong><span>Favoritos</span></div><div><strong>{Math.round(100*saved.watched.length/films.length)}%</strong><span>Assistidos</span></div></div><div className="cv-home-atelier"><div className="cv-home-atelier__top"><span>CURADORIA EM TEMPO REAL</span><b>SESSÃO PERSONALIZADA</b></div><h2>Seu próximo grande filme</h2><p>Três escolhas do ranking, atualizadas conforme seus favoritos, avaliações e filmes assistidos.</p><div className="cv-home-atelier__list">{homePicks.map((film,i)=><button className="cv-home-atelier__film" key={film.id} onClick={()=>setSelected(film)}><FilmArt film={film} poster={bundledPosters[film.id]||posters[film.id]}/><span><strong>{film.title}</strong><small>#{i+1} para hoje · prioridade {film.priority}</small></span><ChevronLeft className="cv-home-atelier__arrow" style={{transform:'rotate(180deg)'}} size={16}/></button>)}</div><button className="cv-home-atelier__cta" onClick={()=>{setTab('Escolher');window.scrollTo(0,0)}}><Shuffle size={17}/> Montar uma noite de cinema</button></div><div className="section-title"><div><span className="eyebrow">CURADORIA PERSONALIZADA</span><h2>Prioridade máxima</h2></div><span className="count">{films.filter(f=>f.priority==='S').length} filmes</span></div>{cards(films.filter(f=>f.priority==='S'&&!watched.has(f.id)).slice(0,8))}<button className="cv-wide" onClick={()=>{setTab('Biblioteca');setPriority('S');window.scrollTo(0,0)}}>Ver todos da prioridade S →</button><div className="section-title"><div><span className="eyebrow">CINEVAULT 2.0 · DESCOBERTAS</span><h2>683 filmes para explorar</h2></div><span className="count">Sem nota pessoal</span></div>{cards(films.filter(f=>f.priority==='N').slice(0,6))}<button className="cv-wide" onClick={()=>{setTab('Biblioteca');setPriority('N');window.scrollTo(0,0)}}>Explorar os novos filmes →</button></>}
 {tab==='Biblioteca'&&<><div className="section-title"><div><span className="eyebrow">CATÁLOGO COMPLETO</span><h2>Biblioteca de filmes</h2></div><span className="count">{visible.length} / {films.length}</span></div><div className="search"><Search size={18}/><input aria-label="Buscar filmes" placeholder="Buscar filme, diretor, ator ou ano..." value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button onClick={()=>setQuery('')} aria-label="Limpar"><X size={17}/></button>}</div><div className="cv-filter-label"><SlidersHorizontal size={16}/> Prioridade</div><div className="chips">{priorities.map(p=><button key={p} className={priority===p?'active':''} aria-pressed={priority===p} onClick={()=>setPriority(p)}>{p==='N'?'Novos · sem nota':p}</button>)}</div><div className="cv-filter-label">Gênero</div><select className="cv-select" value={genre} onChange={e=>setGenre(e.target.value)}>{genres.map(g=><option key={g}>{g}</option>)}</select><label className="cv-check"><input type="checkbox" checked={hideWatched} onChange={e=>setHideWatched(e.target.checked)}/> Ocultar filmes já assistidos</label><div className="cv-library-tools"><label className="cv-fav-filter"><input type="checkbox" checked={onlyFavorites} onChange={e=>setOnlyFavorites(e.target.checked)}/><Heart size={15}/> Apenas favoritos</label><label className="cv-sort-label">Ordenar<select aria-label="Ordenar filmes" value={sortMode} onChange={e=>setSortMode(e.target.value as SortMode)}>{sortOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>{(query||priority!=='Todas'||genre!=='Todos'||hideWatched||onlyFavorites||sortMode!=='ranking')&&<div className="cv-filter-footer"><span>{visible.length} filmes encontrados</span><button onClick={()=>{setQuery('');setPriority('Todas');setGenre('Todos');setHideWatched(false);setOnlyFavorites(false);setSortMode('ranking')}}>Limpar filtros <X size={13}/></button></div>}{cards(visible.slice(0,limit))}{visible.length>limit&&<button className="cv-wide" onClick={()=>setLimit(n=>n+PAGE_SIZE)}>Carregar mais filmes ({Math.min(PAGE_SIZE,visible.length-limit)} de {visible.length-limit} restantes)</button>}{!visible.length&&<p className="empty">Nenhum filme encontrado. Ajuste os filtros.</p>}</>}
 {tab==='Minha lista'&&<><div className="section-title"><div><span className="eyebrow">SEU ESPAÇO</span><h2>Minha lista</h2></div></div><div className="chips">{(['Favoritos','Assistidos','Fila'] as const).map(m=><button key={m} className={listMode===m?'active':''} aria-pressed={listMode===m} onClick={()=>setListMode(m)}>{m} ({m==='Fila'?pulse.queue.length:saved[m==='Favoritos'?'favorites':'watched'].length})</button>)}</div>{listMode==='Fila' ? <section className="cv-pulse-queue" aria-label="Fila de filmes">
  <div className="cv-pulse-queue__intro"><span className="cv-pulse-eyebrow">ESCOLHAS QUE NÃO SE PERDEM</span><h3>Fila da próxima sessão</h3><p>Separe filmes interessantes e organize a ordem sem perder nada da biblioteca.</p></div>
  {queueFilms.length ? queueFilms.map((film,i)=><article className="cv-pulse-queue__row" key={film.id}>
    <button className="cv-pulse-queue__film" onClick={()=>setSelected(film)}><span className="cv-pulse-queue__position">{String(i+1).padStart(2,'0')}</span><FilmArt film={film} poster={bundledPosters[film.id]||posters[film.id]}/><span><strong>{film.title}</strong><small>{film.duration} · Prioridade {film.priority}</small></span></button>
    <div className="cv-pulse-queue__controls"><button disabled={i===0} aria-label={`Subir ${film.title} na fila`} onClick={()=>setPulse(old=>moveQueue(old,film.id,-1))}><ArrowUp size={17}/></button><button disabled={i===queueFilms.length-1} aria-label={`Descer ${film.title} na fila`} onClick={()=>setPulse(old=>moveQueue(old,film.id,1))}><ArrowDown size={17}/></button><button aria-label={`Remover ${film.title} da fila`} onClick={()=>setPulse(old=>toggleQueue(old,film.id,watched))}><X size={17}/></button></div>
  </article>) : <div className="cv-pulse-empty"><Clapperboard size={30}/><p>Sua fila está esperando o primeiro filme.</p><button onClick={()=>{setTab('Escolher');window.scrollTo(0,0)}}>Encontrar uma boa escolha →</button></div>}
</section> : <>{cards(films.filter(f=>(listMode==='Favoritos'?favorites:watched).has(f.id)))}{!(listMode==='Favoritos'?saved.favorites:saved.watched).length&&<p className="empty">Sua lista está vazia. Abra um filme e marque como {listMode==='Favoritos'?'favorito':'assistido'}.</p>}</>}<h3>Segurança dos seus dados</h3><p className="muted">Os dados ficam neste navegador. Exporte um backup para não perder suas marcações ao limpar os dados do Chrome ou trocar de celular.</p><div className="cv-backup"><button onClick={()=>void exportBackup()}><Download size={17}/> Exportar backup</button><label><Upload size={17}/> Importar backup<input type="file" accept="application/json,.json" onChange={e=>{void importBackup(e.target.files?.[0]);e.target.value=''}}/></label></div></>}
{tab==='Escolher'&&<section className="cv-session"><header className="cv-session__intro"><span className="cv-session__kicker">CINEVAULT · CURADORIA PESSOAL</span><h2>A noite é sua.<br/>O filme também.</h2><p>Escolha o clima e quanto tempo vocês têm. O CineVault cruza o ranking, o histórico e seus gostos para sugerir três filmes diferentes.</p></header><div className="cv-session__config"><label>Que tipo de noite vocês querem?<select value={mood} onChange={e=>{setMood(e.target.value as SessionMood);setSessionReady(false);setSessionRound(0)}}><option value="Todos">Surpreenda-nos</option>{moods.map(([name])=><option key={name} value={name}>{name}</option>)}</select></label><fieldset><legend>Tempo disponível</legend><div className="cv-session__durations">{([{value:'Qualquer',label:'Sem limite'},{value:'110',label:'Até 1h50'},{value:'140',label:'Até 2h20'}] as const).map(option=><button key={option.value} type="button" aria-pressed={sessionDuration===option.value} onClick={()=>{setSessionDuration(option.value);setSessionRound(0);setSessionReady(false)}}>{option.label}</button>)}</div></fieldset></div><button className="cv-session__submit" onClick={choose}><Shuffle size={19}/> {sessionReady?'Descobrir outros três filmes':'Criar minha sessão'}</button><p className="cv-session__count">Sem filmes repetidos, sem conteúdo já assistido e sem conexão necessária para recomendar.</p>{sessionReady&&<section className="cv-session__results" aria-live="polite"><span className="cv-session__kicker">PREPARADO PARA VOCÊS</span><h3>Três filmes. Uma noite memorável.</h3><p>Seleção explicável com base exclusivamente nos dados da sua biblioteca.</p>{sessionPicks.length>0?<div className="cv-session__cards">{sessionPicks.map((film,i)=><article key={film.id} className="cv-session__card"><FilmArt film={film} poster={bundledPosters[film.id]||posters[film.id]}/><div className="cv-session__card-content"><small>ESCOLHA {String(i+1).padStart(2,'0')}</small><strong>{film.title}</strong><p>{sessionReason(film,mood)}</p><button onClick={()=>setSelected(film)}>Explorar filme →</button></div></article>)}</div>:<div className="cv-session__empty">Não há filmes disponíveis com esses filtros. Experimente aumentar o tempo ou escolher outro clima.</div>}</section>}</section>}
 {tab==='Estatísticas'&&<><div className="section-title"><div><span className="eyebrow">SEU HISTÓRICO</span><h2>Estatísticas</h2></div></div><div className="stats"><div><strong>{films.length}</strong><span>Na biblioteca</span></div><div><strong>{saved.watched.length}</strong><span>Assistidos</span></div><div><strong>{saved.favorites.length}</strong><span>Favoritos</span></div></div><div className="cv-progress"><div style={{width:`${100*saved.watched.length/films.length}%`}}/></div><p className="muted">{Math.round(100*saved.watched.length/films.length)}% da biblioteca assistida · {Object.keys(saved.ratings).length} avaliações pessoais</p><section className="cv-pulse-journey"><div className="cv-pulse-journey__head"><span className="cv-pulse-eyebrow">SEU DIÁRIO DE CINEMA</span><h3>Uma história construída filme a filme</h3><p>As datas são registradas somente a partir desta versão. Seus assistidos antigos continuam preservados.</p></div>
<div className="cv-pulse-journey__stats"><div><strong>{journey.recorded}</strong><span>sessões com data</span></div><div><strong>{journey.thisMonth}</strong><span>neste mês</span></div><div><strong>{Object.keys(pulse.notes).length}</strong><span>anotações</span></div></div>
{recentHistory.length ? <div className="cv-pulse-journey__history"><h4>Últimos filmes registrados</h4>{recentHistory.map(entry=>{const film=films.find(f=>f.id===entry.filmId);return film?<button key={entry.filmId} onClick={()=>setSelected(film)}><span><b>{film.title}</b><small>{new Date(entry.watchedAt).toLocaleDateString('pt-BR')}</small></span><ChevronRight size={17}/></button>:null})}</div>:<div className="cv-pulse-empty">Quando marcar o próximo filme como assistido, ele aparecerá aqui com a data da sessão.</div>}
</section><h3>Prioridades</h3><div className="cv-priority-list">{priorities.slice(1).map(p=><div key={p}><b>{p}</b><span>{films.filter(f=>f.priority===p).length} filmes</span></div>)}</div><section className="cv-offline">
 <div className="cv-auto-heading"><WifiOff size={21}/><h3>Biblioteca offline</h3></div>
 <p>{Capacitor.isNativePlatform()?'A biblioteca de filmes já funciona no APK. As capas vinculadas continuam sendo carregadas pela internet até incluirmos o pacote de imagens em uma atualização futura.':'Opcional: baixe as capas identificadas para continuar vendo os pôsteres sem internet neste navegador. Os dados pessoais ficam separados do cache de imagens.'}</p>
 <div className="cv-offline-summary"><div><strong>{offlineStatus?.cached ?? 0} / {films.length}</strong><span>capas salvas offline</span></div><div><strong>{humanBytes(offlineStatus?.usedBytes)}</strong><span>ocupação estimada do site*</span></div></div>
 <div className="cv-auto-track"><div style={{width:`${Math.round(100*(offlineStatus?.cached ?? 0)/films.length)}%`}}/></div>
 <small>* Inclui outros dados do site e pode superestimar imagens de servidores externos. Armazenamento do navegador não é o mesmo do futuro APK.</small>
 {offlineProgress.total>0&&<div className="cv-auto-status" role="status"><strong>{offlineProgress.running?'Baixando capas…':'Último download'}</strong><span>{offlineProgress.done} de {offlineProgress.total} verificadas · {offlineProgress.added} novas · {offlineProgress.failed} falhas</span><div className="cv-auto-track"><div style={{width:`${Math.round(100*offlineProgress.done/offlineProgress.total)}%`}}/></div></div>}
 <div className="cv-offline-actions"><button disabled={!availableOffline()||offlineProgress.running||(!offlineStatus?.total&&!Object.keys(bundledPosters).length)} onClick={()=>void startOffline()}><Download size={17}/> {offlineStatus?.cached?'Continuar / verificar downloads':'Baixar todas as capas'}</button>{offlineProgress.running&&<button className="cv-stop" onClick={()=>{pauseOffline.current=true}}><PauseCircle size={17}/> Pausar após capa atual</button>}<button disabled={offlineProgress.running} onClick={()=>void refreshOffline()}><RefreshCw size={17}/> Atualizar contagem</button><button disabled={offlineProgress.running} onClick={()=>void persistOffline()}><ShieldCheck size={17}/> Proteger armazenamento</button><button disabled={offlineProgress.running} onClick={()=>void removeOffline()}><Trash2 size={17}/> Remover capas baixadas</button></div>
 {!availableOffline()&&!Capacitor.isNativePlatform()&&<p role="alert">O armazenamento offline não está disponível neste navegador.</p>}
 <p className="cv-offline-info"><HardDrive size={16}/> {Capacitor.isNativePlatform()?'Imagens offline serão adicionadas em uma futura atualização do APK, sem necessidade de cadastrar novamente os filmes.':'Para levar as 317 imagens dentro do APK, usaremos posteriormente o exportador de capas do Termux, já incluído no projeto.'}</p>
 </section><section className="cv-auto"><div className="cv-auto-heading"><ImagePlus size={21}/><h3>Capas automáticas</h3></div><p>As capas dos filmes cadastrados são vinculadas automaticamente pelo TMDb; imagens não baixadas dependem da internet. Novas consultas usam título original, ano e diretor para evitar imagens incorretas. A identificação exige internet; as capas baixadas poderão ser exibidas offline.</p><div className="cv-auto-metrics"><span><b>{coverCount}</b> com capa</span><span><b>{Object.keys(unresolved).filter(id=>!posters[id]&&!bundledPosters[id]).length}</b> pendentes</span><span><b>{films.length-coverCount}</b> sem capa</span></div><label>API Read Access Token do TMDb<input type="password" value={tmdbToken} autoComplete="off" spellCheck={false} onChange={e=>setTmdbToken(e.target.value)} placeholder="Cole o token do TMDb" /></label><small>Token usado apenas nesta sessão e enviado diretamente ao TMDb para consulta. Não fica salvo nem é incluído no backup. Mantenha esta aba aberta durante a identificação.</small><div className="cv-auto-buttons"><button disabled={autoProgress.running} onClick={()=>void autoPosters(false)}><ImagePlus size={17}/> Identificar capas automaticamente</button><button disabled={autoProgress.running} onClick={()=>void autoPosters(true)}><RefreshCw size={17}/> Resolver pendentes por diretor</button><button disabled={autoProgress.running} onClick={exportPending}><Download size={17}/> Exportar lista de pendentes</button>{autoProgress.running&&<button className="cv-stop" onClick={()=>{stopPosterRun.current=true}}><PauseCircle size={17}/> Pausar após filme atual</button>}</div>{autoProgress.total>0&&<div className="cv-auto-status" role="status"><strong>{autoProgress.running?'Buscando capas…':'Última execução'}</strong><span>{autoProgress.done} de {autoProgress.total} concluídos · {autoProgress.matched} associados · {autoProgress.missed} pendentes</span><div className="cv-auto-track"><div style={{width:`${Math.round(100*autoProgress.done/autoProgress.total)}%`}}/></div><small>{autoProgress.current||'O catálogo continua disponível durante o processamento.'}</small></div>}<img className="cv-auto-brand" alt="TMDb" loading="lazy" src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"/><p className="cv-auto-legal">Imagens e sinopses: TMDb. Este produto utiliza a API do TMDb, mas não é endossado nem certificado pelo TMDb. <a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer">The Movie Database</a>.</p></section></>}
 </main><nav className="bottom" aria-label="Navegação principal">{[{label:'Início',icon:Home},{label:'Biblioteca',icon:Clapperboard},{label:'Minha lista',icon:Heart},{label:'Escolher',icon:Shuffle},{label:'Estatísticas',icon:ChartNoAxesColumn}].map(({label,icon:Icon})=><button key={label} className={tab===label?'current':''} aria-current={tab===label?'page':undefined} onClick={()=>{setTab(label);window.scrollTo(0,0)}}><Icon size={21} strokeWidth={tab===label?2.5:1.8}/><span translate="no">{label}</span></button>)}</nav>
 {selected&&<div className="overlay" onClick={()=>setSelected(null)}><div className="detail cv-f2-detail-enter" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Detalhes do filme" onClick={e=>e.stopPropagation()}><div className="cv-detail-banner" aria-hidden="true">{(posterMeta[selected.id]?.backdropPath||posters[selected.id])&&<img loading="lazy" src={posterMeta[selected.id]?.backdropPath?`https://image.tmdb.org/t/p/w780${posterMeta[selected.id].backdropPath}`:posters[selected.id]} alt=""/>}<div className="cv-detail-banner-shade"/></div><button ref={closeRef} className="close" aria-label="Fechar" onClick={()=>setSelected(null)}><X/></button><div className="detail-top"><FilmArt film={selected} poster={bundledPosters[selected.id]||posters[selected.id]}/><div><span className="pill">#{selected.id} · {selected.priority==='N'?'NOVO · SEM NOTA PESSOAL':`PRIORIDADE ${selected.priority}`}</span><h2>{selected.title}</h2><p>{selected.year} · {selected.duration}</p><span className="gold">{selected.priority==='N'?'Ainda sem avaliação pessoal':selected.stars}</span></div></div><p>{selected.reason}</p><Cv2FilmDetails filmId={selected.id}/><div className="cv-meta"><div><b>Gênero</b><span>{selected.genre}</span></div><div><b>Diretor</b><span>{selected.director}</span></div><div><b>Elenco</b><span>{selected.actors}</span></div><div><b>Ritmo</b><span>{selected.pace}</span></div><div><b>Reviravolta</b><span>{selected.twist}</span></div><div><b>IMDb / Rotten Tomatoes / Letterboxd</b><span>{selected.imdb} · {selected.rt} · {selected.letterboxd}</span></div></div><Suspense fallback={<p className="muted">Preparando o player de trailer…</p>}><FilmTrailer key={selected.id} filmId={selected.id} filmTitle={selected.title}/></Suspense><section className="cv-poster-tool"><h3><ImagePlus size={17}/> Imagens automáticas</h3><p>{(bundledPosters[selected.id]||posters[selected.id])?'Pôster TMDb vinculado automaticamente ao catálogo.':'Pôster ainda não disponível. Use a identificação automática em Estatísticas.'}</p>{posterMeta[selected.id]?.overview&&<><h4>Sinopse (TMDb)</h4><p>{posterMeta[selected.id].overview}</p></>}{unresolved[selected.id]&&<small>Última tentativa: {unresolved[selected.id]}</small>}</section>{selected.priority!=='N'&&<div className="detail-stats"><span>Tensão <b>{selected.tension}/10</b></span><span>Emoção <b>{selected.emotion}/10</b></span></div>}<div className="cv-user-rating"><b>Sua avaliação</b><div>{[1,2,3,4,5].map(n=><button key={n} aria-label={`Avaliar ${n} estrelas`} onClick={()=>rate(selected.id,n)}><Star size={23} fill={(saved.ratings[selected.id]||0)>=n?'currentColor':'none'}/></button>)}</div></div><section className="cv-pulse-detail" aria-label="Sua experiência com este filme">
  <div className="cv-pulse-detail__title"><BookOpen size={19}/><h3>Seu diário de cinema</h3></div>
  <p>Uma lembrança, uma opinião ou o que vocês querem observar quando assistirem. Só vocês veem estas anotações.</p>
  <textarea aria-label="Anotação pessoal sobre o filme" maxLength={500} rows={3} placeholder="O que fez esse filme chamar sua atenção?" value={noteDraft} onChange={e=>setNoteDraft(e.target.value)}/>
  <div className="cv-pulse-detail__buttons"><button onClick={()=>{setPulse(old=>saveNote(old,selected.id,noteDraft));setNotice('Anotação salva no seu diário. Exporte um novo backup quando puder.')}}><Check size={16}/> Salvar anotação</button><button disabled={watched.has(selected.id)} aria-pressed={pulse.queue.includes(selected.id)} onClick={()=>setPulse(old=>toggleQueue(old,selected.id,watched))}><ListPlus size={16}/>{pulse.queue.includes(selected.id)?'Retirar da fila':'Colocar na fila'}</button></div>
  {pulse.history.some(h=>h.filmId===selected.id)&&<small className="cv-pulse-detail__watched">Sessão registrada em {new Date(pulse.history.find(h=>h.filmId===selected.id)!.watchedAt).toLocaleDateString('pt-BR')}</small>}
</section><div className="actions"><button onClick={()=>toggle('favorites',selected.id)}><Heart size={18} fill={favorites.has(selected.id)?'currentColor':'none'}/>{favorites.has(selected.id)?'Favoritado':'Favoritar'}</button><button onClick={()=>toggle('watched',selected.id)}>{watched.has(selected.id)?'✓ Assistido':'Marcar assistido'}</button></div><section className="cv-related"><h3>Na mesma linha</h3><p>Outros filmes do seu ranking que podem combinar com esta escolha.</p><div className="cv-related-list">{related.map(f=><button key={f.id} onClick={()=>setSelected(f)}><FilmArt film={f} poster={bundledPosters[f.id]||posters[f.id]}/><span>{f.title}</span><small>#{f.id} · {f.priority}</small></button>)}</div></section><button className="cv-wide" onClick={()=>setSelected(null)}><ChevronLeft size={16}/> Voltar</button></div></div>}
 {notice&&<button className="cv-toast" role="status" onClick={()=>setNotice('')}>{notice} · Fechar</button>}
 </div>
}
