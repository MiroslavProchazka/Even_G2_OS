// Memory items: one claim taken from one concrete transcript turn, proposed by the model and approved or rejected
// by the user. A proposal is never returned by default retrieval; `listMemoryItems` returns approved items unless the
// panel asks for another status or `all`.
//
// The table lives in migrations/005-memory.mjs. It has no foreign key to `sessions` or `transcript_turns`: an approved
// item may outlive its source session when the user deletes it with `keepMemory=1`, and the row then carries
// `sourceDeleted` with `evidenceState: 'lost'` instead of pointing at a row that no longer exists.
import { randomUUID } from 'node:crypto'
import { ApiError } from '../errors.mjs'

export const MEMORY_KINDS = ['decision', 'commitment', 'fact', 'preference', 'open_question']
export const MEMORY_STATUSES = ['proposed', 'approved', 'rejected', 'superseded']
export const MEMORY_TEXT_MAX = 500
export const MEMORY_QUERY_MAX = 200

const SESSION_ID = /^ses_[a-f0-9]{32}$/
const TURN_ID = /^turn_[a-f0-9]{32}$/
const MEMORY_ID = /^mem_[a-f0-9]{32}$/

const memoryColumns = `
  id, workspace_id AS workspaceId, session_id AS sessionId, turn_id AS turnId,
  turn_revision AS turnRevision, kind, text, source_quote AS sourceQuote, status,
  supersedes_id AS supersedesId, source_deleted AS sourceDeleted, evidence_state AS evidenceState,
  created_at AS createdAt, updated_at AS updatedAt, approved_at AS approvedAt,
  rejected_at AS rejectedAt, superseded_at AS supersededAt`

const INSERT_SQL = `
  INSERT INTO memory_items (
    id, workspace_id, session_id, turn_id, turn_revision, kind, text, source_quote, status,
    supersedes_id, source_deleted, evidence_state, created_at, updated_at
  ) VALUES (
    @id, @workspaceId, @sessionId, @turnId, @turnRevision, @kind, @text, @sourceQuote, @status,
    @supersedesId, @sourceDeleted, @evidenceState, @createdAt, @updatedAt
  )`

/** `mem_` plus 32 lowercase hex characters, the same shape as the other stored ids. */
export function memoryItemId() {
  return `mem_${randomUUID().replaceAll('-', '')}`
}

/** Case- and diacritics-insensitive text, so `rozpoctu` finds `rozpočtu`. */
export function foldText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

function publicItem(row) {
  return { ...row, sourceDeleted: Boolean(row.sourceDeleted) }
}

function requireSession(repo, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new ApiError(400, 'invalid_session', 'Invalid session ID.')
  const session = repo.getSession(sessionId)
  if (!session) throw new ApiError(404, 'not_found', 'Session not found.')
  return session
}

function requireMemoryId(memoryId) {
  if (typeof memoryId !== 'string' || !MEMORY_ID.test(memoryId)) throw new ApiError(400, 'invalid_memory', 'Invalid memory item ID.')
  return memoryId
}

function requireKind(value) {
  if (!MEMORY_KINDS.includes(value)) throw new ApiError(400, 'invalid_kind', `kind must be one of ${MEMORY_KINDS.join(', ')}.`)
  return value
}

function requireText(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_text', 'text must be a string.')
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > MEMORY_TEXT_MAX) {
    throw new ApiError(400, 'invalid_text', `text must contain 1-${MEMORY_TEXT_MAX} characters.`)
  }
  return trimmed
}

function requireQuery(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_query', 'query must be a string.')
  const trimmed = value.trim()
  if (trimmed.length > MEMORY_QUERY_MAX) throw new ApiError(400, 'invalid_query', `query must contain at most ${MEMORY_QUERY_MAX} characters.`)
  return trimmed
}

function requireItem(repo, sessionId, memoryId) {
  const item = getMemoryItem({ repo, sessionId, memoryId })
  if (!item) throw new ApiError(404, 'not_found', 'Memory item not found.')
  return item
}

/**
 * Proposes one item from one concrete turn. The session, the turn and the turn revision are checked against the
 * database, so a proposal cannot name a foreign turn or a transcript text the user has already corrected. `sourceQuote`
 * is the exact turn text at that revision; the claim text stays the caller's wording.
 */
