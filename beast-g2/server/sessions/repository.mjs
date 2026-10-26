const sessionColumns = `
  s.id, s.workspace_id AS workspaceId, s.name, s.source, s.language, s.goal, s.prep,
  s.timezone, s.status, s.capture_state AS captureState, s.writer_id AS writerId,
  s.writer_seen_at AS writerSeenAt, s.end_reason AS endReason,
  s.transcript_revision AS transcriptRevision, s.coverage_declared AS coverageDeclared,
  s.retention_days AS retentionDays, s.created_at AS createdAt,
  s.started_at AS startedAt, s.ended_at AS endedAt, s.expires_at AS expiresAt`

const segmentColumns = `
  id, session_id AS sessionId, sequence, start_ms AS startMs, end_ms AS endMs,
  content_hash AS contentHash, audio_path AS audioPath, audio_bytes AS audioBytes,
  state, created_at AS createdAt, audio_expires_at AS audioExpiresAt,
  transcribed_at AS transcribedAt`

const turnColumns = `
  id, session_id AS sessionId, segment_id AS segmentId, text, revision, source,
  start_ms AS startMs, end_ms AS endMs, created_at AS createdAt, updated_at AS updatedAt`

const gapColumns = `
  id, session_id AS sessionId, start_ms AS startMs, end_ms AS endMs, reason, state,
  created_at AS createdAt, resolved_at AS resolvedAt`

const jobColumns = `
  id, type, session_id AS sessionId, segment_id AS segmentId, state, attempts,
  max_attempts AS maxAttempts, run_after AS runAfter, last_error AS lastError,
  created_at AS createdAt, updated_at AS updatedAt`

const revisionColumns = `
  r.id, r.turn_id AS turnId, r.revision, r.text, r.source, r.created_at AS createdAt`

const sessionPatchColumns = {
  status: 'status',
  captureState: 'capture_state',
  writerId: 'writer_id',
  writerSeenAt: 'writer_seen_at',
  endReason: 'end_reason',
  transcriptRevision: 'transcript_revision',
  coverageDeclared: 'coverage_declared',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  expiresAt: 'expires_at'
}

export class Repository {
  constructor(db, { now = Date.now } = {}) {
    this.db = db
    this.now = now
  }

  transaction(fn) {
    return this.db.transaction(fn)()
  }

  ensureWorkspace() {
    this.db.prepare(`INSERT INTO workspace (id, provider_profile, retention_days, created_at) VALUES ('default', '{}', 30, ?) ON CONFLICT(id) DO NOTHING`).run(this.now())
    return this.getWorkspace()
  }

  getWorkspace() {
    return this.db.prepare('SELECT id, provider_profile AS providerProfile, retention_days AS retentionDays, created_at AS createdAt FROM workspace WHERE id = ?').get('default')
  }

