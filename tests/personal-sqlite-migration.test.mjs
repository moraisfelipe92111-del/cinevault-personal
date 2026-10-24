import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPersonalStorageCoordinator } from '../src/personalStorage.ts'
import { PERSONAL_STORAGE_KEYS, serializePersonalStorageSnapshot } from '../src/personalStorageSnapshot.ts'
import { createPersonalSqliteSnapshotRepository } from '../src/personalSqliteSnapshot.ts'
import { createPersonalSqliteMigrationRepository } from '../src/personalSqliteMigration.ts'

const RECEIPT = 'cv_personal_migration', VALUES = 'cv_personal_value', CHUNKS = 'cv_personal_value_chunk'
const ORIGINALS = ['cv_personal_raw_snapshot', 'cv_personal_raw_snapshot_chunk']
const hash = value => createHash('sha256').update(value).digest('hex')

function source(values = [null, '', 'null', '[broken JSON', "🎬 ação\r\n\u0000\ud800x\udfff", ' {"volume":0,"future":[999999]}\r\n']) {
  const data = new Map(PERSONAL_STORAGE_KEYS.map((key, index) => [key, values[index] ?? null]))
  const store = {getItem(key) { return data.get(key) ?? null }, setItem(key, value) { data.set(key, value) }, removeItem(key) { data.delete(key) }}
  const coordinator = createPersonalStorageCoordinator(() => store), pause = coordinator.pauseWrites()
  const snapshot = pause.captureSnapshot()
  return {data, store, coordinator, pause, snapshot, guard: () => pause.assertUnchanged(snapshot)}
}

function host(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-personal-migration-'))
  const filename = path.join(directory, 'synthetic.sqlite')
  let native = new DatabaseSync(filename)
  const calls = []
  const connection = {
    async execute(sql, transaction) { calls.push(['execute', sql]); assert.equal(transaction, false); return native.prepare(sql).run() },
    async run(sql, values, transaction) { calls.push(['run', sql, values]); assert.equal(transaction, false); return native.prepare(sql).run(...values) },
    async query(sql, values = []) { calls.push(['query', sql, values]); return {values: native.prepare(sql).all(...values).map(row => ({...row}))} },
    async beginTransaction() { calls.push(['begin']); native.exec('BEGIN') },
    async commitTransaction() { calls.push(['commit']); native.exec('COMMIT') },
    async rollbackTransaction() { calls.push(['rollback']); native.exec('ROLLBACK') },
    async isTransactionActive() { calls.push(['active']); return {result: native.isTransaction} },
  }
  const fixture = {
    connection, calls, filename,
    get native() { return native },
    repository() { return createPersonalSqliteMigrationRepository(connection) },
    reopen() { native.close(); native = new DatabaseSync(filename); return this.repository() },
    tables() { return native.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name) },
  }
  t.after(() => { native.close(); fs.rmSync(directory, {recursive: true}) })
  return fixture
}

async function migrate(fixture, input = source()) {
  const repository = fixture.repository(), prepared = await repository.prepare(input.snapshot)
  return {repository, input, prepared, state: await prepared.commit(input.guard)}
}

test('migration import and construction perform no global storage, crypto or database access and the platform bootstrap is the only production entry', () => {
  const url = new URL('../src/personalSqliteMigration.ts', import.meta.url).href
  const code = `Object.defineProperty(globalThis,'localStorage',{get(){throw Error('storage touched')}}); Object.defineProperty(globalThis,'crypto',{get(){throw Error('crypto touched')}}); const m=await import(${JSON.stringify(url)}); m.createPersonalSqliteMigrationRepository(new Proxy({},{get(){throw Error('database touched')}}));`
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {encoding: 'utf8'})
  assert.equal(result.status, 0, result.stderr)
  for (const name of fs.readdirSync(new URL('../src', import.meta.url)).filter(name => /\.(tsx?|mjs)$/.test(name) && !['personalSqliteMigration.ts','personalStorageBootstrap.ts','personalPersistence.ts','mediaSqlite.ts','mediaStorageBootstrap.ts'].includes(name))) {
    assert.ok(!fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8').includes('personalSqliteMigration'), name)
  }
})

