import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { AUDIT_CHECKS, auditIdentity, runNativeSqliteAudit, validateAuditReport } from '../scripts/native-sqlite-audit.mjs'
import { injectNativeAudit } from '../scripts/build-native-sqlite-audit.mjs'
import { createPersonalSqliteSnapshotRepository } from '../src/personalSqliteSnapshot.ts'
import { createPersonalSqliteMigrationRepository } from '../src/personalSqliteMigration.ts'

// Host SQLite checks the probe and its SQL; this is not evidence of native execution.
const context = {runId: '123456789', attempt: '1', platform: 'android'}

class HostSQLite {
  constructor(root, broken = '') { this.root = root; this.broken = broken; this.upgrades = new Map(); this.connections = new Map() }
  async createConnection(name, encrypted, mode, version, readonly) {
    assert.match(name, /^cv2_sqlite_audit_\d+_\d+_(android|ios)$/)
    assert.equal(encrypted, false); assert.equal(mode, 'no-encryption'); assert.equal(readonly, false)
    const owner = this
    const connection = {
      async open() {
        this.db = new DatabaseSync(path.join(owner.root, name + '.sqlite'))
        const previous = this.db.prepare('PRAGMA user_version').get().user_version
        if (!previous) this.db.exec('PRAGMA user_version = ' + version)
        else if (previous < version) {
          this.db.exec('BEGIN')
          try {
            for (const upgrade of owner.upgrades.get(name) || []) {
              if (upgrade.toVersion > previous && upgrade.toVersion <= version)
                for (const statement of upgrade.statements) this.db.exec(statement)
            }
            this.db.exec('PRAGMA user_version = ' + version)
            this.db.exec('COMMIT')
          } catch (error) { this.db.exec('ROLLBACK'); throw error }
        }
      },
      async execute(sql) {
        // Android 8.1.1 splits batches at ;\n, then execSQL prepares one statement.
        // Preparing one statement reproduces the same-line batch failure seen in CI.
        if (owner.broken === 'single-statement-execute') this.db.prepare(sql).run()
        else this.db.exec(sql)
      },
      async run(sql, values = []) {
        if (owner.broken === 'missing-recovery-marker' && /^INSERT INTO audit_recovery_schema\b/.test(sql)) return
        if (owner.broken === 'missing-personal-write-receipt' && sql.startsWith('UPDATE main.cv_personal_migration ')) return
        this.db.prepare(sql).run(...values)
      },
      async query(sql, values = []) {
        // Deliberately change property order; comparison must use values, not JSON key order.
        return {values: this.db.prepare(sql).all(...values).map(row => Object.fromEntries(Object.entries(row).reverse()))}
      },
      async beginTransaction() { this.db.exec('BEGIN') },
      async commitTransaction() { this.db.exec('COMMIT') },
      async rollbackTransaction() { this.db.exec(owner.broken === 'rollback' ? 'COMMIT' : 'ROLLBACK') },
      async isTransactionActive() { return {result: this.db.isTransaction} },
      async executeSet(items) {
        const atomic = owner.broken !== 'batch'
        if (atomic) this.db.exec('BEGIN')
        try {
          for (const item of items) this.db.prepare(item.statement).run(...item.values)
          if (atomic) this.db.exec('COMMIT')
        } catch (error) { if (atomic) this.db.exec('ROLLBACK'); throw error }
      },
      async getVersion() { return {version: this.db.prepare('PRAGMA user_version').get().user_version} },
    }
    this.connections.set(name, connection)
    return connection
  }
  async closeConnection(name) {
    this.connections.get(name).db?.close()
    this.connections.delete(name)
  }
  async addUpgradeStatement(name, statements) { this.upgrades.set(name, statements) }
}

function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-sqlite-audit-test-'))
  t.after(() => {
    // Only files created inside this test's new temporary directory are removed.
    for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file))
    fs.rmdirSync(root)
  })
  return root
}

async function finishWritePhases(root, previous, mode = '') {
  validateAuditReport(previous, context, 'ready_for_write_restart')
  const manager = new HostSQLite(root, mode)
  const pending = await runNativeSqliteAudit({sqlite: manager, previous, ...context})
  validateAuditReport(pending, context, 'ready_for_write_interruption')
  assert.equal(manager.connections.get(pending.database).db.isTransaction, true)
  await manager.closeConnection(pending.database)
  const result = await runNativeSqliteAudit({sqlite: new HostSQLite(root, mode), previous: pending, ...context})
  validateAuditReport(result, context, 'passed')
  return result
}

