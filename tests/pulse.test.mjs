import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_PULSE, parsePulse, safeLoadPulse, toggleQueue, moveQueue, markWatched, visitFilm, saveNote, pickDaily, localDay, watchStats } from '../src/pulse.ts'
import { parseBackup } from '../src/backupValidation.ts'
const ids = new Set([1,2,3,4,5])
const film = (id,extra={})=>({id,title:`Filme ${id}`,genre:'Crime / Investigação',director:`Diretor ${id}`,priority:'S',duration:'95 min',tension:9,emotion:6,twist:'Forte',year:2019,...extra})
const films=[film(1),film(2),film(3),film(4),film(5)]
const profile={watched:[],favorites:[],ratings:{}}
test('the daily film is stable for the same day and profile',()=>{
 const a=pickDaily(films,profile,'2026-10-13'); const b=pickDaily(films,profile,'2026-10-13')
 assert.equal(a?.id,b?.id);assert.ok(a)
})
test('daily recommendations exclude watched films, even when only one remains',()=>{
 const r=pickDaily(films,{...profile,watched:[1,2,3,4]},'2026-10-13')
 assert.equal(r?.id,5)
 assert.equal(pickDaily(films,{...profile,watched:[1,2,3,4,5]},'2026-10-13'),null)
})
test('queue is unique, reverses, and avoids already watched films',()=>{
 const a=toggleQueue(EMPTY_PULSE,1,new Set());const b=toggleQueue(a,1,new Set());
 assert.deepEqual(a.queue,[1]);assert.deepEqual(b.queue,[])
 assert.deepEqual(toggleQueue(EMPTY_PULSE,2,new Set([2])).queue,[])
})
test('queue reorders without mutating original state',()=>{
 const state={...EMPTY_PULSE,queue:[1,2,3]}; const moved=moveQueue(state,2,-1)
 assert.deepEqual(moved.queue,[2,1,3]); assert.deepEqual(state.queue,[1,2,3]);assert.equal(moveQueue(state,1,-1),state)
})
test('watch logging removes watched item from queue and undo removes date',()=>{
 const state={...EMPTY_PULSE,queue:[1,2]};const a=markWatched(state,1,true,'2026-10-13T20:00:00.000Z')
 assert.deepEqual(a.queue,[2]);assert.equal(a.history.length,1)
 assert.deepEqual(markWatched(a,1,false,'2026-10-13T21:00:00.000Z').history,[])
})
test('visits keep most recently opened film first without duplicates',()=>{
 const a=visitFilm(visitFilm(visitFilm(EMPTY_PULSE,2),1),2)
 assert.deepEqual(a.recent,[2,1])
})
test('notes can be saved, trimmed, and deleted',()=>{
 const a=saveNote(EMPTY_PULSE,1,'  filme incrível  ')
 assert.equal(a.notes['1'],'filme incrível')
 assert.deepEqual(saveNote(a,1,' ').notes,{})
})
test('parses the new pulse while ignoring unknown film ids',()=>{
 const parsed=parsePulse({queue:[1,999,1,2],history:[{filmId:2,watchedAt:'2026-10-13T20:00:00.000Z'}],notes:{1:'Excelente',999:'Lixo'},recent:[3,3,999],dailyOffset:2},ids)
 assert.deepEqual(parsed.queue,[1,2]);assert.deepEqual(parsed.recent,[3]);assert.deepEqual(parsed.notes,{'1':'Excelente'})
})
test('rejects malformed histories and too-long notes in imports',()=>{
 const base={queue:[],history:[],notes:{},recent:[],dailyOffset:0}
 assert.throws(()=>parsePulse({...base,history:[{filmId:1,watchedAt:'wrong'}]},ids))
 assert.throws(()=>parsePulse({...base,notes:{1:'x'.repeat(601)}},ids))
 assert.deepEqual(safeLoadPulse(null,ids),EMPTY_PULSE)
})
test('v4 backup round trip preserves posters, rated films, and pulse',()=>{
 const pulse={...EMPTY_PULSE,queue:[1],notes:{'2':'Gostei'},dailyOffset:1}
 const input={version:4,favorites:[1],watched:[2],ratings:{2:5},posters:{1:'https://image.tmdb.org/t/p/w500/abc.jpg'},pulse}
 const parsed=parseBackup(input,ids)
 assert.equal(parsed.posters['1'],input.posters[1]);assert.equal(parsed.pulse.notes['2'],'Gostei')
 assert.deepEqual(parsed.saved.watched,[2]);assert.equal(parsed.saved.ratings['2'],5)
})
test('v3 backup continues to import without pulse',()=>{
 const p=parseBackup({version:3,favorites:[1],watched:[],ratings:{}},ids)
 assert.deepEqual(p.saved.favorites,[1]);assert.equal(p.pulse,undefined)
})
test('v4 backup rejects invalid pulse atomically',()=>{
 assert.throws(()=>parseBackup({version:4,favorites:[],watched:[],ratings:{}},ids))
 assert.throws(()=>parseBackup({version:4,favorites:[],watched:[],ratings:{},pulse:{queue:['oops']}},ids))
})
test('month stats count registered watch dates only',()=>{
 const history=[{filmId:1,watchedAt:'2026-10-13T20:00:00Z'},{filmId:2,watchedAt:'2026-09-02T20:00:00Z'}]
 assert.deepEqual(watchStats(history,new Date(2026,9,13)),{recorded:2,thisMonth:1})
 assert.equal(localDay(new Date(2026,9,13)),'2026-10-13')
})
