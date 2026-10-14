import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = new URL('../', import.meta.url)
const dist = new URL('../dist/', import.meta.url)
const assets = await readdir(new URL('./assets/', dist))
const precache = ['/index.html', '/manifest.webmanifest', '/cinevault-icon.svg', '/icon-192.png', '/icon-512.png', '/audio/cinevault-signature.mp3', '/audio/cinevault-aura.mp3', '/audio/CineVault_Signature.mp3', '/audio/CineVault_Noir.mp3', '/audio/CineVault_Impacto.mp3', ...assets.filter(x => /\.(?:js|css|svg|png|woff2?)$/.test(x)).map(x=>`/assets/${x}`)]
const template = await readFile(new URL('public/sw.js', root), 'utf8')
if (!template.includes('/* __CV_ASSETS__ */ []')) throw Error('Service worker placeholder missing')
await writeFile(join(dist.pathname, 'sw.js'), template.replace('/* __CV_ASSETS__ */ []', JSON.stringify(precache)))
console.log(`CineVault SW: ${precache.length} app assets precached on installation`)