test('an uninitialized migration returns null without creating a marker or six empty defaults', async t => {
  const fixture = host(t)
  assert.equal(await fixture.repository().read(), null)
  assert.deepEqual(fixture.tables(), [])
  assert.ok(!fixture.calls.some(call => ['execute', 'run'].includes(call[0])))
})

test('six exact raw values, schema version and completion marker become visible atomically after the source guard', async t => {
  const fixture = host(t), input = source(), repository = fixture.repository()
  fixture.native.exec('PRAGMA user_version = 9; CREATE TABLE unrelated (id INTEGER); INSERT INTO unrelated VALUES (15)')
  const originalData = [...input.data.entries()]
  const prepared = await repository.prepare(input.snapshot)
  assert.equal(prepared.schemaVersion, 1)
  assert.equal(prepared.entryCount, 6)
  assert.equal(fixture.native.isTransaction, true)
  assert.equal(fixture.native.prepare(`SELECT state FROM ${RECEIPT}`).get().state, 'complete')
  const observer = new DatabaseSync(fixture.filename)
  try {
    const visible = observer.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cv_personal_%' ORDER BY name").all().map(row => row.name)
    assert.deepEqual(visible, ORIGINALS)
  } finally { observer.close() }
  assert.throws(() => input.coordinator.store.setItem(PERSONAL_STORAGE_KEYS[0], 'blocked'), /pausada/)
  let checked = 0
  const state = await prepared.commit(() => { checked++; input.guard() })
  assert.equal(checked, 1)
  assert.equal(state.schemaVersion, 1)
  assert.equal(state.revision, 0)
  assert.equal(state.sourceSha256, hash(serializePersonalStorageSnapshot(input.snapshot)))
  assert.equal(state.currentSha256, state.sourceSha256)
  assert.deepEqual(state.snapshot, input.snapshot)
  assert.equal(fixture.native.isTransaction, false)
  assert.equal(fixture.native.prepare('PRAGMA user_version').get().user_version, 9)
  assert.equal(fixture.native.prepare('SELECT id FROM unrelated').get().id, 15)
  assert.deepEqual([...input.data.entries()], originalData)
  assert.equal(input.coordinator.phase, 'paused')
  const reopened = await fixture.reopen().read()
  assert.deepEqual(reopened, state)
  assert.ok(Object.isFrozen(reopened) && Object.isFrozen(reopened.snapshot) && Object.isFrozen(reopened.snapshot.entries))
})

test('large migrated values reopen exactly with bounded well-formed chunks and independent digests', async t => {
  const fixture = host(t), input = source(['cinema 🎬 ação\r\n'.repeat(150000), '', null, 'null', '{broken', '{"future":true}'])
  assert.ok(serializePersonalStorageSnapshot(input.snapshot).length > 2 * 1024 * 1024)
  await migrate(fixture, input)
  for (const chunk of fixture.native.prepare(`SELECT payload FROM ${CHUNKS}`).all()) {
    assert.ok(chunk.payload.length <= 16384)
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(chunk.payload)), chunk.payload)
  }
  for (const header of fixture.native.prepare(`SELECT * FROM ${VALUES} ORDER BY slot`).all()) {
    assert.equal(header.sha256, hash(JSON.stringify(input.snapshot.entries[header.slot].raw)))
  }
  assert.deepEqual((await fixture.reopen().read()).snapshot, input.snapshot)
})

