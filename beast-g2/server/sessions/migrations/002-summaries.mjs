// Migration 2: Summaries, citations, action candidates, preparations and the widened jobs table.
export const version = 2

export const sql = `
      CREATE TABLE summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        transcript_revision INTEGER NOT NULL,
        generator TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        content_json TEXT NOT NULL DEFAULT '{}',
        coverage_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'stale')),
        review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'reviewed', 'edited')),
        stale_reason TEXT,
        last_error TEXT,
        supersedes_id TEXT REFERENCES summaries(id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ready_at INTEGER,
        edited_at INTEGER
      );

      CREATE TABLE summary_citations (
        summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES transcript_turns(id) ON DELETE CASCADE,
        turn_revision INTEGER NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        quote TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (summary_id, turn_id)
      );

      CREATE TABLE action_candidates (
        id TEXT PRIMARY KEY,
        summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        owner TEXT,
        due TEXT,
        due_text TEXT,
        conditional INTEGER NOT NULL DEFAULT 0,
        citations_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE preparations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        source_transcript_revision INTEGER NOT NULL,
        focus TEXT NOT NULL DEFAULT '',
        content_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ready', 'stale')),
        stale_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE jobs_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('transcribe', 'summarize')),
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        segment_id TEXT REFERENCES segments(id) ON DELETE CASCADE,
        summary_id TEXT REFERENCES summaries(id) ON DELETE CASCADE,
        transcript_revision INTEGER,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (type = 'transcribe' AND segment_id IS NOT NULL AND summary_id IS NULL) OR
          (type = 'summarize' AND summary_id IS NOT NULL AND segment_id IS NULL)
        )
      );

      INSERT INTO jobs_new (
        id, type, session_id, segment_id, summary_id, transcript_revision,
        idempotency_key, state, attempts, max_attempts, run_after, last_error,
        created_at, updated_at
      )
      SELECT
        id, type, session_id, segment_id, NULL, NULL,
        idempotency_key, state, attempts, max_attempts, run_after, last_error,
        created_at, updated_at
      FROM jobs;

      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;

      CREATE INDEX summaries_session_created ON summaries(session_id, created_at DESC);
      CREATE INDEX summaries_status ON summaries(status, updated_at);
      CREATE INDEX citations_turn ON summary_citations(turn_id);
      CREATE INDEX actions_summary ON action_candidates(summary_id, created_at);
      CREATE INDEX preparations_session_created ON preparations(session_id, created_at DESC);
      CREATE INDEX preparations_source_summary ON preparations(source_summary_id);
      CREATE INDEX jobs_pending ON jobs(state, run_after, created_at);
      CREATE INDEX jobs_segment ON jobs(segment_id);
      CREATE INDEX jobs_summary ON jobs(summary_id);
    `
