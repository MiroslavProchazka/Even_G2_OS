import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../server/sessions/db.mjs'
import { Repository } from '../server/sessions/repository.mjs'
import { SessionService } from '../server/sessions/service.mjs'
import { searchSessions } from '../server/sessions/search.mjs'
import { expireAudio, importDeletedSessions, listDeletedSessions, sweep } from '../server/sessions/retention.mjs'
import { backupDatabase } from '../scripts/backup.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'retention-check.mjs')
const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = 1_800_000_000_000

function iso(ms) {
  return new Date(ms).toISOString()
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
}

function writeAudio(dataDir, relativePath, bytes) {
  const file = path.join(dataDir, relativePath)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, Buffer.alloc(bytes, 7))
  return file
}

function seed(db, dataDir) {
  const ids = {
    old: `ses_${'a'.repeat(32)}`,
    fresh: `ses_${'b'.repeat(32)}`,
    active: `ses_${'c'.repeat(32)}`,
    paused: `ses_${'d'.repeat(32)}`,
    restore: `ses_${'e'.repeat(32)}`
  }
  const segments = {
    oldTranscribed: `seg_${'1'.repeat(32)}`,
    oldPending: `seg_${'2'.repeat(32)}`,
    fresh: `seg_${'3'.repeat(32)}`,
    active: `seg_${'4'.repeat(32)}`,
    restore: `seg_${'5'.repeat(32)}`
  }
  const turns = {
    old: `trn_${'6'.repeat(32)}`,
    fresh: `trn_${'7'.repeat(32)}`,
    restore: `trn_${'8'.repeat(32)}`
  }
  const summary = `sum_${'9'.repeat(32)}`
  const action = `act_${'a'.repeat(32)}`
  const preparation = `prp_${'b'.repeat(32)}`
  const gap = `gap_${'c'.repeat(32)}`
  const job = `job_${'d'.repeat(32)}`
  const memoryOld = `mem_${'e'.repeat(32)}`
  const memoryFresh = `mem_${'f'.repeat(32)}`

  db.prepare(`INSERT INTO workspace (id, provider_profile, retention_days, created_at) VALUES ('default', '{}', 30, ?)`).run(NOW)
  const insertSession = db.prepare(`INSERT INTO sessions (
    id, workspace_id, name, source, language, goal, prep, timezone, status, capture_state,
    writer_id, writer_seen_at, end_reason, transcript_revision, coverage_declared, retention_days,
    created_at, started_at, ended_at, expires_at
  ) VALUES (
    @id, 'default', @name, 'g2', 'cs', '', '', 'Europe/Prague', @status, @captureState,
    @writerId, @writerSeenAt, @endReason, 1, 'complete', 30, @createdAt, @startedAt, @endedAt, @expiresAt
  )`)
  insertSession.run({
    id: ids.old,
    name: 'Synthetic old',
    status: 'ended',
    captureState: 'off',
    writerId: null,
    writerSeenAt: null,
    endReason: 'user',
    createdAt: NOW - 45 * DAY,
    startedAt: NOW - 45 * DAY,
    endedAt: NOW - 40 * DAY,
    expiresAt: NOW - 10 * DAY
  })
  insertSession.run({
    id: ids.fresh,
    name: 'Synthetic fresh',
    status: 'ended',
    captureState: 'off',
    writerId: null,
    writerSeenAt: null,
    endReason: 'user',
    createdAt: NOW - DAY,
    startedAt: NOW - DAY,
    endedAt: NOW - DAY,
    expiresAt: NOW + 29 * DAY
  })
  insertSession.run({
    id: ids.active,
    name: 'Synthetic active',
    status: 'active',
    captureState: 'on',
    writerId: 'phone',
    writerSeenAt: NOW,
    endReason: null,
    createdAt: NOW - 40 * DAY,
    startedAt: NOW - 40 * DAY,
    endedAt: null,
    expiresAt: NOW - 10 * DAY
  })
  insertSession.run({
    id: ids.paused,
    name: 'Synthetic paused',
    status: 'paused',
    captureState: 'off',
    writerId: 'phone',
    writerSeenAt: NOW,
    endReason: null,
    createdAt: NOW - 40 * DAY,
    startedAt: NOW - 40 * DAY,
    endedAt: null,
    expiresAt: NOW - 10 * DAY
  })
  insertSession.run({
    id: ids.restore,
    name: 'Synthetic restore',
    status: 'ended',
    captureState: 'off',
    writerId: null,
    writerSeenAt: null,
    endReason: 'user',
    createdAt: NOW - DAY,
    startedAt: NOW - DAY,
    endedAt: NOW - DAY,
    expiresAt: NOW + DAY
  })

  const insertSegment = db.prepare(`INSERT INTO segments (
    id, session_id, sequence, start_ms, end_ms, content_hash, audio_path, audio_bytes,
    state, created_at, audio_expires_at, transcribed_at
  ) VALUES (
    @id, @sessionId, @sequence, @startMs, @endMs, @contentHash, @audioPath, @audioBytes,
    @state, @createdAt, @audioExpiresAt, @transcribedAt
  )`)
  const audio = (sessionId, segmentId) => `audio/${sessionId}/${segmentId}.wav`
  insertSegment.run({
    id: segments.oldTranscribed,
    sessionId: ids.old,
    sequence: 0,
    startMs: 0,
    endMs: 1000,
    contentHash: 'hash-old-transcribed',
    audioPath: audio(ids.old, segments.oldTranscribed),
    audioBytes: 64,
    state: 'transcribed',
    createdAt: NOW - 45 * DAY,
    audioExpiresAt: NOW - 44 * DAY,
    transcribedAt: NOW - 44 * DAY
  })
  insertSegment.run({
    id: segments.oldPending,
    sessionId: ids.old,
    sequence: 1,
    startMs: 1000,
    endMs: 2000,
    contentHash: 'hash-old-pending',
    audioPath: audio(ids.old, segments.oldPending),
    audioBytes: 32,
    state: 'accepted',
    createdAt: NOW - 45 * DAY,
    audioExpiresAt: NOW + 23 * HOUR,
    transcribedAt: null
  })
  insertSegment.run({
    id: segments.fresh,
    sessionId: ids.fresh,
    sequence: 0,
    startMs: 0,
    endMs: 1000,
    contentHash: 'hash-fresh',
    audioPath: audio(ids.fresh, segments.fresh),
    audioBytes: 48,
    state: 'transcribed',
    createdAt: NOW - DAY,
    audioExpiresAt: NOW + 23 * HOUR,
    transcribedAt: NOW - DAY
  })
  insertSegment.run({
    id: segments.active,
    sessionId: ids.active,
    sequence: 0,
    startMs: 0,
    endMs: 1000,
    contentHash: 'hash-active',
    audioPath: audio(ids.active, segments.active),
    audioBytes: 16,
    state: 'accepted',
    createdAt: NOW - 40 * DAY,
    audioExpiresAt: NOW + 23 * HOUR,
    transcribedAt: null
  })
  insertSegment.run({
    id: segments.restore,
    sessionId: ids.restore,
    sequence: 0,
    startMs: 0,
    endMs: 1000,
    contentHash: 'hash-restore',
    audioPath: audio(ids.restore, segments.restore),
    audioBytes: 24,
    state: 'transcribed',
    createdAt: NOW - DAY,
    audioExpiresAt: NOW + 23 * HOUR,
    transcribedAt: NOW - DAY
  })

  const insertTurn = db.prepare(`INSERT INTO transcript_turns (
    id, session_id, segment_id, text, revision, source, start_ms, end_ms, created_at, updated_at
  ) VALUES (@id, @sessionId, @segmentId, @text, 1, 'manual', @startMs, @endMs, @createdAt, @updatedAt)`)
  insertTurn.run({ id: turns.old, sessionId: ids.old, segmentId: segments.oldTranscribed, text: 'RETENTION OLD', startMs: 0, endMs: 1000, createdAt: NOW - 45 * DAY, updatedAt: NOW - 45 * DAY })
  insertTurn.run({ id: turns.fresh, sessionId: ids.fresh, segmentId: segments.fresh, text: 'RETENTION FRESH', startMs: 0, endMs: 1000, createdAt: NOW - DAY, updatedAt: NOW - DAY })
  insertTurn.run({ id: turns.restore, sessionId: ids.restore, segmentId: segments.restore, text: 'RETENTION RESTORE', startMs: 0, endMs: 1000, createdAt: NOW - DAY, updatedAt: NOW - DAY })

  db.prepare(
    `INSERT INTO summaries (
    id, session_id, transcript_revision, generator, prompt_version, content_json, coverage_json,
    status, review_status, idempotency_key, created_at, updated_at
  ) VALUES (?, ?, 1, 'synthetic', 'v1', ?, '{}', 'ready', 'unreviewed', 'summary:old', ?, ?)`
  ).run(summary, ids.old, JSON.stringify({ overview: { text: 'RETENTION SUMMARY' } }), NOW - 40 * DAY, NOW - 40 * DAY)
  db.prepare(`INSERT INTO summary_citations (summary_id, turn_id, turn_revision, start_ms, end_ms, quote, created_at) VALUES (?, ?, 1, 0, 1000, 'RETENTION OLD', ?)`).run(
    summary,
    turns.old,
    NOW - 40 * DAY
  )
  db.prepare(`INSERT INTO action_candidates (id, summary_id, session_id, text, citations_json, created_at) VALUES (?, ?, ?, 'RETENTION ACTION', '[]', ?)`).run(action, summary, ids.old, NOW - 40 * DAY)
  db.prepare(
    `INSERT INTO preparations (
    id, session_id, source_session_id, source_summary_id, source_transcript_revision,
    focus, content_json, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 1, '', '{"summary":{}}', 'ready', ?, ?)`
  ).run(preparation, ids.old, ids.old, summary, NOW - 40 * DAY, NOW - 40 * DAY)
  db.prepare(`INSERT INTO coverage_gaps (id, session_id, start_ms, end_ms, reason, state, created_at) VALUES (?, ?, 0, 1000, 'missing_segment', 'open', ?)`).run(gap, ids.old, NOW - 45 * DAY)
  db.prepare(
    `INSERT INTO jobs (
    id, type, session_id, segment_id, idempotency_key, state, attempts, max_attempts, run_after, created_at, updated_at
  ) VALUES (?, 'transcribe', ?, ?, ?, 'pending', 0, 3, ?, ?, ?)`
  ).run(job, ids.old, segments.oldPending, 'transcribe:old-pending', NOW - 45 * DAY, NOW - 45 * DAY, NOW - 45 * DAY)

  const insertMemory = db.prepare(`INSERT INTO memory_items (
    id, workspace_id, session_id, turn_id, turn_revision, kind, text, source_quote, status,
    source_deleted, evidence_state, created_at, updated_at
  ) VALUES (?, 'default', ?, ?, 1, 'decision', ?, ?, 'approved', 0, 'present', ?, ?)`)
  insertMemory.run(memoryOld, ids.old, turns.old, 'RETENTION MEMORY OLD', 'RETENTION OLD', NOW - 40 * DAY, NOW - 40 * DAY)
  insertMemory.run(memoryFresh, ids.fresh, turns.fresh, 'RETENTION MEMORY FRESH', 'RETENTION FRESH', NOW - DAY, NOW - DAY)

  const files = {
    oldTranscribed: writeAudio(dataDir, audio(ids.old, segments.oldTranscribed), 64),
    oldPending: writeAudio(dataDir, audio(ids.old, segments.oldPending), 32),
    fresh: writeAudio(dataDir, audio(ids.fresh, segments.fresh), 48),
    active: writeAudio(dataDir, audio(ids.active, segments.active), 16),
    restore: writeAudio(dataDir, audio(ids.restore, segments.restore), 24)
  }
  return { ids, segments, turns, summary, action, preparation, gap, job, memoryOld, memoryFresh, files }
}

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-retention-'))
  const dataDir = path.join(dir, 'data')
  const dbPath = path.join(dataDir, 'sessions.sqlite')
  const db = openDatabase(dbPath)
  const seeded = seed(db, dataDir)
  t.after(() => {
    if (db.open) db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, dataDir, dbPath, db, ...seeded }
}

