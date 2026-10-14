import { useEffect, useRef, useState } from 'react'
import { BellRing, Check, ChevronRight, Download, Eye, Film, Headphones, RotateCw, Settings2, ShieldCheck, Sparkles, Volume2, VolumeX, X } from 'lucide-react'
import { Capacitor } from '@capacitor/core'
import { fetchLatestRelease, LOCAL_RELEASE, type Release } from './release'
import { playBrandAudio, stopBrandAudio, type SonicStyle } from './sonic'
import { beginNativeUpdate, currentInstalledBuild, nativeUpdateAvailable } from './nativeUpdater'
import './experience.css'

const PREF_KEY='cinevault.experience.v1'
type Preferences={intro:boolean,sound:boolean,updates:boolean,sonic:SonicStyle,volume:number}
const defaults:Preferences={intro:true,sound:true,updates:true,sonic:'cinema',volume:.65}
function preferences():Preferences {
 try {const parsed:unknown=JSON.parse(localStorage.getItem(PREF_KEY)||'null');return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?{
 intro:(parsed as Partial<Preferences>).intro!==false,
 sound:(parsed as Partial<Preferences>).sound!==false,
 updates:(parsed as Partial<Preferences>).updates!==false,
 sonic:(parsed as Partial<Preferences>).sonic==='aura'?'aura':'cinema',
 volume:typeof (parsed as Partial<Preferences>).volume==='number' && Number.isFinite((parsed as Preferences).volume)?Math.min(1,Math.max(.15,(parsed as Preferences).volume)):.65
 }:defaults}catch{return defaults}
}
/** Playback may fail under browser autoplay policy, never block startup. */
export const playBrandTone = playBrandAudio

