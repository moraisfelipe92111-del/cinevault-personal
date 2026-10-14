/** CineVault Pulse: deterministic, offline-first film rituals and journal. */
import { selectSession, type SessionFilm, type SessionProfile } from './session.ts'

export type WatchEntry = { filmId: number; watchedAt: string }
export type PulseState = {
  queue: number[]
  history: WatchEntry[]
  notes: Record<string,string>
  recent: number[]
  dailyOffset: number
}
export const PULSE_KEY = 'cinevault.pulse.v1'
export const EMPTY_PULSE: PulseState = {queue:[],history:[],notes:{},recent:[],dailyOffset:0}
const object = (value: unknown): value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const validDate = (s: unknown): s is string => typeof s==='string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s))
const validId = (id:unknown,allowedIds:ReadonlySet<number>):id is number => typeof id==='number' && Number.isInteger(id) && allowedIds.has(id)
const uniqueIds = (raw:unknown[],allowedIds:ReadonlySet<number>,cap:number) => [...new Set(raw.filter((id):id is number=>validId(id,allowedIds)))].slice(0,cap)

/** Reject malformed v4 structures before modifying application state. Unknown film IDs are safely discarded. */
export function parsePulse(raw:unknown,allowedIds:ReadonlySet<number>):PulseState {
  if(!object(raw) || !Array.isArray(raw.queue) || !Array.isArray(raw.history) || !object(raw.notes) || !Array.isArray(raw.recent) || !Number.isInteger(raw.dailyOffset) || Number(raw.dailyOffset)<0 || Number(raw.dailyOffset)>100000) {
    throw new Error('Dados da experiência pessoal inválidos')
  }
  const history:WatchEntry[]=[]
  const seen=new Set<number>()
  for(const entry of raw.history.slice(0,1000)){
    if(!object(entry) || !validId(entry.filmId,allowedIds) || !validDate(entry.watchedAt)) throw new Error('Histórico de sessões inválido')
    if(seen.has(entry.filmId))continue
    history.push({filmId:entry.filmId,watchedAt:entry.watchedAt})
    seen.add(entry.filmId)
  }
  const notes:Record<string,string>={}
  for(const [id,value] of Object.entries(raw.notes)){
    if(!allowedIds.has(Number(id)))continue
    if(typeof value!=='string' || value.length>600)throw new Error('Anotação de filme inválida')
    if(value.trim())notes[id]=value.trim().slice(0,500)
  }
  return {queue:uniqueIds(raw.queue,allowedIds,317),history,notes,recent:uniqueIds(raw.recent,allowedIds,12),dailyOffset:raw.dailyOffset as number}
}
export function safeLoadPulse(raw:unknown,allowedIds:ReadonlySet<number>):PulseState {
  try{return parsePulse(raw,allowedIds)}catch{return {...EMPTY_PULSE}}
}
export function toggleQueue(state:PulseState,id:number,watched:ReadonlySet<number>):PulseState {
  if(state.queue.includes(id))return {...state,queue:state.queue.filter(x=>x!==id)}
  if(watched.has(id))return state
  return {...state,queue:[...state.queue,id]}
}
export function moveQueue(state:PulseState,id:number,delta:-1|1):PulseState {
  const before=state.queue.indexOf(id),after=before+delta
  if(before<0 || after<0 || after>=state.queue.length)return state
  const queue=[...state.queue];[queue[before],queue[after]]=[queue[after],queue[before]]
  return {...state,queue}
}
export function markWatched(state:PulseState,id:number,checked:boolean,date:string):PulseState {
  return checked
    ? {...state,queue:state.queue.filter(x=>x!==id),history:[...state.history.filter(x=>x.filmId!==id),{filmId:id,watchedAt:date}]}
    : {...state,history:state.history.filter(x=>x.filmId!==id)}
}
export function visitFilm(state:PulseState,id:number):PulseState {
  if(state.recent[0]===id)return state
  return {...state,recent:[id,...state.recent.filter(x=>x!==id)].slice(0,8)}
}
export function saveNote(state:PulseState,id:number,note:string):PulseState {
  const notes={...state.notes}
  if(!note.trim())delete notes[id]
  else notes[id]=note.trim().slice(0,500)
  return {...state,notes}
}
function dayHash(localDay:string):number {
  let hash=2166136261
  for(let i=0;i<localDay.length;i++)hash=Math.imul(hash^localDay.charCodeAt(i),16777619)
  return hash>>>0
}
export function localDay(date:Date):string {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
/** Always deterministic for the same day, offset, catalogue and personal history. Never calls an API. */
export function pickDaily<T extends SessionFilm>(catalog:readonly T[],profile:SessionProfile,localDate:string,offset=0):T|null {
  const available=catalog.filter(f=>!profile.watched.includes(f.id))
  if(!available.length)return null
  const round=(dayHash(localDate)%Math.max(1,Math.ceil(available.length/3)))+Math.max(0,Math.trunc(offset))
  return selectSession(catalog,profile,{mood:'Todos',duration:'Qualquer',round},1)[0] || null
}
export function watchStats(history:readonly WatchEntry[],now:Date) {
  const month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`
  const thisMonth=history.filter(h=>localDay(new Date(h.watchedAt)).slice(0,7)===month).length
  return {recorded:history.length,thisMonth}
}