function count(db, table, column, value) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(value).count
}

function segment(db, id) {
  return db.prepare('SELECT state, audio_path AS audioPath, audio_bytes AS audioBytes, start_ms AS startMs, end_ms AS endMs FROM segments WHERE id = ?').get(id)
}

test('audio is deleted after transcription and after the 24 hour window', (t) => {
  const fx = fixture(t)
  const result = expireAudio(fx.db, NOW)

  assert.equal(result.audioDeleted, 3)
  assert.deepEqual(result.segmentIds.sort(), [fx.segments.oldTranscribed, fx.segments.fresh, fx.segments.restore].sort())
  assert.ok(!existsSync(fx.files.oldTranscribed))
  assert.ok(!existsSync(fx.files.fresh))
  assert.ok(!existsSync(fx.files.restore))
  assert.ok(existsSync(fx.files.oldPending))
  assert.ok(existsSync(fx.files.active))

  const transcribed = segment(fx.db, fx.segments.oldTranscribed)
  assert.equal(transcribed.state, 'transcribed')
  assert.equal(transcribed.audioPath, '')
  assert.equal(transcribed.audioBytes, 0)
  assert.equal(transcribed.startMs, 0)
  assert.equal(transcribed.endMs, 1000)
  const turn = fx.db.prepare('SELECT text, start_ms AS startMs, end_ms AS endMs FROM transcript_turns WHERE id = ?').get(fx.turns.old)
  assert.deepEqual(turn, { text: 'RETENTION OLD', startMs: 0, endMs: 1000 })

  const pending = segment(fx.db, fx.segments.oldPending)
  assert.equal(pending.state, 'accepted')
  assert.equal(pending.audioBytes, 32)
  assert.equal(fx.db.prepare('SELECT state FROM jobs WHERE id = ?').get(fx.job).state, 'pending')
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM coverage_gaps WHERE session_id = ?').get(fx.ids.old).count, 1)
})

