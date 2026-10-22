// CI-only probe. It never opens the application's personal storage or database.
import { createPersonalSqliteSnapshotRepository } from '../src/personalSqliteSnapshot.ts'
import { PERSONAL_STORAGE_KEYS, serializePersonalStorageSnapshot } from '../src/personalStorageSnapshot.ts'
import { createPersonalStorageCoordinator } from '../src/personalStorage.ts'
import { createPersonalSqliteMigrationRepository } from '../src/personalSqliteMigration.ts'

export const AUDIT_CHECKS = Object.freeze([
  'parameterized_unicode_crud', 'explicit_commit', 'explicit_rollback',
  'failed_batch_atomicity', 'migration_v1_v2', 'connection_reopen', 'raw_snapshot_exact_round_trip',
])
const TEXT = "Sessão de cinema 🎬 — ação, emoção e d'água\n'); DROP TABLE audit_entries; --"
const UPDATED = TEXT + '\nAtualizado sem alterar os caracteres.'
const PENDING = 'Uncommitted change that must disappear after process interruption'
const RECOVERY_SCHEMA = 'CREATE TABLE audit_recovery_schema (id INTEGER PRIMARY KEY, state TEXT NOT NULL);'

const PHASES = {
  ready_for_restart: { databaseVersion: 2, committedVersion: 2, transactionOpen: false, checks: [...AUDIT_CHECKS] },
  ready_for_interruption: { databaseVersion: 3, committedVersion: 2, transactionOpen: true,
    checks: [...AUDIT_CHECKS, 'process_restart', 'raw_snapshot_process_restart',
      'uncommitted_migration_prepared', 'uncommitted_raw_snapshot_modified', 'uncommitted_personal_migration_prepared'] },
  passed: { databaseVersion: 3, committedVersion: 3, transactionOpen: false,
    checks: [...AUDIT_CHECKS, 'process_restart', 'raw_snapshot_process_restart',
      'interrupted_migration_rollback', 'migration_retry_committed', 'raw_snapshot_interruption_recovery',
      'personal_migration_interruption_rollback', 'personal_migration_atomic_commit', 'personal_migration_connection_reopen'] },
}

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
  requireValue(Object.hasOwn(PHASES, status), 'invalid expected state')
  const expected = PHASES[status]
  requireValue(report?.schemaVersion === 4 && report.status === status, 'unexpected report state')
  requireValue(report.runId === context.runId && report.attempt === context.attempt &&
    report.platform === context.platform && report.database === database, 'report identity mismatch')
  requireValue(report.databaseVersion === expected.databaseVersion &&
    report.committedVersion === expected.committedVersion && report.transactionOpen === expected.transactionOpen &&
    JSON.stringify(report.checks) === JSON.stringify(expected.checks), 'incomplete checks')
  return report
}

function makeReport(context, status) {
  return {schemaVersion: 4, runId: context.runId, attempt: context.attempt,
    platform: context.platform, database: auditIdentity(context), status, ...PHASES[status], checks: [...PHASES[status].checks]}
}

async function verifyData(db, version = 2) {
  const rows = (await db.query('SELECT id, value FROM audit_entries ORDER BY id')).values
  requireValue(rows?.length === 2 && rows[0].id === 1 && rows[0].value === UPDATED &&
    rows[1].id === 3 && rows[1].value === 'committed', 'records changed or a rolled-back write survived')
  requireValue((await db.getVersion()).version === version, 'schema version mismatch')
  const migration = (await db.query('SELECT id FROM audit_schema')).values
  requireValue(migration?.length === 1 && migration[0].id === 2, 'migration missing or repeated')
}

async function prepareRecoveryMigration(db) {
  // Keep each native call to one statement inside the already-open transaction.
  await db.execute(RECOVERY_SCHEMA, false)
  await db.run('INSERT INTO audit_recovery_schema (id, state) VALUES (?, ?)', [3, 'completed'], false)
  await db.execute('PRAGMA user_version = 3;', false)
}

async function verifyRecoveryMarker(db) {
  const rows = (await db.query('SELECT id, state FROM audit_recovery_schema')).values
  requireValue(rows?.length === 1 && rows[0].id === 3 && rows[0].state === 'completed', 'recovery migration marker mismatch')
}

async function verifyRecovery(db) {
  await verifyData(db, 3)
  await verifyRecoveryMarker(db)
}

function syntheticSource() {
  // This is generated test data, never values read from the application's store.
  const values = [
    JSON.stringify({favorites: [1, 999999, 1], future: {keep: true, text: 'cinema 🎬 ação\r\n'.repeat(150000)}}),
    "[broken JSON\r\n\u0000\ud800x\udfff\n'); DROP TABLE personal_data; --",
    null, '', 'null',
    '  {"intro":false,"sound":true,"volume":0,"sonic":"future-mode","future":{}}\r\n',
  ]
  const data = new Map(PERSONAL_STORAGE_KEYS.map((key, index) => [key, values[index]]))
  const coordinator = createPersonalStorageCoordinator(() => ({
    getItem(key) { return data.get(key) ?? null },
    setItem(key, raw) { data.set(key, raw) },
    removeItem(key) { data.delete(key) },
  }))
  const pause = coordinator.pauseWrites()
  return {pause, snapshot: pause.captureSnapshot()}
}

