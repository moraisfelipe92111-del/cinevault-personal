import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { createPersonalStorageCoordinator } from '../src/personalStorage.ts'
import { PERSONAL_STORAGE_KEYS } from '../src/personalStorageSnapshot.ts'
import { commitJsonBatch } from '../src/storageSafety.ts'
import { createJsonMapStorage } from '../src/jsonMapStorage.ts'

const keys = [...PERSONAL_STORAGE_KEYS]
function memory(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values, mutations: 0, reads: 0, failNextKey: null, onRead: null, onWrite: null,
    getItem(key) {
      this.reads++
      this.onRead?.(key)
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      this.onWrite?.(key)
      this.mutations++
      if (this.failNextKey === key) { this.failNextKey = null; throw new Error('quota') }
      values.set(key, value)
    },
    removeItem(key) { this.mutations++; values.delete(key) },
  }
}

test('coordinator construction and pausing are lazy and do not read or mutate storage', () => {
  let accesses = 0
  const coordinator = createPersonalStorageCoordinator(() => { accesses++; return memory() })
  assert.equal(coordinator.phase, 'active')
  const pause = coordinator.pauseWrites()
  assert.equal(coordinator.phase, 'paused')
  pause.resumeLocalWrites()
  assert.equal(accesses, 0)
  assert.ok(Object.isFrozen(coordinator.store))
})

test('the shared facade preserves exact raw values and missing keys for all six keys', () => {
  const db = memory()
  const {store} = createPersonalStorageCoordinator(() => db)
  for (const [index, key] of keys.entries()) {
    assert.equal(store.getItem(key), null)
    const raw = index % 2 ? ' [invalid JSON\r\n' : ' {"unknownId":999999,"text":"🎬"} '
    store.setItem(key, raw)
    assert.equal(store.getItem(key), raw)
    store.removeItem(key)
    assert.equal(store.getItem(key), null)
  }
})

test('unknown keys and nontext writes are refused before accessing the underlying store', () => {
  const coordinator = createPersonalStorageCoordinator(() => assert.fail('source must not be accessed'))
  for (const key of ['', 'outside.key', '__proto__', 'cinevault.personal.v3']) {
    assert.throws(() => coordinator.store.getItem(key), /não autorizada/)
    assert.throws(() => coordinator.store.setItem(key, 'x'), /não autorizada/)
    assert.throws(() => coordinator.store.removeItem(key), /não autorizada/)
  }
  for (const value of [undefined, null, 1, false, {}]) {
    assert.throws(() => coordinator.store.setItem(keys[0], value), /texto/)
  }
})

test('a pause blocks every writer and validated imports without performing rollback writes', () => {
  const initial = Object.fromEntries(keys.map(key => [key, 'original']))
  const db = memory(initial)
  const coordinator = createPersonalStorageCoordinator(() => db)
  const pause = coordinator.pauseWrites()
  for (const key of keys) {
    assert.equal(coordinator.store.getItem(key), 'original')
    assert.throws(() => coordinator.store.setItem(key, 'new'), /pausada/)
    assert.throws(() => coordinator.store.removeItem(key), /pausada/)
    assert.throws(() => commitJsonBatch(coordinator.store, [{key, value: {changed: true}}]), /pausada/)
  }
  assert.equal(db.mutations, 0)
  assert.deepEqual(Object.fromEntries(db.values), initial)
  pause.resumeLocalWrites()
  coordinator.store.setItem(keys[5], 'preferences after pause')
  assert.equal(db.values.get(keys[5]), 'preferences after pause')
})

