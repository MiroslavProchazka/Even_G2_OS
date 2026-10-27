// Migration 3: full-text index over the final transcript.
//
// `transcript_search` is a standalone FTS5 table, not an external-content table: the triggers below own every row, so a
// correction, a new turn and a cascade delete from the session keep the index exact. FTS5 is a hard requirement. If the
// better-sqlite3 build lacks FTS5, `CREATE VIRTUAL TABLE ... USING fts5` fails with `no such module: fts5` and `migrate()`
// throws. There is deliberately no LIKE fallback: a silent fallback would hide a broken index.
export const version = 3

export const sql = `
      CREATE VIRTUAL TABLE transcript_search USING fts5(
        turn_id UNINDEXED,
        session_id UNINDEXED,
        revision UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER transcript_search_insert AFTER INSERT ON transcript_turns BEGIN
        INSERT INTO transcript_search (turn_id, session_id, revision, text)
        VALUES (new.id, new.session_id, new.revision, new.text);
      END;

      CREATE TRIGGER transcript_search_update AFTER UPDATE ON transcript_turns BEGIN
        DELETE FROM transcript_search WHERE turn_id = old.id;
        INSERT INTO transcript_search (turn_id, session_id, revision, text)
        VALUES (new.id, new.session_id, new.revision, new.text);
      END;

      CREATE TRIGGER transcript_search_delete AFTER DELETE ON transcript_turns BEGIN
        DELETE FROM transcript_search WHERE turn_id = old.id;
      END;

      INSERT INTO transcript_search (turn_id, session_id, revision, text)
      SELECT id, session_id, revision, text FROM transcript_turns;
    `
