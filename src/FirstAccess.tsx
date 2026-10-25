import {useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {ArrowRight,Clapperboard,ShieldCheck,Upload} from 'lucide-react'
import type {PersonalPersistence} from './personalPersistence.ts'
import {completeFirstAccess,needsFirstAccess,readDiscoveryPreferences,saveDiscoveryPreferences} from './publicAccess.ts'
import {DISCOVERY_FORMATS,type DiscoveryFormat} from './experiencePreferences.ts'
import {restoreLibraryBackup} from './personalBackupImport.ts'
import './FirstAccess.css'

function FormatChoices({value,onChange,disabled=false}:{value:DiscoveryFormat[];onChange:(value:DiscoveryFormat[])=>void;disabled?:boolean}) {
  return <fieldset className="sn-access-formats" disabled={disabled}><legend>O que você quer explorar?</legend>
    {DISCOVERY_FORMATS.map(option=><label key={option.id}><input type="checkbox" checked={value.includes(option.id)}
      onChange={()=>onChange(value.includes(option.id)?value.filter(id=>id!==option.id):[...value,option.id])}/><span>{option.label}</span></label>)}
  </fieldset>
}

/** Mounted only after the storage bootstrap; the library and its effects wait until this flow ends. */
export function FirstAccess({persistence,knownIds,children}:{persistence:PersonalPersistence;knownIds:ReadonlySet<number>;children:ReactNode}) {
  const [screen,setScreen]=useState<'welcome'|'preferences'|'library'>(()=>
    needsFirstAccess(persistence.reader,persistence.getMediaProgress())?'welcome':'library')
  const [formats,setFormats]=useState<DiscoveryFormat[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const input=useRef<HTMLInputElement>(null),heading=useRef<HTMLHeadingElement>(null),inFlight=useRef(false)
  const status=useSyncExternalStore(persistence.subscribe,persistence.getStatus,persistence.getStatus)
  useEffect(()=>{if(screen!=='library')heading.current?.focus()},[screen])
  const run=async(operation:()=>Promise<void>)=>{
    if(inFlight.current)return
    inFlight.current=true;setBusy(true);setMessage('')
    try{await operation();setScreen('library')}
    catch(error){setMessage(error instanceof Error?error.message:'Não foi possível concluir. Seus dados foram preservados.')}
    finally{inFlight.current=false;setBusy(false)}
  }
  const restore=async(file?:File)=>{
    if(!file)return
    await run(async()=>{
      if(file.size>96*1024*1024)throw new Error('Arquivo de backup muito grande.')
      let raw:unknown
      try{raw=JSON.parse(await file.text())}catch{throw new Error('Não foi possível ler uma cópia válida neste arquivo.')}
      await persistence.flush()
      if(persistence.getStatus().phase!=='ready'||!needsFirstAccess(persistence.reader,persistence.getMediaProgress()))
        throw new Error('Sua biblioteca mudou. Reabra seus dados antes de restaurar uma cópia.')
      await restoreLibraryBackup(persistence,raw,file.size,knownIds)
    })
  }
  if(screen==='library')return children
  const disabled=busy||status.phase!=='ready'
  return <main className="sn-access" translate="no"><section className="sn-access-card" aria-busy={busy}>
    <span className="sn-access-symbol" aria-hidden="true"><Clapperboard size={34}/></span>
    <span className="sn-access-kicker">SUA PRÓXIMA BOA HISTÓRIA</span>
    <h1 ref={heading} tabIndex={-1}>{screen==='welcome'?'Uma biblioteca com a sua cara.':'Comece pelo que você gosta.'}</h1>
    {screen==='welcome'?<>
      <p>Descubra filmes, séries, animes e programas. Organize suas escolhas e acompanhe os episódios que já assistiu.</p>
      <div className="sn-access-note"><ShieldCheck size={22}/><p><strong>Entre e explore, sem cadastro.</strong> Sua lista e seu histórico ficam neste aparelho. Você pode guardar e restaurar uma cópia completa.</p></div>
      <button className="sn-access-primary" disabled={disabled} onClick={()=>setScreen('preferences')}>Explorar agora <ArrowRight size={18}/></button>
      <button className="sn-access-secondary" disabled={disabled} onClick={()=>input.current?.click()}><Upload size={18}/> Restaurar cópia</button>
      <input ref={input} className="sn-access-file" type="file" accept="application/json,.json" aria-label="Selecionar cópia da biblioteca" disabled={disabled}
        onChange={event=>{const file=event.target.files?.[0];event.target.value='';void restore(file)}}/>
      <small>O aplicativo ajuda a escolher e acompanhar. Para assistir às obras completas, use os serviços oficiais.</small>
    </>:<>
      <p>Escolha os atalhos que quer ver no início. Você pode mudar depois, em Minha lista.</p>
      <FormatChoices value={formats} onChange={setFormats} disabled={disabled}/>
      <button className="sn-access-primary" disabled={disabled} onClick={()=>void run(()=>completeFirstAccess(persistence,formats))}>Abrir minha biblioteca <ArrowRight size={18}/></button>
      <button className="sn-access-secondary" disabled={disabled} onClick={()=>void run(()=>completeFirstAccess(persistence,[]))}>Agora não</button>
      <button className="sn-access-back" disabled={disabled} onClick={()=>{setMessage('');setScreen('welcome')}}>Voltar</button>
      <small>As escolhas organizam a exploração. A curadoria inicial é uma seleção editorial; suas avaliações pessoais começam vazias.</small>
    </>}
    {busy&&<p role="status">{screen==='welcome'?'Restaurando sua biblioteca…':'Salvando suas escolhas…'}</p>}
    {message&&<p role="alert" className="sn-access-error">{message}</p>}
  </section></main>
}

export function DiscoveryPreferences({persistence}:{persistence:PersonalPersistence}) {
  const status=useSyncExternalStore(persistence.subscribe,persistence.getStatus,persistence.getStatus)
  // The reader is stable; its cached contents change only on an acknowledged revision.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const model=useMemo(()=>readDiscoveryPreferences(persistence.reader),[persistence,status.version])
  const [draft,setDraft]=useState<DiscoveryFormat[]|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const value=draft??model.value.publicAccess?.formats??[]
  const save=async()=>{
    if(busy)return
    const selected=[...value];setBusy(true);setMessage('')
    try{await saveDiscoveryPreferences(persistence,selected);setDraft(null);setMessage('Preferências de exploração salvas.')}
    catch(error){setMessage(error instanceof Error?error.message:'Não foi possível salvar.')}
    finally{setBusy(false)}
  }
  return <section className="sn-discovery-preferences" aria-label="Preferências de exploração"><h3>Suas descobertas</h3>
    <p>Escolha os atalhos do início. Você continua podendo explorar todo o catálogo.</p>
    <FormatChoices value={value} onChange={setDraft} disabled={busy||model.blocked||status.phase!=='ready'}/>
    {model.blocked?<p role="alert">Suas preferências foram preservadas. Revise os dados antes de alterá-las.</p>:
      <button disabled={busy||status.phase!=='ready'} onClick={()=>void save()}>Salvar preferências de exploração</button>}
    {message&&<p role="status">{message}</p>}
  </section>
}
