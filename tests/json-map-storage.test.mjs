import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createJsonMapStorage } from '../src/jsonMapStorage.ts'
import { parseBackup } from '../src/backupValidation.ts'

const keys = ['cinevault.posters.v1', 'cinevault.posterMeta.v2', 'cinevault.posterUnresolved.v1']

function memoryStore(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values, mutations: 0, failNextKey: null,
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) {
      this.mutations++
      if (this.failNextKey === key) {
        this.failNextKey = null
        throw new Error('quota')
      }
      values.set(key, value)
    },
    removeItem(key) { this.mutations++; values.delete(key) },
  }
}

test('mapas ausentes e validos continuam gravaveis', () => {
  const db = memoryStore({[keys[1]]: ' { "1": {"year": 2001} } '})
  const storage = createJsonMapStorage(() => db)
  assert.deepEqual(storage.read(keys[0]), {})
  assert.deepEqual(storage.read(keys[1]), {1: {year: 2001}})
  assert.equal(db.mutations, 0)
  assert.equal(db.getItem(keys[1]), ' { "1": {"year": 2001} } ')
  assert.equal(storage.write(keys[0], {}), true)
  assert.equal(storage.write(keys[1], {1: {year: 2002}}), true)
  assert.equal(storage.hasBlocked(), false)
})

test('JSON ilegivel nunca e substituido pelo mapa vazio', () => {
  for (const key of keys) {
    for (const raw of ['', '   ', '{"1":', 'null', '[]', '0', 'false', '"texto"']) {
      const db = memoryStore({[key]: raw})
      const storage = createJsonMapStorage(() => db)
      assert.deepEqual(storage.read(key), {})
      assert.equal(storage.hasBlocked(), true)
      assert.equal(storage.write(key, {}), false)
      assert.equal(storage.write(key, {1: 'novo'}), false)
      assert.equal(db.getItem(key), raw)
      assert.equal(db.mutations, 0)
    }
  }
})

test('um mapa bloqueado nao impede gravar outro mapa valido', () => {
  const db = memoryStore({[keys[0]]: '{"1":', [keys[1]]: '{}'})
  const storage = createJsonMapStorage(() => db)
  storage.read(keys[0]); storage.read(keys[1])
  assert.equal(storage.write(keys[1], {1: {year: 2001}}), true)
  assert.equal(storage.write(keys[0], {}), false)
  assert.equal(db.getItem(keys[0]), '{"1":')
})

test('acesso negado permanece protegido ate uma restauracao', () => {
  const db = memoryStore({[keys[0]]: '{"1":"original"}'})
  let unavailable = true, attempts = 0
  const storage = createJsonMapStorage(() => {
    attempts++
    if (unavailable) throw new Error('SecurityError')
    return db
  })
  assert.deepEqual(storage.read(keys[0]), {})
  assert.equal(storage.write(keys[0], {}), false)
  assert.equal(attempts, 1)
  unavailable = false
  assert.equal(storage.write(keys[0], {}), false)
  assert.equal(db.getItem(keys[0]), '{"1":"original"}')
  storage.restore([{key: keys[0], value: {1: 'recuperado'}}])
  assert.equal(storage.hasBlocked(), false)
  assert.equal(storage.write(keys[0], {1: 'atualizado'}), true)
})

test('falta de espaco e informada sem apagar o mapa valido', () => {
  const db = memoryStore({[keys[0]]: '{"1":"original"}'})
  const storage = createJsonMapStorage(() => db)
  storage.read(keys[0]); db.failNextKey = keys[0]
  assert.throws(() => storage.write(keys[0], {1: 'novo'}), /quota/)
  assert.equal(db.getItem(keys[0]), '{"1":"original"}')
})