test('the pause captures all raw values and rejects an external source change before cutover', () => {
  const db = memory({[keys[0]]: ' {"favorites":[999999]} ', [keys[5]]: '{broken'})
  const coordinator = createPersonalStorageCoordinator(() => db)
  const pause = coordinator.pauseWrites()
  const snapshot = pause.captureSnapshot()
  assert.equal(snapshot.entries[0].raw, ' {"favorites":[999999]} ')
  assert.equal(snapshot.entries[5].raw, '{broken')
  assert.doesNotThrow(() => pause.assertUnchanged(snapshot))
  db.values.set(keys[5], 'external update')
  assert.throws(() => pause.assertUnchanged(snapshot), /source changed since capture/)
  assert.equal(coordinator.phase, 'paused')
  assert.equal(db.mutations, 0)
})

test('a failed snapshot read keeps writers paused until its owner explicitly resumes', () => {
  let unavailable = true
  const db = memory()
  const coordinator = createPersonalStorageCoordinator(() => {
    if (unavailable) throw new Error('SecurityError')
    return db
  })
  const pause = coordinator.pauseWrites()
  assert.throws(() => pause.captureSnapshot(), /cannot read/)
  assert.equal(coordinator.phase, 'paused')
  assert.throws(() => coordinator.store.setItem(keys[0], 'new'), /pausada/)
  unavailable = false
  pause.resumeLocalWrites()
  coordinator.store.setItem(keys[0], 'new')
  assert.equal(db.values.get(keys[0]), 'new')
})

test('a stale pause cannot release, close or capture data owned by a later pause', () => {
  const coordinator = createPersonalStorageCoordinator(() => memory())
  const first = coordinator.pauseWrites()
  first.resumeLocalWrites()
  const second = coordinator.pauseWrites()
  for (const action of [first.resumeLocalWrites, first.closeLegacyAccess, first.captureSnapshot,
    () => first.assertUnchanged({})]) assert.throws(action, /não está ativa/)
  assert.throws(() => coordinator.pauseWrites(), /já está pausada/)
  assert.equal(coordinator.phase, 'paused')
  second.resumeLocalWrites()
  assert.equal(coordinator.phase, 'active')
})

test('closing legacy access refuses every stale read and write without reopening the source', () => {
  let accesses = 0
  const db = memory({[keys[0]]: 'stale local state'})
  const coordinator = createPersonalStorageCoordinator(() => { accesses++; return db })
  const pause = coordinator.pauseWrites()
  pause.closeLegacyAccess()
  assert.equal(coordinator.phase, 'closed')
  for (const key of keys) {
    assert.throws(() => coordinator.store.getItem(key), /encerrado/)
    assert.throws(() => coordinator.store.setItem(key, 'new'), /encerrado/)
    assert.throws(() => coordinator.store.removeItem(key), /encerrado/)
    assert.throws(() => commitJsonBatch(coordinator.store, [{key, value: {}}]), /encerrado/)
  }
  assert.throws(() => pause.resumeLocalWrites(), /não está ativa/)
  assert.throws(() => coordinator.pauseWrites(), /encerrado/)
  assert.equal(accesses, 0)
  assert.equal(db.mutations, 0)
})

test('a pause cannot interrupt the read, write or rollback portion of a synchronous import batch', () => {
  const db = memory({[keys[0]]: 'old'})
  const coordinator = createPersonalStorageCoordinator(() => db)
  const rejectPause = () => assert.throws(() => coordinator.pauseWrites(), /em andamento/)
  db.onRead = rejectPause
  db.onWrite = rejectPause
  commitJsonBatch(coordinator.store, [{key: keys[0], value: 1}, {key: keys[1], value: 2}])
  db.failNextKey = keys[1]
  assert.throws(() => commitJsonBatch(coordinator.store, [{key: keys[0], value: 3}, {key: keys[1], value: 4}]), /dados anteriores/)
  assert.equal(db.values.get(keys[0]), '1')
  assert.equal(db.values.get(keys[1]), '2')
  coordinator.pauseWrites().resumeLocalWrites()
})