async function committedWriteFixture(t) {
  const root = rootFor(t), first = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const manager = new HostSQLite(root), pending = await runNativeSqliteAudit({sqlite: manager, previous: first, ...context})
  await manager.closeConnection(pending.database)
  const previous = await runNativeSqliteAudit({sqlite: new HostSQLite(root), previous: pending, ...context})
  validateAuditReport(previous, context, 'ready_for_write_restart')
  return {root, previous}
}

test('audit accepts only bounded CI identities and native platforms', () => {
  assert.equal(auditIdentity(context), 'cv2_sqlite_audit_123456789_1_android')
  for (const changed of [{runId: '../personal'}, {attempt: '0'}, {platform: 'web'}, {runId: 123}, {attempt: '1234567'}])
    assert.throws(() => auditIdentity({...context, ...changed}))
})

test('host SQLite: CRUD, Unicode, commits, rollbacks and upgrade preserve exact values', async t => {
  const report = await runNativeSqliteAudit({sqlite: new HostSQLite(rootFor(t)), ...context})
  assert.equal(report.status, 'ready_for_restart')
  assert.deepEqual(report.checks, AUDIT_CHECKS)
  validateAuditReport(report, context, 'ready_for_restart')
})

test('host SQLite: a fresh connection manager reopens the same persisted database', async t => {
  const root = rootFor(t)
  const previous = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const reopened = new HostSQLite(root)
  const result = await runNativeSqliteAudit({sqlite: reopened, previous, ...context})
  try {
    assert.equal(result.status, 'ready_for_interruption')
    validateAuditReport(result, context, 'ready_for_interruption')
    assert.equal(reopened.connections.size, 1)
    assert.equal(reopened.connections.get(result.database).db.isTransaction, true)
  } finally { await reopened.closeConnection(result.database) }
})

test('host SQLite: interrupted schema and record writes roll back, then migration retry commits', async t => {
  const root = rootFor(t)
  const first = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const manager = new HostSQLite(root)
  const pending = await runNativeSqliteAudit({sqlite: manager, previous: first, ...context})
  // Host-side close rolls back the open transaction. Native CI uses process kill.
  await manager.closeConnection(pending.database)
  const written = await runNativeSqliteAudit({sqlite: new HostSQLite(root), previous: pending, ...context})
  const result = await finishWritePhases(root, written)
  assert.equal(result.databaseVersion, 3)
  assert.ok(result.checks.includes('interrupted_migration_rollback'))
  assert.ok(result.checks.includes('migration_retry_committed'))
  assert.ok(result.checks.includes('personal_write_interruption_rollback'))
  assert.equal(result.personalRevision, 2)
  assert.equal(result.committedPersonalRevision, 2)
  assert.equal(result.checks.length, 22)
})

test('host SQLite: recovery succeeds when native execute accepts one statement per call', async t => {
  const root = rootFor(t)
  const mode = 'single-statement-execute'
  const first = await runNativeSqliteAudit({sqlite: new HostSQLite(root, mode), ...context})
  const manager = new HostSQLite(root, mode)
  const pending = await runNativeSqliteAudit({sqlite: manager, previous: first, ...context})
  await manager.closeConnection(pending.database)
  const written = await runNativeSqliteAudit({sqlite: new HostSQLite(root, mode), previous: pending, ...context})
  const result = await finishWritePhases(root, written, mode)
  const db = new DatabaseSync(path.join(root, result.database + '.sqlite'))
  try {
    assert.deepEqual(db.prepare('SELECT id, state FROM audit_recovery_schema').all().map(row => ({...row})),
      [{id: 3, state: 'completed'}])
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3)
  } finally { db.close() }
})

test('audit refuses interruption when the uncommitted migration marker was not written', async t => {
  const root = rootFor(t)
  const first = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const manager = new HostSQLite(root, 'missing-recovery-marker')
  try {
    await assert.rejects(runNativeSqliteAudit({sqlite: manager, previous: first, ...context}), /recovery migration marker mismatch/)
    assert.equal(manager.connections.size, 0)
    const db = new DatabaseSync(path.join(root, first.database + '.sqlite'))
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'audit_recovery_schema'").all().length, 0)
      assert.notEqual(db.prepare('SELECT value FROM audit_entries WHERE id = 1').get().value,
        'Uncommitted change that must disappear after process interruption')
    } finally { db.close() }
  } finally {
    for (const name of [...manager.connections.keys()]) await manager.closeConnection(name)
  }
})

test('audit refuses an interrupted migration that actually committed the changed records', async t => {
  const root = rootFor(t)
  const first = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const manager = new HostSQLite(root)
  const pending = await runNativeSqliteAudit({sqlite: manager, previous: first, ...context})
  await manager.connections.get(pending.database).commitTransaction()
  await manager.closeConnection(pending.database)
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(root), previous: pending, ...context}), /records changed|schema version mismatch/)
})

