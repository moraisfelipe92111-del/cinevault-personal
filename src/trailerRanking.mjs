/** CineVault 2.0: pure, deterministic TMDb video filtering/ranking.
 * This module never claims a dub is verified solely from a language code.
 */
const ID=/^[A-Za-z0-9_-]{11}$/
const FAN=/\b(fan[ -]?made|fan[ -]?edit|concept|fake|parody|reaction|review|explicad[oa])\b/i
const DUB=/\b(dublad[oa]s?|dublagem|vers[aã]o dublada|dubbed(?: in)? portuguese)\b/i
const SUB=/\b(legendad[oa]s?|subtitulado|subtitled|legendas)\b/i

export function normalizeFilmName(s){
  return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/&/g,' e ').replace(/[^a-z0-9]+/g,' ').trim()
}
export function nameVariants(title){
  const s=String(title||'').trim()
  // Portuguese title + original title, e.g. "Garota Exemplar (Gone Girl)".
  const bits=[s,s.replace(/\([^)]*\)/g,'').trim(), ...Array.from(s.matchAll(/\(([^)]{2,100})\)/g),m=>m[1])]
  return [...new Set(bits.map(normalizeFilmName).filter(Boolean))]
}
export function chooseMovieMatch(film,raw){
  const titles=new Set(nameVariants(film.title))
  const year=Number(film.year)
  const matches=(Array.isArray(raw)?raw:[]).filter(m=>{
    if(!Number.isSafeInteger(m?.id)||m.id<=0 || m?.media_type==='tv')return false
    const date=String(m.release_date||'')
    const actual=Number(date.slice(0,4))
    if(!actual || Math.abs(actual-year)>1)return false
    const names=[m.title,m.original_title].map(normalizeFilmName)
    return names.some(n=>titles.has(n))
  })
  if(!matches.length)return null
  // Film year > exact title confidence, but ambiguity must fail closed.
  const exactYear=matches.filter(m=>Number(String(m.release_date).slice(0,4))===year)
  const considered=exactYear.length?exactYear:matches
  const unique=new Set(considered.map(m=>m.id))
  return unique.size===1?considered[0].id:null
}
export function rankedVideos(videos){
  const seen=new Set()
  return (Array.isArray(videos)?videos:[])
    .filter(v=>v && v.site==='YouTube' && v.type==='Trailer' && ID.test(String(v.key||'')) && !FAN.test(String(v.name||'')))
    .filter(v=>{if(seen.has(v.key))return false;seen.add(v.key);return true})
    .map(v=>{
      const name=String(v.name||'').slice(0,160)
      const language=String(v.iso_639_1||'').toLowerCase()
      const region=String(v.iso_3166_1||'').toUpperCase()
      const isPt=language==='pt'
      const isBr=isPt&&region==='BR'
      const dubbedIndicated=isPt&&DUB.test(name)&&!SUB.test(name)
      const subtitledIndicated=SUB.test(name)
      const official=v.official===true
      let score=(official?150:0)+(isBr?60:isPt?45:0)+(dubbedIndicated?40:0)
      if(subtitledIndicated)score-=12
      if(/\b(teaser|tv spot|featurette|clip)\b/i.test(name))score-=22
      if(!isPt&&language!=='en')score-=8
      const when=Date.parse(String(v.published_at||''))||0
      return {v,score,when,official,dubbedIndicated,subtitledIndicated,language,region,name}
    })
    .sort((a,b)=>b.score-a.score||b.when-a.when||String(a.v.key).localeCompare(String(b.v.key)))
}
export function bestTrailer(videos,tmdbId){
  const v=rankedVideos(videos)[0]
  if(!v)return null
  return {
    tmdbId,
    youtubeVideoId:v.v.key,
    title:v.name,
    provider:'YouTube',
    type:'Trailer',
    language:v.language,
    region:v.region,
    official:v.official,
    dubbedStatus:v.dubbedIndicated?'indicated_by_title':'unknown',
    subtitlesIndicated:v.subtitledIndicated,
    checkedAt:new Date().toISOString(),
  }
}
