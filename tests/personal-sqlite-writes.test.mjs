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

const batch = values => values.map(([slot, raw]) => ({key: PERSONAL_STORAGE_KEYS[slot], raw}))
const merged = (snapshot, changes) => ({...snapshot, entries: snapshot.entries.map(entry => changes.find(change => change.key === entry.key) || entry)})
const mutations = fixture => fixture.calls.filter(call => ['run', 'execute'].includes(call[0])).length
async function ready(t) {
  const fixture = host(t), {repository, input} = await migrate(fixture)
  fixture.repo = repository; fixture.original = input.snapshot; fixture.calls.length = 0
  return fixture
}

test('write batches validate all keys, revisions, sizes and raw types before native access', async t => {
  const f = host(t), repo = f.repository()
  for (const changes of [null, [], [{}], [{key: 'unknown', raw: 'private'}], [{key: PERSONAL_STORAGE_KEYS[0]}],
    batch([[0, 1]]), [{key: PERSONAL_STORAGE_KEYS[0], raw: 'x', extra: true}], batch([[0, 'a'], [0, 'b']]), new Array(1),
    batch(Array.from({length: 7}, () => [0, 'x']))]) await assert.rejects(repo.writeBatch(changes, 0))
  for (const revision of [-1, 0.5, NaN, Infinity, '0', undefined, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(repo.prepareWrite(batch([[0, 'x']]), revision), /invalid expected revision/)
  await assert.rejects(repo.writeBatch(batch([[0, 'x'.repeat(33554432)]]), 0), /exceeds the supported/)
  assert.equal(f.calls.length, 0)
})

test('writes refuse an uninitialized database without creating six defaults', async t => {
  const f = host(t)
  await assert.rejects(f.repository().writeBatch(batch([[0, 'x']]), 0), /original is missing/)
  assert.equal(mutations(f), 0)
  assert.deepEqual(f.tables(), [])
})

test('all six exact values and one revision become visible to an observer atomically', async t => {
  const f = await ready(t)
  f.native.exec('PRAGMA user_version = 19; CREATE TABLE unrelated (id INTEGER); INSERT INTO unrelated VALUES (7)')
  const changes = batch([[5, ''], [4, null], [3, 'null'], [2, 'invalid\r\n\u0000\ud800x\udfff🎬'], [1, '{"future":[999999]}'], [0, ' []\r\n']])
  const expected = merged(f.original, changes), prepared = await f.repo.prepareWrite(changes, 0)
  assert.equal(prepared.baseRevision, 0); assert.equal(prepared.revision, 1); assert.equal(prepared.changedKeys.length, 6)
  const observer = new DatabaseSync(f.filename)
  try {
    assert.equal(observer.prepare(`SELECT revision FROM ${RECEIPT}`).get().revision, 0)
    assert.equal(observer.prepare(`SELECT current_sha256 FROM ${RECEIPT}`).get().current_sha256, hash(serializePersonalStorageSnapshot(f.original)))
    const state = await prepared.commit()
    assert.equal(observer.prepare(`SELECT revision FROM ${RECEIPT}`).get().revision, 1)
    assert.deepEqual(state.snapshot, expected)
    assert.equal(state.currentSha256, hash(serializePersonalStorageSnapshot(expected)))
    assert.equal(state.sourceSha256, hash(serializePersonalStorageSnapshot(f.original)))
    assert.deepEqual(await createPersonalSqliteSnapshotRepository(f.connection).read(), f.original)
    assert.equal(f.native.prepare('PRAGMA user_version').get().user_version, 19)
    assert.equal(f.native.prepare('SELECT id FROM unrelated').get().id, 7)
    assert.deepEqual(await f.reopen().read(), state)
  } finally { observer.close() }
})

test('a large updated value reopens exactly with bounded Unicode chunks and original preservation', async t => {
  const f = await ready(t), text = 'nova história 🎬 ação\r\n\u0000\ud800x\udfff'.repeat(100000)
  assert.ok(text.length > 2 * 1024 * 1024)
  const state = await f.repo.writeBatch(batch([[0, text], [1, null]]), 0)
  for (const chunk of f.native.prepare(`SELECT payload FROM ${CHUNKS}`).all()) {
    assert.ok(chunk.payload.length > 0 && chunk.payload.length <= 16384)
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(chunk.payload)), chunk.payload)
  }
  assert.deepEqual(await f.reopen().read(), state)
  assert.deepEqual(await createPersonalSqliteSnapshotRepository(f.connection).read(), f.original)
})

