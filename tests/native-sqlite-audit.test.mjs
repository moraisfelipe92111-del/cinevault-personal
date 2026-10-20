import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { AUDIT_CHECKS, auditIdentity, runNativeSqliteAudit, validateAuditReport } from '../scripts/native-sqlite-audit.mjs'
import { injectNativeAudit } from '../scripts/build-native-sqlite-audit.mjs'

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
      async execute(sql) { this.db.exec(sql) },
      async run(sql, values = []) { this.db.prepare(sql).run(...values) },
      async query(sql, values = []) {
        // Deliberately change property order; comparison must use values, not JSON key order.
        return {values: this.db.prepare(sql).all(...values).map(row => Object.fromEntries(Object.entries(row).reverse()))}
      },
      async beginTransaction() { this.db.exec('BEGIN') },
      async commitTransaction() { this.db.exec('COMMIT') },
      async rollbackTransaction() { this.db.exec(owner.broken === 'rollback' ? 'COMMIT' : 'ROLLBACK') },
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
  const result = await runNativeSqliteAudit({sqlite: new HostSQLite(root), previous, ...context})
  assert.equal(result.status, 'passed')
  validateAuditReport(result, context, 'passed')
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

test('audit rejects stale identity and incomplete markers before opening any database', async t => {
  const previous = await runNativeSqliteAudit({sqlite: new HostSQLite(rootFor(t)), ...context})
  const sqlite = { createConnection() { throw Error('database must not be opened') } }
  for (const changed of [{runId: '999'}, {database: 'personal'}, {checks: []}, {databaseVersion: 1}, {status: 'passed'}])
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
