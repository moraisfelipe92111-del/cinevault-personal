import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  PERSONAL_STORAGE_KEYS, capturePersonalStorageSnapshot,
  validatePersonalStorageSnapshot, serializePersonalStorageSnapshot,
  parsePersonalStorageSnapshot, assertPersonalStorageUnchanged,
} from '../src/personalStorageSnapshot.ts'

const keys = [...PERSONAL_STORAGE_KEYS]
function reader(values = []) {
  const data = new Map(keys.map((key, index) => [key, values[index] ?? null]))
  const reads = []
  const store = {
    getItem(key) { reads.push(key); return data.get(key) ?? null },
    setItem() { assert.fail('snapshot must never write to its source') },
    removeItem() { assert.fail('snapshot must never remove source data') },
  }
  return {data, reads, store}
}
const clone = snapshot => JSON.parse(JSON.stringify(snapshot))

test('snapshot covers exactly the six audited keys, including experience preferences', () => {
  const baseline = JSON.parse(fs.readFileSync(new URL('../planning/cv2-audit/persistence-baseline.json', import.meta.url)))
  assert.deepEqual(keys, baseline.personalStorage.map(entry => entry.key))
  assert.equal(keys.length, 6)
  const sources = ['App.tsx', 'pulse.ts', 'experience.tsx'].map(name =>
    fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')).join('\n')
  const current = [...sources.matchAll(/['"](cinevault\.[^'"\s]+)['"]/g)].map(match => match[1])
  assert.deepEqual(new Set(current), new Set(keys))
})

test('snapshot preserves raw JSON, invalid JSON, unknown IDs and future fields without parsing them', () => {
  const values = [
    '  {"favorites":[999999,1,1],"future":{"keep":true}}\r\n',
    '{"queue":[999999],"notes":{"1":"ação 🎬"},"future":null}',
    '{"1":"not-a-canonical-url"}',
    '{"1":{"year":1e999,"confidence":1e999}}',
    '[broken JSON',
    '{"intro":false,"sound":false,"volume":0,"sonic":"future-mode"}',
  ]
  const {store, reads} = reader(values)
  const captured = capturePersonalStorageSnapshot(store)
  assert.deepEqual(captured.entries.map(entry => entry.raw), values)
  assert.deepEqual(reads, [...keys, ...keys])
  assert.deepEqual(parsePersonalStorageSnapshot(serializePersonalStorageSnapshot(captured)), captured)
})

test('snapshot distinguishes absence, empty text, JSON null, objects, arrays and whitespace', () => {
  const values = [null, '', 'null', '{}', '[]', '  \n\t']
  const snapshot = capturePersonalStorageSnapshot(reader(values).store)
  assert.deepEqual(snapshot.entries.map(entry => entry.raw), values)
  assert.deepEqual(parsePersonalStorageSnapshot(serializePersonalStorageSnapshot(snapshot)).entries.map(entry => entry.raw), values)
})

test('snapshot serialization round trips exact UTF-16 including NUL, CRLF and lone surrogates', () => {
  for (const raw of ["Sessão 🎬 — d'água\r\n", '\u0000', '\ud800', '\udfff', '\ud800x\udfff', '\ufeff', '\u2028\u2029', '\\ud800', "'); DROP TABLE personal_data; --"]) {
    const snapshot = capturePersonalStorageSnapshot(reader(keys.map(() => raw)).store)
    const restored = parsePersonalStorageSnapshot(serializePersonalStorageSnapshot(snapshot))
    for (const entry of restored.entries) assert.equal(entry.raw, raw)
  }
})

test('a denied read aborts the entire snapshot without substituting defaults or exposing values', () => {
  for (const denied of keys) {
    const {store} = reader(keys.map(() => 'PRIVATE CONTENT'))
    store.getItem = key => {
      if (key === denied) throw new Error('PRIVATE CONTENT')
      return 'PRIVATE CONTENT'
    }
    assert.throws(() => capturePersonalStorageSnapshot(store), error => {
      assert.match(error.message, /cannot read/)
      assert.ok(error.message.includes(denied))
      assert.ok(!error.message.includes('PRIVATE CONTENT'))
      return true
    })
  }
})

test('storage values outside string or null are rejected instead of coerced', () => {
  for (const raw of [undefined, 0, false, {}, []]) {
    assert.throws(() => capturePersonalStorageSnapshot({getItem() { return raw }}), /unexpected storage value/)
  }
})

test('captured and validated snapshots are immutable and detached from mutable inputs', () => {
  const {store, data} = reader(keys.map(() => 'original'))
  const snapshot = capturePersonalStorageSnapshot(store)
  data.set(keys[0], 'later')
  assert.equal(snapshot.entries[0].raw, 'original')
  for (const value of [PERSONAL_STORAGE_KEYS, snapshot, snapshot.entries, ...snapshot.entries]) assert.ok(Object.isFrozen(value))
  assert.throws(() => { snapshot.entries[0].raw = 'changed' }, TypeError)
  const input = clone(snapshot)
  const checked = validatePersonalStorageSnapshot(input)
  input.entries[0].raw = 'mutated'
  assert.equal(checked.entries[0].raw, 'original')
})

test('incomplete, repeated, unknown or reordered keys and unsupported envelopes are refused before source reads', () => {
  const valid = capturePersonalStorageSnapshot(reader().store)
  const variants = [null, [], {}, {...valid, format: 'other'}, {...valid, version: 2}, {...valid, extra: true}]
  const changed = change => { const value = clone(valid); change(value); variants.push(value) }
  changed(value => { value.entries.pop() })
  changed(value => { value.entries.push(value.entries[0]) })
  changed(value => { value.entries[1] = value.entries[0] })
  changed(value => { value.entries[0].key = 'other.key' })
  changed(value => { value.entries.reverse() })
  changed(value => { delete value.entries[0].raw })
  changed(value => { value.entries[0].raw = {} })
  changed(value => { value.entries[0].extra = 'unexpected' })
  const store = {getItem() { assert.fail('invalid snapshot must be refused before reading source') }}
  for (const value of variants) {
    assert.throws(() => validatePersonalStorageSnapshot(value), /Personal storage snapshot:/)
    assert.throws(() => serializePersonalStorageSnapshot(value), /Personal storage snapshot:/)
    assert.throws(() => assertPersonalStorageUnchanged(store, value), /Personal storage snapshot:/)
  }
  assert.throws(() => parsePersonalStorageSnapshot('{broken'), /invalid serialized envelope/)
})

test('a source change between read passes prevents an apparently complete snapshot', () => {
  for (const changedKey of keys) {
    const {store, reads} = reader(keys.map(() => 'original'))
    const getItem = store.getItem
    store.getItem = key => {
      const nextPass = reads.length >= keys.length
      const result = getItem(key)
      return nextPass && key === changedKey ? 'changed' : result
    }
    assert.throws(() => capturePersonalStorageSnapshot(store), /storage changed during capture/)
  }
})

test('the final comparison detects changed or newly present values in every personal key', () => {
  for (const key of keys) {
    const {store, data} = reader()
    const snapshot = capturePersonalStorageSnapshot(store)
    assert.doesNotThrow(() => assertPersonalStorageUnchanged(store, snapshot))
    data.set(key, 'null')
    assert.throws(() => assertPersonalStorageUnchanged(store, snapshot), /source changed since capture/)
    data.set(key, null)
    assert.doesNotThrow(() => assertPersonalStorageUnchanged(store, snapshot))
  }
})

test('importing snapshot preparation does not read browser storage or activate it in the app', () => {
  const module = new URL('../src/personalStorageSnapshot.ts', import.meta.url).href
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    'Object.defineProperty(globalThis,"localStorage",{get(){throw Error("storage must not be read on import")}}); await import(' + JSON.stringify(module) + ');'], {encoding: 'utf8'})
  assert.equal(child.status, 0, child.stderr)
  for (const name of ['main.tsx', 'App.tsx', 'experience.tsx']) {
    const source = fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')
    assert.ok(!source.includes('personalStorageSnapshot'))
  }
})