  createSession(session) {
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, workspace_id, name, source, language, goal, prep, timezone, status, capture_state,
          transcript_revision, coverage_declared, retention_days, created_at, expires_at
        ) VALUES (
          @id, @workspaceId, @name, @source, @language, @goal, @prep, @timezone, @status, @captureState,
          @transcriptRevision, @coverageDeclared, @retentionDays, @createdAt, @expiresAt
        )`
      )
      .run(session)
    return this.getSession(session.id)
  }

  getSession(id) {
    return this.db.prepare(`SELECT ${sessionColumns} FROM sessions s WHERE s.id = ?`).get(id) ?? null
  }

  listSessions(limit = 50) {
    return this.db
      .prepare(
        `SELECT ${sessionColumns},
          (SELECT COUNT(*) FROM transcript_turns t WHERE t.session_id = s.id) AS turnCount,
          (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id) AS segmentCount,
          (SELECT COUNT(*) FROM coverage_gaps g WHERE g.session_id = s.id AND g.state = 'open') AS gapCount
        FROM sessions s
        WHERE s.status != 'deleted'
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ?`
      )
      .all(limit)
  }

  updateSession(id, patch) {
    const entries = Object.entries(patch).filter(([key, value]) => key in sessionPatchColumns && value !== undefined)
    if (!entries.length) return this.getSession(id)
    const assignments = entries.map(([key]) => `${sessionPatchColumns[key]} = @${key}`).join(', ')
    this.db.prepare(`UPDATE sessions SET ${assignments} WHERE id = @id`).run({ id, ...Object.fromEntries(entries) })
    return this.getSession(id)
  }

  deleteSession(id) {
    return this.transaction(() => {
      const session = this.getSession(id)
      if (!session) return null
      const audioPaths = this.db
        .prepare('SELECT audio_path AS audioPath FROM segments WHERE session_id = ?')
        .all(id)
        .map((row) => row.audioPath)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      return { session, audioPaths }
    })
  }

  countSegments(sessionId) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM segments WHERE session_id = ?').get(sessionId).count
  }

  sumAudioBytes(sessionId) {
    return this.db.prepare('SELECT COALESCE(SUM(audio_bytes), 0) AS bytes FROM segments WHERE session_id = ?').get(sessionId).bytes
  }

  sumRetainedAudioBytes() {
    return this.db.prepare(`SELECT COALESCE(SUM(audio_bytes), 0) AS bytes FROM segments WHERE state IN ('accepted', 'failed') AND audio_bytes > 0`).get().bytes
  }

  getSegment(id) {
    return this.db.prepare(`SELECT ${segmentColumns} FROM segments WHERE id = ?`).get(id) ?? null
  }

  getSegmentBySequence(sessionId, sequence) {
    return this.db.prepare(`SELECT ${segmentColumns} FROM segments WHERE session_id = ? AND sequence = ?`).get(sessionId, sequence) ?? null
  }

  listSegments(sessionId) {
    return this.db.prepare(`SELECT ${segmentColumns} FROM segments WHERE session_id = ? ORDER BY start_ms, sequence`).all(sessionId)
  }

  listExpiredAudio(now) {
    return this.db.prepare(`SELECT ${segmentColumns} FROM segments WHERE state IN ('accepted', 'failed') AND audio_bytes > 0 AND audio_expires_at <= ? ORDER BY audio_expires_at`).all(now)
  }

  insertSegment(segment) {
    this.db
      .prepare(
        `INSERT INTO segments (
          id, session_id, sequence, start_ms, end_ms, content_hash, audio_path, audio_bytes,
          state, created_at, audio_expires_at
        ) VALUES (
          @id, @sessionId, @sequence, @startMs, @endMs, @contentHash, @audioPath, @audioBytes,
          @state, @createdAt, @audioExpiresAt
        )`
      )
      .run(segment)
    return this.getSegment(segment.id)
  }

  insertJob(job) {
    this.db
      .prepare(
        `INSERT INTO jobs (
          id, type, session_id, segment_id, idempotency_key, state, attempts, max_attempts,
          run_after, created_at, updated_at
        ) VALUES (
          @id, @type, @sessionId, @segmentId, @idempotencyKey, @state, @attempts, @maxAttempts,
          @runAfter, @createdAt, @updatedAt
        )`
      )
      .run(job)
    return this.getJob(job.id)
  }

  markSegmentTranscribed(id, now) {
    this.db.prepare(`UPDATE segments SET state = 'transcribed', transcribed_at = ? WHERE id = ? AND state = 'accepted'`).run(now, id)
  }

  markSegmentFailed(id, now) {
    this.db.prepare(`UPDATE segments SET state = 'failed', transcribed_at = ? WHERE id = ? AND state = 'accepted'`).run(now, id)
  }

  markSegmentExpired(id, now) {
    this.db.prepare(`UPDATE segments SET state = 'expired', transcribed_at = ? WHERE id = ? AND state = 'accepted'`).run(now, id)
  }

  clearSegmentAudio(id) {
    this.db.prepare(`UPDATE segments SET audio_path = '', audio_bytes = 0 WHERE id = ?`).run(id)
  }

  failJobsForSegment(segmentId, message, now) {
    return this.db.prepare(`UPDATE jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE segment_id = ? AND state IN ('pending', 'running')`).run(message, now, segmentId).changes
  }

  getTurn(id) {
    return this.db.prepare(`SELECT ${turnColumns} FROM transcript_turns WHERE id = ?`).get(id) ?? null
  }

  getTurnBySegment(segmentId) {
    return this.db.prepare(`SELECT ${turnColumns} FROM transcript_turns WHERE segment_id = ?`).get(segmentId) ?? null
  }

  listTurns(sessionId) {
    return this.db.prepare(`SELECT ${turnColumns} FROM transcript_turns WHERE session_id = ? ORDER BY start_ms, created_at, id`).all(sessionId)
  }

  insertTurn(turn) {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO transcript_turns (
            id, session_id, segment_id, text, revision, source, start_ms, end_ms, created_at, updated_at
          ) VALUES (
            @id, @sessionId, @segmentId, @text, @revision, @source, @startMs, @endMs, @createdAt, @updatedAt
          ) ON CONFLICT(segment_id) DO NOTHING`
        )
        .run(turn)
      if (result.changes === 0) return { turn: this.getTurnBySegment(turn.segmentId), created: false }
      this.db.prepare(`INSERT INTO transcript_revisions (turn_id, revision, text, source, created_at) VALUES (?, ?, ?, ?, ?)`).run(turn.id, turn.revision, turn.text, turn.source, turn.createdAt)
      return { turn: this.getTurn(turn.id), created: true }
    })
  }

  updateTurnText(id, text, revision, source, now) {
    this.db.prepare(`UPDATE transcript_turns SET text = ?, revision = ?, source = ?, updated_at = ? WHERE id = ?`).run(text, revision, source, now, id)
    this.db.prepare(`INSERT INTO transcript_revisions (turn_id, revision, text, source, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, revision, text, source, now)
    return this.getTurn(id)
  }

  listRevisions(sessionId) {
    return this.db
      .prepare(
        `SELECT ${revisionColumns}
         FROM transcript_revisions r
         JOIN transcript_turns t ON t.id = r.turn_id
         WHERE t.session_id = ?
         ORDER BY t.start_ms, r.revision`
      )
      .all(sessionId)
  }

  sumTranscriptChars(sessionId) {
    return this.db.prepare('SELECT COALESCE(SUM(length(text)), 0) AS chars FROM transcript_turns WHERE session_id = ?').get(sessionId).chars
  }

  insertGap(gap) {
    const existing = this.db
      .prepare(
        `SELECT ${gapColumns} FROM coverage_gaps
         WHERE session_id = ? AND start_ms = ? AND IFNULL(end_ms, -1) = IFNULL(?, -1) AND reason = ?
         LIMIT 1`
      )
      .get(gap.sessionId, gap.startMs, gap.endMs ?? null, gap.reason)
    if (existing) return existing
    this.db
      .prepare(
        `INSERT INTO coverage_gaps (id, session_id, start_ms, end_ms, reason, state, created_at)
         VALUES (@id, @sessionId, @startMs, @endMs, @reason, @state, @createdAt)`
      )
      .run(gap)
    return this.db.prepare(`SELECT ${gapColumns} FROM coverage_gaps WHERE id = ?`).get(gap.id)
  }

  countOpenGaps(sessionId) {
    return this.db.prepare(`SELECT COUNT(*) AS count FROM coverage_gaps WHERE session_id = ? AND state = 'open'`).get(sessionId).count
  }

  listGaps(sessionId) {
    return this.db.prepare(`SELECT ${gapColumns} FROM coverage_gaps WHERE session_id = ? ORDER BY start_ms, created_at`).all(sessionId)
  }

  getJob(id) {
    return this.db.prepare(`SELECT ${jobColumns} FROM jobs WHERE id = ?`).get(id) ?? null
  }

  claimNextJob(now) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM jobs WHERE state = 'pending' AND run_after <= ? ORDER BY created_at, id LIMIT 1`).get(now)
      if (!row) return null
      const changed = this.db.prepare(`UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'pending'`).run(now, row.id)
      if (changed.changes !== 1) return null
      return this.getJob(row.id)
    })
  }

  finishJob(id, state, error, now) {
    return this.db.prepare(`UPDATE jobs SET state = ?, last_error = ?, updated_at = ? WHERE id = ? AND state IN ('pending', 'running')`).run(state, error ?? null, now, id).changes
  }

  retryJob(id, runAfter, error, now) {
    return this.db.prepare(`UPDATE jobs SET state = 'pending', run_after = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'running'`).run(runAfter, error, now, id).changes
  }

  recoverRunningJobs(now) {
    return this.db.prepare(`UPDATE jobs SET state = 'pending', run_after = ?, updated_at = ? WHERE state = 'running'`).run(now, now).changes
  }

  listJobs(sessionId) {
    return this.db.prepare(`SELECT ${jobColumns} FROM jobs WHERE session_id = ? ORDER BY created_at, id`).all(sessionId)
  }

  listExpiredSessions(now) {
    return this.db.prepare(`SELECT id FROM sessions WHERE status = 'ended' AND expires_at <= ?`).all(now)
  }
}
