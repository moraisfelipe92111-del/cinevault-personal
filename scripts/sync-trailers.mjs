/** CineVault 2.0 — automatic bulk trailer sync (Node 22+).
 * Runs in GitHub Actions with a protected TMDB_READ_ACCESS_TOKEN secret.
 * No movie-by-movie entry, no YouTube video downloads, no token in APK.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chooseMovieMatch, nameVariants, bestTrailer } from '../src/trailerRanking.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const token=String(process.env.TMDB_READ_ACCESS_TOKEN||'').trim()
const args=process.argv.slice(2)
const backupFlag=args.indexOf('--backup')
const backupFile=backupFlag===-1?null:args[backupFlag+1]
const refresh=args.includes('--refresh')
const limitFlag=args.indexOf('--max')
const limit=limitFlag===-1?Infinity:Number(args[limitFlag+1])
if((backupFlag>=0&&!backupFile) || !(limit>0))throw Error('Uso: npm run trailers:sync [-- --backup /caminho/backup.json] [--max 100] [--refresh]')
if(!token){console.error('Configure TMDB_READ_ACCESS_TOKEN como segredo no GitHub ou variavel do Termux (uma unica vez). Nenhum token deve entrar no codigo.');process.exit(2)}
const filmPath=path.join(root,'src/films.json')
const idPath=path.join(root,'src/movieTmdbIds.json')
const trailerPath=path.join(root,'src/trailerCatalog.json')
const statusPath=path.join(root,'src/trailerSyncStatus.json')
const films=JSON.parse(await fs.readFile(filmPath,'utf8'))
if(!Array.isArray(films)||!films.length)throw Error('Catalogo invalido')
const allowed=new Set()
for(const f of films){
 if(!Number.isSafeInteger(f.id)||f.id<=0||allowed.has(f.id)||!Number.isSafeInteger(f.year)||!f.title)throw Error('IDs, anos ou titulos invalidos no catalogo')
 allowed.add(f.id)
}
async function readMap(file){try{const d=JSON.parse(await fs.readFile(file,'utf8'));return d&&typeof d==='object'&&!Array.isArray(d)?d:{}}catch(e){if(e.code==='ENOENT')return {};throw e}}
const ids=await readMap(idPath)
const trailers=await readMap(trailerPath)
const status=await readMap(statusPath)
if(backupFile){
 const backup=JSON.parse(await fs.readFile(path.resolve(backupFile),'utf8'))
 for(const [key,value] of Object.entries(backup.posterMeta||{})){
  const f=films.find(f=>String(f.id)===key)
  if(!f||!Number.isSafeInteger(value?.tmdbId)||value.tmdbId<=0)continue
  if(value.year && Math.abs(Number(value.year)-f.year)>1)continue
  if(!ids[key])ids[key]=value.tmdbId
 }
}
const TTL=28*24*60*60*1000
const GOOD=()=>Date.now()
const fresh=iso=>Number.isFinite(Date.parse(iso)) && GOOD()-Date.parse(iso)<TTL
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function request(endpoint,params){
 const u=new URL(`https://api.themoviedb.org/3${endpoint}`)
 for(const [k,v] of Object.entries(params))u.searchParams.set(k,v)
 for(let attempt=0;attempt<4;attempt++){
  let response
  try{response=await fetch(u,{headers:{Authorization:`Bearer ${token}`,accept:'application/json'},signal:AbortSignal.timeout(14000)})}
  catch(e){if(attempt===3)throw Error('TMDb indisponivel ou timeout: '+e.message);await sleep(1100*(attempt+1));continue}
  if(response.status===401||response.status===403)throw Error('TMDb negou credencial ou permissao (401/403)')
  if(response.status===429||response.status>=500){
   if(attempt===3)throw Error(`TMDb temporariamente indisponivel (${response.status})`)
   const retry=Number(response.headers.get('retry-after'))
   await sleep(Math.min(12000,Math.max(1200,Number.isFinite(retry)&&retry>0?retry*1000:(attempt+1)*2200)))
   continue
  }
  if(!response.ok)throw Error(`TMDb HTTP ${response.status}`)
  const data=await response.json()
  if(!data||typeof data!=='object')throw Error('TMDb resposta inesperada')
  return data
 }
 throw Error('Falha repetida de consulta')
}
function searchVariants(s){
 const title=String(s||'').trim()
 const bits=[title.replace(/\([^)]*\)/g,'').trim(), ...Array.from(title.matchAll(/\(([^)]{2,100})\)/g),m=>m[1])]
 return [...new Set(bits.filter(Boolean))].slice(0,3)
}
async function findTmdbId(film){
 const choices=new Set()
 let plausible=[]
 for(const query of searchVariants(film.title)){
  const result=await request('/search/movie',{query,language:'pt-BR',year:String(film.year),include_adult:'false'})
  plausible=plausible.concat(Array.isArray(result.results)?result.results:[])
  const match=chooseMovieMatch(film,plausible)
  if(match)choices.add(match)
  await sleep(90)
 }
 if(choices.size===1)return [...choices][0]
 // Fallback: en-US index, still exact translated/original title AND approximate year.
 for(const query of searchVariants(film.title).slice(0,2)){
  const result=await request('/search/movie',{query,language:'en-US',year:String(film.year),include_adult:'false'})
  plausible=plausible.concat(Array.isArray(result.results)?result.results:[])
 }
 return chooseMovieMatch(film,plausible)
}
async function findVideos(tmdbId){
 const responses=await Promise.all([
  request(`/movie/${tmdbId}/videos`,{language:'pt-BR'}),
  request(`/movie/${tmdbId}/videos`,{language:'en-US'})
 ])
 return responses.flatMap(r=>Array.isArray(r.results)?r.results:[])
}
async function atomicJson(file,data){const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(data,null,2)+'\n');await fs.rename(tmp,file)}
async function checkpoint(){await atomicJson(idPath,ids);await atomicJson(trailerPath,trailers);await atomicJson(statusPath,status)}
let scanned=0,hit=0,missing=0,unresolved=0,failed=0,skipped=0
// The initial bulk run handles all new catalogue entries; following runs reuse cached results.
try{
 for(const film of films){
  if(scanned>=limit)break
  const key=String(film.id)
  const previous=trailers[key]
  if(!refresh && ((previous&&fresh(previous.checkedAt)) || (status[key]&&fresh(status[key].checkedAt)))){skipped++;continue}
  scanned++
  try{
   let tmdbId=Number(ids[key])||0
   if(!Number.isSafeInteger(tmdbId)||tmdbId<=0){
     tmdbId=await findTmdbId(film)||0
     if(tmdbId)ids[key]=tmdbId
   }
   if(!tmdbId){
     unresolved++;status[key]={reason:'tmdb_unresolved',checkedAt:new Date().toISOString()};
     continue
   }
   const selection=bestTrailer(await findVideos(tmdbId),tmdbId)
   if(selection){trailers[key]=selection;hit++;delete status[key]}
   else {delete trailers[key];missing++;status[key]={reason:'trailer_unavailable',checkedAt:new Date().toISOString()}}
  }catch(e){
    // Network interruptions cannot replace an already valid trailer with an invalid record.
    failed++
    console.warn(`Filme #${film.id}: consulta temporariamente indisponivel (${e.message}).`)
    if(/401|403/.test(String(e.message)))throw e
  }
  if(scanned%15===0){await checkpoint();console.log(`Trailer sync: ${scanned} verificados, ${hit} encontrados, ${missing} ausentes, ${unresolved} IDs pendentes, ${failed} falhas`)}
  await sleep(110)
 }
}finally{await checkpoint()}
console.log(`TRAILERS AUTOMATICOS: ${hit} novos, ${skipped} em cache, ${missing} sem video, ${unresolved} identificacoes pendentes, ${failed} consultas falharam; total mapeado: ${Object.keys(trailers).length}/${films.length}`)
console.log('Nenhuma chave TMDb foi gravada em arquivos ou enviada ao APK.')
