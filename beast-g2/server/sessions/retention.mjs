// Audio and session retention with a deletion journal.
//
// Every function takes `now` in epoch milliseconds and never reads the wall clock, so the retention check can run with a
// fixed clock in tests. The sweep is idempotent: it only touches rows that still exist, and every batch commits in one
// transaction. `deleted_sessions` is written before a session row disappears, so a restore can replay the list and keep the
// deleted ids unavailable even when the backup predates the deletion.
import { unlinkSync } from 'node:fs'
import path from 'node:path'

export const AUDIO_RETENTION_MS = 24 * 60 * 60 * 1000
export const SESSION_RETENTION_DAYS = 30
export const RETENTION_REASON = 'retention_expired'
export const BATCH_SIZE = 100

function defaultDataDir(db) {
  return typeof db.name === 'string' && db.name !== ':memory:' ? path.dirname(db.name) : null
}

function removeAudioFile(dataDir, relativePath) {
  if (!dataDir || !relativePath) return
  const root = path.resolve(dataDir)
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(`${root}${path.sep}`)) return
  try {
    unlinkSync(target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/**
 * Deletes stored audio for every transcribed segment and for every segment whose 24 h audio window has passed. The segment
 * row, its transcript turn, the timing and the coverage gap stay. A segment that was never transcribed is marked `expired`,
 * its pending transcription jobs fail, and one `audio_expired` gap records the hole. Audio files are removed before the row is
 * cleared, inside the batch transaction, so a failed unlink rolls the batch back and the next sweep retries it.
 */
export function expireAudio(db, now, { dataDir = defaultDataDir(db) } = {}) {
  const segmentIds = []
  const audioPaths = []
  const seen = new Set()
  const select = db.prepare(`
    SELECT id, session_id AS sessionId, state, audio_path AS audioPath, start_ms AS startMs, end_ms AS endMs
    FROM segments
    WHERE audio_bytes > 0 AND (state = 'transcribed' OR audio_expires_at <= ?)
    ORDER BY audio_expires_at, id
    LIMIT ?`)
  for (;;) {
    const batch = select.all(now, BATCH_SIZE).filter((segment) => !seen.has(segment.id))
    if (!batch.length) break
    for (const segment of batch) seen.add(segment.id)
    db.transaction(() => {
      for (const segment of batch) {
        removeAudioFile(dataDir, segment.audioPath)
        if (segment.state === 'accepted') {
          db.prepare(`UPDATE segments SET state = 'expired' WHERE id = ? AND state = 'accepted'`).run(segment.id)
          db.prepare(`UPDATE jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE segment_id = ? AND state IN ('pending', 'running')`).run(
            'Audio expired before transcription.',
            now,
            segment.id
          )
          db.prepare(`INSERT OR IGNORE INTO coverage_gaps (id, session_id, start_ms, end_ms, reason, state, created_at) VALUES (?, ?, ?, ?, 'audio_expired', 'open', ?)`).run(
            `gap_${segment.id.slice(4)}`,
            segment.sessionId,
            segment.startMs,
            segment.endMs,
            now
          )
        }
        const changed = db.prepare(`UPDATE segments SET audio_path = '', audio_bytes = 0 WHERE id = ? AND audio_bytes > 0`).run(segment.id).changes
        if (changed !== 1) continue
        segmentIds.push(segment.id)
        if (segment.audioPath) audioPaths.push(segment.audioPath)
      }
    })()
    if (batch.length < BATCH_SIZE) break
  }
  return { audioDeleted: segmentIds.length, segmentIds, audioPaths }
}

/**
 * Hard-deletes sessions whose retention deadline has passed and sessions whose id is in `deleted_sessions`. The id is recorded
 * before the session row is removed, so a restore can replay the list. Turns, segments, summaries, preparations, action
 * candidates, gaps, jobs and search rows disappear with the session; audio files are removed too. Active and paused sessions
 * are never expired by their deadline, but a tombstoned id is removed even if the restored row still says active: the deletion
 * already happened after the backup. Each batch is one transaction and the whole sweep is idempotent.
 */
export function expireSessions(db, now, { dataDir = defaultDataDir(db) } = {}) {
  const deletedIds = []
  const audioSegmentIds = []
  const audioPaths = []
  const seen = new Set()
  const select = db.prepare(`
    SELECT s.id, s.expires_at AS retentionDeadline
    FROM sessions s
    LEFT JOIN deleted_sessions d ON d.session_id = s.id
    WHERE d.session_id IS NOT NULL
       OR (s.status NOT IN ('active', 'paused') AND s.expires_at <= ?)
    ORDER BY s.expires_at, s.id
    LIMIT ?`)
  for (;;) {
    const batch = select.all(now, BATCH_SIZE).filter((session) => !seen.has(session.id))
    if (!batch.length) break
    for (const session of batch) seen.add(session.id)
    db.transaction(() => {
      for (const session of batch) {
        db.prepare(`INSERT OR IGNORE INTO deleted_sessions (session_id, deleted_at, reason, retention_deadline) VALUES (?, ?, ?, ?)`).run(session.id, now, RETENTION_REASON, session.retentionDeadline)
        const segments = db.prepare(`SELECT id, audio_path AS audioPath FROM segments WHERE session_id = ? AND audio_bytes > 0`).all(session.id)
        for (const segment of segments) {
          removeAudioFile(dataDir, segment.audioPath)
          db.prepare(`UPDATE segments SET audio_path = '', audio_bytes = 0 WHERE id = ?`).run(segment.id)
          audioSegmentIds.push(segment.id)
          if (segment.audioPath) audioPaths.push(segment.audioPath)
        }
        db.prepare('DELETE FROM transcript_search WHERE session_id = ?').run(session.id)
        const changed = db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id).changes
        if (changed === 1) deletedIds.push(session.id)
      }
    })()
    if (batch.length < BATCH_SIZE) break
  }
  return { sessionsDeleted: deletedIds.length, deletedIds, audioDeleted: audioSegmentIds.length, audioSegmentIds, audioPaths }
}

/** Runs both retention passes in order: audio first, then sessions. */
export function sweep(db, now, options = {}) {
  const audio = expireAudio(db, now, options)
  const sessions = expireSessions(db, now, options)
  return {
    audioDeleted: audio.audioDeleted + sessions.audioDeleted,
    sessionsDeleted: sessions.sessionsDeleted,
    deletedIds: sessions.deletedIds,
    audioSegmentIds: [...audio.segmentIds, ...sessions.audioSegmentIds]
  }
}

/** The deletion journal, newest last. It has no text and no audio path. */
export function listDeletedSessions(db) {
  return db
    .prepare(
      `SELECT session_id AS sessionId, deleted_at AS deletedAt, reason, retention_deadline AS retentionDeadline
       FROM deleted_sessions ORDER BY deleted_at, session_id`
    )
    .all()
}

/** Records tombstones idempotently; an existing row keeps its original time and reason. */
export function recordDeletedSessions(db, entries) {
  const insert = db.prepare(`INSERT OR IGNORE INTO deleted_sessions (session_id, deleted_at, reason, retention_deadline) VALUES (@sessionId, @deletedAt, @reason, @retentionDeadline)`)
  let recorded = 0
  db.transaction(() => {
    for (const entry of entries) {
      if (!entry || typeof entry.sessionId !== 'string' || !entry.sessionId) throw new Error('A tombstone needs a session id.')
      if (!Number.isInteger(entry.deletedAt) || !Number.isInteger(entry.retentionDeadline)) throw new Error('A tombstone needs integer times.')
      recorded += insert.run({ ...entry, reason: String(entry.reason ?? RETENTION_REASON) }).changes
    }
  })()
  return recorded
}

/**
 * Copies the deletion journal from another database, for example from the live database into a restored backup. The sweep
 * then removes every restored session whose id is in the list. Copying is idempotent and keeps the original timestamps.
 */
export function importDeletedSessions(db, sourceDb) {
  return recordDeletedSessions(db, listDeletedSessions(sourceDb))
}
