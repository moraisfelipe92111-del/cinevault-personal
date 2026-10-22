import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createPersonalSqliteSnapshotRepository } from '../src/personalSqliteSnapshot.ts'
import { PERSONAL_STORAGE_KEYS, capturePersonalStorageSnapshot, serializePersonalStorageSnapshot } from '../src/personalStorageSnapshot.ts'

const TABLE = 'cv_personal_raw_snapshot'
const CHUNKS = 'cv_personal_raw_snapshot_chunk'
const snapshot = values => capturePersonalStorageSnapshot({getItem(key) {
  return values[PERSONAL_STORAGE_KEYS.indexOf(key)] ?? null
}})
const basic = () => snapshot([null, '', 'null', '[broken JSON', "ação 🎬\r\n\u0000\ud800x\udfff", '{"future":true,"volume":0}'])
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')

function host(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-raw-sqlite-'))
  const filename = path.join(directory, 'synthetic.sqlite')
  let native = new DatabaseSync(filename)
  const calls = []
  const connection = {
    async execute(sql, transaction) {
      calls.push(['execute', sql]); assert.equal(transaction, false)
      // A single prepared statement models the Android native execute behavior.
      return native.prepare(sql).run()
    },
    async run(sql, values, transaction) {
      calls.push(['run', sql, values]); assert.equal(transaction, false)
      return native.prepare(sql).run(...values)
    },
    async query(sql, values = []) {
      calls.push(['query', sql, values])
      return {values: native.prepare(sql).all(...values).map(row => Object.fromEntries(Object.entries(row).reverse()))}
    },
    async beginTransaction() { calls.push(['begin']); native.exec('BEGIN') },
    async commitTransaction() { calls.push(['commit']); native.exec('COMMIT') },
    async rollbackTransaction() { calls.push(['rollback']); native.exec('ROLLBACK') },
    async isTransactionActive() { calls.push(['active']); return {result: native.isTransaction} },
  }
  const api = {
    connection, calls,
    get native() { return native },
    repository() { return createPersonalSqliteSnapshotRepository(connection) },
    reopen() { native.close(); native = new DatabaseSync(filename); return this.repository() },
    tables() { return native.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name) },
  }
  t.after(() => { native.close(); fs.rmSync(directory, {recursive: true}) })
  return api
}

test('SQLite snapshot import and construction are lazy and production startup does not activate the repository', () => {
  const repository = createPersonalSqliteSnapshotRepository(new Proxy({}, {get() { assert.fail('no database access during construction') }}))
  assert.ok(Object.isFrozen(repository))
  const moduleUrl = new URL('../src/personalSqliteSnapshot.ts', import.meta.url).href
  const script = `Object.defineProperty(globalThis,'localStorage',{get(){throw Error('storage touched')}}); Object.defineProperty(globalThis,'crypto',{get(){throw Error('crypto touched')}}); const m = await import(${JSON.stringify(moduleUrl)}); m.createPersonalSqliteSnapshotRepository(new Proxy({},{get(){throw Error('database touched')}}));`
  const imported = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {encoding: 'utf8'})
  assert.equal(imported.status, 0, imported.stderr)
  for (const file of fs.readdirSync(new URL('../src', import.meta.url)).filter(name => /\.(tsx?|mjs)$/.test(name) && name !== 'personalSqliteSnapshot.ts')) {
    const text = fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
    assert.ok(!text.includes('personalSqliteSnapshot'), file + ' must not activate SQLite migration')
  }
})

test('reading an absent SQLite copy returns null without creating tables or substituting an empty snapshot', async t => {
  const fixture = host(t)
  assert.equal(await fixture.repository().read(), null)
  assert.deepEqual(fixture.tables(), [])
  assert.equal(fixture.calls.filter(call => ['execute', 'run'].includes(call[0])).length, 0)
  assert.equal(fixture.native.isTransaction, false)
})

test('SQLite preserves all six raw values including absence, invalid JSON and exact UTF-16 code units', async t => {
  const variants = [basic(), snapshot(['{}', '[]', ' \r\n\t', '\ufeff\u2028\u2029', '\\ud800', "'); DROP TABLE unrelated; --"])]
  for (const expected of variants) {
    const fixture = host(t)
    fixture.native.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY); INSERT INTO unrelated VALUES (15); PRAGMA user_version = 7;')
    const repository = fixture.repository()
    assert.equal(await repository.preserve(expected), 'preserved')
    const restored = await fixture.reopen().read()
    assert.deepEqual(restored, expected)
    assert.ok(Object.isFrozen(restored) && Object.isFrozen(restored.entries))
    assert.ok(restored.entries.every(Object.isFrozen))
    assert.equal(fixture.native.prepare('SELECT id FROM unrelated').get().id, 15)
    assert.equal(fixture.native.prepare('PRAGMA user_version').get().user_version, 7)
    const meta = fixture.native.prepare(`SELECT * FROM ${TABLE}`).get()
    assert.equal(meta.sha256, hash(serializePersonalStorageSnapshot(expected)))
    assert.equal(meta.utf16_length, serializePersonalStorageSnapshot(expected).length)
  }
})

