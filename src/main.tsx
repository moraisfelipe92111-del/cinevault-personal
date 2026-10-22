import { StrictMode, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './personalStorage.css'
import AppErrorBoundary from './AppErrorBoundary'
import { Capacitor } from '@capacitor/core'
import { openPersonalStorage, type OpenPersonalStorage } from './nativePersonalStorage'
import { personalStorageCoordinator } from './personalStorage'
import { capturePersonalStorageSnapshot, type PersonalStorageSnapshot } from './personalStorageSnapshot'
import { exportJsonBackup } from './nativeBackup'
import { PersonalStorageLockError } from './personalStorageLock'

type Application = typeof import('./App.tsx').default
const root = createRoot(document.getElementById('root')!)
let opened: OpenPersonalStorage | null = null
let opening = false

function Recovery({onRetry, snapshot, confirmed=false,reason}:{onRetry:()=>void; snapshot:()=>PersonalStorageSnapshot; confirmed?:boolean;reason?:string}) {
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const backup=async()=>{
    setBusy(true)
    try{await exportJsonBackup(snapshot(),'complete');setMessage('Escolha um destino para guardar esta cópia.')}
    catch{setMessage('Não foi possível ler esta cópia. Não limpe os dados nem desinstale o aplicativo.')}
    finally{setBusy(false)}
  }
  return <main className="cv-storage-screen"><section role="alert">
    <h1>Vamos preservar sua biblioteca.</h1>
    <p>Não foi possível confirmar a abertura ou o salvamento dos dados. Confira o espaço disponível e tente reabri-los.</p>
    {reason&&<p>{reason}</p>}
    <p>Se o problema continuar, feche o aplicativo completamente e abra de novo. Evite desinstalar ou limpar seus dados.</p>
    <button disabled={busy} onClick={onRetry}>Reabrir meus dados</button>
    <button disabled={busy} onClick={()=>void backup()}>{confirmed?'Exportar última cópia confirmada':'Exportar dados anteriores'}</button>
    {confirmed&&<small>Esta cópia contém a última gravação que o aplicativo conseguiu confirmar. Reabra os dados para verificar se houve uma gravação posterior.</small>}
    {message&&<p role="status">{message}</p>}
  </section></main>
}

function StorageApplication({owner,App}:{owner:OpenPersonalStorage;App:Application}) {
  const status=useSyncExternalStore(owner.persistence.subscribe,owner.persistence.getStatus,owner.persistence.getStatus)
  if(status.phase==='failed'||status.phase==='closed')return <Recovery onRetry={()=>void start()} snapshot={()=>owner.persistence.captureSnapshot()} confirmed/>
  return <App persistence={owner.persistence}/>
}

async function start() {
  if(opening)return
  opening=true
  root.render(<main className="cv-storage-screen"><section role="status"><h1>Preparando sua biblioteca…</h1><p>Estamos conferindo seus dados antes de abrir.</p></section></main>)
  try {
    if(opened){await opened.close();opened=null}
    opened=await openPersonalStorage()
    // App parsers and effects cannot run before the native bootstrap completes.
    const {default:App}=await import('./App.tsx')
    const owner=opened
    root.render(<StrictMode><AppErrorBoundary onRetry={()=>void start()}><StorageApplication owner={owner} App={App}/></AppErrorBoundary></StrictMode>)
  } catch(error) {
    const owner=opened
    root.render(<Recovery onRetry={()=>void start()} snapshot={()=>owner?owner.persistence.captureSnapshot():capturePersonalStorageSnapshot(personalStorageCoordinator.store)} confirmed={Boolean(owner)} reason={error instanceof PersonalStorageLockError?error.message:undefined}/>)
  } finally {opening=false}
}

// The dedicated CI document executes the injected probe with synthetic data.
// Its real application entry remains present but never opens the production DB.
if(!document.querySelector('script[src="/cv2-native-sqlite-audit.js"]'))void start()

window.addEventListener('pagehide',()=>{if(opened)void opened.close().catch(()=>{})})

if (!Capacitor.isNativePlatform() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
  })
}
