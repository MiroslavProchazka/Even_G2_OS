import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ApiError } from '../errors.mjs'
import { deleteMemoryForSession } from './memory.mjs'
import { recordDeletedSessions } from './retention.mjs'
import { BYTES_PER_MS, ByteReader, WavError, makeWavHeader, parseWavHeader, validateWavBuffer } from './wav.mjs'

const SESSION_ID = /^ses_[a-f0-9]{32}$/
const SEGMENT_ID = /^seg_[a-f0-9]{32}$/
const TURN_ID = /^turn_[a-f0-9]{32}$/
const WRITER_ID = /^[A-Za-z0-9_.:-]{1,100}$/
const GAP_REASONS = new Set([
  'network',
  'ble',
  'capture_interrupted',
  'stt_failed',
  'transcription_failed',
  'audio_expired',
  'import_truncated',
  'import_aborted',
  'import_invalid',
  'missing_segment',
  'backend_restart',
  'unknown'
])

export const DEFAULT_LIMITS = {
  sessionRetentionDays: 30,
  audioRetentionMs: 24 * 60 * 60 * 1000,
  audioQuotaBytes: 512 * 1024 * 1024,
  maxSessionMs: 60 * 60 * 1000,
  maxTranscriptChars: 100000,
  maxImportBytes: 128 * 1024 * 1024,
  segmentMs: 30000,
  writerLeaseMs: 60000,
  minSegmentMs: 100,
  maxSegmentMs: 60000,
  workerMaxAttempts: 3,
  diskReserveBytes: 64 * 1024 * 1024
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function integer(value, name, min, max) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isInteger(number) || number < min || number > max) throw new ApiError(400, `invalid_${name}`, `${name} must be an integer between ${min} and ${max}.`)
  return number
}

function text(value, name, min, max) {
  if (typeof value !== 'string') throw new ApiError(400, `invalid_${name}`, `${name} must be a string.`)
  const trimmed = value.trim()
  if (trimmed.length < min || trimmed.length > max) throw new ApiError(400, `invalid_${name}`, `${name} must contain ${min}-${max} characters.`)
  return trimmed
}

function optionalText(value, name, max) {
  if (value === undefined || value === null) return ''
  return text(value, name, 0, max)
}

function oneOf(value, name, values) {
  if (!values.includes(value)) throw new ApiError(400, `invalid_${name}`, `${name} must be one of ${values.join(', ')}.`)
  return value
}

