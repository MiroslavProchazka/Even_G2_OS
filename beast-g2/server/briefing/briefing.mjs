// Deterministic briefing over 1-3 stored sessions. It reads the latest summary of each selected session, never calls a
// model and never writes. A claim is included only when its source is verified against the current transcript revision.
// Contract: docs/BRIEFING.md.
import { ApiError } from '../errors.mjs'

export const BRIEFING_MAX_SESSIONS = 3
export const BRIEFING_MAX_BODY = 16000
const KIND_ORDER = new Map([
  ['overview', 0],
  ['decision', 1],
  ['commitment', 2],
  ['open_question', 3]
])

function iso(value) {
  return new Date(value).toISOString()
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Validates the request selection. A non-array, a non-string or a blank id is invalid_selection; an empty array is
 * empty_selection; more than three unique ids is too_many_sessions. Duplicates are dropped in first-seen order.
 */
export function selectSessionIds(value) {
  if (!Array.isArray(value)) throw new ApiError(400, 'invalid_selection', 'sessionIds must be an array of session IDs.')
  if (value.length === 0) throw new ApiError(400, 'empty_selection', 'Select at least one session.')
  const ids = []
  for (const id of value) {
    if (typeof id !== 'string' || !id.trim()) throw new ApiError(400, 'invalid_selection', 'Every session ID must be a non-empty string.')
    if (!ids.includes(id)) ids.push(id)
  }
  if (ids.length > BRIEFING_MAX_SESSIONS) throw new ApiError(400, 'too_many_sessions', `Select at most ${BRIEFING_MAX_SESSIONS} sessions.`)
  return ids
}

/** Returns the claim list or null when the stored content is malformed. An absent list means no claims. */
function claimList(content, key) {
  const value = content[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const claims = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const text = nonEmpty(item.text)
    if (!text) return null
    if (!Array.isArray(item.citations) || item.citations.length === 0) return null
    if (!item.citations.every((id) => typeof id === 'string' && id)) return null
    claims.push({ text, citations: item.citations })
  }
  return claims
}

/** Stored action candidates carry the stable id used by the commitment item. */
function storedActions(summary) {
  if (!Array.isArray(summary.actionCandidates)) return null
  const actions = []
  for (const candidate of summary.actionCandidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const id = nonEmpty(candidate.id)
    const text = nonEmpty(candidate.text)
    if (!id || !text) return null
    if (!Array.isArray(candidate.citations) || candidate.citations.length === 0) return null
    if (!candidate.citations.every((citation) => typeof citation === 'string' && citation)) return null
    actions.push({
      id,
      text,
      owner: nonEmpty(candidate.owner),
      due: nonEmpty(candidate.due),
      dueText: nonEmpty(candidate.dueText),
      conditional: Boolean(candidate.conditional),
      citations: candidate.citations
    })
  }
  return actions
}

function unique(values) {
  return [...new Set(values)]
}

/**
 * Verifies one source. The reason order follows docs/BRIEFING.md: a missing summary, a summary that is not ready, a
 * transcript revision mismatch, malformed content and finally a citation that is missing or stale.
 */
function verifySource(session, summary, turns) {
  if (!summary) return { reason: 'no_summary' }
  if (summary.status === 'pending') return { reason: 'summary_pending' }
  if (summary.status === 'failed') return { reason: 'summary_failed' }
  if (summary.status === 'stale') return { reason: 'summary_stale' }
  if (summary.status !== 'ready') return { reason: 'summary_invalid' }
  if (summary.transcriptRevision !== session.transcriptRevision) return { reason: 'transcript_changed' }

  const content = summary.content
  if (!content || typeof content !== 'object' || Array.isArray(content)) return { reason: 'summary_invalid' }
  const overview = content.overview
  if (!overview || typeof overview !== 'object' || Array.isArray(overview)) return { reason: 'summary_invalid' }
  if (!nonEmpty(overview.text)) return { reason: 'summary_invalid' }
  if (!Array.isArray(overview.citations) || overview.citations.length === 0) return { reason: 'summary_invalid' }
  if (!overview.citations.every((id) => typeof id === 'string' && id)) return { reason: 'summary_invalid' }

  const decisions = claimList(content, 'decisions')
  const contentActions = claimList(content, 'actionCandidates')
  const openQuestions = claimList(content, 'openQuestions')
  if (!decisions || !contentActions || !openQuestions) return { reason: 'summary_invalid' }
  const actions = storedActions(summary)
  if (!actions) return { reason: 'summary_invalid' }

  const summaryCitations = Array.isArray(summary.citations) ? summary.citations : []
  if (summaryCitations.length === 0) return { reason: 'summary_invalid' }
  const citationsByTurn = new Map()
  for (const citation of summaryCitations) {
    if (!citation || typeof citation !== 'object' || typeof citation.turnId !== 'string' || !citation.turnId) return { reason: 'summary_invalid' }
    citationsByTurn.set(citation.turnId, citation)
  }
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]))
  const used = unique([
    ...overview.citations,
    ...decisions.flatMap((item) => item.citations),
    ...contentActions.flatMap((item) => item.citations),
    ...openQuestions.flatMap((item) => item.citations),
    ...actions.flatMap((item) => item.citations)
  ])
  for (const id of used) if (!citationsByTurn.has(id) || !turnsById.has(id)) return { reason: 'citation_missing' }
  for (const id of used) {
    const citation = citationsByTurn.get(id)
    const turn = turnsById.get(id)
    if (!Number.isInteger(citation.turnRevision) || citation.turnRevision !== turn.revision) return { reason: 'citation_stale' }
  }
  return { reason: null, overview, decisions, actions, openQuestions, citationsByTurn, turnsById }
}