test('audit detects a schema object that survived the interrupted migration', async t => {
  const root = rootFor(t)
  const first = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const manager = new HostSQLite(root)
  const pending = await runNativeSqliteAudit({sqlite: manager, previous: first, ...context})
  await manager.closeConnection(pending.database)
  const db = new DatabaseSync(path.join(root, pending.database + '.sqlite'))
  db.exec('CREATE TABLE audit_recovery_schema (id INTEGER PRIMARY KEY, state TEXT NOT NULL)')
  db.close()
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(root), previous: pending, ...context}), /interrupted schema change survived/)
})

test('audit detects a rollback implementation that commits instead', async t => {
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(rootFor(t), 'rollback'), ...context}), /explicit rollback failed/)
})

test('audit detects partial writes when the failing batch is not atomic', async t => {
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(rootFor(t), 'batch'), ...context}), /partial write/)
})

test('audit detects records changed between launches', async t => {
  const root = rootFor(t)
  const previous = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const db = new DatabaseSync(path.join(root, previous.database + '.sqlite'))
  db.prepare('UPDATE audit_entries SET value = ? WHERE id = ?').run('corrupted', 1)
  db.close()
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(root), previous, ...context}), /records changed/)
})

test('audit detects a changed raw copy after restarting instead of replacing the preserved source', async t => {
  const root = rootFor(t)
  const previous = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const db = new DatabaseSync(path.join(root, previous.database + '.sqlite'))
  db.prepare('UPDATE cv_personal_raw_snapshot_chunk SET payload = ? WHERE ordinal = ?').run('corrupted', 0)
  db.close()
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(root), previous, ...context}), /snapshot/)
})

test('audit checks the original raw copy after an interrupted transaction and cannot accept a surviving chunk mutation', async t => {
  const root = rootFor(t)
  const previous = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const manager = new HostSQLite(root)
  const pending = await runNativeSqliteAudit({sqlite: manager, previous, ...context})
  await manager.closeConnection(pending.database)
  const db = new DatabaseSync(path.join(root, pending.database + '.sqlite'))
  db.prepare('UPDATE cv_personal_raw_snapshot_chunk SET payload = ? WHERE ordinal = ?').run('survived interruption', 0)
  db.close()
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(root), previous: pending, ...context}), /snapshot/)
})

test('audit refuses a personal completion marker that incorrectly survived the interruption', async t => {
  const root = rootFor(t), first = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const manager = new HostSQLite(root), pending = await runNativeSqliteAudit({sqlite: manager, previous: first, ...context})
  await manager.closeConnection(pending.database)
  const writer = new HostSQLite(root), db = await writer.createConnection(pending.database, false, 'no-encryption', 2, false)
  await db.open()
  const original = await createPersonalSqliteSnapshotRepository(db).read()
  await (await createPersonalSqliteMigrationRepository(db).prepare(original)).commit(() => {})
  await writer.closeConnection(pending.database)
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(root), previous: pending, ...context}), /interrupted personal migration survived/)
})

test('audit refuses a partial personal schema after interruption instead of repairing or silently skipping it', async t => {
  const root = rootFor(t), first = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  const manager = new HostSQLite(root), pending = await runNativeSqliteAudit({sqlite: manager, previous: first, ...context})
  await manager.closeConnection(pending.database)
  const db = new DatabaseSync(path.join(root, pending.database + '.sqlite'))
  db.exec('CREATE VIEW cv_personal_migration AS SELECT 1 AS id')
  db.close()
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(root), previous: pending, ...context}), /unexpected migration schema/)
})

test('audit refuses an allegedly interrupted personal write that actually committed', async t => {
  const {root, previous} = await committedWriteFixture(t), manager = new HostSQLite(root)
  const pending = await runNativeSqliteAudit({sqlite: manager, previous, ...context})
  validateAuditReport(pending, context, 'ready_for_write_interruption')
  await manager.connections.get(pending.database).commitTransaction()
  await manager.closeConnection(pending.database)
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(root), previous: pending, ...context}), /personal write revision or exact values changed/)
})

test('audit refuses partial personal values that survived the write interruption instead of repairing them', async t => {
  const {root, previous} = await committedWriteFixture(t), manager = new HostSQLite(root)
  const pending = await runNativeSqliteAudit({sqlite: manager, previous, ...context})
  await manager.closeConnection(pending.database)
  const db = new DatabaseSync(path.join(root, pending.database + '.sqlite'))
  db.prepare('UPDATE cv_personal_value_chunk SET payload = ? WHERE slot = ? AND ordinal = ?').run('null', 1, 0)
  db.close()
  await assert.rejects(runNativeSqliteAudit({sqlite: new HostSQLite(root), previous: pending, ...context}), /integrity mismatch/)
})

