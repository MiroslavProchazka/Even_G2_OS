// Migration 5: memory items.
//
// A memory item is one claim taken from one concrete transcript turn: the model may only propose it, and the user
// approves or rejects it in the phone panel. The table has no foreign key to `sessions` or `transcript_turns` on
// purpose: an approved item may outlive its source when the user deletes the session with `keepMemory=1`, and the
// row then records `source_deleted = 1` with `evidence_state = 'lost'` instead of pointing at a missing row.
//
// The trigger is the safety net for every deletion path that does not go through SessionService.deleteSession, most
// importantly the retention sweep, which removes sessions with plain SQL. A kept item has `source_deleted = 1` before
// its session row disappears, so the trigger leaves it alone.
export const version = 5

export const sql = `
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        turn_revision INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('decision', 'commitment', 'fact', 'preference', 'open_question')),
        text TEXT NOT NULL,
        source_quote TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded')),
        supersedes_id TEXT REFERENCES memory_items(id),
        source_deleted INTEGER NOT NULL DEFAULT 0 CHECK (source_deleted IN (0, 1)),
        evidence_state TEXT NOT NULL DEFAULT 'present' CHECK (evidence_state IN ('present', 'lost')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        approved_at INTEGER,
        rejected_at INTEGER,
        superseded_at INTEGER
      );

      CREATE INDEX memory_items_session_status ON memory_items(session_id, status, created_at);
      CREATE INDEX memory_items_workspace_status ON memory_items(workspace_id, status, created_at);

      CREATE TRIGGER memory_items_session_deleted AFTER DELETE ON sessions
      BEGIN
        DELETE FROM memory_items WHERE session_id = OLD.id AND source_deleted = 0;
      END;
    `
