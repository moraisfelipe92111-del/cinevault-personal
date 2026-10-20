// CI-only probe. It never opens the application's personal storage or database.
export const AUDIT_CHECKS = Object.freeze([
  'parameterized_unicode_crud', 'explicit_commit', 'explicit_rollback',
  'failed_batch_atomicity', 'migration_v1_v2', 'connection_reopen',
])
const TEXT = "Sessão de cinema 🎬 — ação, emoção e d'água\n'); DROP TABLE audit_entries; --"
const UPDATED = TEXT + '\nAtualizado sem alterar os caracteres.'

function requireValue(condition, message) {
  if (!condition) throw Error('SQLite audit: ' + message)
}

export function auditIdentity({ runId, attempt, platform }) {
  requireValue(typeof runId === 'string' && typeof attempt === 'string' &&
    /^[1-9]\d{0,19}$/.test(runId) && /^[1-9]\d{0,5}$/.test(attempt), 'invalid CI identity')
  requireValue(platform === 'android' || platform === 'ios', 'native platform required')
  return 'cv2_sqlite_audit_' + runId + '_' + attempt + '_' + platform
}

export function validateAuditReport(report, context, status) {
  const database = auditIdentity(context)
  requireValue(status === 'passed' || status === 'ready_for_restart', 'invalid expected state')
  const checks = status === 'passed' ? [...AUDIT_CHECKS, 'process_restart'] : [...AUDIT_CHECKS]
  requireValue(report?.schemaVersion === 1 && report.status === status, 'unexpected report state')
  requireValue(report.runId === context.runId && report.attempt === context.attempt &&
    report.platform === context.platform && report.database === database, 'report identity mismatch')
  requireValue(report.databaseVersion === 2 && JSON.stringify(report.checks) === JSON.stringify(checks), 'incomplete checks')
  return report
}

async function verifyData(db) {
  const rows = (await db.query('SELECT id, value FROM audit_entries ORDER BY id')).values
  requireValue(rows?.length === 2 && rows[0].id === 1 && rows[0].value === UPDATED &&
    rows[1].id === 3 && rows[1].value === 'committed', 'records changed or a rolled-back write survived')
  requireValue((await db.getVersion()).version === 2, 'schema version mismatch')
  const migration = (await db.query('SELECT id FROM audit_schema')).values
  requireValue(migration?.length === 1 && migration[0].id === 2, 'migration missing or repeated')
}

export async function runNativeSqliteAudit({ sqlite, previous = null, ...context }) {
  const database = auditIdentity(context)
  if (previous !== null) validateAuditReport(previous, context, 'ready_for_restart')
  let connected = false
  const open = async version => {
    const db = await sqlite.createConnection(database, false, 'no-encryption', version, false)
    connected = true
    await db.open()
    return db
  }
  const close = async () => {
    await sqlite.closeConnection(database, false)
    connected = false
  }
  try {
    if (previous === null) {
      let db = await open(1)
      // No IF NOT EXISTS: an unexpected reused database must fail this fresh-run test.
      await db.execute('CREATE TABLE audit_entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL);')
      await db.run('INSERT INTO audit_entries (id, value) VALUES (?, ?)', [1, TEXT])
      requireValue((await db.query('SELECT value FROM audit_entries WHERE id = ?', [1])).values?.[0]?.value === TEXT, 'Unicode or parameter binding failed')
      await db.run('UPDATE audit_entries SET value = ? WHERE id = ?', [UPDATED, 1])
      await db.executeSet([
        {statement: 'INSERT INTO audit_entries (id, value) VALUES (?, ?)', values: [2, 'temporary']},
        {statement: 'UPDATE audit_entries SET value = ? WHERE id = ?', values: ['updated batch', 2]},
      ])
      requireValue((await db.query('SELECT value FROM audit_entries WHERE id = ?', [2])).values?.[0]?.value === 'updated batch', 'successful batch failed')
      await db.run('DELETE FROM audit_entries WHERE id = ?', [2])

      await db.beginTransaction()
      await db.run('INSERT INTO audit_entries (id, value) VALUES (?, ?)', [3, 'committed'], false)
      await db.commitTransaction()
      await db.beginTransaction()
      await db.run('INSERT INTO audit_entries (id, value) VALUES (?, ?)', [4, 'must roll back'], false)
      await db.rollbackTransaction()
      requireValue((await db.query('SELECT id FROM audit_entries WHERE id = ?', [4])).values?.length === 0, 'explicit rollback failed')

      let constraintRejected = false
      try {
        await db.executeSet([
          {statement: 'INSERT INTO audit_entries (id, value) VALUES (?, ?)', values: [5, 'must roll back with failed batch']},
          {statement: 'INSERT INTO audit_entries (id, value) VALUES (?, ?)', values: [1, 'duplicate primary key']},
        ])
      } catch (error) {
        constraintRejected = /constraint|unique|primary.?key/i.test(String(error?.message ?? error))
      }
      requireValue(constraintRejected, 'batch did not report the expected constraint failure')
      requireValue((await db.query('SELECT id FROM audit_entries WHERE id = ?', [5])).values?.length === 0, 'failed batch left a partial write')
      await close()

      await sqlite.addUpgradeStatement(database, [{toVersion: 2, statements: [
        'CREATE TABLE audit_schema (id INTEGER PRIMARY KEY);',
        'INSERT INTO audit_schema (id) VALUES (2);',
      ]}])
      db = await open(2)
      await verifyData(db)
      await close()
      db = await open(2)
      await verifyData(db)
      await close()
    } else {
      const db = await open(2)
      await verifyData(db)
      await close()
    }
    return {
      schemaVersion: 1, runId: context.runId, attempt: context.attempt,
      platform: context.platform, database, databaseVersion: 2,
      status: previous === null ? 'ready_for_restart' : 'passed',
      checks: previous === null ? [...AUDIT_CHECKS] : [...AUDIT_CHECKS, 'process_restart'],
    }
  } finally {
    if (connected) await close()
  }
}
