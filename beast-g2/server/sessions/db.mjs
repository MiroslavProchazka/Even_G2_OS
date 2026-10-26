import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE workspace (
        id TEXT PRIMARY KEY,
        provider_profile TEXT NOT NULL DEFAULT '{}',
        retention_days INTEGER NOT NULL DEFAULT 30,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('import', 'g2')),
        language TEXT NOT NULL CHECK (language IN ('cs', 'en', 'auto')),
        goal TEXT NOT NULL DEFAULT '',
        prep TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT 'Europe/Prague',
        status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'ended', 'deleted')),
        capture_state TEXT NOT NULL CHECK (capture_state IN ('off', 'starting', 'on', 'unknown')),
        writer_id TEXT,
        writer_seen_at INTEGER,
        end_reason TEXT,
        transcript_revision INTEGER NOT NULL DEFAULT 1,
        coverage_declared TEXT NOT NULL DEFAULT 'unknown' CHECK (coverage_declared IN ('unknown', 'partial', 'complete')),
        retention_days INTEGER NOT NULL DEFAULT 30,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        audio_path TEXT NOT NULL,
        audio_bytes INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'transcribed', 'failed', 'expired')),
        created_at INTEGER NOT NULL,
        audio_expires_at INTEGER NOT NULL,
        transcribed_at INTEGER,
        UNIQUE (session_id, sequence)
      );

      CREATE TABLE transcript_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL UNIQUE REFERENCES segments(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL CHECK (source IN ('stt', 'manual')),
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE transcript_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL REFERENCES transcript_turns(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('stt', 'manual')),
        created_at INTEGER NOT NULL,
        UNIQUE (turn_id, revision)
      );

      CREATE TABLE coverage_gaps (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER,
        reason TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('transcribe')),
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX sessions_created ON sessions(created_at DESC);
      CREATE INDEX sessions_status_expiry ON sessions(status, expires_at);
      CREATE INDEX segments_session_start ON segments(session_id, start_ms);
      CREATE INDEX segments_audio_expiry ON segments(state, audio_expires_at);
      CREATE INDEX turns_session_start ON transcript_turns(session_id, start_ms);
      CREATE INDEX gaps_session_start ON coverage_gaps(session_id, start_ms);
      CREATE INDEX jobs_pending ON jobs(state, run_after, created_at);
      CREATE INDEX jobs_segment ON jobs(segment_id);
    `
  }
]

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version)
  )
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, Date.now())
    })()
  }
}
