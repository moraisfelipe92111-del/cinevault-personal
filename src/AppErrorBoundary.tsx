import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode; onRetry?: () => void }
type State = { failed: boolean }
/** Covers React rendering errors; native crashes still require Android instrumentation. */
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }
  static getDerivedStateFromError(): State { return { failed: true } }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    // No user information or backups are logged remotely.
    if (import.meta.env.DEV) console.error('[CineVault] Renderização interrompida:', error.name)
  }
  render() {
    if (!this.state.failed) return this.props.children
    return <main style={{minHeight:'100dvh',background:'#090a0d',color:'#eee4d6',display:'grid',placeItems:'center',padding:28,fontFamily:'system-ui'}}>
      <section style={{maxWidth:440,textAlign:'center'}} role="alert">
        <h1 style={{color:'#e6bf7b'}}>CineVault</h1>
        <h2>Não foi possível abrir esta tela.</h2>
        <p>Seus dados não foram apagados. Não desinstale o aplicativo; tente reabrir e, se o problema continuar, use seu backup.</p>
        <button style={{background:'#d4ac70',color:'#15120f',padding:'14px 22px',border:0,borderRadius:12,fontWeight:700}} onClick={() => this.props.onRetry ? this.props.onRetry() : window.location.reload()}>Tentar novamente</button>
      </section>
    </main>
  }
}
