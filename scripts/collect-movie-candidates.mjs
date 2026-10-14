/** CineVault 2.0 candidate discovery: review-first and read-only against the live catalog.
 * Requires TMDB_READ_ACCESS_TOKEN, used only as an Authorization header in GitHub Actions.
 * Creates proposed titles in planning/, never edits src/films.json or user data.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const preferredGenreIds = new Set([53,80,9648,878,27,18,28,10752,36])
const discoverGenres = [53,80,9648,878,27,18,28,10752,36,10749,12]
const secondaryYear = (raw) => Number(String(raw||'').slice(0,4))
const sleep = (ms) => new Promise(r=>setTimeout(r,ms))

export const normalizeMovieName = (raw) => String(raw||'')
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  .replace(/&/g,' e ').replace(/[^a-z0-9]+/g,' ').trim()
export function catalogNameKeys(title) {
  const raw=String(title||'')
  const values=[raw,raw.replace(/\([^)]*\)/g,'').trim(),...Array.from(raw.matchAll(/\(([^)]{2,90})\)/g),m=>m[1])]
  return new Set(values.map(normalizeMovieName).filter(Boolean))
}
export function preexistingMovie(movie,knownTmdbIds,knownFilmNames){
  if(knownTmdbIds.has(movie.id))return true
  const year=secondaryYear(movie.release_date)
  if(!year)return false
  for(const title of [movie.title,movie.original_title]){
    if(knownFilmNames.has(`${normalizeMovieName(title)}|${year}`))return true
  }
  return false
}
export function qualifiedMovie(m, nowYear=2026){
  const year=secondaryYear(m?.release_date)
  return !!(Number.isSafeInteger(m?.id)&&m.id>0&&
    !m.adult && m.video!==true && typeof m.title==='string'&&m.title.trim()&&
    year>=1950&&year<=nowYear &&
    Array.isArray(m.genre_ids)&&m.genre_ids.every(x=>Number.isInteger(x)) &&
    Number.isFinite(m.vote_count)&&m.vote_count>=100 &&
    Number.isFinite(m.vote_average)&&m.vote_average>=6 &&
    typeof m.poster_path==='string' && /^\/[a-zA-Z0-9_.\/-]+$/.test(m.poster_path))
}
export function candidateScore(candidate){
  const preferred=candidate.genreIds.filter(id=>preferredGenreIds.has(id)).length
  const seed=candidate.recommendedBy.length
  return Math.round((candidate.voteAverage*10 + Math.min(28,Math.log10(candidate.voteCount+1)*6) +
    preferred*7 + Math.min(65,seed*14))*10)/10
}
export function resolveCandidates({films,existingTmdbMap,sources,goal=683,nowYear=2026}) {
  if(!Array.isArray(films)||films.length<1)throw Error('Base atual ausente')
  const currentNames=new Map(), currentIds=new Set()
  for(const f of films){
    if(!Number.isSafeInteger(f.id)||currentIds.has(f.id))throw Error('IDs locais duplicados')
    currentIds.add(f.id)
    if(!Number.isInteger(f.year))throw Error('Ano atual inválido')
    for(const name of catalogNameKeys(f.title))currentNames.set(`${name}|${f.year}`,f.id)
  }
  const knownTmdbIds=new Set(Object.values(existingTmdbMap).filter(x=>Number.isSafeInteger(x)&&x>0))
  const found=new Map()
  let unqualified=0,already=0,ambiguous=0
  for(const {movie,seed} of sources){
    if(!qualifiedMovie(movie,nowYear)){unqualified++;continue}
    if(preexistingMovie(movie,knownTmdbIds,currentNames)){already++;continue}
    const year=secondaryYear(movie.release_date)
    const normalized=normalizeMovieName(movie.title)
    if(!normalized){unqualified++;continue}
    const key=`${normalized}|${year}`
    if([...found.values()].some(x=>x.dedupeKey===key && x.tmdbId!==movie.id)){
      ambiguous++;continue
    }
    let item=found.get(movie.id)
    if(!item){
      item={tmdbId:movie.id,title:movie.title,originalTitle:movie.original_title||movie.title,
        year,genreIds:movie.genre_ids,posterPath:movie.poster_path,
        overview:String(movie.overview||'').slice(0,1500),voteAverage:movie.vote_average,
        voteCount:movie.vote_count,recommendedBy:[],discoveredBy:[],dedupeKey:key}
      found.set(movie.id,item)
    }
    if(seed && !item.recommendedBy.includes(seed))item.recommendedBy.push(seed)
    if(!seed&&!item.discoveredBy.includes('TMDb Discover'))item.discoveredBy.push('TMDb Discover')
  }
  const all=[...found.values()].map(({dedupeKey,...candidate})=>({
    ...candidate, score:candidateScore(candidate), status:'awaiting_review',
    reason:'Selecionado automaticamente para revisão; avaliação personalizada ainda pendente.'
  })).sort((a,b)=>b.score-a.score||b.voteCount-a.voteCount||a.tmdbId-b.tmdbId)
  return {candidates:all,stats:{current:films.length,goal,missingToGoal:Math.max(0,goal-films.length),
    proposed:all.length,eligibleForReview:Math.min(Math.max(0,goal-films.length),all.length),
    alreadyExcluded:already,unqualified,ambiguous,
    warning:all.length<Math.max(0,goal-films.length)?'A lista ainda não é suficiente para chegar à meta; amplie a pesquisa ou revise os filtros.':null}}
}

export async function collectSources({films,ids,request,maxSeeds=65,pagesPerGenre=6}){
  const seeds=films.filter(f=>f.priority==='S'||f.priority==='A')
    .sort((a,b)=>a.priority.localeCompare(b.priority)||a.id-b.id)
    .map(f=>({id:ids[String(f.id)],label:f.title}))
    .filter(x=>Number.isSafeInteger(x.id)&&x.id>0).slice(0,maxSeeds)
  const sources=[]
  let requests=0
  for(const seed of seeds){
    for(let page=1;page<=2;page++){
      const x=await request(`/movie/${seed.id}/recommendations`,{language:'pt-BR',page})
      requests++
      for(const movie of Array.isArray(x.results)?x.results:[])sources.push({movie,seed:seed.label})
      await sleep(85)
    }
  }
  for(const genre of discoverGenres){
    for(let page=1;page<=pagesPerGenre;page++){
      const x=await request('/discover/movie',{language:'pt-BR',page,include_adult:'false',
        with_genres:String(genre),'vote_count.gte':'100','vote_average.gte':'6',
        sort_by:page%2?'vote_count.desc':'popularity.desc'})
      requests++
      for(const movie of Array.isArray(x.results)?x.results:[])sources.push({movie,seed:null})
      await sleep(85)
    }
  }
  return {sources,seeds:seeds.length,requests}
}

function createRequester(token){
  return async (endpoint,params)=>{
    const url=new URL('https://api.themoviedb.org/3'+endpoint)
    for(const [key,val] of Object.entries(params))url.searchParams.set(key,String(val))
    for(let attempt=0;attempt<4;attempt++){
      try{
        const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`,accept:'application/json'},
          signal:AbortSignal.timeout(17000)})
        if(response.status===401||response.status===403)throw Error('TMDb negou a credencial: '+response.status)
        if(response.status===429||response.status>=500){
          if(attempt===3)throw Error('TMDb indisponível: HTTP '+response.status)
          const retry=Number(response.headers.get('retry-after'))
          await sleep(Math.min(12000,Math.max(1400,Number.isFinite(retry)&&retry>0?retry*1000:1800*(attempt+1))))
          continue
        }
        if(!response.ok)throw Error('TMDb resposta HTTP '+response.status)
        const data=await response.json()
        if(!data || typeof data!=='object')throw Error('TMDb retornou dados inválidos')
        return data
      }catch(e){
        if(/credencial|HTTP 4\d\d/.test(e.message)||attempt===3)throw e
        await sleep(1700*(attempt+1))
      }
    }
    throw Error('TMDb indisponível após tentativas')
  }
}

export async function run({root=DEFAULT_ROOT,token=process.env.TMDB_READ_ACCESS_TOKEN||'',maxSeeds=65,pagesPerGenre=6}={}) {
  if(!token.trim())throw Error('TMDB_READ_ACCESS_TOKEN ausente. Não inclua o valor no código.')
  const films=JSON.parse(await readFile(join(root,'src/films.json'),'utf8'))
  const ids=JSON.parse(await readFile(join(root,'src/movieTmdbIds.json'),'utf8'))
  const {sources,seeds,requests}=await collectSources({films,ids,request:createRequester(token),maxSeeds,pagesPerGenre})
  const results=resolveCandidates({films,existingTmdbMap:ids,sources,goal:1000})
  const output=join(root,'planning');await mkdir(output,{recursive:true})
  const report={...results.stats,requests,seeds,generatedAt:new Date().toISOString(),
    note:'Lista apenas para revisão; NÃO altera src/films.json nem IDs dos filmes existentes.'}
  const jsonFiles=[['cinevault2-candidates.json',{metadata:report,movies:results.candidates}],
    ['cinevault2-candidate-stats.json',report]]
  for(const [name,data] of jsonFiles){
    const file=join(output,name), tmp=file+'.tmp'
    await writeFile(tmp,JSON.stringify(data,null,2)+'\n')
    await rename(tmp,file)
  }
  console.log('CINEVAULT 2.0 CANDIDATOS: '+results.candidates.length+' títulos únicos propostos para revisão; '+seeds+' filmes-semente; '+requests+' consultas; 317 registros originais preservados.')
  if(report.warning)console.log('AVISO: '+report.warning)
  console.log('Arquivos em planning/. Nenhum filme foi automaticamente inserido na biblioteca.')
  return report
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  run().catch(e=>{console.error('ERRO na coleta: '+e.message);process.exitCode=1})
}