test('a copy larger than 2 MiB reopens exactly and every native chunk is bounded and well-formed Unicode', async t => {
  const fixture = host(t)
  const raw = 'cinema 🎬 ação\r\n'.repeat(150000) + '\u0000\ud800x\udfff'
  const expected = snapshot([raw, '', null, 'null', '[broken JSON', '{"future":{"keep":true}}'])
  const serialized = serializePersonalStorageSnapshot(expected)
  assert.ok(serialized.length > 2 * 1024 * 1024)
  await fixture.repository().preserve(expected)
  const chunks = fixture.native.prepare(`SELECT ordinal, payload FROM ${CHUNKS} ORDER BY ordinal`).all()
  assert.ok(chunks.length > 100)
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.ordinal, index)
    assert.ok(chunk.payload.length > 0 && chunk.payload.length <= 16384)
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(chunk.payload)), chunk.payload)
  }
  assert.equal(chunks.map(chunk => chunk.payload).join(''), serialized)
  const reads = fixture.calls.filter(call => call[0] === 'query' && call[1].includes('payload'))
  assert.ok(reads.every(call => /WHERE ordinal = \?$/.test(call[1])))
  assert.deepEqual(await fixture.reopen().read(), expected)
})

test('the first committed copy is immutable and an identical retry does not rewrite any row', async t => {
  const fixture = host(t), expected = basic(), repository = fixture.repository()
  await repository.preserve(expected)
  const mutations = fixture.calls.filter(call => ['execute', 'run'].includes(call[0])).length
  assert.equal(await repository.preserve(expected), 'already_preserved')
  assert.equal(fixture.calls.filter(call => ['execute', 'run'].includes(call[0])).length, mutations)
  await assert.rejects(repository.preserve(snapshot(['changed'])), /existing snapshot differs; replacement refused/)
  assert.deepEqual(await fixture.reopen().read(), expected)
  assert.ok(fixture.calls.filter(call => call[0] === 'run').every(call => call[1].startsWith('INSERT INTO main.')))
})

test('invalid envelopes are refused before database access and inputs detach before the first await', async t => {
  const fixture = host(t), repository = fixture.repository()
  for (const input of [null, {}, {...basic(), version: 9}, {...basic(), entries: []}]) await assert.rejects(repository.preserve(input))
  assert.equal(fixture.calls.length, 0)
  const input = JSON.parse(JSON.stringify(basic())), expected = structuredClone(input)
  const saving = repository.preserve(input)
  input.entries[0].raw = 'mutated during hash calculation'
  await saving
  assert.deepEqual(await repository.read(), expected)
})

test('missing SHA-256 support fails before database access instead of preserving an unverifiable copy', async t => {
  const fixture = host(t), original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  try {
    Object.defineProperty(globalThis, 'crypto', {value: undefined, configurable: true})
    await assert.rejects(fixture.repository().preserve(basic()), /SHA-256 support is required/)
    assert.equal(fixture.calls.length, 0)
  } finally { Object.defineProperty(globalThis, 'crypto', original) }
})

test('unexpected schemas, views, triggers and partial snapshot schemas are refused without replacement', async t => {
  const definitions = [
    `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, value TEXT)`,
    `CREATE VIEW ${TABLE} AS SELECT 1 AS id`,
  ]
  for (const sql of definitions) {
    const fixture = host(t)
    fixture.native.exec(sql)
    await assert.rejects(fixture.repository().preserve(basic()), /unexpected snapshot schema/)
    assert.deepEqual(fixture.tables(), [TABLE])
  }
  for (const mutation of [
    `DROP TABLE ${CHUNKS}`,
    `CREATE TRIGGER unexpected_writer AFTER INSERT ON ${CHUNKS} BEGIN DELETE FROM ${CHUNKS}; END`,
    `CREATE INDEX unexpected_index ON ${CHUNKS} (payload)`,
  ]) {
    const fixture = host(t)
    await fixture.repository().preserve(basic())
    fixture.native.exec(mutation)
    await assert.rejects(fixture.repository().read(), /unexpected snapshot schema|incomplete snapshot schema/)
  }
})