test('closing an interrupted prepared connection rolls back target schema, values and marker, then a retry commits once', async t => {
  const fixture = host(t), input = source()
  await fixture.repository().prepare(input.snapshot)
  assert.equal(fixture.native.isTransaction, true)
  const recovered = fixture.reopen()
  assert.equal(await recovered.read(), null)
  assert.deepEqual(fixture.tables(), ORIGINALS)
  assert.deepEqual(await createPersonalSqliteSnapshotRepository(fixture.connection).read(), input.snapshot)
  const prepared = await recovered.prepare(input.snapshot)
  await prepared.commit(input.guard)
  assert.equal(fixture.native.prepare(`SELECT COUNT(*) AS total FROM ${RECEIPT}`).get().total, 1)
  assert.equal(fixture.native.prepare(`SELECT COUNT(*) AS total FROM ${VALUES}`).get().total, 6)
})

test('explicit rollback retains the original and a stale prepared handle cannot commit or roll back a later preparation', async t => {
  const fixture = host(t), input = source(), repository = fixture.repository()
  const first = await repository.prepare(input.snapshot)
  await first.rollback()
  assert.equal(fixture.native.isTransaction, false)
  assert.deepEqual(fixture.tables(), ORIGINALS)
  const second = await repository.prepare(input.snapshot), commands = fixture.calls.length
  await assert.rejects(first.commit(input.guard), /owns the connection/)
  await assert.rejects(first.rollback(), /owns the connection/)
  assert.equal(fixture.calls.length, commands)
  assert.deepEqual((await second.commit(input.guard)).snapshot, input.snapshot)
})

test('a completed database is authoritative and a second migration never overwrites it or the preserved original', async t => {
  const fixture = host(t), {state} = await migrate(fixture)
  const writes = fixture.calls.filter(call => ['run', 'execute'].includes(call[0])).length
  await assert.rejects(fixture.repository().prepare(source(['changed']).snapshot), /already authoritative/)
  assert.equal(fixture.calls.filter(call => ['run', 'execute'].includes(call[0])).length, writes)
  assert.deepEqual(await fixture.reopen().read(), state)
})

test('invalid inputs fail before database access and mutable inputs detach before the first await', async t => {
  const fixture = host(t), repository = fixture.repository()
  for (const value of [null, {}, {...source().snapshot, version: 2}, {...source().snapshot, entries: []}]) await assert.rejects(repository.prepare(value))
  assert.equal(fixture.calls.length, 0)
  const mutable = JSON.parse(JSON.stringify(source().snapshot)), expected = structuredClone(mutable)
  const preparing = repository.prepare(mutable)
  mutable.entries[0].raw = 'changed while hashing'
  const prepared = await preparing
  assert.deepEqual((await prepared.commit(() => {})).snapshot, expected)
})

test('a value or completion-marker write failure rolls back all target objects and keeps the durable original', async t => {
  for (const target of [CHUNKS, RECEIPT]) {
    const fixture = host(t), input = source(), run = fixture.connection.run
    fixture.connection.run = async (sql, values, transaction) => {
      if (sql.startsWith('INSERT INTO main.' + target + ' ')) throw Error('quota failure containing PRIVATE DATA')
      return run(sql, values, transaction)
    }
    await assert.rejects(fixture.repository().prepare(input.snapshot), error => {
      assert.match(error.message, /storage operation failed/)
      assert.ok(!error.message.includes('PRIVATE DATA'))
      return true
    })
    assert.equal(fixture.native.isTransaction, false)
    assert.deepEqual(fixture.tables(), ORIGINALS)
    assert.equal(input.coordinator.phase, 'paused')
    assert.deepEqual(await createPersonalSqliteSnapshotRepository(fixture.connection).read(), input.snapshot)
  }
})

test('an observed external source change aborts commit and never resumes legacy writers', async t => {
  const fixture = host(t), input = source(), repository = fixture.repository()
  const prepared = await repository.prepare(input.snapshot)
  input.data.set(PERSONAL_STORAGE_KEYS[0], 'external newer value')
  await assert.rejects(prepared.commit(input.guard), /source verification failed/)
  assert.equal(fixture.native.isTransaction, false)
  assert.deepEqual(fixture.tables(), ORIGINALS)
  assert.equal(input.data.get(PERSONAL_STORAGE_KEYS[0]), 'external newer value')
  assert.equal(input.coordinator.phase, 'paused')
  assert.deepEqual(await createPersonalSqliteSnapshotRepository(fixture.connection).read(), input.snapshot)
  const commands = fixture.calls.length
  await assert.rejects(repository.read(), /close and reopen/)
  assert.equal(fixture.calls.length, commands)
})