test('sessions expire after 30 days while active and paused sessions stay', (t) => {
  const fx = fixture(t)
  const result = sweep(fx.db, NOW)

  assert.equal(result.sessionsDeleted, 1)
  assert.deepEqual(result.deletedIds, [fx.ids.old])
  assert.equal(result.audioDeleted, 4)
  assert.equal(fx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.old), undefined)
  for (const id of [fx.ids.fresh, fx.ids.active, fx.ids.paused, fx.ids.restore]) {
    assert.ok(fx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(id), `${id} must stay`)
  }
  assert.deepEqual(listDeletedSessions(fx.db), [{ sessionId: fx.ids.old, deletedAt: NOW, reason: 'retention_expired', retentionDeadline: NOW - 10 * DAY }])

  assert.equal(count(fx.db, 'segments', 'session_id', fx.ids.old), 0)
  assert.equal(count(fx.db, 'transcript_turns', 'session_id', fx.ids.old), 0)
  assert.equal(count(fx.db, 'summaries', 'session_id', fx.ids.old), 0)
  assert.equal(count(fx.db, 'summary_citations', 'summary_id', fx.summary), 0)
  assert.equal(count(fx.db, 'action_candidates', 'session_id', fx.ids.old), 0)
  assert.equal(count(fx.db, 'preparations', 'session_id', fx.ids.old), 0)
  assert.equal(count(fx.db, 'coverage_gaps', 'session_id', fx.ids.old), 0)
  assert.equal(count(fx.db, 'jobs', 'session_id', fx.ids.old), 0)
  assert.equal(count(fx.db, 'transcript_search', 'session_id', fx.ids.old), 0)
  assert.equal(count(fx.db, 'memory_items', 'session_id', fx.ids.old), 0)
  assert.equal(count(fx.db, 'memory_items', 'session_id', fx.ids.fresh), 1)

  assert.ok(!existsSync(fx.files.oldTranscribed))
  assert.ok(!existsSync(fx.files.oldPending))
  assert.ok(!existsSync(fx.files.fresh))
  assert.ok(existsSync(fx.files.active))
  assert.ok(!existsSync(fx.files.restore))
})

