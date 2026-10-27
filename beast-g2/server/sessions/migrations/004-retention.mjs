// Migration 4: the deletion journal for hard-deleted sessions.
//
// `deleted_sessions` is a tombstone list: one row per session that retention removed, kept after the session row is gone.
// It records the id, the deletion time, the reason and the retention deadline the session had, so a later restore can purge
// the id instead of resurrecting the session. Nothing here references `sessions`, because the tombstone outlives the session.
export const version = 4

export const sql = `
      CREATE TABLE deleted_sessions (
        session_id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        retention_deadline INTEGER NOT NULL
      );

      CREATE INDEX deleted_sessions_deleted_at ON deleted_sessions(deleted_at);
      CREATE INDEX deleted_sessions_deadline ON deleted_sessions(retention_deadline);
      CREATE INDEX segments_audio_retention ON segments(audio_expires_at) WHERE audio_bytes > 0;
    `