test('asynchronous or invalid source verification is refused before commit', async t => {
  for (const guard of [() => Promise.resolve(), () => false, undefined]) {
    const fixture = host(t), input = source(), prepared = await fixture.repository().prepare(input.snapshot)
    await assert.rejects(prepared.commit(guard), /source verification/)
    assert.deepEqual(fixture.tables(), ORIGINALS)
    assert.equal(fixture.native.isTransaction, false)
  }
})

test('a source pause that lost ownership cannot authorize commit or release the later pause', async t => {
  const fixture = host(t), input = source(), prepared = await fixture.repository().prepare(input.snapshot)
  input.pause.resumeLocalWrites()
  const later = input.coordinator.pauseWrites()
  await assert.rejects(prepared.commit(input.guard), /source verification failed/)
  assert.equal(input.coordinator.phase, 'paused')
  later.assertUnchanged(input.snapshot)
  assert.deepEqual(fixture.tables(), ORIGINALS)
})

test('an in-progress preparation refuses concurrent operations before they access the backend', async t => {
  const fixture = host(t), input = source(), repository = fixture.repository(), query = fixture.connection.query
  let entered, release, first = true
  const waiting = new Promise(resolve => { entered = resolve })
  const continued = new Promise(resolve => { release = resolve })
  fixture.connection.query = async (...args) => {
    if (first) { first = false; entered(); await continued }
    return query(...args)
  }
  const preparing = repository.prepare(input.snapshot)
  await waiting
  const commands = fixture.calls.length
  await assert.rejects(repository.read(), /operation is in progress/)
  await assert.rejects(repository.prepare(input.snapshot), /operation is in progress/)
  assert.equal(fixture.calls.length, commands)
  release()
  await (await preparing).rollback()
})

test('another transaction is refused without committing or rolling back its changes', async t => {
  const fixture = host(t)
  fixture.native.exec('CREATE TABLE unrelated (id INTEGER); BEGIN; INSERT INTO unrelated VALUES (15)')
  await assert.rejects(fixture.repository().prepare(source().snapshot), /another transaction/)
  assert.equal(fixture.native.isTransaction, true)
  assert.equal(fixture.native.prepare('SELECT id FROM unrelated').get().id, 15)
  assert.ok(!fixture.calls.some(call => ['begin', 'commit', 'rollback', 'run', 'execute'].includes(call[0])))
  fixture.native.exec('ROLLBACK')
})

test('a second repository cannot roll back the first prepared transaction', async t => {
  const fixture = host(t), input = source(), first = await fixture.repository().prepare(input.snapshot)
  await assert.rejects(fixture.repository().read(), /another transaction/)
  assert.equal(fixture.native.isTransaction, true)
  assert.deepEqual((await first.commit(input.guard)).snapshot, input.snapshot)
})

test('public operations cannot enter a prepared transaction and changed prepared values cannot be committed', async t => {
  const fixture = host(t), input = source(), repository = fixture.repository(), prepared = await repository.prepare(input.snapshot)
  const commands = fixture.calls.length
  await assert.rejects(repository.read(), /owns the connection/)
  await assert.rejects(repository.prepare(input.snapshot), /owns the connection/)
  assert.equal(fixture.calls.length, commands)
  fixture.native.prepare(`UPDATE ${CHUNKS} SET payload = ? WHERE slot = 0 AND ordinal = 0`).run('corrupted')
  let checked = false
  await assert.rejects(prepared.commit(() => { checked = true }), /integrity mismatch/)
  assert.equal(checked, false)
  assert.deepEqual(fixture.tables(), ORIGINALS)
})