test('a quota failure restores old values and removes new keys through the coordinator', () => {
  const initial = {[keys[0]]: 'old', [keys[2]]: 'old posters'}
  const db = memory(initial)
  const coordinator = createPersonalStorageCoordinator(() => db)
  db.failNextKey = keys[2]
  assert.throws(() => commitJsonBatch(coordinator.store, [
    {key: keys[0], value: {favorites: [1]}}, {key: keys[1], value: {queue: []}}, {key: keys[2], value: {}},
  ]), /dados anteriores/)
  assert.deepEqual(Object.fromEntries(db.values), initial)
  assert.equal(coordinator.phase, 'active')
  coordinator.pauseWrites().resumeLocalWrites()
})

test('an unauthorized key anywhere in a batch is refused before any source read or write', () => {
  const db = memory({[keys[0]]: 'original'})
  const coordinator = createPersonalStorageCoordinator(() => db)
  assert.throws(() => commitJsonBatch(coordinator.store, [
    {key: keys[0], value: 'new'}, {key: 'outside.key', value: {}},
  ]), /não autorizada/)
  assert.equal(db.reads, 0)
  assert.equal(db.mutations, 0)
})

test('paused restores keep unreadable map guards and originals intact until a successful restore', () => {
  const db = memory({[keys[2]]: '{broken', [keys[3]]: '{also broken'})
  const coordinator = createPersonalStorageCoordinator(() => db)
  const maps = createJsonMapStorage(() => coordinator.store)
  maps.read(keys[2]); maps.read(keys[3])
  const pause = coordinator.pauseWrites()
  assert.throws(() => maps.restore([{key: keys[2], value: {1: 'restored'}}]), /pausada/)
  assert.equal(db.mutations, 0)
  assert.equal(maps.write(keys[2], {}), false)
  pause.resumeLocalWrites()
  maps.restore([{key: keys[2], value: {1: 'restored'}}])
  assert.equal(maps.write(keys[2], {1: 'updated'}), true)
  assert.equal(maps.write(keys[3], {}), false)
  assert.equal(db.values.get(keys[3]), '{also broken')
})

test('a snapshot is refused if its pause ownership ends during the final source read', () => {
  const db = memory()
  const coordinator = createPersonalStorageCoordinator(() => db)
  const pause = coordinator.pauseWrites()
  db.onRead = () => { if (db.reads === keys.length * 2) pause.resumeLocalWrites() }
  assert.throws(() => pause.captureSnapshot(), /não está ativa/)
  assert.equal(coordinator.phase, 'active')
})

test('App and preferences share injected persistence without bypassing legacy coordination', () => {
 const app=fs.readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8')
 const experience=fs.readFileSync(new URL('../src/experience.tsx',import.meta.url),'utf8')
 for(const source of [app,experience]){
  assert.ok(source.includes('persistence'))
  assert.ok(!/\blocalStorage\b/.test(source))
  assert.ok(!source.includes('personalStorage.setItem('))
  assert.ok(!source.includes('pauseWrites('))
 }
 assert.ok(app.includes('<ExperienceLayer persistence={persistence}/>'))
 const main=fs.readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8')
 assert.ok(main.indexOf('opened=await openPersonalStorage()')<main.indexOf("await import('./App.tsx')"))
 assert.ok(main.includes('cv2-native-sqlite-audit.js'))
 for(const name of fs.readdirSync(new URL('../src/',import.meta.url)).filter(name=>/\.(ts|tsx|mjs)$/.test(name))){
  if(name==='personalStorage.ts')continue
  const source=fs.readFileSync(new URL('../src/'+name,import.meta.url),'utf8')
  assert.ok(!/\blocalStorage\s*\??\.\s*(getItem|setItem|removeItem|clear)\b/.test(source),name)
  assert.ok(!/=>\s*localStorage\b/.test(source),name)
 }
})

test('importing the shared coordinator performs no browser storage access', () => {
  const module = new URL('../src/personalStorage.ts', import.meta.url).href
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    'Object.defineProperty(globalThis,"localStorage",{get(){throw Error("no import reads")}}); await import(' + JSON.stringify(module) + ');'], {encoding: 'utf8'})
  assert.equal(child.status, 0, child.stderr)
})