function citationViews(ids, citationsByTurn, turnsById) {
  return unique(ids).map((id) => {
    const citation = citationsByTurn.get(id)
    const turn = turnsById.get(id)
    return {
      turnId: citation.turnId,
      turnRevision: citation.turnRevision,
      startMs: citation.startMs,
      endMs: citation.endMs,
      quote: nonEmpty(citation.quote) ?? turn.text
    }
  })
}

function sourceRef(source) {
  return {
    sessionId: source.sessionId,
    sessionName: source.sessionName,
    sessionDate: source.sessionDate,
    summaryId: source.summaryId,
    summaryCreatedAt: source.summaryCreatedAt,
    verification: 'verified'
  }
}

function itemsFor(source, summary, verified) {
  const base = { verification: 'verified', source: sourceRef(source) }
  const items = []
  const overview = verified.overview
  items.push({
    id: `${summary.id}:overview`,
    kind: 'overview',
    text: overview.text,
    owner: null,
    due: null,
    dueText: null,
    conditional: false,
    ...base,
    citations: citationViews(overview.citations, verified.citationsByTurn, verified.turnsById)
  })
  for (const [index, decision] of verified.decisions.entries())
    items.push({
      id: `${summary.id}:decision:${index}`,
      kind: 'decision',
      text: decision.text,
      owner: null,
      due: null,
      dueText: null,
      conditional: false,
      ...base,
      citations: citationViews(decision.citations, verified.citationsByTurn, verified.turnsById)
    })
  for (const action of verified.actions)
    items.push({
      id: `${summary.id}:commitment:${action.id}`,
      kind: 'commitment',
      text: action.text,
      owner: action.owner,
      due: action.due,
      dueText: action.dueText,
      conditional: action.conditional,
      ...base,
      citations: citationViews(action.citations, verified.citationsByTurn, verified.turnsById)
    })
  for (const [index, question] of verified.openQuestions.entries())
    items.push({
      id: `${summary.id}:open_question:${index}`,
      kind: 'open_question',
      text: question.text,
      owner: null,
      due: null,
      dueText: null,
      conditional: false,
      ...base,
      citations: citationViews(question.citations, verified.citationsByTurn, verified.turnsById)
    })
  return items
}

/**
 * Builds the briefing from session details in selection order. `detail.summaries[0]` is the latest summary, already
 * newest-first. Only a verified source contributes items; an unverified source contributes none and keeps its reason.
 */
export function buildBriefing(details, { generatedAt = new Date().toISOString() } = {}) {
  const sources = []
  const entries = []
  for (const [sourceIndex, detail] of details.entries()) {
    const session = detail.session
    const summary = detail.summaries?.[0] ?? null
    const sessionDate = iso(session.endedAt ?? session.startedAt ?? session.createdAt)
    const verified = verifySource(session, summary, detail.turns ?? [])
    const source = {
      sessionId: session.id,
      sessionName: session.name,
      sessionDate,
      summaryId: summary?.id ?? null,
      summaryCreatedAt: summary ? iso(summary.readyAt ?? summary.createdAt) : null,
      summaryStatus: summary?.status ?? null,
      reviewStatus: summary?.reviewStatus ?? null,
      transcriptRevision: session.transcriptRevision,
      summaryTranscriptRevision: summary?.transcriptRevision ?? null,
      verification: verified.reason === null ? 'verified' : 'unverified',
      reason: verified.reason,
      coverage: summary?.coverage ?? null
    }
    sources.push(source)
    if (verified.reason !== null) continue
    for (const [order, item] of itemsFor(source, summary, verified).entries()) entries.push({ item, sourceIndex, order })
  }
  entries.sort((a, b) => KIND_ORDER.get(a.item.kind) - KIND_ORDER.get(b.item.kind) || a.sourceIndex - b.sourceIndex || a.order - b.order)
  return { generatedAt, maxSessions: BRIEFING_MAX_SESSIONS, sources, items: entries.map((entry) => entry.item) }
}

/** Builds one briefing from the stored sessions service. Read-only: no model call, no write. */
export function createBriefingService({ service, now = Date.now }) {
  if (!service || typeof service.getSessionDetail !== 'function') throw new Error('Briefing requires the session service.')
  return {
    build(sessionIds) {
      const ids = selectSessionIds(sessionIds)
      const details = ids.map((id) => {
        let detail
        try {
          detail = service.getSessionDetail(id)
        } catch (error) {
          if (error instanceof ApiError && (error.status === 400 || error.status === 404)) throw new ApiError(404, 'not_found', 'Session not found.')
          throw error
        }
        if (!detail?.session || detail.session.status === 'deleted') throw new ApiError(404, 'not_found', 'Session not found.')
        return detail
      })
      return buildBriefing(details, { generatedAt: new Date(now()).toISOString() })
    }
  }
}
