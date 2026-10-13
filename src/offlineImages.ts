import { Capacitor } from '@capacitor/core'
/**
 * CineVault 0.5 — download-only image archive.
 * Cache Storage accepts opaque cross-origin TMDb images; a service worker serves
 * the cached response to <img> even when the device has no connectivity.
 * This is deliberately separate from personal data in localStorage.
 */
export const POSTER_CACHE = 'cinevault-posters-w342-v1'
export const POSTER_WIDTH = 'w342'
export type OfflineStatus = { cached: number; total: number; usedBytes?: number; quotaBytes?: number; persisted?: boolean }
export type DownloadProgress = { running: boolean; done: number; total: number; added: number; failed: number; current: string }

export function canonicalPosterUrl(url: string): string {
  // Accept only the known TMDb public image host; no arbitrary URL downloads.
  const match = /^https:\/\/image\.tmdb\.org\/t\/p\/(?:w92|w154|w185|w342|w500|w780|original)(\/[a-zA-Z0-9_./-]+\.(?:jpg|jpeg|png|webp))$/i.exec(url)
  return match ? `https://image.tmdb.org/t/p/${POSTER_WIDTH}${match[1]}` : ''
}

function posterUrls(posters: Record<string, string>): string[] {
  return [...new Set(Object.values(posters).map(canonicalPosterUrl).filter(Boolean))]
}
export function availableOffline(): boolean {
  return !Capacitor.isNativePlatform() && typeof window !== 'undefined' && 'caches' in window && 'serviceWorker' in navigator
}
export async function scanOffline(posters: Record<string, string>): Promise<OfflineStatus> {
  const urls = posterUrls(posters)
  let cached = 0
  if (availableOffline()) {
    const cache = await caches.open(POSTER_CACHE)
    const entries = await cache.keys()
    const saved = new Set(entries.map(req => req.url))
    cached = urls.filter(url => saved.has(url)).length
  }
  const estimate = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => undefined) : undefined
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => undefined) : undefined
  return { cached, total: urls.length, usedBytes: estimate?.usage, quotaBytes: estimate?.quota, persisted }
}

export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  return navigator.storage.persist()
}

export async function downloadAllPosters(
  posters: Record<string, string>,
  isPaused: () => boolean,
  onProgress: (progress: DownloadProgress) => void,
): Promise<DownloadProgress> {
  if (!availableOffline()) throw new Error('Cache offline indisponível neste navegador.')
  // Avoid a false success if the worker has not taken control of this page yet.
  const registration = await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller || !registration.active) {
    throw new Error('O modo offline ainda está sendo ativado. Atualize a página e tente novamente.')
  }
  const urls = posterUrls(posters)
  const cache = await caches.open(POSTER_CACHE)
  let done = 0, added = 0, failed = 0
  onProgress({ running: true, done, total: urls.length, added, failed, current: '' })
  for (const url of urls) {
    if (isPaused()) break
    try {
      const previous = await cache.match(url)
      if (!previous) {
        // no-cors is required for TMDb's image host on some devices; the
        // resulting opaque response can be stored and replayed by the SW.
        const response = await fetch(url, { mode: 'no-cors', cache: 'no-store' })
        if (response.type !== 'opaque' && !response.ok) throw Error('Imagem indisponível')
        await cache.put(url, response)
        added++
      }
    } catch {
      failed++
    }
    done++
    onProgress({ running: true, done, total: urls.length, added, failed, current: url.split('/').at(-1) || '' })
    // Keep long downloads responsive on mid-range Android phones.
    if (done % 5 === 0) await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { running: false, done, total: urls.length, added, failed, current: '' }
}

export async function clearOfflineImages(): Promise<void> {
  if (!availableOffline()) throw Error('Cache offline indisponível')
  await caches.delete(POSTER_CACHE)
}

export function humanBytes(value?: number): string {
  if (value == null || !Number.isFinite(value)) return 'Indisponível'
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB']
  let amount = value
  let i = -1
  do { amount /= 1024; i++ } while (amount >= 1024 && i < units.length - 1)
  return `${amount.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${units[i]}`
}