test('a temporary table with the same name cannot shadow the preserved main-database copy', async t => {
  const fixture = host(t), expected = basic()
  fixture.native.exec(`CREATE TEMP TABLE ${CHUNKS} (ordinal INTEGER PRIMARY KEY, payload TEXT); INSERT INTO ${CHUNKS} VALUES (0, 'unrelated temporary data');`)
  await fixture.repository().preserve(expected)
  assert.deepEqual(await fixture.repository().read(), expected)
  assert.equal(fixture.native.prepare(`SELECT payload FROM temp.${CHUNKS}`).get().payload, 'unrelated temporary data')
})

test('missing, extra, reordered, truncated and changed chunks or metadata never produce a successful read', async t => {
  const mutations = [
    `DELETE FROM ${TABLE}`,
    `DELETE FROM ${CHUNKS} WHERE ordinal = 0`,
    `INSERT INTO ${CHUNKS} VALUES (999, 'extra')`,
    `UPDATE ${CHUNKS} SET ordinal = 999 WHERE ordinal = 0`,
    `UPDATE ${CHUNKS} SET payload = 'x' || substr(payload, 2) WHERE ordinal = 0`,
    `UPDATE ${CHUNKS} SET payload = substr(payload, 1, length(payload) - 1) WHERE ordinal = 0`,
    `UPDATE ${TABLE} SET sha256 = '${'0'.repeat(64)}'`,
    `UPDATE ${TABLE} SET chunk_count = 1000000000, utf16_length = 1000000000`,
  ]
  for (const sql of mutations) {
    const fixture = host(t)
    await fixture.repository().preserve(snapshot(['x'.repeat(40000), null, '', 'null', 'bad', '{}']))
    fixture.native.exec(sql)
    const writes = fixture.calls.filter(call => ['execute', 'run'].includes(call[0])).length
    await assert.rejects(fixture.repository().read())
    assert.equal(fixture.calls.filter(call => ['execute', 'run'].includes(call[0])).length, writes)
  }
})

test('even a valid digest cannot authorize an unsupported stored envelope or a noncanonical serialization', async t => {
  const original = serializePersonalStorageSnapshot(basic())
  for (const changed of [original.replace('"version":1', '"version":9'), ' ' + original]) {
    const fixture = host(t)
    await fixture.repository().preserve(basic())
    fixture.native.prepare(`UPDATE ${CHUNKS} SET payload = ? WHERE ordinal = 0`).run(changed)
    fixture.native.prepare(`UPDATE ${TABLE} SET sha256 = ?, utf16_length = ?`).run(hash(changed), changed.length)
    await assert.rejects(fixture.repository().read())
  }
})

test('a failed chunk write rolls back the new tables, metadata and all preceding chunks', async t => {
  const fixture = host(t), run = fixture.connection.run
  fixture.connection.run = async (sql, values, transaction) => {
    if (sql.includes(CHUNKS) && values[0] === 1) throw Error('quota exhausted with PRIVATE VALUES')
    return run(sql, values, transaction)
  }
  const repository = fixture.repository(), expected = snapshot(['x'.repeat(40000)])
  await assert.rejects(repository.preserve(expected), error => {
    assert.match(error.message, /database operation failed/)
    assert.ok(!error.message.includes('PRIVATE VALUES'))
    return true
  })
  assert.deepEqual(fixture.tables(), [])
  assert.equal(fixture.native.isTransaction, false)
  const commands = fixture.calls.length
  await assert.rejects(repository.read(), /close and reopen/)
  assert.equal(fixture.calls.length, commands)
  fixture.connection.run = run
  assert.equal(await fixture.reopen().preserve(expected), 'preserved')
})

test('a reported commit failure is not reported as success and an uncommitted copy rolls back', async t => {
  const fixture = host(t)
  fixture.connection.commitTransaction = async () => { throw Error('native commit failed') }
  await assert.rejects(fixture.repository().preserve(basic()), /database operation failed/)
  assert.deepEqual(fixture.tables(), [])
  assert.equal(fixture.native.isTransaction, false)
})

test('a commit acknowledgement lost after commit requires reopening and the first durable copy remains recoverable', async t => {
  const fixture = host(t), commit = fixture.connection.commitTransaction
  fixture.connection.commitTransaction = async () => { await commit(); throw Error('acknowledgement lost') }
  await assert.rejects(fixture.repository().preserve(basic()), /database operation failed/)
  assert.equal(fixture.native.isTransaction, false)
  fixture.connection.commitTransaction = commit
  const repository = fixture.reopen()
  assert.deepEqual(await repository.read(), basic())
  assert.equal(await repository.preserve(basic()), 'already_preserved')
})