function clock(ms) {
  if (ms === null || ms === undefined) return 'unknown'
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

function publicSegment(segment) {
  const { audioPath: _audioPath, ...rest } = segment
  return rest
}

export class SessionService {
  constructor({ repo, dataDir, limits = {}, now = Date.now, logger = () => {} }) {
    this.repo = repo
    this.dataDir = path.resolve(dataDir)
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.limits.maxSegmentBytes = this.limits.maxSegmentMs * BYTES_PER_MS + 44
    this.now = now
    this.logger = logger
    this.workspace = repo.ensureWorkspace()
  }

  getLimits() {
    return { ...this.limits }
  }

  createSession(input = {}) {
    const name = text(input.name, 'name', 1, 200)
    const language = oneOf(input.language ?? 'cs', 'language', ['cs', 'en', 'auto'])
    const source = oneOf(input.source ?? 'import', 'source', ['import', 'g2'])
    const goal = optionalText(input.goal, 'goal', 4000)
    const prep = optionalText(input.prep, 'prep', 4000)
    const timezone = this.timezone(input.timezone ?? 'Europe/Prague')
    const retentionDays = input.retentionDays === undefined ? this.workspace.retentionDays : integer(input.retentionDays, 'retentionDays', 1, 365)
    const now = this.now()
    return this.repo.createSession({
      id: id('ses'),
      workspaceId: this.workspace.id,
      name,
      source,
      language,
      goal,
      prep,
      timezone,
      status: 'draft',
      captureState: 'off',
      transcriptRevision: 1,
      coverageDeclared: 'unknown',
      retentionDays,
      createdAt: now,
      expiresAt: now + retentionDays * 86400000
    })
  }

  listSessions({ limit = 50 } = {}) {
    return this.repo.listSessions(integer(limit, 'limit', 1, 100))
  }

  getSessionDetail(sessionId) {
    const session = this.requireSession(sessionId)
    return {
      session,
      segments: this.repo.listSegments(session.id).map(publicSegment),
      turns: this.repo.listTurns(session.id),
      gaps: this.repo.listGaps(session.id),
      jobs: this.repo.listJobs(session.id),
      summaries: this.summaryService?.listSummaries(session.id) ?? [],
      preparation: this.summaryService?.getLatestPreparation(session.id) ?? null
    }
  }

  attachSummaryService(summaryService) {
    this.summaryService = summaryService
    return this
  }

  invalidateSummaries(sessionId, reason) {
    try {
      this.summaryService?.markStaleForSession(sessionId, reason)
    } catch (error) {
      this.logger({ event: 'summary.stale_failed', sessionId, error: error instanceof Error ? error.message.slice(0, 500) : 'Summary invalidation failed.' })
    }
  }

  invalidateSummaryTurn(sessionId, turnId, reason) {
    try {
      this.summaryService?.markStaleForTurn(sessionId, turnId, reason)
    } catch (error) {
      this.logger({ event: 'summary.stale_failed', sessionId, error: error instanceof Error ? error.message.slice(0, 500) : 'Summary invalidation failed.' })
    }
  }

  startSession(sessionId, { writerId } = {}) {
    const writer = this.writerId(writerId)
    const now = this.now()
    return this.repo.transaction(() => {
      const session = this.requireSession(sessionId)
      if (session.status === 'ended') throw new ApiError(409, 'session_ended', 'Session has ended.')
      if (session.status === 'paused') throw new ApiError(409, 'session_paused', 'Resume the paused session instead.')
      if (session.status === 'active') {
        if (session.writerId === writer) {
          return this.repo.updateSession(session.id, {
            captureState: session.captureState === 'on' ? 'on' : 'starting',
            writerSeenAt: now
          })
        }
        if (this.leaseActive(session, now)) throw new ApiError(409, 'writer_conflict', 'Another writer is active on this session.')
      }
      if (session.status !== 'draft' && session.status !== 'active') throw new ApiError(409, 'invalid_state', 'Session cannot be started.')
      return this.repo.updateSession(session.id, {
        status: 'active',
        captureState: 'starting',
        writerId: writer,
        writerSeenAt: now,
        startedAt: session.startedAt ?? now
      })
    })
  }

  pauseSession(sessionId, { writerId } = {}) {
    const writer = this.writerId(writerId)
    const now = this.now()
    return this.repo.transaction(() => {
      const session = this.requireSession(sessionId)
      if (session.status === 'paused') {
        if (session.writerId === writer) {
          this.repo.updateSession(session.id, { writerSeenAt: now })
          return this.repo.getSession(session.id)
        }
        if (this.leaseActive(session, now)) throw new ApiError(409, 'writer_conflict', 'Another writer is active on this session.')
      }
      if (session.status !== 'active') throw new ApiError(409, 'invalid_state', 'Only an active session can be paused.')
      if (session.writerId !== writer) throw new ApiError(409, 'writer_conflict', 'Another writer owns this session.')
      return this.repo.updateSession(session.id, { status: 'paused', captureState: 'off', writerSeenAt: now })
    })
  }

  resumeSession(sessionId, { writerId } = {}) {
    const writer = this.writerId(writerId)
    const now = this.now()
    return this.repo.transaction(() => {
      const session = this.requireSession(sessionId)
      if (session.status === 'active') {
        if (session.writerId === writer) {
          return this.repo.updateSession(session.id, {
            captureState: session.captureState === 'on' ? 'on' : 'starting',
            writerSeenAt: now
          })
        }
        if (this.leaseActive(session, now)) throw new ApiError(409, 'writer_conflict', 'Another writer is active on this session.')
      }
      if (session.status !== 'paused') throw new ApiError(409, 'invalid_state', 'Only a paused session can be resumed.')
      if (session.writerId && session.writerId !== writer && this.leaseActive(session, now)) throw new ApiError(409, 'writer_conflict', 'Another writer is active on this session.')
      return this.repo.updateSession(session.id, {
        status: 'active',
        captureState: 'starting',
        writerId: writer,
        writerSeenAt: now
      })
    })
  }

  endSession(sessionId, { writerId, lastSequence, reason = 'user' } = {}) {
    const writer = this.writerId(writerId)
    const now = this.now()
    let gapsAdded = false
    const ended = this.repo.transaction(() => {
      const session = this.requireSession(sessionId)
      if (session.status === 'ended') return session
      if (session.status !== 'active' && session.status !== 'paused') throw new ApiError(409, 'invalid_state', 'Session cannot be ended.')
      if (session.writerId && session.writerId !== writer && this.leaseActive(session, now)) throw new ApiError(409, 'writer_conflict', 'Another writer owns this session.')
      if (lastSequence !== undefined) {
        const max = integer(lastSequence, 'lastSequence', 0, 1000000)
        const present = new Set(this.repo.listSegments(session.id).map((segment) => segment.sequence))
        for (let sequence = 0; sequence <= max; sequence++) {
          if (present.has(sequence)) continue
          gapsAdded = true
          this.repo.insertGap({
            id: id('gap'),
            sessionId: session.id,
            startMs: sequence * this.limits.segmentMs,
            endMs: null,
            reason: 'missing_segment',
            state: 'open',
            createdAt: now
          })
        }
      }
      const updated = this.repo.updateSession(session.id, {
        status: 'ended',
        captureState: 'off',
        writerSeenAt: now,
        endedAt: now,
        expiresAt: now + session.retentionDays * 86400000,
        endReason: text(reason, 'reason', 1, 100)
      })
      this.refreshCoverage(session.id)
      return this.repo.getSession(updated.id)
    })
    if (gapsAdded) this.invalidateSummaries(sessionId, 'transcript_incomplete')
    return ended
  }

  acceptSegment(sessionId, input = {}, { writerId } = {}) {
    const writer = this.writerId(writerId)
    const now = this.now()
    const result = this.repo.transaction(() => {
      const session = this.requireSession(sessionId)
      if (session.status === 'paused') throw new ApiError(409, 'session_paused', 'Session is paused.')
      if (session.status !== 'active') throw new ApiError(409, 'session_not_active', 'Session is not active.')
      this.requireWriter(session, writer, now)
      const segmentId = this.segmentId(input.id)
      const sequence = integer(input.sequence, 'sequence', 0, 1000000)
      const startMs = integer(input.startMs, 'startMs', 0, this.limits.maxSessionMs)
      const endMs = integer(input.endMs, 'endMs', startMs + 1, this.limits.maxSessionMs)
      const durationMs = endMs - startMs
      if (durationMs < this.limits.minSegmentMs || durationMs > this.limits.maxSegmentMs) {
        throw new ApiError(400, 'invalid_segment', `Segment duration must be ${this.limits.minSegmentMs}-${this.limits.maxSegmentMs} ms.`)
      }
      const audio = Buffer.isBuffer(input.audio) ? input.audio : null
      if (!audio) throw new ApiError(400, 'invalid_audio', 'Audio body is required.')
      let info
      try {
        info = validateWavBuffer(audio, { maxBytes: this.limits.maxSegmentBytes, maxDurationMs: this.limits.maxSegmentMs })
      } catch (error) {
        if (error instanceof WavError) throw new ApiError(400, 'invalid_audio', error.message)
        throw error
      }
      if (Math.abs(info.durationMs - durationMs) > 50) throw new ApiError(400, 'invalid_audio', 'Segment timestamps do not match the audio duration.')
      const contentHash = sha256(audio.subarray(44))
      const existing = this.repo.getSegment(segmentId)
      if (existing) {
        if (existing.contentHash === contentHash) return { segment: publicSegment(existing), duplicate: true }
        throw new ApiError(409, 'segment_conflict', 'Segment ID already exists with different content.')
      }
      const bySequence = this.repo.getSegmentBySequence(session.id, sequence)
      if (bySequence) throw new ApiError(409, 'sequence_conflict', 'Sequence number is already used by another segment.')
      if (this.repo.sumRetainedAudioBytes() + audio.length > this.limits.audioQuotaBytes) throw new ApiError(507, 'storage_full', 'Audio storage quota is exhausted.')
      this.ensureDiskSpace(audio.length)
      const audioPath = path.posix.join('audio', session.id, `${segmentId}.wav`)
      this.writeAudio(audioPath, audio)
      try {
        this.repo.insertSegment({
          id: segmentId,
          sessionId: session.id,
          sequence,
          startMs,
          endMs,
          contentHash,
          audioPath,
          audioBytes: audio.length,
          state: 'accepted',
          createdAt: now,
          audioExpiresAt: now + this.limits.audioRetentionMs
        })
        this.repo.insertJob({
          id: id('job'),
          type: 'transcribe',
          sessionId: session.id,
          segmentId,
          idempotencyKey: `transcribe:${segmentId}`,
          state: 'pending',
          attempts: 0,
          maxAttempts: this.limits.workerMaxAttempts,
          runAfter: now,
          createdAt: now,
          updatedAt: now
        })
      } catch (error) {
        this.removeAudio(audioPath)
        throw error
      }
      if (session.captureState !== 'on') this.repo.updateSession(session.id, { captureState: 'on' })
      return { segment: publicSegment(this.repo.getSegment(segmentId)), duplicate: false }
    })
    if (!result.duplicate) this.invalidateSummaries(sessionId, 'transcript_extended')
    return result
  }

  async importWav(sessionId, req, { writerId } = {}) {
    const writer = this.writerId(writerId)
    const now = this.now()
    const session = this.requireSession(sessionId)
    if (session.status === 'paused') throw new ApiError(409, 'session_paused', 'Session is paused.')
    if (session.status !== 'active') throw new ApiError(409, 'session_not_active', 'Session is not active.')
    this.requireWriter(session, writer, now)
    const declared = Number(req.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > this.limits.maxImportBytes + 44) throw new ApiError(413, 'too_large', 'Import exceeds the configured size limit.')
    const reader = new ByteReader(req)
    let info
    try {
      info = parseWavHeader(await reader.read(44), { maxBytes: this.limits.maxImportBytes, maxDurationMs: this.limits.maxSessionMs })
    } catch (error) {
      if (error instanceof WavError) throw new ApiError(400, 'invalid_audio', error.message)
      throw error
    }
    const segmentBytes = this.limits.segmentMs * BYTES_PER_MS
    let sequence = 0
    let received = 0
    let accepted = 0
    let duplicates = 0
    try {
      while (received < info.dataBytes) {
        const pcm = await reader.read(Math.min(segmentBytes, info.dataBytes - received))
        if (pcm.length === 0) break
        if (pcm.length % 2) throw new ApiError(400, 'invalid_audio', 'PCM16 data must have an even length.')
        const startMs = Math.round(received / BYTES_PER_MS)
        const endMs = Math.round((received + pcm.length) / BYTES_PER_MS)
        const segmentId = `seg_${sha256(`${sessionId}:${sequence}:${sha256(pcm)}`).slice(0, 32)}`
        const audio = Buffer.concat([makeWavHeader(pcm.length), pcm])
        const result = this.acceptSegment(sessionId, { id: segmentId, sequence, startMs, endMs, audio }, { writerId: writer })
        if (result.duplicate) duplicates++
        else accepted++
        received += pcm.length
        sequence++
      }
    } catch (error) {
      const conflict = error instanceof ApiError && error.status === 409
      if (!conflict && this.repo.getSession(sessionId) && received < info.dataBytes) {
        this.recordImportGap(sessionId, received, info.durationMs, error instanceof ApiError && error.status === 400 ? 'import_invalid' : 'import_aborted')
      }
      throw error
    }
    const truncated = received < info.dataBytes
    if (truncated) this.recordImportGap(sessionId, received, info.durationMs, 'import_truncated')
    this.repo.updateSession(sessionId, { captureState: 'off' })
    this.refreshCoverage(sessionId)
    return {
      sessionId,
      declaredDurationMs: info.durationMs,
      receivedDurationMs: Math.round(received / BYTES_PER_MS),
      segmentsAccepted: accepted,
      segmentsDuplicate: duplicates,
      truncated
    }
  }

  addGap(sessionId, input = {}) {
    const now = this.now()
    const gap = this.repo.transaction(() => {
      const session = this.requireSession(sessionId)
      if (session.status === 'draft') throw new ApiError(409, 'session_not_started', 'Start the session before recording a gap.')
      const startMs = integer(input.startMs, 'startMs', 0, this.limits.maxSessionMs)
      const endMs = input.endMs === undefined || input.endMs === null ? null : integer(input.endMs, 'endMs', startMs + 1, this.limits.maxSessionMs)
      const reason = oneOf(input.reason, 'reason', [...GAP_REASONS])
      const inserted = this.repo.insertGap({
        id: id('gap'),
        sessionId: session.id,
        startMs,
        endMs,
        reason,
        state: 'open',
        createdAt: now
      })
      this.refreshCoverage(session.id)
      return inserted
    })
    this.invalidateSummaries(sessionId, 'transcript_incomplete')
    return gap
  }

  correctTurn(sessionId, turnId, input = {}) {
    const now = this.now()
    return this.repo.transaction(() => {
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new ApiError(400, 'invalid_session', 'Invalid session ID.')
      if (typeof turnId !== 'string' || !TURN_ID.test(turnId)) throw new ApiError(400, 'invalid_turn', 'Invalid turn ID.')
      const turn = this.repo.getTurn(turnId)
      if (!turn || turn.sessionId !== sessionId) throw new ApiError(404, 'not_found', 'Turn not found.')
      const session = this.repo.getSession(turn.sessionId)
      if (!session) throw new ApiError(404, 'not_found', 'Session not found.')
      const corrected = text(input.text, 'text', 1, 4000)
      const updated = this.repo.updateTurnText(turn.id, corrected, turn.revision + 1, 'manual', now)
      this.repo.updateSession(session.id, { transcriptRevision: session.transcriptRevision + 1 })
      this.invalidateSummaryTurn(session.id, turn.id, 'transcript_corrected')
      return updated
    })
  }

  exportSession(sessionId, format = 'json') {
    if (!['json', 'markdown'].includes(format)) throw new ApiError(400, 'invalid_format', 'Use json or markdown.')
    const detail = this.getSessionDetail(sessionId)
    const exported = {
      formatVersion: 2,
      exportedAt: new Date(this.now()).toISOString(),
      session: detail.session,
      segments: detail.segments,
      turns: detail.turns,
      revisions: this.repo.listRevisions(detail.session.id),
      gaps: detail.gaps,
      jobs: detail.jobs,
      summaries: this.summaryService?.listSummaries(detail.session.id) ?? [],
      preparations: this.summaryService?.listPreparations(detail.session.id) ?? [],
      completeness: {
        declared: detail.session.coverageDeclared,
        segments: detail.segments.length,
        transcribedSegments: detail.segments.filter((segment) => segment.state === 'transcribed').length,
        openGaps: detail.gaps.filter((gap) => gap.state === 'open').length
      }
    }
    return format === 'markdown' ? this.renderMarkdown(exported) : exported
  }

  deleteSession(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new ApiError(400, 'invalid_session', 'Invalid session ID.')
    const now = this.now()
    // A manual delete is journaled in the same transaction as the hard delete, so a restore that predates it cannot
    // bring the session back. The journal row carries no text and no audio path. Memory items derived from the session
    // follow the same rule: they are deleted unless the caller explicitly keeps them, and a kept item records that its
    // evidence is gone instead of pointing at a missing turn.
    const result = this.repo.transaction(() => {
      const session = this.repo.getSession(sessionId)
      if (!session) return null
      recordDeletedSessions(this.repo.db, [{ sessionId, deletedAt: now, reason: 'user_deleted', retentionDeadline: session.expiresAt }])
      deleteMemoryForSession(this.repo.db, sessionId, { keep: options.keepMemory === true, now })
      return this.repo.deleteSession(sessionId)
    })
    if (!result) return false
    for (const audioPath of result.audioPaths) this.removeAudio(audioPath)
    return true
  }

  prune(now = this.now()) {
    const expiredAudio = this.repo.listExpiredAudio(now)
    for (const segment of expiredAudio) {
      this.repo.transaction(() => {
        if (!this.repo.getSession(segment.sessionId)) return
        if (segment.state === 'accepted') {
          this.repo.markSegmentExpired(segment.id, now)
          this.repo.failJobsForSegment(segment.id, 'Audio expired before transcription.', now)
          this.repo.insertGap({
            id: id('gap'),
            sessionId: segment.sessionId,
            startMs: segment.startMs,
            endMs: segment.endMs,
            reason: 'audio_expired',
            state: 'open',
            createdAt: now
          })
        }
        this.repo.clearSegmentAudio(segment.id)
        this.refreshCoverage(segment.sessionId)
      })
      this.removeAudio(segment.audioPath)
      if (segment.state === 'accepted') this.invalidateSummaries(segment.sessionId, 'transcript_incomplete')
    }
    const expiredSessions = this.repo.listExpiredSessions(now)
    for (const session of expiredSessions) this.deleteSession(session.id)
    return { audio: expiredAudio.length, sessions: expiredSessions.length }
  }

  recordTranscription({ job, text: transcript, now = this.now() }) {
    const clean = typeof transcript === 'string' ? transcript.trim() : ''
    if (!clean || clean.length > 4000) throw new Error('Invalid transcript.')
    const result = this.repo.transaction(() => {
      const session = this.repo.getSession(job.sessionId)
      const segment = this.repo.getSegment(job.segmentId)
      if (!session || !segment) return { discarded: 'session_missing' }
      if (segment.state !== 'accepted') {
        this.repo.finishJob(job.id, 'cancelled', `Segment is ${segment.state}.`, now)
        return { discarded: `segment_${segment.state}` }
      }
      const chars = this.repo.sumTranscriptChars(session.id) + clean.length
      const result = this.repo.insertTurn({
        id: id('turn'),
        sessionId: session.id,
        segmentId: segment.id,
        text: clean,
        revision: 1,
        source: 'stt',
        startMs: segment.startMs,
        endMs: segment.endMs,
        createdAt: now,
        updatedAt: now
      })
      this.repo.markSegmentTranscribed(segment.id, now)
      this.repo.finishJob(job.id, 'done', null, now)
      let limitReached = false
      if (result.created && chars > this.limits.maxTranscriptChars) {
        if (session.status !== 'ended') {
          this.repo.updateSession(session.id, {
            status: 'ended',
            captureState: 'off',
            endedAt: now,
            expiresAt: now + session.retentionDays * 86400000,
            endReason: 'character_limit'
          })
        } else if (!session.endReason) {
          this.repo.updateSession(session.id, { endReason: 'character_limit' })
        }
        limitReached = true
      }
      this.refreshCoverage(session.id)
      return { turn: result.turn, created: result.created, limitReached, audioPath: segment.audioPath, segmentId: segment.id }
    })
    if (result.discarded) return result
    if (result.created) this.invalidateSummaries(job.sessionId, 'transcript_extended')
    if (result.audioPath) {
      this.removeAudio(result.audioPath)
      this.repo.clearSegmentAudio(result.segmentId)
    }
    return { turn: result.turn, created: result.created, limitReached: result.limitReached }
  }

  recordTranscriptionFailure({ job, error, retry, retryAt, now = this.now() }) {
    const message = typeof error === 'string' && error.trim() ? error.trim().slice(0, 500) : 'Transcription failed.'
    const result = this.repo.transaction(() => {
      const session = this.repo.getSession(job.sessionId)
      const segment = this.repo.getSegment(job.segmentId)
      if (!session || !segment) return { discarded: 'session_missing' }
      if (segment.state !== 'accepted') {
        this.repo.finishJob(job.id, 'cancelled', `Segment is ${segment.state}.`, now)
        return { discarded: `segment_${segment.state}` }
      }
      if (retry) {
        this.repo.retryJob(job.id, retryAt, message, now)
        return { retry: true }
      }
      this.repo.markSegmentFailed(segment.id, now)
      this.repo.insertGap({
        id: id('gap'),
        sessionId: session.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        reason: 'transcription_failed',
        state: 'open',
        createdAt: now
      })
      this.repo.finishJob(job.id, 'failed', message, now)
      this.refreshCoverage(session.id)
      return { failed: true, audioPath: segment.audioPath, segmentId: segment.id }
    })
    if (result.failed && result.audioPath) {
      this.removeAudio(result.audioPath)
      this.repo.clearSegmentAudio(result.segmentId)
    }
    if (result.failed) this.invalidateSummaries(job.sessionId, 'transcript_incomplete')
    return result
  }

  audioPath(relativePath) {
    const target = path.resolve(this.dataDir, relativePath)
    const root = `${this.dataDir}${path.sep}`
    if (!target.startsWith(root)) throw new Error('Audio path escapes the data directory.')
    return target
  }

  requireSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new ApiError(400, 'invalid_session', 'Invalid session ID.')
    const session = this.repo.getSession(sessionId)
    if (!session) throw new ApiError(404, 'not_found', 'Session not found.')
    return session
  }

  writerId(value) {
    if (typeof value !== 'string' || !WRITER_ID.test(value)) throw new ApiError(400, 'invalid_writer', 'writerId must be 1-100 characters of letters, digits, dot, colon, underscore or dash.')
    return value
  }

  segmentId(value) {
    if (typeof value !== 'string' || !SEGMENT_ID.test(value)) throw new ApiError(400, 'invalid_segment', 'Invalid segment ID.')
    return value
  }

  timezone(value) {
    if (typeof value !== 'string' || !value || value.length > 64) throw new ApiError(400, 'invalid_timezone', 'Invalid timezone.')
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format()
    } catch {
      throw new ApiError(400, 'invalid_timezone', 'Invalid IANA timezone.')
    }
    return value
  }

  leaseActive(session, now) {
    return Boolean(session.writerId && session.writerSeenAt && now - session.writerSeenAt < this.limits.writerLeaseMs)
  }

  requireWriter(session, writer, now) {
    if (session.writerId !== writer) throw new ApiError(409, 'writer_conflict', 'Another writer owns this session.')
    this.repo.updateSession(session.id, { writerSeenAt: now })
  }

  refreshCoverage(sessionId) {
    const session = this.repo.getSession(sessionId)
    if (!session) return
    const segments = this.repo.countSegments(sessionId)
    const gaps = this.repo.countOpenGaps(sessionId)
    const coverage = segments === 0 ? 'unknown' : gaps > 0 ? 'partial' : 'complete'
    if (coverage !== session.coverageDeclared) this.repo.updateSession(sessionId, { coverageDeclared: coverage })
  }

  recordImportGap(sessionId, receivedBytes, declaredDurationMs, reason) {
    const startMs = Math.round(receivedBytes / BYTES_PER_MS)
    if (startMs >= declaredDurationMs) return null
    const session = this.repo.getSession(sessionId)
    if (!session) return null
    const gap = this.repo.insertGap({
      id: id('gap'),
      sessionId,
      startMs,
      endMs: declaredDurationMs,
      reason,
      state: 'open',
      createdAt: this.now()
    })
    this.refreshCoverage(sessionId)
    this.invalidateSummaries(sessionId, 'transcript_incomplete')
    return gap
  }

  ensureDiskSpace(incomingBytes) {
    const stats = statfsSync(this.dataDir)
    const free = stats.bavail * stats.bsize
    if (free - incomingBytes < this.limits.diskReserveBytes) throw new ApiError(507, 'storage_full', 'Gateway disk is full. No segment was accepted.')
  }

  writeAudio(relativePath, audio) {
    const target = this.audioPath(relativePath)
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, audio, { mode: 0o600 })
      renameSync(temporary, target)
    } catch {
      try {
        unlinkSync(temporary)
      } catch {
        /* The temporary file may not exist. */
      }
      this.removeAudio(relativePath)
      throw new ApiError(507, 'storage_full', 'Audio could not be stored. No segment was accepted.')
    }
  }

  removeAudio(relativePath) {
    if (!relativePath) return
    try {
      unlinkSync(this.audioPath(relativePath))
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger({ event: 'audio.delete_failed', path: relativePath, error: error.message })
    }
  }

  renderMarkdown(exported) {
    const lines = [
      `# ${exported.session.name}`,
      '',
      `- Session: ${exported.session.id}`,
      `- Language: ${exported.session.language}`,
      `- Status: ${exported.session.status}`,
      `- Coverage: ${exported.completeness.declared}`,
      `- Segments: ${exported.completeness.segments} accepted, ${exported.completeness.transcribedSegments} transcribed`,
      `- Open gaps: ${exported.completeness.openGaps}`,
      `- Created: ${new Date(exported.session.createdAt).toISOString()}`,
      `- Started: ${exported.session.startedAt ? new Date(exported.session.startedAt).toISOString() : 'not started'}`,
      `- Ended: ${exported.session.endedAt ? new Date(exported.session.endedAt).toISOString() : 'not ended'}`,
      ''
    ]
    if (exported.session.goal) lines.push(`Goal: ${exported.session.goal}`, '')
    if (exported.session.prep) lines.push(`Preparation: ${exported.session.prep}`, '')
    lines.push('## Transcript', '')
    if (!exported.turns.length) lines.push('_No transcribed speech._', '')
    for (const turn of exported.turns) {
      lines.push(`### ${clock(turn.startMs)}–${clock(turn.endMs)} · ${turn.segmentId} · rev ${turn.revision}`, '', turn.text, '')
    }
    lines.push('## Coverage gaps', '')
    if (!exported.gaps.length) lines.push('_No known gaps._', '')
    for (const gap of exported.gaps) lines.push(`- ${clock(gap.startMs)}–${clock(gap.endMs)}: ${gap.reason} (${gap.state})`)
    lines.push('')
    lines.push('## Summaries', '')
    if (!exported.summaries.length) lines.push('_No summary._', '')
    for (const summary of exported.summaries) {
      lines.push(
        `### ${summary.id} · ${summary.status} · transcript rev ${summary.transcriptRevision}${summary.reviewStatus === 'edited' ? ' · manually edited' : ''}`,
        '',
        summary.content.overview?.text ?? '',
        ''
      )
      if (summary.content.decisions?.length) {
        lines.push('#### Decisions', '')
        for (const decision of summary.content.decisions) lines.push(`- ${decision.text} [${decision.citations.join(', ')}]`)
        lines.push('')
      }
      if (summary.content.actionCandidates?.length) {
        lines.push('#### Action candidates', '')
        for (const action of summary.content.actionCandidates) {
          const owner = action.owner ? `owner: ${action.owner}` : 'owner unknown'
          const due = action.dueText ? `due: ${action.dueText}` : action.due ? `due: ${action.due}` : 'due unknown'
          const conditional = action.conditional ? ', conditional proposal' : ''
          lines.push(`- ${action.text} (${owner}, ${due}${conditional}) [${action.citations.join(', ')}]`)
        }
        lines.push('')
      }
      if (summary.content.openQuestions?.length) {
        lines.push('#### Open questions', '')
        for (const question of summary.content.openQuestions) lines.push(`- ${question.text} [${question.citations.join(', ')}]`)
        lines.push('')
      }
      if (summary.citations?.length) {
        lines.push('#### Citations', '')
        for (const citation of summary.citations) lines.push(`- ${citation.turnId} rev ${citation.turnRevision}: ${citation.quote}`)
        lines.push('')
      }
    }
    lines.push('## Next preparation', '')
    if (!exported.preparations.length) lines.push('_No preparation._', '')
    for (const preparation of exported.preparations) {
      const source = preparation.content.source ?? {}
      lines.push(
        `### ${preparation.id} · ${preparation.status}`,
        '',
        `Source: ${source.sessionName ?? source.sessionId ?? 'unknown'} · ${source.summaryId ?? 'unknown'} · ${source.sessionDate ?? 'unknown date'}`,
        ''
      )
      if (preparation.content.focus) lines.push(`Focus: ${preparation.content.focus}`, '')
      for (const decision of preparation.content.summary?.decisions ?? []) lines.push(`- Decision: ${decision.text} [${decision.citations.join(', ')}]`)
      for (const action of preparation.content.summary?.actionCandidates ?? []) lines.push(`- Action: ${action.text} [${action.citations.join(', ')}]`)
      lines.push('')
    }
    return lines.join('\n')
  }
}