test('missing, extra, reordered and corrupted values or markers refuse hydration without fallback', async t => {
  const mutations = [
    `DELETE FROM ${RECEIPT}`,
    `DELETE FROM ${VALUES} WHERE slot = 0`,
    `UPDATE ${VALUES} SET value_key = 'unknown.key' WHERE slot = 0`,
    `DELETE FROM ${CHUNKS} WHERE slot = 0`,
    `INSERT INTO ${CHUNKS} VALUES (0, 999, 'extra')`,
    `UPDATE ${CHUNKS} SET payload = 'corrupted' WHERE slot = 0`,
    `UPDATE ${VALUES} SET chunk_count = 1000000000 WHERE slot = 0`,
    `UPDATE ${RECEIPT} SET current_sha256 = '${'0'.repeat(64)}'`,
    `UPDATE ${RECEIPT} SET source_sha256 = '${'0'.repeat(64)}'`,
  ]
  for (const sql of mutations) {
    const fixture = host(t)
    await migrate(fixture)
    fixture.native.exec(sql)
    const mutationsBefore = fixture.calls.filter(call => ['execute', 'run'].includes(call[0])).length
    await assert.rejects(fixture.repository().read())
    assert.equal(fixture.calls.filter(call => ['execute', 'run'].includes(call[0])).length, mutationsBefore)
  }
})

test('a newer committed database revision is read from SQLite and never replaced by an older legacy snapshot', async t => {
  const fixture = host(t), input = source(['old']), {state} = await migrate(fixture, input)
  const next = JSON.parse(JSON.stringify(state.snapshot)), encoded = JSON.stringify('newer database value')
  next.entries[0].raw = 'newer database value'
  fixture.native.prepare(`UPDATE ${CHUNKS} SET payload = ? WHERE slot = 0 AND ordinal = 0`).run(encoded)
  fixture.native.prepare(`UPDATE ${VALUES} SET utf16_length = ?, sha256 = ? WHERE slot = 0`).run(encoded.length, hash(encoded))
  fixture.native.prepare(`UPDATE ${RECEIPT} SET current_sha256 = ?, revision = 1`).run(hash(serializePersonalStorageSnapshot(next)))
  const current = await fixture.reopen().read()
  assert.deepEqual(current.snapshot, next)
  assert.equal(current.revision, 1)
  assert.equal(current.sourceSha256, state.sourceSha256)
  await assert.rejects(fixture.repository().prepare(input.snapshot), /already authoritative/)
  assert.deepEqual((await fixture.reopen().read()).snapshot, next)
  fixture.native.exec(`UPDATE ${RECEIPT} SET revision = 0`)
  await assert.rejects(fixture.repository().read(), /initial revision/)
})

test('partial schemas, unexpected triggers and a lost preserved original cannot authorize hydration', async t => {
  for (const mutation of [
    `DROP TABLE ${CHUNKS}`,
    `CREATE TRIGGER unexpected_writer AFTER INSERT ON ${VALUES} BEGIN DELETE FROM ${VALUES}; END`,
    'DROP TABLE cv_personal_raw_snapshot_chunk',
  ]) {
    const fixture = host(t)
    await migrate(fixture)
    fixture.native.exec(mutation)
    await assert.rejects(fixture.repository().read())
  }
  const fixture = host(t)
  fixture.native.exec(`CREATE VIEW ${RECEIPT} AS SELECT 1 AS id`)
  await assert.rejects(fixture.repository().prepare(source().snapshot), /unexpected migration schema/)
  assert.deepEqual(fixture.tables(), [RECEIPT])
})

test('a changed source cannot replace an already preserved original when a migration is retried', async t => {
  const fixture = host(t), first = source()
  await (await fixture.repository().prepare(first.snapshot)).rollback()
  await assert.rejects(fixture.repository().prepare(source(['different']).snapshot), /preserved original differs/)
  assert.deepEqual(fixture.tables(), ORIGINALS)
  assert.deepEqual(await createPersonalSqliteSnapshotRepository(fixture.connection).read(), first.snapshot)
})