test('the sweep is idempotent', (t) => {
  const fx = fixture(t)
  const first = sweep(fx.db, NOW)
  const sessions = count(fx.db, 'sessions', 'workspace_id', 'default')
  const segments = count(fx.db, 'segments', 'session_id', fx.ids.fresh)
  assert.equal(first.sessionsDeleted, 1)

  const second = sweep(fx.db, NOW)

  assert.deepEqual(second, { audioDeleted: 0, sessionsDeleted: 0, deletedIds: [], audioSegmentIds: [] })
  assert.equal(count(fx.db, 'sessions', 'workspace_id', 'default'), sessions)
  assert.equal(count(fx.db, 'segments', 'session_id', fx.ids.fresh), segments)
  assert.equal(listDeletedSessions(fx.db).length, 1)
  assert.ok(fx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.fresh))
  assert.ok(fx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.active))
})

test('a search no longer returns a deleted session', (t) => {
  const fx = fixture(t)
  sweep(fx.db, NOW)

  const results = searchSessions(new Repository(fx.db), { query: 'retention' })

  assert.ok(results.length > 0)
  assert.ok(results.every((result) => result.sessionId !== fx.ids.old))
  assert.ok(results.some((result) => result.sessionId === fx.ids.fresh))
  assert.equal(count(fx.db, 'transcript_search', 'session_id', fx.ids.old), 0)
})