async function verifyRawSnapshot(db, expected) {
  const snapshot = await createPersonalSqliteSnapshotRepository(db).read()
  requireValue(snapshot !== null && serializePersonalStorageSnapshot(snapshot) === serializePersonalStorageSnapshot(expected),
    'raw snapshot changed or was not durably preserved')
}

function verifyPersonalMigration(state, expected) {
  requireValue(state?.schemaVersion === 1 && state.revision === 0 && state.sourceSha256 === state.currentSha256 &&
    serializePersonalStorageSnapshot(state.snapshot) === serializePersonalStorageSnapshot(expected),
    'personal migration marker or exact values changed')
}

export async function runNativeSqliteAudit({ sqlite, previous = null, ...context }) {
  const database = auditIdentity(context)
  if (previous !== null) {
    requireValue(previous.status === 'ready_for_restart' || previous.status === 'ready_for_interruption', 'cannot resume this state')
    validateAuditReport(previous, context, previous.status)
  }
  const source = syntheticSource(), rawSnapshot = source.snapshot
  requireValue(serializePersonalStorageSnapshot(rawSnapshot).length > 2 * 1024 * 1024, 'large snapshot fixture is incomplete')
  let connected = false
  let awaitingInterruption = false
  let primaryError = null
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
      requireValue(await createPersonalSqliteSnapshotRepository(db).preserve(rawSnapshot) === 'preserved', 'raw snapshot was not freshly preserved')
      await verifyRawSnapshot(db, rawSnapshot)
      await close()

      await sqlite.addUpgradeStatement(database, [{toVersion: 2, statements: [
        'CREATE TABLE audit_schema (id INTEGER PRIMARY KEY);',
        'INSERT INTO audit_schema (id) VALUES (2);',
      ]}])
      db = await open(2)
      await verifyData(db)
      await verifyRawSnapshot(db, rawSnapshot)
      await close()
      db = await open(2)
      await verifyData(db)
      await verifyRawSnapshot(db, rawSnapshot)
      await close()
      return makeReport(context, 'ready_for_restart')
    } else if (previous.status === 'ready_for_restart') {
      const db = await open(2)
      await verifyData(db)
      await verifyRawSnapshot(db, rawSnapshot)
      const pendingMigration = await createPersonalSqliteMigrationRepository(db).prepare(rawSnapshot)
      requireValue(pendingMigration.schemaVersion === 1 && pendingMigration.entryCount === 6, 'personal migration preparation is incomplete')
      await db.run('UPDATE audit_entries SET value = ? WHERE id = ?', [PENDING, 1], false)
      await prepareRecoveryMigration(db)
      await db.run('UPDATE main.cv_personal_raw_snapshot_chunk SET payload = ? WHERE ordinal = ?', [PENDING, 0], false)
      requireValue((await db.isTransactionActive()).result === true, 'interruption requires an open transaction')
      requireValue((await db.getVersion()).version === 3, 'pending schema version not applied')
      requireValue((await db.query('SELECT value FROM audit_entries WHERE id = ?', [1])).values?.[0]?.value === PENDING, 'pending write not applied')
      await verifyRecoveryMarker(db)
      requireValue((await db.query('SELECT payload FROM main.cv_personal_raw_snapshot_chunk WHERE ordinal = ?', [0])).values?.[0]?.payload === PENDING,
        'pending raw snapshot write not applied')
      const personalMarker = (await db.query('SELECT schema_version, state, entry_count FROM main.cv_personal_migration WHERE id = ?', [1])).values
      requireValue(personalMarker?.length === 1 && personalMarker[0].schema_version === 1 && personalMarker[0].state === 'complete' &&
        personalMarker[0].entry_count === 6, 'pending personal migration marker is incomplete')
      // Deliberately leave the native connection open. The CI controller kills
      // this fresh audit application's process before the next launch.
      awaitingInterruption = true
      return makeReport(context, 'ready_for_interruption')
    } else {
      let db = await open(2)
      await verifyData(db)
      await verifyRawSnapshot(db, rawSnapshot)
      const tables = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", ['audit_recovery_schema'])).values
      requireValue(tables?.length === 0, 'interrupted schema change survived')
      const personal = createPersonalSqliteMigrationRepository(db)
      requireValue(await personal.read() === null, 'interrupted personal migration survived')
      const prepared = await personal.prepare(rawSnapshot)
      await prepareRecoveryMigration(db)
      verifyPersonalMigration(await prepared.commit(() => source.pause.assertUnchanged(rawSnapshot)), rawSnapshot)
      await verifyRecovery(db)
      await verifyRawSnapshot(db, rawSnapshot)
      await close()
      db = await open(3)
      await verifyRecovery(db)
      await verifyRawSnapshot(db, rawSnapshot)
      verifyPersonalMigration(await createPersonalSqliteMigrationRepository(db).read(), rawSnapshot)
      await close()
      return makeReport(context, 'passed')
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (connected && !awaitingInterruption) {
      try { await close() } catch (error) {
        if (primaryError) console.error('SQLite audit cleanup failed: ' + String(error))
        else throw error
      }
    }
  }
}