test('a native commit that returns without committing is detected and rolled back', async t => {
  const fixture = host(t)
  fixture.connection.commitTransaction = async () => {}
  await assert.rejects(fixture.repository().preserve(basic()), /transaction did not commit/)
  assert.equal(fixture.native.isTransaction, false)
  assert.deepEqual(fixture.tables(), [])
})

test('a copy removed after commit cannot produce success or allow silent recreation on the same repository', async t => {
  const fixture = host(t), commit = fixture.connection.commitTransaction
  let first = true
  fixture.connection.commitTransaction = async () => {
    await commit()
    if (first) { first = false; fixture.native.exec(`DROP TABLE ${CHUNKS}; DROP TABLE ${TABLE}`) }
  }
  const repository = fixture.repository()
  await assert.rejects(repository.preserve(basic()), /snapshot read-back mismatch after commit/)
  const commands = fixture.calls.length
  await assert.rejects(repository.preserve(basic()), /close and reopen/)
  assert.equal(fixture.calls.length, commands)
  assert.deepEqual(fixture.tables(), [])
})

test('an unrelated active transaction is refused without committing or rolling back its writes', async t => {
  const fixture = host(t)
  fixture.native.exec('CREATE TABLE unrelated (id INTEGER); BEGIN; INSERT INTO unrelated VALUES (15)')
  await assert.rejects(fixture.repository().preserve(basic()), /another transaction is already active/)
  assert.equal(fixture.native.isTransaction, true)
  assert.equal(fixture.native.prepare('SELECT id FROM unrelated').get().id, 15)
  assert.ok(!fixture.calls.some(call => ['begin', 'commit', 'rollback', 'execute', 'run'].includes(call[0])))
  fixture.native.exec('ROLLBACK')
})

test('a begin failure never claims transaction ownership or attempts a rollback', async t => {
  const fixture = host(t)
  fixture.connection.beginTransaction = async () => { throw Error('cannot acquire write lock') }
  await assert.rejects(fixture.repository().preserve(basic()), /database operation failed/)
  assert.ok(!fixture.calls.some(call => ['query', 'commit', 'rollback', 'execute', 'run'].includes(call[0])))
  assert.deepEqual(fixture.tables(), [])
})

test('concurrent repository operations are refused while the first copy transaction owns the connection', async t => {
  const fixture = host(t), repository = fixture.repository(), query = fixture.connection.query
  let entered, release
  const waiting = new Promise(resolve => { entered = resolve })
  const continueRead = new Promise(resolve => { release = resolve })
  let first = true
  fixture.connection.query = async (...args) => {
    if (first) { first = false; entered(); await continueRead }
    return query(...args)
  }
  const saving = repository.preserve(basic())
  await waiting
  const commands = fixture.calls.length
  await assert.rejects(repository.read(), /operation is in progress/)
  await assert.rejects(repository.preserve(basic()), /operation is in progress/)
  assert.equal(fixture.calls.length, commands)
  release()
  assert.equal(await saving, 'preserved')
  assert.deepEqual(await repository.read(), basic())
})

test('rollback failures cannot expose private values or hide the primary failure and the connection is not reused', async t => {
  const fixture = host(t)
  fixture.connection.run = async () => { throw Error('PRIVATE ORIGINAL VALUES') }
  fixture.connection.rollbackTransaction = async () => { throw Error('PRIVATE CLEANUP VALUES') }
  const repository = fixture.repository()
  await assert.rejects(repository.preserve(basic()), error => {
    assert.match(error.message, /database operation failed/)
    assert.ok(!error.message.includes('PRIVATE'))
    return true
  })
  const commands = fixture.calls.length
  await assert.rejects(repository.read(), /close and reopen/)
  assert.equal(fixture.calls.length, commands)
  assert.equal(await fixture.reopen().read(), null)
})

test('unknown native transaction status or absent query rows cannot be treated as an empty database', async t => {
  for (const mode of ['transaction-status', 'query-rows']) {
    const fixture = host(t)
    if (mode === 'transaction-status') fixture.connection.isTransactionActive = async () => ({})
    else fixture.connection.query = async () => ({})
    await assert.rejects(fixture.repository().read())
    assert.deepEqual(fixture.tables(), [])
    assert.ok(!fixture.calls.some(call => ['execute', 'run'].includes(call[0])))
  }
})