test('a restored backup cannot bring back a deleted id', async (t) => {
  const fx = fixture(t)
  const backupPath = path.join(fx.dir, 'backup.sqlite')
  await backupDatabase({ source: fx.dbPath, out: backupPath, now: new Date(NOW) })

  const live = sweep(fx.db, NOW + 40 * DAY)
  assert.equal(live.sessionsDeleted, 3, JSON.stringify(live))
  assert.deepEqual(live.deletedIds.sort(), [fx.ids.old, fx.ids.fresh, fx.ids.restore].sort())
  assert.equal(listDeletedSessions(fx.db).length, 3)

  const restoredPath = path.join(fx.dir, 'restore', 'sessions.sqlite')
  mkdirSync(path.dirname(restoredPath), { recursive: true })
  copyFileSync(backupPath, restoredPath)
  const restored = openDatabase(restoredPath)
  t.after(() => {
    if (restored.open) restored.close()
  })
  assert.ok(restored.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.restore))
  const restoredSession = restored.prepare('SELECT expires_at AS expiresAt FROM sessions WHERE id = ?').get(fx.ids.restore)
  assert.ok(restoredSession.expiresAt > NOW + 2 * HOUR, 'the restored deadline is still in the future')
  assert.equal(listDeletedSessions(restored).length, 0)

  assert.equal(importDeletedSessions(restored, fx.db), 3)
  const afterImport = sweep(restored, NOW + 2 * HOUR)

  assert.deepEqual(afterImport.deletedIds.sort(), [fx.ids.old, fx.ids.fresh, fx.ids.restore].sort())
  assert.equal(restored.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.restore), undefined)
  assert.ok(restored.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.paused))
  assert.deepEqual(listDeletedSessions(restored), [
    { sessionId: fx.ids.old, deletedAt: NOW + 40 * DAY, reason: 'retention_expired', retentionDeadline: NOW - 10 * DAY },
    { sessionId: fx.ids.fresh, deletedAt: NOW + 40 * DAY, reason: 'retention_expired', retentionDeadline: NOW + 29 * DAY },
    { sessionId: fx.ids.restore, deletedAt: NOW + 40 * DAY, reason: 'retention_expired', retentionDeadline: NOW + DAY }
  ])
  assert.equal(count(restored, 'transcript_search', 'session_id', fx.ids.restore), 0)
  assert.equal(searchSessions(new Repository(restored), { query: 'restore' }).length, 0)
  restored.close()

  const cliPath = path.join(fx.dir, 'restore-cli', 'sessions.sqlite')
  mkdirSync(path.dirname(cliPath), { recursive: true })
  copyFileSync(backupPath, cliPath)
  const cli = run(['--db', cliPath, '--deleted-from', fx.dbPath, '--now', iso(NOW + 2 * HOUR), '--apply', '--json'])
  assert.equal(cli.status, 0, cli.stderr)
  const cliReport = JSON.parse(cli.stdout)
  assert.ok(cliReport.deletedIds.includes(fx.ids.restore))
  const cliDb = openDatabase(cliPath)
  try {
    assert.equal(cliDb.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.restore), undefined)
    assert.ok(cliDb.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.paused))
  } finally {
    cliDb.close()
  }
})