test('audit cannot authorize a write interruption without its prepared revision receipt', async t => {
  const {root, previous} = await committedWriteFixture(t), manager = new HostSQLite(root, 'missing-personal-write-receipt')
  await assert.rejects(runNativeSqliteAudit({sqlite: manager, previous, ...context}), /state digest mismatch|revision update/)
  assert.equal(manager.connections.size, 0)
  const reader = new HostSQLite(root), db = await reader.createConnection(previous.database, false, 'no-encryption', 3, false)
  await db.open()
  try { assert.equal((await createPersonalSqliteMigrationRepository(db).read()).revision, 1) }
  finally { await reader.closeConnection(previous.database) }
})

test('write reports require the exact prepared and committed revisions and all earlier migration checks', async t => {
  const {root, previous} = await committedWriteFixture(t)
  for (const change of [{schemaVersion: 4}, {personalRevision: 0}, {committedPersonalRevision: 0}, {transactionOpen: true},
    {checks: previous.checks.filter(check => check !== 'personal_write_stale_revision_rejected')}])
    assert.throws(() => validateAuditReport({...previous, ...change}, context, previous.status))
  const manager = new HostSQLite(root), pending = await runNativeSqliteAudit({sqlite: manager, previous, ...context})
  try {
    for (const change of [{personalRevision: 1}, {committedPersonalRevision: 2}, {transactionOpen: false},
      {checks: pending.checks.filter(check => check !== 'uncommitted_personal_write_prepared')}])
      assert.throws(() => validateAuditReport({...pending, ...change}, context, pending.status))
  } finally { await manager.closeConnection(pending.database) }
})

test('audit rejects stale identity and incomplete markers before opening any database', async t => {
  const previous = await runNativeSqliteAudit({sqlite: new HostSQLite(rootFor(t)), ...context})
  const sqlite = { createConnection() { throw Error('database must not be opened') } }
  for (const changed of [{runId: '999'}, {database: 'personal'}, {checks: []}, {databaseVersion: 1}, {status: 'passed'}, {schemaVersion: 1}, {schemaVersion: 2}, {schemaVersion: 3}, {schemaVersion: 4}, {personalRevision: 0}])
    await assert.rejects(runNativeSqliteAudit({sqlite, previous: {...previous, ...changed}, ...context}), /SQLite audit:/)
})

test('audit refuses to initialize over an unexpected existing audit database', async t => {
  const sqlite = new HostSQLite(rootFor(t))
  await runNativeSqliteAudit({sqlite, ...context})
  await assert.rejects(runNativeSqliteAudit({sqlite, ...context}), /already exists/)
})

test('a success report requires every check and process restart evidence', async t => {
  const root = rootFor(t)
  const previous = await runNativeSqliteAudit({sqlite: new HostSQLite(root), ...context})
  assert.throws(() => validateAuditReport({...previous, status: 'passed'}, context, 'passed'), /incomplete checks/)
  previous.checks.pop()
  assert.throws(() => validateAuditReport(previous, context, 'ready_for_restart'), /incomplete checks/)
})

test('generated HTML retains the real CineVault entry and allows only one probe injection', () => {
  const html = '<html><head><script type="module" src="/assets/cinevault.js"></script></head><body>CineVault</body></html>'
  const prepared = injectNativeAudit(html)
  assert.ok(prepared.includes('src="/assets/cinevault.js"'))
  assert.ok(prepared.includes('<body>CineVault</body>'))
  assert.throws(() => injectNativeAudit(prepared), /already injected/)
  assert.throws(() => injectNativeAudit('<body>no head</body>'), /Unexpected HTML/)
})

test('audit bundle preparation refuses to run outside CI before loading Vite or writing files', () => {
  const result = spawnSync(process.execPath, ['scripts/build-native-sqlite-audit.mjs'], {
    encoding: 'utf8', env: {...process.env, GITHUB_ACTIONS: 'false'},
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /restricted to GitHub Actions/)
})

test('a cleanup failure cannot hide the original native database error', async t => {
  const log = t.mock.method(console, 'error', () => {})
  const sqlite = {
    async createConnection() { return {async open() { throw Error('native open failed') }} },
    async closeConnection() { throw Error('cleanup failed') },
  }
  await assert.rejects(runNativeSqliteAudit({sqlite, ...context}), /native open failed/)
  assert.equal(log.mock.callCount(), 1)
})
