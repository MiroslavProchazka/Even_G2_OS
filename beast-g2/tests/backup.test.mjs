import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../server/sessions/db.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backupScript = path.join(root, 'scripts', 'backup.mjs')
const restoreScript = path.join(root, 'scripts', 'restore-check.mjs')
const SESSION_TEXT = 'SYNTHETIC-TRANSCRIPT-DO-NOT-PRINT'
const SUMMARY_TEXT = 'SYNTHETIC-SUMMARY-DO-NOT-PRINT'

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
}

function seed(db, dataDir) {
  const now = 1_700_000_000_000
  const sessionA = `ses_${'a'.repeat(32)}`
  const sessionB = `ses_${'b'.repeat(32)}`
  const segmentA = `seg_${'c'.repeat(32)}`
  const segmentB = `seg_${'d'.repeat(32)}`
  const segmentC = `seg_${'e'.repeat(32)}`
  const turnA = `trn_${'f'.repeat(32)}`
  const turnB = `trn_${'g'.repeat(32)}`
  const summary = `sum_${'h'.repeat(32)}`
  const preparation = `prp_${'i'.repeat(32)}`
  const audioDir = path.join(dataDir, 'audio')
  mkdirSync(audioDir, { recursive: true })
  const audioPath = path.join(audioDir, `${segmentC}.wav`)
  writeFileSync(audioPath, Buffer.alloc(64, 7))

  db.prepare(`INSERT INTO workspace (id, provider_profile, retention_days, created_at) VALUES ('default', '{}', 30, ?)`).run(now)
  const insertSession = db.prepare(`INSERT INTO sessions (
    id, workspace_id, name, source, language, goal, prep, timezone, status,
    capture_state, transcript_revision, coverage_declared, retention_days, created_at, expires_at
  ) VALUES (@id, 'default', @name, @source, @language, '', '', 'Europe/Prague', @status, @captureState, 1, 'complete', 30, @createdAt, @expiresAt)`)
  insertSession.run({ id: sessionA, name: 'Synthetic A', source: 'g2', language: 'cs', status: 'ended', captureState: 'off', createdAt: now, expiresAt: now + 30 * 86400000 })
  insertSession.run({ id: sessionB, name: 'Synthetic B', source: 'import', language: 'en', status: 'active', captureState: 'on', createdAt: now + 1000, expiresAt: now + 30 * 86400000 })

  const insertSegment = db.prepare(`INSERT INTO segments (
    id, session_id, sequence, start_ms, end_ms, content_hash, audio_path, audio_bytes,
    state, created_at, audio_expires_at
  ) VALUES (@id, @sessionId, @sequence, @startMs, @endMs, @contentHash, @audioPath, @audioBytes, @state, @createdAt, @audioExpiresAt)`)
  insertSegment.run({
    id: segmentA,
    sessionId: sessionA,
    sequence: 0,
    startMs: 0,
    endMs: 1000,
    contentHash: 'hash-a',
    audioPath: '',
    audioBytes: 0,
    state: 'transcribed',
    createdAt: now,
    audioExpiresAt: now + 86400000
  })
  insertSegment.run({
    id: segmentB,
    sessionId: sessionA,
    sequence: 1,
    startMs: 1000,
    endMs: 2000,
    contentHash: 'hash-b',
    audioPath: '',
    audioBytes: 0,
    state: 'transcribed',
    createdAt: now + 1000,
    audioExpiresAt: now + 86400000
  })
  insertSegment.run({
    id: segmentC,
    sessionId: sessionB,
    sequence: 0,
    startMs: 0,
    endMs: 1000,
    contentHash: 'hash-c',
    audioPath,
    audioBytes: 64,
    state: 'accepted',
    createdAt: now + 2000,
    audioExpiresAt: now + 86400000
  })

  const insertTurn = db.prepare(`INSERT INTO transcript_turns (
    id, session_id, segment_id, text, revision, source, start_ms, end_ms, created_at, updated_at
  ) VALUES (@id, @sessionId, @segmentId, @text, 1, 'manual', @startMs, @endMs, @createdAt, @updatedAt)`)
  insertTurn.run({ id: turnA, sessionId: sessionA, segmentId: segmentA, text: SESSION_TEXT, startMs: 0, endMs: 1000, createdAt: now, updatedAt: now })
  insertTurn.run({ id: turnB, sessionId: sessionA, segmentId: segmentB, text: `${SESSION_TEXT} two`, startMs: 1000, endMs: 2000, createdAt: now + 1000, updatedAt: now + 1000 })

  db.prepare(
    `INSERT INTO summaries (
    id, session_id, transcript_revision, generator, prompt_version, content_json, coverage_json,
    status, review_status, idempotency_key, created_at, updated_at
  ) VALUES (?, ?, 1, 'synthetic', 'v1', ?, '{}', 'ready', 'unreviewed', 'summary:synthetic', ?, ?)`
  ).run(summary, sessionA, JSON.stringify({ title: SUMMARY_TEXT }), now, now)
  db.prepare(
    `INSERT INTO preparations (
    id, session_id, source_session_id, source_summary_id, source_transcript_revision,
    focus, content_json, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 1, '', '{}', 'ready', ?, ?)`
  ).run(preparation, sessionA, sessionA, summary, now, now)

  return { audioPath, sessionA, sessionB, sessionC: `ses_${'z'.repeat(32)}` }
}

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-backup-'))
  const dataDir = path.join(dir, 'data')
  const dbPath = path.join(dataDir, 'sessions.sqlite')
  const db = openDatabase(dbPath)
  const ids = seed(db, dataDir)
  t.after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, dataDir, dbPath, db, ...ids }
}