test('mutable batch inputs detach before the first await and returned state is immutable', async t => {
  const f = await ready(t), changes = batch([[1, 'exact before await']])
  const writing = f.repo.writeBatch(changes, 0)
  changes[0].raw = 'changed after call'; changes.push({key: 'unknown', raw: 'later'})
  const state = await writing
  assert.equal(state.snapshot.entries[1].raw, 'exact before await')
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.snapshot.entries[1]))
})

test('an identical retry performs no DML and does not increase the revision', async t => {
  const f = await ready(t), changes = batch([[1, 'new'], [2, null]])
  const first = await f.repo.writeBatch(changes, 0)
  f.calls.length = 0
  assert.deepEqual(await f.repo.writeBatch(changes, 1), first)
  assert.equal(mutations(f), 0)
})

test('only changed slots are written and stale or future revisions never overwrite newer data', async t => {
  const f = await ready(t), state = await f.repo.writeBatch(batch([[1, 'new'], [2, f.original.entries[2].raw]]), 0)
  assert.deepEqual(f.calls.filter(call => call[0] === 'run' && call[1].startsWith('DELETE')).map(call => call[2]), [[1]])
  for (const revision of [0, 2]) {
    const repo = f.reopen(), count = mutations(f)
    await assert.rejects(repo.writeBatch(batch([[1, 'must not replace']]), revision), /stale personal revision/)
    assert.equal(mutations(f), count)
    assert.deepEqual(await f.reopen().read(), state)
  }
})

test('revision overflow rejects changed values before mutation but permits an exact no-op', async t => {
  const f = await ready(t)
  f.native.prepare(`UPDATE ${RECEIPT} SET revision = ?`).run(Number.MAX_SAFE_INTEGER)
  await assert.rejects(f.repo.writeBatch(batch([[0, 'new']]), Number.MAX_SAFE_INTEGER), /overflow/)
  assert.equal(mutations(f), 0)
  const state = await f.reopen().writeBatch(batch([[0, f.original.entries[0].raw]]), Number.MAX_SAFE_INTEGER)
  assert.equal(state.revision, Number.MAX_SAFE_INTEGER)
})

test('closing a prepared write recovers old values and revision and a retry commits once', async t => {
  const f = await ready(t), changes = batch([[0, 'first'], [1, null], [5, '{broken']])
  await f.repo.prepareWrite(changes, 0)
  assert.equal(f.native.isTransaction, true)
  const repo = f.reopen(), recovered = await repo.read()
  assert.equal(recovered.revision, 0); assert.deepEqual(recovered.snapshot, f.original)
  const committed = await repo.writeBatch(changes, 0)
  assert.equal(committed.revision, 1); assert.deepEqual(committed.snapshot, merged(f.original, changes))
  assert.deepEqual(await f.reopen().read(), committed)
})

test('rollback and stale write leases cannot end or enter a later preparation', async t => {
  const f = await ready(t), first = await f.repo.prepareWrite(batch([[0, 'first']]), 0)
  await first.rollback()
  const second = await f.repo.prepareWrite(batch([[0, 'second']]), 0), count = f.calls.length
  await assert.rejects(first.commit(), /owns the connection/); await assert.rejects(first.rollback(), /owns the connection/)
  await assert.rejects(f.repo.read(), /owns the connection/); await assert.rejects(f.repo.prepare(f.original), /owns the connection/)
  await assert.rejects(f.repo.writeBatch(batch([[1, 'concurrent']]), 0), /owns the connection/)
  assert.equal(f.calls.length, count)
  assert.equal((await second.commit()).snapshot.entries[0].raw, 'second')
  await assert.rejects(second.commit(), /owns the connection/)
})