export function proposeMemoryItem({ repo, workspaceId, sessionId, turnId, revision, kind, text, now = Date.now() }) {
  const session = requireSession(repo, sessionId)
  if (session.workspaceId !== workspaceId) throw new ApiError(404, 'not_found', 'Session not found.')
  if (typeof turnId !== 'string' || !TURN_ID.test(turnId)) throw new ApiError(400, 'invalid_turn', 'Invalid turn ID.')
  const turn = repo.getTurn(turnId)
  if (!turn || turn.sessionId !== sessionId) throw new ApiError(404, 'not_found', 'Turn not found.')
  if (!Number.isInteger(revision)) throw new ApiError(400, 'invalid_revision', 'revision must be an integer.')
  if (turn.revision !== revision) throw new ApiError(409, 'stale_revision', 'The turn was revised; use its current revision.')
  const item = {
    id: memoryItemId(),
    workspaceId,
    sessionId,
    turnId: turn.id,
    turnRevision: turn.revision,
    kind: requireKind(kind),
    text: requireText(text),
    sourceQuote: turn.text,
    status: 'proposed',
    supersedesId: null,
    sourceDeleted: 0,
    evidenceState: 'present',
    createdAt: now,
    updatedAt: now
  }
  repo.db.prepare(INSERT_SQL).run(item)
  return getMemoryItem({ repo, sessionId, memoryId: item.id })
}

/** One item of this session, or null. A memory id from another session is never returned. */
export function getMemoryItem({ repo, sessionId, memoryId, approvedOnly = false }) {
  requireMemoryId(memoryId)
  const row = repo.db.prepare(`SELECT ${memoryColumns} FROM memory_items WHERE id = ? AND session_id = ?`).get(memoryId, sessionId)
  if (!row) return null
  if (approvedOnly && row.status !== 'approved') throw new ApiError(404, 'not_found', 'Memory item not found.')
  return publicItem(row)
}

/**
 * Items of one session. The default is `approved`; `all` is for the panel and returns every status. A query is
 * optional, at most 200 characters, and is folded for Czech diacritics before it is matched as a substring of the
 * item text. Only this session's rows are read, so another session's items can never leak into the result.
 */
export function listMemoryItems({ repo, sessionId, status, query } = {}) {
  requireSession(repo, sessionId)
  const wanted = status === undefined || status === null || status === '' ? 'approved' : status
  if (wanted !== 'all' && !MEMORY_STATUSES.includes(wanted)) {
    throw new ApiError(400, 'invalid_status', `status must be all or one of ${MEMORY_STATUSES.join(', ')}.`)
  }
  const needle = query === undefined || query === null ? '' : requireQuery(query)
  const rows =
    wanted === 'all'
      ? repo.db.prepare(`SELECT ${memoryColumns} FROM memory_items WHERE session_id = ? ORDER BY created_at DESC, id DESC`).all(sessionId)
      : repo.db.prepare(`SELECT ${memoryColumns} FROM memory_items WHERE session_id = ? AND status = ? ORDER BY created_at DESC, id DESC`).all(sessionId, wanted)
  const items = rows.map(publicItem)
  if (!needle) return items
  const folded = foldText(needle)
  return items.filter((item) => foldText(item.text).includes(folded))
}

/**
 * Kept items whose source session was deleted. This is the only cross-session read: normal retrieval stays scoped to one
 * session, while a kept item has no session row left to open. The list is workspace-scoped, defaults to every status and
 * supports the same folded query as the per-session list.
 */