export function ExperienceLayer(){
 const [prefs,setPrefs]=useState<Preferences>(preferences)
 const [splash,setSplash]=useState(()=>prefs.intro)
 const [settings,setSettings]=useState(false)
 const [update,setUpdate]=useState<Release|null>(null)
 const [preview,setPreview]=useState(false)
 const [checkState,setCheckState]=useState<'idle'|'checking'|'none'>('idle')
 const [soundMsg,setSoundMsg]=useState('')
 const [autoSoundBlocked,setAutoSoundBlocked]=useState(false)
 const [downloadBusy,setDownloadBusy]=useState(false)
 const [downloadPct,setDownloadPct]=useState(0)
 const [installError,setInstallError]=useState('')
 const lastCheckedAt=useRef(0)
 const dismissedForSession=useRef<number|null>(null)
 const introPlayed = useRef(false)
 const reduced=typeof window!=='undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
 function save(p:Preferences){setPrefs(p);try{localStorage.setItem(PREF_KEY,JSON.stringify(p))}catch{/* Persistence is best-effort; never block app */}}
 function closeSplash(){stopBrandAudio();setSplash(false)}
 function replaySplash(){stopBrandAudio();setSettings(false);setAutoSoundBlocked(false);setSplash(true);if(prefs.sound)void playBrandTone(prefs.sonic,prefs.volume).then(ok=>{if(!ok)setAutoSoundBlocked(true)});window.setTimeout(()=>closeSplash(),reduced?380:2570)}
 async function check(manual:boolean){
  if(!manual&&Date.now()-lastCheckedAt.current<180000)return
  lastCheckedAt.current=Date.now()
  if(manual)setCheckState('checking')
  const build=await currentInstalledBuild(LOCAL_RELEASE.build)
  const available=await fetchLatestRelease(fetch,build)
  if(available){
   if(manual||dismissedForSession.current!==available.build)setUpdate(available)
   setCheckState('idle')
  }else if(manual)setCheckState('none')
 }
 useEffect(()=>{
  if (!prefs.intro){setSplash(false);return}
  if (prefs.sound&&!introPlayed.current){
   introPlayed.current=true
   void playBrandTone(prefs.sonic,prefs.volume).then(ok=>{if(!ok)setAutoSoundBlocked(true)})
  }
  const timer=window.setTimeout(()=>setSplash(false),reduced?380:2570)
  return ()=>{window.clearTimeout(timer);stopBrandAudio();introPlayed.current=false}
  // Initial launch only: settings changes should not re-trigger the intro.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[])
 useEffect(()=>{
  if(prefs.updates){const timer=window.setTimeout(()=>void check(false),splash?3000:800);return()=>window.clearTimeout(timer)}
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[splash,prefs.updates])
 useEffect(()=>{
  const activate=()=>{if(prefs.updates&&document.visibilityState==='visible')void check(false)}
  document.addEventListener('visibilitychange',activate)
  window.addEventListener('focus',activate)
  return()=>{document.removeEventListener('visibilitychange',activate);window.removeEventListener('focus',activate)}
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[prefs.updates])
 useEffect(()=>{
  const esc=(e:KeyboardEvent)=>{if(e.key==='Escape'){if(update&&!update.required){setUpdate(null)}else setSettings(false)}}
  document.addEventListener('keydown',esc)
  return()=>document.removeEventListener('keydown',esc)
 },[update])
 async function goToRelease(release:Release){
   if(nativeUpdateAvailable()){
    setInstallError('');setDownloadPct(0);setDownloadBusy(true)
    try{
      const status=await beginNativeUpdate(release,setDownloadPct)
      if(status==='permission_required')setInstallError('Autorize o CineVault a instalar atualizações nas configurações do Android, volte ao aplicativo e toque em Atualizar novamente.')
      else if(status==='installer_opened')setInstallError('Download validado. Confirme a instalação na janela do Android.')
    }catch(err){setInstallError(err instanceof Error?err.message:'Não foi possível baixar a atualização; tente novamente.')}
    finally{setDownloadBusy(false)}
    return
   }
   if(Capacitor.isNativePlatform()){
    setInstallError('O instalador interno não está disponível neste APK. Reinstale a versão com suporte nativo.');return
   }
   window.open(release.url,'_blank','noopener,noreferrer')
 }
 return <>
  <button className="cv10-settings-trigger" aria-label="Abrir configurações do CineVault" onClick={()=>{setSettings(true);setCheckState('idle')}} title="Experiência e atualizações"><Settings2 size={20}/></button>
  {splash&&<div className="cv10-splash" aria-label="Iniciando CineVault" role="status">
   <div className="cv11-film-beam" aria-hidden="true"/><div className="cv11-frame-top" aria-hidden="true"/><div className="cv10-splash-halo"/><div className="cv11-reel" aria-hidden="true"/><img className="cv10-splash-icon" src="/icon-512.png" alt="CineVault"/>
   <span className="cv10-splash-word">CINE<span>VAULT</span></span>
   <span className="cv10-splash-tag">SEU CINEMA. SUAS ESCOLHAS. SUA HISTÓRIA.</span>
   <span className="cv11-splash-caption">SIGNATURE EXPERIENCE</span>
   <div className="cv10-splash-line" aria-hidden="true"/>
   {autoSoundBlocked && prefs.sound && <button className="cv11-unlock-audio" onClick={()=>{void playBrandTone(prefs.sonic,prefs.volume).then(ok=>setAutoSoundBlocked(!ok))}}> <Volume2 size={16}/> Tocar assinatura sonora</button>}
   <button className="cv10-splash-skip" onClick={closeSplash}>Pular abertura</button>
  </div>}
  {settings&&<div className="cv10-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setSettings(false)}}>
   <section role="dialog" aria-modal="true" aria-label="Configurações da experiência" className="cv10-panel">
    <header><div><span className="cv10-kicker"><Sparkles size={14}/> SIGNATURE EXPERIENCE · 1.2</span><h2>Uma experiência sua.</h2></div><button className="cv10-x" onClick={()=>setSettings(false)} aria-label="Fechar configurações"><X/></button></header>
    <div className="cv10-pref"><span><Film/><b>Abertura cinematográfica</b><small>Exibir o símbolo ao iniciar</small></span><input type="checkbox" aria-label="Ativar abertura cinematográfica" checked={prefs.intro} onChange={e=>save({...prefs,intro:e.target.checked})}/></div>
    <div className="cv10-pref"><span>{prefs.sound?<Volume2/>:<VolumeX/>}<b>Assinatura sonora</b><small>Escolha o timbre e o volume; o aparelho pode bloquear reprodução automática</small></span><input type="checkbox" aria-label="Ativar som de abertura" checked={prefs.sound} onChange={e=>save({...prefs,sound:e.target.checked})}/></div>
    <div className="cv11-sound-controls" aria-label="Estilo do som de abertura"><div className="cv11-modes"><button aria-pressed={prefs.sonic==='cinema'} onClick={()=>save({...prefs,sonic:'cinema',sound:true})}>Cinema · Impacto</button><button aria-pressed={prefs.sonic==='aura'} onClick={()=>save({...prefs,sonic:'aura',sound:true})}>Aura · Suave</button></div><label htmlFor="cv11-volume">Volume <strong>{Math.round(prefs.volume*100)}%</strong></label><input id="cv11-volume" type="range" min="15" max="100" step="5" value={Math.round(prefs.volume*100)} onChange={e=>save({...prefs,volume:Number(e.target.value)/100})}/></div>
    <div className="cv10-pref"><span><BellRing/><b>Verificar atualizações</b><small>Avisos automáticos no APK ao abrir e quando voltar ao aplicativo</small></span><input type="checkbox" aria-label="Verificar atualizações ao abrir" checked={prefs.updates} onChange={e=>save({...prefs,updates:e.target.checked})}/></div>
    <div className="cv10-actions"><button onClick={replaySplash}><Eye size={17}/> Rever abertura</button><button onClick={()=>void playBrandTone(prefs.sonic,prefs.volume).then(ok=>setSoundMsg(ok?'Assinatura sonora reproduzida.':'O áudio foi bloqueado pelo sistema.'))}><Headphones size={17}/> Ouvir som</button></div>
    {soundMsg&&<small className="cv10-message" role="status">{soundMsg}</small>}
    <div className="cv10-release"><span className="cv10-kicker"><ShieldCheck size={15}/> ATUALIZAÇÕES</span><p>Versão desta compilação: <strong>{LOCAL_RELEASE.version} (build {LOCAL_RELEASE.build})</strong></p><button className="cv10-check" disabled={checkState==='checking'} onClick={()=>void check(true)}><RotateCw size={16}/> {checkState==='checking'?'Consultando…':'Buscar atualização agora'}</button>{checkState==='none'&&<small>Não há uma versão mais recente confirmada ou não foi possível consultar agora.</small>}<button className="cv10-demo" onClick={()=>{setSettings(false);setPreview(true)}}>Visualizar o aviso de atualização <ChevronRight size={15}/></button></div>
    <p className="cv10-disclaimer">O APK verifica a versão, baixa e confere a assinatura localmente. O Android sempre pede confirmação antes de instalar; seus dados não são apagados em atualizações assinadas pela mesma chave.</p>
   </section>
  </div>}
  {(update||preview)&&<div className="cv10-overlay cv10-over-update">
   <section className="cv10-panel cv10-update" role="dialog" aria-modal="true" aria-label="Nova versão disponível">
    <img src="/icon-192.png" alt="" className="cv10-update-icon"/>
    <span className="cv10-kicker">{preview?'DEMONSTRAÇÃO DO AVISO':'CINEVAULT · NOVA VERSÃO'}</span>
    <h2>{preview?'Assim será o aviso de atualização':update?.title}</h2>
    <p>{preview?'Quando houver uma nova versão publicada, as novidades aparecerão aqui.':`Nova versão ${update?.version} disponível para instalar.`}</p>
    <ul>{preview?<><li><Check size={15}/> Novidades e melhorias detalhadas</li><li><Check size={15}/> Link oficial de instalação</li></>:update?.notes.map((text,i)=><li key={i}><Check size={15}/>{text}</li>)}</ul>
    {update&&!preview&&<button className="cv10-primary" disabled={downloadBusy} onClick={()=>void goToRelease(update)}><Download size={18}/> {downloadBusy?'Baixando e verificando…':nativeUpdateAvailable()?'Baixar e atualizar no app':'Abrir APK oficial'}</button>}
    {update&&!preview&&downloadBusy&&<div className="cv12-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloadPct}><span style={{width:`${downloadPct}%`}}/></div>}
    {installError&&<small className="cv12-install-status" role="status">{installError}</small>}
    <button className="cv10-secondary" disabled={downloadBusy} onClick={()=>{
      if(update&&!preview)dismissedForSession.current=update.build
      setUpdate(null);setPreview(false);setInstallError('')
    }}>{preview?'Fechar demonstração':'Depois'}</button>
    {update?.required&&!preview&&<small>Atualização recomendada para continuar com segurança. O uso offline não é bloqueado.</small>}
   </section>
  </div>}
 </>
}
