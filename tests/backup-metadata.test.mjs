import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBackup } from '../src/backupValidation.ts'
import { commitJsonBatch } from '../src/storageSafety.ts'

const ids = new Set([1])
const meta = {
  tmdbId: 10, tmdbTitle: 'Teste', year: 2001,
  posterPath: '/poster.jpg', backdropPath: null,
  overview: 'Exemplo', confidence: 0.9,
  checkedAt: '2026-10-20T19:00:00Z'
}
const backup = (version = 3) => ({
  version, favorites: [1], watched: [1], ratings: {1: 5},
  posterMeta: {1: {...meta}},
  ...(version === 4 ? {pulse: {
    queue: [], history: [], notes: {}, recent: [], dailyOffset: 0
  }} : {})
})

test('metadados validos continuam compativeis com backups 1 a 4', () => {
  for (const version of [1, 2, 3, 4]) {
    const raw = backup(version)
    assert.deepEqual(parseBackup(raw, ids).posterMeta, raw.posterMeta)
  }
})
test('conversoes legadas finitas e valores ausentes sao preservados', () => {
  const raw = backup()
  raw.posterMeta[1].year = '2001'
  raw.posterMeta[1].confidence = '0.9'
  let parsed = parseBackup(raw, ids).posterMeta[1]
  assert.equal(parsed.year, 2001)
  assert.equal(parsed.confidence, 0.9)
  delete raw.posterMeta[1].year
  delete raw.posterMeta[1].confidence
  parsed = parseBackup(raw, ids).posterMeta[1]
  assert.equal(parsed.year, 0)
  assert.equal(parsed.confidence, 0)
})
test('ano e confianca rejeitam numeros invalidos ou nao finitos', () => {
  for (const field of ['year', 'confidence']) {
    for (const value of ['invalido', 'Infinity', '-Infinity', Infinity, -Infinity, NaN]) {
      const raw = backup()
      raw.posterMeta[1][field] = value
      assert.throws(() => parseBackup(raw, ids), /números inválidos/)
    }
  }
})
test('overflow numerico em JSON tambem e rejeitado', () => {
  for (const field of ['year', 'confidence']) {
    const raw = backup()
    raw.posterMeta[1][field] = 'OVERFLOW'
    const input = JSON.parse(JSON.stringify(raw).replace('"OVERFLOW"', '1e309'))
    assert.equal(input.posterMeta[1][field], Infinity)
    assert.throws(() => parseBackup(input, ids), /números inválidos/)
  }
})
test('metadados invalidos nao alteram entrada nem chegam a gravacao', () => {
  const raw = backup(4)
  raw.posterMeta[1].year = 'invalido'
  const before = structuredClone(raw)
  let writes = 0
  const data = new Map([['dados', 'ORIGINAL']])
  const store = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { writes++; data.set(key, value) },
    removeItem: key => { writes++; data.delete(key) }
  }
  assert.throws(() => {
    const parsed = parseBackup(raw, ids)
    commitJsonBatch(store, [{key: 'dados', value: parsed}])
  }, /números inválidos/)
  assert.equal(writes, 0)
  assert.equal(data.get('dados'), 'ORIGINAL')
  assert.deepEqual(raw, before)
})