export function listRetainedMemoryItems({ repo, workspaceId, status, query } = {}) {
  const wanted = status === undefined || status === null || status === '' ? 'all' : status
  if (wanted !== 'all' && !MEMORY_STATUSES.includes(wanted)) {
    throw new ApiError(400, 'invalid_status', `status must be all or one of ${MEMORY_STATUSES.join(', ')}.`)
  }
  const needle = query === undefined || query === null ? '' : requireQuery(query)
  const rows =
    wanted === 'all'
      ? repo.db.prepare(`SELECT ${memoryColumns} FROM memory_items WHERE workspace_id = ? AND source_deleted = 1 ORDER BY updated_at DESC, id DESC`).all(workspaceId)
      : repo.db.prepare(`SELECT ${memoryColumns} FROM memory_items WHERE workspace_id = ? AND source_deleted = 1 AND status = ? ORDER BY updated_at DESC, id DESC`).all(workspaceId, wanted)
  const items = rows.map(publicItem)
  if (!needle) return items
  const folded = foldText(needle)
  return items.filter((item) => foldText(item.text).includes(folded))
}

/**
 * Approves or rejects a proposed item. The same status is idempotent and keeps the original timestamp; any other
 * transition, including leaving a rejected or superseded item, is a conflict.
 */
export function setMemoryStatus({ repo, sessionId, memoryId, status, now = Date.now() }) {
  if (status !== 'approved' && status !== 'rejected') throw new ApiError(400, 'invalid_status', 'status must be approved or rejected.')
  requireSession(repo, sessionId)
  const item = requireItem(repo, sessionId, memoryId)
  if (item.status === status) return item
  if (item.status !== 'proposed') throw new ApiError(409, 'invalid_transition', `A ${item.status} item cannot become ${status}.`)
  const changed = repo.db
    .prepare(
      `UPDATE memory_items
       SET status = ?, approved_at = ?, rejected_at = ?, updated_at = ?
       WHERE id = ? AND session_id = ? AND status = 'proposed'`
    )
    .run(status, status === 'approved' ? now : null, status === 'rejected' ? now : null, now, memoryId, sessionId).changes
  if (changed !== 1) throw new ApiError(409, 'invalid_transition', 'The memory item changed while it was being reviewed.')
  return requireItem(repo, sessionId, memoryId)
}

/**
 * Replaces an item with a new proposed one that keeps the same turn, revision and source quote. The old row is kept
 * and marked `superseded`, so the history of a claim stays readable. Rejected and superseded items cannot be replaced.
 */
export function supersedeMemoryItem({ repo, sessionId, memoryId, kind, text, now = Date.now() }) {
  return repo.transaction(() => {
    requireSession(repo, sessionId)
    const old = requireItem(repo, sessionId, memoryId)
    if (old.status !== 'proposed' && old.status !== 'approved') {
      throw new ApiError(409, 'invalid_transition', `A ${old.status} item cannot be replaced.`)
    }
    const replacement = {
      id: memoryItemId(),
      workspaceId: old.workspaceId,
      sessionId,
      turnId: old.turnId,
      turnRevision: old.turnRevision,
      kind: kind === undefined || kind === null ? old.kind : requireKind(kind),
      text: requireText(text),
      sourceQuote: old.sourceQuote,
      status: 'proposed',
      supersedesId: old.id,
      sourceDeleted: old.sourceDeleted ? 1 : 0,
      evidenceState: old.evidenceState,
      createdAt: now,
      updatedAt: now
    }
    repo.db.prepare(INSERT_SQL).run(replacement)
    repo.db.prepare(`UPDATE memory_items SET status = 'superseded', superseded_at = ?, updated_at = ? WHERE id = ? AND session_id = ?`).run(now, now, old.id, sessionId)
    return {
      item: requireItem(repo, sessionId, replacement.id),
      superseded: requireItem(repo, sessionId, old.id)
    }
  })
}

/**
 * Applies the source-deletion rule in the same transaction as the session delete. Without `keep` every item derived
 * from the session is removed. With `keep` each surviving item keeps its text but records that its evidence is gone:
 * `source_deleted = 1` and `evidence_state = 'lost'`.
 */
export function deleteMemoryForSession(db, sessionId, { keep = false, now = Date.now() } = {}) {
  if (keep) {
    const kept = db.prepare(`UPDATE memory_items SET source_deleted = 1, evidence_state = 'lost', updated_at = ? WHERE session_id = ? AND source_deleted = 0`).run(now, sessionId).changes
    return { deleted: 0, kept }
  }
  const deleted = db.prepare('DELETE FROM memory_items WHERE session_id = ?').run(sessionId).changes
  return { deleted, kept: 0 }
}
