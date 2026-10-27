import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrate, migrations } from '../server/sessions/db.mjs'

test('migration v2 preserves transcription jobs from a v1 database', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  db.exec(migrations[0].sql)
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(1)

  const now = 1_700_000_000_000
  const sessionId = `ses_${'a'.repeat(32)}`
  const segmentId = `seg_${'b'.repeat(32)}`
  const jobId = `job_${'c'.repeat(32)}`
  db.prepare('INSERT INTO workspace (id, provider_profile, retention_days, created_at) VALUES (?, ?, ?, ?)').run('ws', '{}', 30, now)
  db.prepare(
    `INSERT INTO sessions (
      id, workspace_id, name, source, language, goal, prep, timezone, status,
      capture_state, transcript_revision, coverage_declared, retention_days, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, 'ws', 'Old session', 'import', 'cs', '', '', 'Europe/Prague', 'ended', 'off', 1, 'complete', 30, now, now + 1000)
  db.prepare(
    `INSERT INTO segments (
      id, session_id, sequence, start_ms, end_ms, content_hash, audio_path, audio_bytes,
      state, created_at, audio_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(segmentId, sessionId, 0, 0, 1000, 'hash', '/tmp/old.wav', 32, 'accepted', now, now + 1000)
  db.prepare(
    `INSERT INTO jobs (
      id, type, session_id, segment_id, idempotency_key, state, attempts, max_attempts,
      run_after, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, 'transcribe', sessionId, segmentId, 'transcribe:old', 'pending', 1, 3, now, null, now, now)

  migrate(db)

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)
  assert.equal(job.segment_id, segmentId)
  assert.equal(job.summary_id, null)
  assert.equal(job.state, 'pending')
  assert.deepEqual(
    db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => row.version),
    [1, 2, 3]
  )
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'summaries'").get())
  db.close()
})