test('backup validado libera somente os mapas restaurados', () => {
  const db = memoryStore(Object.fromEntries(keys.map(key => [key, '{"1":'])))
  const storage = createJsonMapStorage(() => db)
  for (const key of keys) storage.read(key)

  const legacy = parseBackup({
    version: 1, favorites: [], watched: [], ratings: {}
  }, new Set([1]))

  storage.restore([{key: 'cinevault.personal.v2', value: legacy.saved}])
  for (const key of keys) assert.equal(storage.write(key, {}), false)

  const parsed = parseBackup({
    version: 4, favorites: [], watched: [], ratings: {},
    posters: {1: 'https://image.tmdb.org/t/p/w500/poster.jpg'},
    posterMeta: {}, unresolved: {},
    pulse: {queue: [], history: [], notes: {}, recent: [], dailyOffset: 0},
  }, new Set([1]))

  storage.restore([{key: keys[0], value: parsed.posters}])
  assert.equal(storage.write(keys[0], parsed.posters), true)
  assert.equal(storage.write(keys[1], {}), false)
  assert.equal(db.getItem(keys[1]), '{"1":')

  storage.restore([
    {key: keys[1], value: parsed.posterMeta},
    {key: keys[2], value: parsed.unresolved}
  ])
  assert.equal(storage.hasBlocked(), false)
})

test('falha durante restauracao reverte dados e conserva bloqueios', () => {
  const initial = {[keys[0]]: '{"1":', [keys[1]]: '{"2":', personal: 'ORIGINAL'}
  const db = memoryStore(initial)
  const storage = createJsonMapStorage(() => db)
  storage.read(keys[0]); storage.read(keys[1]); db.failNextKey = keys[1]

  assert.throws(() => storage.restore([
    {key: keys[0], value: {1: 'novo'}},
    {key: 'personal', value: {watched: [1]}},
    {key: keys[1], value: {1: {year: 2001}}},
  ]), /dados anteriores/)

  assert.deepEqual(Object.fromEntries(db.values), initial)
  const before = db.mutations
  assert.equal(storage.write(keys[0], {}), false)
  assert.equal(storage.write(keys[1], {}), false)
  assert.equal(db.mutations, before)
})

test('backup invalido nao chega a gravacao nem libera mapas', () => {
  const db = memoryStore({[keys[0]]: '{"1":'})
  const storage = createJsonMapStorage(() => db)
  storage.read(keys[0])

  assert.throws(() => {
    const parsed = parseBackup({
      version: 4, favorites: [], watched: [], ratings: {}, posters: [],
      pulse: {queue: [], history: [], notes: {}, recent: [], dailyOffset: 0},
    }, new Set([1]))
    storage.restore([{key: keys[0], value: parsed.posters}])
  }, /inválid/)

  assert.equal(storage.write(keys[0], {}), false)
  assert.equal(db.mutations, 0)
})

test('App uses guarded async poster batches and awaits restores before reporting success', () => {
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8')
 assert.ok(app.includes('createAsyncJsonMapStorage(persistence)'))
 assert.ok(!app.includes('posterStorage.write('))
 assert.ok(!app.includes('personalStorage.setItem('))
 const importing=app.slice(app.indexOf('const importBackup='),app.indexOf('const cards='))
 assert.ok(importing.includes('setNotice(await restoreLibraryBackup(persistence,raw,file.size,new Set(filmsById.keys()),posterStorage))'))
 const restoring=readFileSync(new URL('../src/personalBackupImport.ts',import.meta.url),'utf8')
 assert.ok(restoring.includes('await maps.restoreMediaBackup(input)'))
 assert.ok(restoring.includes('await maps.restoreSnapshot(input)'))
 assert.ok(restoring.indexOf('parseBackup(input,knownIds)')<restoring.indexOf('await maps.restore(['))
 assert.ok(restoring.indexOf('await maps.restore([')<restoring.indexOf('Backup restaurado:'))
 const exporting=app.slice(app.indexOf('const exportBackup='),app.indexOf('const importBackup='))
 assert.ok(exporting.indexOf('await persistence.flush()')<exporting.indexOf('await exportJsonBackup('))
 const auto=app.slice(app.indexOf('const autoPosters='),app.indexOf('const [sortMode'))
 assert.ok(auto.indexOf('posterStorage.hasBlocked()')<auto.indexOf('await autoIdentify('))
 assert.ok(auto.includes('await posterStorage.update([POSTER_KEY,META_KEY,UNRESOLVED_KEY]'))
})