test('a delayed native read holds the operation guard against concurrent methods', async t => {
  const f = await ready(t), query = f.connection.query
  let entered, release, first = true
  const waiting = new Promise(resolve => { entered = resolve }), continued = new Promise(resolve => { release = resolve })
  f.connection.query = async (...args) => { if (first) { first = false; entered(); await continued }; return query(...args) }
  const preparing = f.repo.prepareWrite(batch([[0, 'new']]), 0)
  await waiting
  const count = f.calls.length
  await assert.rejects(f.repo.read(), /operation is in progress/)
  await assert.rejects(f.repo.prepareWrite(batch([[1, 'other']]), 0), /operation is in progress/)
  assert.equal(f.calls.length, count)
  release(); await (await preparing).rollback()
})

test('foreign transactions and other repositories cannot commit or roll back this connection owner', async t => {
  const f = await ready(t)
  f.native.exec('CREATE TABLE unrelated (id INTEGER); BEGIN; INSERT INTO unrelated VALUES (7)')
  await assert.rejects(f.repo.writeBatch(batch([[0, 'x']]), 0), /storage operation failed/)
  assert.equal(f.native.isTransaction, true); assert.equal(f.native.prepare('SELECT id FROM unrelated').get().id, 7)
  assert.ok(!f.calls.some(call => ['begin', 'commit', 'rollback'].includes(call[0])))
  f.native.exec('ROLLBACK')
  const repo = f.reopen(), prepared = await repo.prepareWrite(batch([[0, 'valid']]), 0)
  await assert.rejects(f.repository().writeBatch(batch([[1, 'intruder']]), 0))
  assert.equal(f.native.isTransaction, true)
  assert.equal((await prepared.commit()).snapshot.entries[0].raw, 'valid')
})

test('failures during later headers, chunks or receipt roll back the entire batch and hide private messages', async t => {
  for (const target of ['header', 'chunk', 'receipt']) {
    const f = await ready(t), run = f.connection.run
    f.connection.run = async (sql, values, transaction) => {
      if ((target === 'header' && sql.startsWith(`UPDATE main.${VALUES}`) && values[3] === 1) ||
          (target === 'chunk' && sql.startsWith(`INSERT INTO main.${CHUNKS}`) && values[0] === 1) ||
          (target === 'receipt' && sql.startsWith(`UPDATE main.${RECEIPT}`))) throw Error('disk full PRIVATE VALUE')
      return run(sql, values, transaction)
    }
    await assert.rejects(f.repo.writeBatch(batch([[0, 'first'], [1, 'second']]), 0), error => {
      assert.match(error.message, /storage operation failed/); assert.ok(!error.message.includes('PRIVATE VALUE')); return true
    })
    assert.equal(f.native.isTransaction, false)
    assert.deepEqual((await f.reopen().read()).snapshot, f.original)
    assert.equal(f.native.prepare(`SELECT revision FROM ${RECEIPT}`).get().revision, 0)
  }
})

test('ignored chunks and compare-and-swap receipt writes are detected before commit', async t => {
  for (const target of [CHUNKS, RECEIPT]) {
    const f = await ready(t), run = f.connection.run
    f.connection.run = async (sql, ...args) => {
      if (sql.startsWith(`INSERT INTO main.${target}`) || sql.startsWith(`UPDATE main.${target}`)) return {changes: 1}
      return run(sql, ...args)
    }
    await assert.rejects(f.repo.writeBatch(batch([[0, 'new']]), 0), /sequence is incomplete|revision update|state digest mismatch/)
    assert.equal(f.native.isTransaction, false)
    assert.deepEqual((await f.reopen().read()).snapshot, f.original)
  }
})

