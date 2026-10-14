/**
 * Pack TMDb posters as real APK/PWA assets directly from a CineVault JSON backup.
 * Runs under Node 20+ / Termux, without any API token or third-party dependency.
 * This bypasses browser CORS restrictions and prevents origin-bound browser cache
 * from being confused with files that actually ship inside an Android APK.
 */
import { readFile, writeFile, mkdir, stat, rename, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const backupPath = process.argv[2]
if (!backupPath) {
  console.error('Uso: node scripts/pack-posters.mjs ~/storage/downloads/cinevault-backup.json')
  process.exit(2)
}
const root = resolve(import.meta.dirname, '..')
const directory = join(root, 'public', 'offline-posters')
const catalog = JSON.parse(await readFile(join(root, 'src', 'films.json'), 'utf8'))
const knownIds = new Set(catalog.map(f => f.id))
const data = JSON.parse(await readFile(resolve(backupPath), 'utf8'))
const posters = data?.posters
if (!posters || typeof posters !== 'object' || Array.isArray(posters)) {
  throw Error('Backup sem vínculos de pôsteres. Exporte o backup atualizado em Minha Lista.')
}
await mkdir(directory, { recursive: true })
const entries = Object.entries(posters).filter(([id, url]) =>
  /^\d{1,8}$/.test(id) && knownIds.has(Number(id)) &&
  typeof url === 'string' && /^https:\/\/image\.tmdb\.org\/t\/p\/(?:w342|w500)\/[a-zA-Z0-9_./-]+\.(?:jpg|jpeg|png|webp)$/i.test(url)
)
const map = {}
const failures = []
let progress = 0
let downloaded = 0
let reused = 0
const tasks = entries.map(([id, source]) => ({id, source}))
const poolSize = 3
async function download({id, source}) {
  const url = source.replace('/t/p/w500/', '/t/p/w342/')
  const extension = url.split('.').at(-1).toLowerCase()
  const pathname = `${id}.${extension}`
  const path = join(directory, pathname)
  try {
    const existing = await stat(path).catch(() => null)
    if (existing && existing.size > 1024) { reused++; map[id] = `/offline-posters/${pathname}`; return }
    const resp = await fetch(url, { signal: AbortSignal.timeout(18000) })
    if (!resp.ok || !resp.headers.get('content-type')?.startsWith('image/')) throw Error(`HTTP ${resp.status}, formato de resposta inválido`)
    const bytes = Buffer.from(await resp.arrayBuffer())
    if (bytes.length < 1024 || bytes.length > 8 * 1024 * 1024) throw Error('Imagem com tamanho inesperado')
    const temporary = path + '.tmp'
    try { await writeFile(temporary, bytes); await rename(temporary, path) }
    catch (err) { await unlink(temporary).catch(()=>{}); throw err }
    downloaded++
    map[id] = `/offline-posters/${pathname}`
  } catch (err) {
    failures.push({id,reason:String(err)})
  } finally {
    progress++
    if (progress % 10 === 0 || progress === entries.length) console.log(`${progress}/${entries.length} · ${downloaded} baixadas · ${reused} já existentes · ${failures.length} falhas`)
  }
}
let next = 0
await Promise.all(Array.from({length: Math.min(poolSize,tasks.length)}, async()=>{
  while (next < tasks.length) await download(tasks[next++])
}))
// Always write the available manifest, even when connectivity interrupts downloads.
await writeFile(join(directory, 'index.json'), JSON.stringify(map, null, 2) + '\n')
// Bundled by Vite so the mapping works offline in the future APK too.
await writeFile(join(root, 'src', 'offlineBundled.json'), JSON.stringify(map, null, 2) + '\n')
await writeFile(join(directory, 'falhas.json'), JSON.stringify(failures, null, 2) + '\n')
console.log(`Pronto: ${Object.keys(map).length}/${entries.length} imagens reais dentro do projeto. Nenhum token foi incluído.`)
if (failures.length) console.log('Falhas registradas em public/offline-posters/falhas.json. Rode novamente para retomar.')