test('the retention check reports a dry run and applies on request', (t) => {
  const fx = fixture(t)

  const dry = run(['--db', fx.dbPath, '--now', iso(NOW), '--json'])
  assert.equal(dry.status, 0, dry.stderr)
  assert.ok(!dry.stdout.includes('RETENTION'))
  const report = JSON.parse(dry.stdout)
  assert.equal(report.mode, 'dry-run')
  assert.equal(report.audioDeleted, 4)
  assert.equal(report.sessionsDeleted, 1)
  assert.deepEqual(report.deletedIds, [fx.ids.old])
  assert.equal(report.tempCopyRemoved, true)
  assert.ok(fx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.old))
  assert.equal(count(fx.db, 'deleted_sessions', 'session_id', fx.ids.old), 0)
  assert.ok(existsSync(fx.files.oldTranscribed))
  assert.ok(existsSync(fx.files.fresh))

  const applied = run(['--db', fx.dbPath, '--now', iso(NOW), '--json', '--apply'])
  assert.equal(applied.status, 0, applied.stderr)
  assert.ok(!applied.stdout.includes('RETENTION'))
  const appliedReport = JSON.parse(applied.stdout)
  assert.equal(appliedReport.mode, 'apply')
  assert.equal(appliedReport.audioDeleted, 4)
  assert.equal(appliedReport.sessionsDeleted, 1)
  assert.deepEqual(appliedReport.deletedIds, [fx.ids.old])
  assert.equal(appliedReport.tempCopyRemoved, null)
  assert.equal(fx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.old), undefined)
  assert.equal(listDeletedSessions(fx.db).length, 1)
  assert.ok(!existsSync(fx.files.oldTranscribed))
  assert.ok(!existsSync(fx.files.oldPending))
  assert.ok(!existsSync(fx.files.fresh))
  assert.ok(!existsSync(fx.files.restore))
  assert.ok(existsSync(fx.files.active))

  const again = run(['--db', fx.dbPath, '--now', iso(NOW), '--json', '--apply'])
  assert.equal(again.status, 0, again.stderr)
  const againReport = JSON.parse(again.stdout)
  assert.equal(againReport.audioDeleted, 0)
  assert.equal(againReport.sessionsDeleted, 0)
  assert.deepEqual(againReport.deletedIds, [])
  assert.equal(againReport.journalRows, 1)
})

test('a manual delete writes the deletion journal in the same transaction', (t) => {
  const fx = fixture(t)
  const service = new SessionService({ repo: new Repository(fx.db), dataDir: fx.dataDir, now: () => NOW })

  assert.equal(service.deleteSession(fx.ids.fresh), true)
  assert.equal(fx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(fx.ids.fresh), undefined)
  assert.equal(count(fx.db, 'memory_items', 'session_id', fx.ids.fresh), 0)
  const journal = listDeletedSessions(fx.db)
  assert.equal(journal.length, 1)
  assert.equal(journal[0].sessionId, fx.ids.fresh)
  assert.equal(journal[0].reason, 'user_deleted')
  assert.equal(journal[0].deletedAt, NOW)
  assert.ok(!existsSync(fx.files.fresh))
})