test('rejected COMMIT and lost acknowledgement report failure while the actual durable revision survives reopening', async t => {
  for (const durable of [false, true]) {
    const f = await ready(t), changes = batch([[0, 'committed only if durable']]), prepared = await f.repo.prepareWrite(changes, 0)
    const commit = f.connection.commitTransaction
    f.connection.commitTransaction = async () => { if (durable) await commit(); throw Error('PRIVATE commit failure') }
    await assert.rejects(prepared.commit(), /storage operation failed/)
    f.connection.commitTransaction = commit
    const count = f.calls.length
    await assert.rejects(f.repo.read(), /close and reopen/); assert.equal(f.calls.length, count)
    const recovered = await f.reopen().read()
    assert.equal(recovered.revision, durable ? 1 : 0)
    assert.deepEqual(recovered.snapshot, durable ? merged(f.original, changes) : f.original)
    assert.deepEqual(await createPersonalSqliteSnapshotRepository(f.connection).read(), f.original)
  }
})

test('COMMIT without ending the transaction is detected and rolled back', async t => {
  const f = await ready(t), prepared = await f.repo.prepareWrite(batch([[0, 'pending']]), 0), commit = f.connection.commitTransaction
  f.connection.commitTransaction = async () => {}
  await assert.rejects(prepared.commit(), /did not commit/)
  f.connection.commitTransaction = commit
  assert.equal(f.native.isTransaction, false)
  assert.deepEqual((await f.reopen().read()).snapshot, f.original)
})

test('ignored rollback and rollback failures invalidate the lease until reopening', async t => {
  for (const throws of [false, true]) {
    const f = await ready(t), prepared = await f.repo.prepareWrite(batch([[0, 'pending']]), 0), rollback = f.connection.rollbackTransaction
    f.connection.rollbackTransaction = async () => { if (throws) throw Error('PRIVATE rollback') }
    await assert.rejects(prepared.rollback(), error => !error.message.includes('PRIVATE'))
    const count = f.calls.length
    await assert.rejects(f.repo.read(), /close and reopen/); assert.equal(f.calls.length, count)
    f.connection.rollbackTransaction = rollback
    assert.deepEqual((await f.reopen().read()).snapshot, f.original)
  }
})

test('begin failures and unknown native replies never mutate data or end a foreign transaction', async t => {
  for (const broken of ['begin', 'status', 'query']) {
    const f = await ready(t), begin = f.connection.beginTransaction, active = f.connection.isTransactionActive, query = f.connection.query
    if (broken === 'begin') f.connection.beginTransaction = async () => { throw Error('begin rejected') }
    if (broken === 'status') f.connection.isTransactionActive = async () => ({})
    if (broken === 'query') f.connection.query = async () => ({})
    await assert.rejects(f.repo.writeBatch(batch([[0, 'must not persist']]), 0))
    assert.equal(mutations(f), 0)
    if (broken !== 'query') assert.ok(!f.calls.some(call => call[0] === 'rollback'))
    f.connection.beginTransaction = begin; f.connection.isTransactionActive = active; f.connection.query = query
    assert.deepEqual((await f.reopen().read()).snapshot, f.original)
  }
})

test('corrupted values, markers, schemas or originals refuse writes without repair or fallback', async t => {
  for (const sql of [`DELETE FROM ${VALUES} WHERE slot = 0`, `DELETE FROM ${RECEIPT}`,
    `UPDATE ${CHUNKS} SET payload = 'corrupt' WHERE slot = 1`,
    `UPDATE ${RECEIPT} SET source_sha256 = '${'0'.repeat(64)}', revision = 1`,
    `CREATE TRIGGER unexpected AFTER UPDATE ON ${VALUES} BEGIN DELETE FROM ${VALUES}; END`,
    'DELETE FROM cv_personal_raw_snapshot_chunk WHERE ordinal = 0']) {
    const f = await ready(t)
    f.native.exec(sql)
    await assert.rejects(f.repo.writeBatch(batch([[0, 'new']]), 0))
    assert.equal(mutations(f), 0)
  }
})

test('altered prepared target values cannot be committed successfully', async t => {
  const f = await ready(t), prepared = await f.repo.prepareWrite(batch([[0, 'valid']]), 0)
  f.native.prepare(`UPDATE ${CHUNKS} SET payload = ? WHERE slot = 0`).run('wrong')
  await assert.rejects(prepared.commit(), /integrity mismatch/)
  assert.equal(f.native.isTransaction, false)
  assert.deepEqual((await f.reopen().read()).snapshot, f.original)
})