test('a rejected commit rolls back targets and a lost acknowledgement after commit is recoverable without re-migration', async t => {
  for (const committed of [false, true]) {
    const fixture = host(t), input = source(), prepared = await fixture.repository().prepare(input.snapshot), commit = fixture.connection.commitTransaction
    fixture.connection.commitTransaction = async () => { if (committed) await commit(); throw Error('native acknowledgement failure PRIVATE DATA') }
    await assert.rejects(prepared.commit(input.guard), error => {
      assert.match(error.message, /storage operation failed/)
      assert.ok(!error.message.includes('PRIVATE DATA'))
      return true
    })
    fixture.connection.commitTransaction = commit
    assert.equal(fixture.native.isTransaction, false)
    const recovered = await fixture.reopen().read()
    if (committed) assert.deepEqual(recovered.snapshot, input.snapshot)
    else { assert.equal(recovered, null); assert.deepEqual(fixture.tables(), ORIGINALS) }
    assert.equal(input.coordinator.phase, 'paused')
  }
})

test('a native commit that does not end the prepared transaction is detected and rolled back', async t => {
  const fixture = host(t), input = source(), prepared = await fixture.repository().prepare(input.snapshot)
  fixture.connection.commitTransaction = async () => {}
  await assert.rejects(prepared.commit(input.guard), /did not commit/)
  assert.equal(fixture.native.isTransaction, false)
  assert.deepEqual(fixture.tables(), ORIGINALS)
})

test('rollback errors preserve the primary failure and poison the repository until the connection is reopened', async t => {
  const fixture = host(t), input = source(), repository = fixture.repository(), prepared = await repository.prepare(input.snapshot)
  fixture.connection.rollbackTransaction = async () => { throw Error('PRIVATE CLEANUP') }
  await assert.rejects(prepared.commit(() => { throw Error('PRIVATE SOURCE') }), error => {
    assert.match(error.message, /source verification failed/)
    assert.ok(!error.message.includes('PRIVATE'))
    return true
  })
  const commands = fixture.calls.length
  await assert.rejects(repository.read(), /close and reopen/)
  assert.equal(fixture.calls.length, commands)
  assert.equal(await fixture.reopen().read(), null)
})

test('unknown query or transaction replies fail closed before creating target data', async t => {
  for (const fault of ['query', 'transaction']) {
    const fixture = host(t)
    if (fault === 'query') fixture.connection.query = async () => ({})
    else fixture.connection.isTransactionActive = async () => ({})
    await assert.rejects(fixture.repository().prepare(source().snapshot))
    assert.deepEqual(fixture.tables(), [])
    assert.ok(!fixture.calls.some(call => ['execute', 'run'].includes(call[0])))
  }
})

test('a begin failure never attempts to roll back a transaction this repository did not open', async t => {
  const fixture = host(t)
  fixture.connection.beginTransaction = async () => { throw Error('cannot acquire lock') }
  await assert.rejects(fixture.repository().prepare(source().snapshot), /storage operation failed/)
  assert.ok(!fixture.calls.some(call => ['rollback', 'commit', 'run', 'execute'].includes(call[0])))
  assert.deepEqual(fixture.tables(), [])
})

test('an acknowledged rollback that leaves the transaction open is rejected and requires reopening', async t => {
  const fixture = host(t), input = source(), repository = fixture.repository(), prepared = await repository.prepare(input.snapshot)
  fixture.connection.rollbackTransaction = async () => {}
  await assert.rejects(prepared.rollback(), /did not roll back/)
  const commands = fixture.calls.length
  await assert.rejects(repository.read(), /close and reopen/)
  assert.equal(fixture.calls.length, commands)
  assert.equal(await fixture.reopen().read(), null)
})