function backupAndCheck(t) {
  const fx = fixture(t)
  const backupPath = path.join(fx.dir, 'backups', 'sessions.sqlite')
  const result = run(backupScript, ['--source', fx.dbPath, '--out', backupPath])
  assert.equal(result.status, 0, result.stderr)
  return { fx, backupPath, result }
}

test('backup writes a consistent copy, manifest, and passes the restore check', (t) => {
  const { fx, backupPath, result } = backupAndCheck(t)
  const manifestPath = `${backupPath}.manifest.json`
  assert.match(result.stdout, /Backup OK/)
  assert.ok(existsSync(backupPath))
  assert.ok(existsSync(manifestPath))
  assert.ok(!result.stdout.includes(SESSION_TEXT))
  assert.ok(!result.stdout.includes(SUMMARY_TEXT))

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(Object.keys(manifest).sort(), ['backupBytes', 'createdAt', 'integrity', 'schemaVersion', 'sha256', 'sourceBytes'])
  assert.equal(manifest.integrity, 'ok')
  assert.equal(manifest.schemaVersion, 5)
  assert.equal(manifest.backupBytes, statSync(backupPath).size)
  assert.equal(manifest.sha256, createHash('sha256').update(readFileSync(backupPath)).digest('hex'))
  assert.ok(manifest.sourceBytes > 0)
  assert.ok(!Number.isNaN(Date.parse(manifest.createdAt)))

  const copied = readdirSync(path.join(fx.dir, 'backups'), { recursive: true }).filter((name) => String(name).endsWith('.wav'))
  assert.deepEqual(copied, [])
  assert.ok(existsSync(fx.audioPath))

  const check = run(restoreScript, ['--backup', backupPath, '--json'])
  assert.equal(check.status, 0, check.stderr)
  assert.ok(!check.stdout.includes(SESSION_TEXT))
  assert.ok(!check.stdout.includes(SUMMARY_TEXT))
  const report = JSON.parse(check.stdout.trim())
  assert.equal(report.ok, true)
  assert.equal(report.sha256, manifest.sha256)
  assert.equal(report.schemaVersion, manifest.schemaVersion)
  assert.equal(report.integrity, 'ok')
  assert.equal(report.tempRemoved, true)
  assert.deepEqual(report.counts, { sessions: 2, segments: 3, turns: 2, summaries: 1, preparations: 1 })
})

test('backup refuses to overwrite without --force and replaces with it', (t) => {
  const { fx, backupPath } = backupAndCheck(t)
  const manifestPath = `${backupPath}.manifest.json`
  const before = readFileSync(manifestPath, 'utf8')
  const refused = run(backupScript, ['--source', fx.dbPath, '--out', backupPath])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /--force/)
  assert.equal(readFileSync(manifestPath, 'utf8'), before)

  fx.db
    .prepare(
      `INSERT INTO sessions (
      id, workspace_id, name, source, language, goal, prep, timezone, status,
      capture_state, transcript_revision, coverage_declared, retention_days, created_at, expires_at
    ) VALUES (?, 'default', 'Synthetic C', 'g2', 'cs', '', '', 'Europe/Prague', 'ended', 'off', 1, 'complete', 30, ?, ?)`
    )
    .run(fx.sessionC, 1_700_000_100_000, 1_700_000_100_000 + 30 * 86400000)

  const forced = run(backupScript, ['--source', fx.dbPath, '--out', backupPath, '--force'])
  assert.equal(forced.status, 0, forced.stderr)
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.notEqual(after.sha256, JSON.parse(before).sha256)
  const check = run(restoreScript, ['--backup', backupPath, '--json'])
  assert.equal(check.status, 0, check.stderr)
  assert.equal(JSON.parse(check.stdout.trim()).counts.sessions, 3)
})

test('restore check rejects a corrupted copy', (t) => {
  const { backupPath } = backupAndCheck(t)
  const corruptPath = path.join(path.dirname(backupPath), 'corrupt.sqlite')
  copyFileSync(backupPath, corruptPath)
  copyFileSync(`${backupPath}.manifest.json`, `${corruptPath}.manifest.json`)
  const original = readFileSync(corruptPath)
  writeFileSync(corruptPath, original.subarray(0, original.length - 1))
  const truncated = run(restoreScript, ['--backup', corruptPath])
  assert.notEqual(truncated.status, 0)
  assert.match(truncated.stderr, /size|checksum/i)

  const damagedPath = path.join(path.dirname(backupPath), 'damaged.sqlite')
  const damaged = Buffer.from(original)
  for (let offset = 100; offset < 180 && offset < damaged.length; offset += 1) damaged[offset] = 0xff
  writeFileSync(damagedPath, damaged)
  const manifest = JSON.parse(readFileSync(`${backupPath}.manifest.json`, 'utf8'))
  manifest.backupBytes = damaged.length
  manifest.sha256 = createHash('sha256').update(damaged).digest('hex')
  writeFileSync(`${damagedPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  const failed = run(restoreScript, ['--backup', damagedPath])
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /integrity|malformed|not a database/i)
})

test('restore check rejects a missing manifest', (t) => {
  const { backupPath } = backupAndCheck(t)
  rmSync(`${backupPath}.manifest.json`)
  const result = run(restoreScript, ['--backup', backupPath])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /manifest/i)
})
