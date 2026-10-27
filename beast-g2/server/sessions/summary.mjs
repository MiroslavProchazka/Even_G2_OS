import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from '../errors.mjs'
import { SUMMARY_PROMPT_VERSION, collectCitations, mergeSummaryParts, validateSummaryContent } from './summary-content.mjs'

const SESSION_ID = /^ses_[a-f0-9]{32}$/
const SUMMARY_ID = /^sum_[a-f0-9]{32}$/

export const SUMMARY_LIMITS = {
  summaryMaxChars: 100000,
  summaryChunkChars: 12000,
  summaryMaxChunks: 12,
  summaryMaxItems: 100,
  summaryTimeoutMs: 90000
}

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function message(error) {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : 'Summary generation failed.'
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function optionalText(value, name, max) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new ApiError(400, `invalid_${name}`, `${name} must be a string.`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new ApiError(400, `invalid_${name}`, `${name} must contain at most ${max} characters.`)
  return trimmed
}

function chunkTurns(turns, limits) {
  const total = turns.reduce((sum, turn) => sum + turn.text.length, 0)
  if (total > limits.summaryMaxChars) throw new ApiError(413, 'summary_too_large', 'Transcript exceeds the summary input limit.')
  const chunks = []
  let current = []
  let chars = 0
  for (const turn of turns) {
    const cost = turn.text.length + 80
    if (current.length && chars + cost > limits.summaryChunkChars) {
      chunks.push(current)
      current = []
      chars = 0
    }
    current.push(turn)
    chars += cost
  }
  if (current.length) chunks.push(current)
  if (chunks.length > limits.summaryMaxChunks) throw new ApiError(413, 'summary_too_large', 'Transcript needs too many summary chunks.')
  return chunks
}

export class SummaryService {
  constructor({ repo, generate, generator = 'unknown', limits = {}, now = Date.now, logger = () => {} }) {
    this.repo = repo
    this.generate = generate
    this.generator = generator
    this.limits = { ...SUMMARY_LIMITS }
    for (const [key, value] of Object.entries(limits)) if (value !== undefined) this.limits[key] = value
    this.now = now
    this.logger = logger
    this.pending = new Set()
    this.running = new Map()
  }

  getLimits() {
    return { ...this.limits }
  }

  requestSummary(sessionId, { allowPartial = false, force = false } = {}) {
    if (typeof allowPartial !== 'boolean' || typeof force !== 'boolean') throw new ApiError(400, 'invalid_summary', 'allowPartial and force must be booleans.')
    const session = this.requireSession(sessionId)
    if (session.status !== 'ended' && !allowPartial)
      throw new ApiError(409, 'session_not_ended', 'The session has not ended. End it before requesting a summary, or explicitly allow partial coverage.')
    const pendingTranscriptions = this.repo.countPendingTranscriptionJobs(session.id)
    if (!allowPartial && pendingTranscriptions > 0) throw new ApiError(409, 'transcription_pending', 'Wait for pending transcription, or explicitly allow partial coverage.')
    const turns = this.repo.listTurns(session.id)
    if (!turns.length) throw new ApiError(409, 'no_transcript', 'The session has no final transcript turns.')
    chunkTurns(turns, this.limits)
    const now = this.now()
    const gaps = this.repo.listGaps(session.id)
    const gapKey = gaps.map((gap) => `${gap.startMs}:${gap.endMs ?? 'x'}:${gap.reason}`).join('|')
    const coverageKey = session.status === 'ended' && pendingTranscriptions === 0 && session.coverageDeclared === 'complete' ? 'complete' : `partial:${digest(gapKey)}:${pendingTranscriptions}`
    const key = `summarize:${session.id}:${session.transcriptRevision}:${coverageKey}`
    const existing = this.repo.getSummaryByIdempotencyKey(key)
    const previous = existing ?? this.repo.getLatestSummary(session.id)
    if (!existing && previous?.reviewStatus === 'edited' && previous.status !== 'failed' && !force)
      throw new ApiError(409, 'summary_edited', 'The summary has a manual edit. Request regeneration with force to replace it.')
    let idempotencyKey = key
    if (existing) {
      if (existing.reviewStatus === 'edited' && existing.status !== 'failed' && !force)
        throw new ApiError(409, 'summary_edited', 'The summary has a manual edit. Request regeneration with force to replace it.')
      if (existing.status === 'pending' && !force) return { summary: this.view(existing), created: false }
      if (existing.status === 'ready' && !force) return { summary: this.view(existing), created: false }
      if (existing.status === 'stale' && !force) throw new ApiError(409, 'summary_stale', 'The summary is stale. Regenerate it explicitly.')
      if (existing.status === 'failed' && !force) {
        const reset = this.repo.transaction(() => {
          this.repo.replaceSummaryCitations(existing.id, [])
          this.repo.replaceActionCandidates(existing.id, session.id, [], now)
          return this.repo.updateSummary(existing.id, {
            status: 'pending',
            reviewStatus: 'unreviewed',
            contentJson: '{}',
            coverageJson: '{}',
            lastError: null,
            staleReason: null,
            readyAt: null,
            editedAt: null,
            updatedAt: now
          })
        })
        this.launch(reset.id)
        return { summary: this.view(this.repo.getSummary(reset.id)), created: false }
      }
      if (existing.status === 'pending') return { summary: this.view(existing), created: false }
      this.repo.updateSummary(existing.id, {
        idempotencyKey: `${key}:superseded:${randomUUID()}`,
        status: 'stale',
        staleReason: 'superseded_by_regeneration',
        updatedAt: now
      })
      this.repo.markPreparationsStaleForSummary(existing.id, 'superseded_by_regeneration', now)
      idempotencyKey = key
    }
    const summary = this.repo.insertSummary({
      id: id('sum'),
      sessionId: session.id,
      transcriptRevision: session.transcriptRevision,
      generator: this.generator,
      promptVersion: SUMMARY_PROMPT_VERSION,
      contentJson: '{}',
      coverageJson: '{}',
      status: 'pending',
      reviewStatus: 'unreviewed',
      staleReason: null,
      lastError: null,
      supersedesId: previous?.id ?? null,
      idempotencyKey,
      createdAt: now,
      updatedAt: now
    })
    this.launch(summary.id)
    return { summary: this.view(this.repo.getSummary(summary.id)), created: true }
  }

  run(summaryId) {
    const running = this.running.get(summaryId)
    if (running) return running
    const promise = this.execute(summaryId).finally(() => this.running.delete(summaryId))
    this.running.set(summaryId, promise)
    return promise
  }

  async execute(summaryId) {
    const summary = this.repo.getSummary(summaryId)
    if (!summary || summary.status !== 'pending') return summary ? this.view(summary) : null
    const session = this.repo.getSession(summary.sessionId)
    if (!session) {
      this.repo.updateSummary(summary.id, { status: 'failed', lastError: 'Session was deleted.', updatedAt: this.now() })
      return null
    }
    if (session.transcriptRevision !== summary.transcriptRevision) {
      this.repo.updateSummary(summary.id, {
        status: 'stale',
        staleReason: 'transcript_changed_before_generation',
        updatedAt: this.now()
      })
      const stale = this.repo.getSummary(summary.id)
      return stale ? this.view(stale) : null
    }
    const turns = this.repo.listTurns(session.id)
    try {
      if (!turns.length) throw new ApiError(409, 'no_transcript', 'The session has no final transcript turns.')
      const chunks = chunkTurns(turns, this.limits)
      const parts = []
      for (const [index, chunk] of chunks.entries()) {
        const raw = await this.generate({
          session,
          turns: chunk,
          chunk: { index, count: chunks.length },
          signal: AbortSignal.timeout(this.limits.summaryTimeoutMs)
        })
        parts.push(validateSummaryContent(raw, chunk, { maxItems: this.limits.summaryMaxItems }))
      }
      const content = mergeSummaryParts(parts, { maxItems: this.limits.summaryMaxItems })
      const currentSummary = this.repo.getSummary(summary.id)
      if (!currentSummary || currentSummary.status !== 'pending') return currentSummary ? this.view(currentSummary) : null
      const current = this.repo.getSession(session.id)
      if (!current || current.transcriptRevision !== summary.transcriptRevision) {
        this.repo.updateSummary(summary.id, {
          status: 'stale',
          staleReason: 'transcript_changed_during_generation',
          updatedAt: this.now()
        })
        const stale = this.repo.getSummary(summary.id)
        return stale ? this.view(stale) : null
      }
      const pendingTranscriptions = this.repo.countPendingTranscriptionJobs(current.id)
      const declared = current.status === 'ended' && pendingTranscriptions === 0 ? current.coverageDeclared : current.coverageDeclared === 'unknown' ? 'unknown' : 'partial'
      const coverage = {
        declared,
        turns: turns.length,
        pendingTranscriptions,
        gaps: this.repo.listGaps(current.id)
      }
      const citations = collectCitations(content, turns)
      const finalContent = { ...content, coverage }
      const completedAt = this.now()
      const actions = finalContent.actionCandidates.map((candidate) => ({
        id: id('act'),
        text: candidate.text,
        owner: candidate.owner,
        due: candidate.due,
        dueText: candidate.dueText,
        conditional: candidate.conditional ? 1 : 0,
        citationsJson: JSON.stringify(candidate.citations)
      }))
      const finalized = this.repo.transaction(() => {
        const latestSummary = this.repo.getSummary(summary.id)
        if (!latestSummary || latestSummary.status !== 'pending') return false
        const latestSession = this.repo.getSession(session.id)
        if (!latestSession || latestSession.transcriptRevision !== summary.transcriptRevision) {
          this.repo.updateSummary(summary.id, {
            status: 'stale',
            staleReason: 'transcript_changed_during_generation',
            updatedAt: completedAt
          })
          return false
        }
        this.repo.replaceSummaryCitations(
          summary.id,
          citations.map((citation) => ({ ...citation, createdAt: completedAt }))
        )
        this.repo.replaceActionCandidates(summary.id, session.id, actions, completedAt)
        this.repo.updateSummary(summary.id, {
          status: 'ready',
          contentJson: JSON.stringify(finalContent),
          coverageJson: JSON.stringify(coverage),
          readyAt: completedAt,
          updatedAt: completedAt,
          lastError: null,
          staleReason: null
        })
        return true
      })
      if (!finalized) {
        const stored = this.repo.getSummary(summary.id)
        return stored ? this.view(stored) : null
      }
      const stored = this.repo.getSummary(summary.id)
      return stored ? this.view(stored) : null
    } catch (error) {
      const failedAt = this.now()
      const current = this.repo.getSummary(summary.id)
      if (!current || current.status !== 'pending') return current ? this.view(current) : null
      this.repo.transaction(() => {
        this.repo.replaceSummaryCitations(summary.id, [])
        this.repo.replaceActionCandidates(summary.id, session.id, [], failedAt)
        this.repo.updateSummary(summary.id, {
          status: 'failed',
          lastError: message(error),
          updatedAt: failedAt
        })
      })
      throw error
    }
  }

  async waitForIdle() {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  recoverPending() {
    const changed = this.repo.failPendingSummaries(this.now(), 'Gateway restarted before summary generation completed.')
    if (changed) this.logger({ event: 'summary.recovered', summaries: changed })
    return changed
  }

  listSummaries(sessionId) {
    this.requireSession(sessionId)
    return this.repo.listSummaries(sessionId).map((row) => this.view(row))
  }

  getSummary(sessionId, summaryId) {
    return this.view(this.requireSummary(sessionId, summaryId))
  }

  getLatestSummary(sessionId) {
    this.requireSession(sessionId)
    const summary = this.repo.getLatestSummary(sessionId)
    return summary ? this.view(summary) : null
  }

  updateSummary(sessionId, summaryId, input = {}) {
    const summary = this.requireSummary(sessionId, summaryId)
    if (summary.status !== 'ready') throw new ApiError(409, 'summary_not_ready', 'Only a ready summary can be edited.')
    const turns = this.repo.listTurns(sessionId)
    const content = {
      ...validateSummaryContent(input.content, turns, {
        status: 400,
        maxItems: this.limits.summaryMaxItems
      }),
      coverage: parseJson(summary.coverageJson, {})
    }
    const citations = collectCitations(content, turns)
    const actions = content.actionCandidates.map((candidate) => ({
      id: id('act'),
      text: candidate.text,
      owner: candidate.owner,
      due: candidate.due,
      dueText: candidate.dueText,
      conditional: candidate.conditional ? 1 : 0,
      citationsJson: JSON.stringify(candidate.citations)
    }))
    const now = this.now()
    this.repo.transaction(() => {
      this.repo.replaceSummaryCitations(
        summary.id,
        citations.map((citation) => ({ ...citation, createdAt: now }))
      )
      this.repo.replaceActionCandidates(summary.id, sessionId, actions, now)
      this.repo.updateSummary(summary.id, {
        contentJson: JSON.stringify(content),
        status: 'ready',
        reviewStatus: 'edited',
        editedAt: now,
        updatedAt: now,
        staleReason: null,
        lastError: null
      })
      this.repo.markPreparationsStaleForSummary(summary.id, 'summary_edited', now)
    })
    return this.view(this.repo.getSummary(summary.id))
  }

  createPreparation(sessionId, input = {}) {
    const target = this.requireSession(sessionId)
    if (typeof input.sourceSummaryId !== 'string' || !SUMMARY_ID.test(input.sourceSummaryId)) throw new ApiError(400, 'invalid_summary', 'Invalid summary ID.')
    const source = this.repo.getSummary(input.sourceSummaryId)
    if (!source) throw new ApiError(404, 'not_found', 'Summary not found.')
    if (source.status !== 'ready') throw new ApiError(409, 'summary_not_ready', 'Only a ready summary can be used as preparation.')
    const sourceSession = this.repo.getSession(source.sessionId)
    if (!sourceSession) throw new ApiError(404, 'not_found', 'Source session not found.')
    const citations = this.repo.listSummaryCitations(source.id)
    const citationIsCurrent = citations.every((citation) => {
      const turn = this.repo.getTurn(citation.turnId)
      return turn && turn.revision === citation.turnRevision
    })
    if (!citationIsCurrent) throw new ApiError(409, 'summary_stale', 'The summary no longer matches the transcript. Regenerate it first.')
    const focus = optionalText(input.focus, 'focus', 4000)
    const now = this.now()
    const content = {
      schemaVersion: 1,
      focus,
      source: {
        sessionId: sourceSession.id,
        sessionName: sourceSession.name,
        summaryId: source.id,
        summaryCreatedAt: new Date(source.readyAt ?? source.createdAt).toISOString(),
        transcriptRevision: source.transcriptRevision,
        sessionDate: new Date(sourceSession.endedAt ?? sourceSession.createdAt).toISOString()
      },
      summary: parseJson(source.contentJson, {}),
      citations: citations.map((citation) => ({
        ...citation,
        date: new Date(sourceSession.endedAt ?? sourceSession.createdAt).toISOString()
      }))
    }
    const preparation = this.repo.insertPreparation({
      id: id('prep'),
      sessionId: target.id,
      sourceSessionId: source.sessionId,
      sourceSummaryId: source.id,
      sourceTranscriptRevision: source.transcriptRevision,
      focus,
      contentJson: JSON.stringify(content),
      status: 'ready',
      staleReason: null,
      createdAt: now,
      updatedAt: now
    })
    return this.preparationView(preparation)
  }

  getPreparation(sessionId, preparationId) {
    this.requireSession(sessionId)
    if (typeof preparationId !== 'string' || !/^prep_[a-f0-9]{32}$/.test(preparationId)) throw new ApiError(400, 'invalid_preparation', 'Invalid preparation ID.')
    const preparation = this.repo.getPreparation(preparationId)
    if (!preparation || preparation.sessionId !== sessionId) throw new ApiError(404, 'not_found', 'Preparation not found.')
    return this.preparationView(preparation)
  }

  getLatestPreparation(sessionId) {
    this.requireSession(sessionId)
    const preparation = this.repo.getLatestPreparation(sessionId)
    return preparation ? this.preparationView(preparation) : null
  }

  listPreparations(sessionId) {
    this.requireSession(sessionId)
    return this.repo.listPreparations(sessionId).map((row) => this.preparationView(row))
  }

  markStaleForSession(sessionId, reason) {
    const now = this.now()
    const changed = this.repo.markSummariesStaleForSession(sessionId, reason, now)
    this.repo.markPreparationsStaleForSession(sessionId, reason, now)
    return changed
  }

  markStaleForTurn(sessionId, turnId, reason) {
    const now = this.now()
    return this.repo.markSummariesStaleForTurn(sessionId, turnId, reason, now)
  }

  launch(summaryId) {
    const promise = this.run(summaryId)
      .catch((error) => {
        try {
          const current = this.repo.getSummary(summaryId)
          if (current?.status === 'stale') return
          this.logger({ event: 'summary.failed', summaryId, error: message(error) })
        } catch {
          /* The database may already be closed during shutdown. */
        }
      })
      .finally(() => this.pending.delete(promise))
    this.pending.add(promise)
  }

  requireSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new ApiError(400, 'invalid_session', 'Invalid session ID.')
    const session = this.repo.getSession(sessionId)
    if (!session) throw new ApiError(404, 'not_found', 'Session not found.')
    return session
  }

  requireSummary(sessionId, summaryId) {
    if (typeof summaryId !== 'string' || !SUMMARY_ID.test(summaryId)) throw new ApiError(400, 'invalid_summary', 'Invalid summary ID.')
    const summary = this.repo.getSummary(summaryId)
    if (!summary || summary.sessionId !== sessionId) throw new ApiError(404, 'not_found', 'Summary not found.')
    return summary
  }

  view(row) {
    const { contentJson, coverageJson, idempotencyKey: _idempotencyKey, ...rest } = row
    return {
      ...rest,
      content: parseJson(contentJson, {}),
      coverage: parseJson(coverageJson, {}),
      citations: this.repo.listSummaryCitations(row.id).map(({ summaryId: _summaryId, ...citation }) => citation),
      actionCandidates: this.repo.listActionCandidates(row.id).map(({ citationsJson, conditional, summaryId: _summaryId, ...candidate }) => ({
        ...candidate,
        conditional: Boolean(conditional),
        citations: parseJson(citationsJson, [])
      }))
    }
  }

  preparationView(row) {
    const { contentJson, ...rest } = row
    return { ...rest, content: parseJson(contentJson, {}) }
  }
}
