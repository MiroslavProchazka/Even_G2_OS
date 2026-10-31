// Read-only public HTTP API. Every route is a GET, every response is scoped and every
// read is limited to the workspace carried by the bearer token. No route writes.
//
//   GET /api/public/me
//   GET /api/public/sessions?limit=
//   GET /api/public/sessions/:id
//   GET /api/public/sessions/:id/summary
//   GET /api/public/memory
//
// The gateway mounts this module before its own token check, so a public token never has to
// match GATEWAY_TOKEN and a gateway token never opens these routes. See docs/API.md.
import { ApiError } from '../errors.mjs'
import { sendJson } from '../http-util.mjs'
import { listWorkspaceMemoryItems } from '../sessions/memory.mjs'
import { authenticatePublicToken, requireScope } from './scopes.mjs'

const PREFIX = '/api/public'
const SESSION_ID = /^ses_[a-f0-9]{32}$/
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const SESSION_FIELDS = ['id', 'name', 'status', 'source', 'language', 'createdAt', 'startedAt', 'endedAt', 'transcriptRevision', 'coverageDeclared']
const TURN_FIELDS = ['id', 'text', 'revision', 'startMs', 'endMs', 'createdAt']
const GAP_FIELDS = ['startMs', 'endMs', 'reason']
const SUMMARY_FIELDS = ['id', 'status', 'reviewStatus', 'transcriptRevision', 'createdAt', 'readyAt', 'editedAt', 'content', 'citations', 'actionCandidates', 'coverage']
const MEMORY_FIELDS = ['id', 'kind', 'text', 'sessionId', 'turnId', 'turnRevision', 'status', 'evidenceState', 'createdAt', 'updatedAt', 'approvedAt']

/** Copies only the named fields, so a new repository column can never leak by accident. */
function pick(row, fields) {
  return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]))
}

function matchRoute(pathname) {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null
  const parts = pathname.slice(PREFIX.length).split('/').filter(Boolean)
  if (parts.length === 1 && parts[0] === 'me') return { name: 'me' }
  if (parts.length === 1 && parts[0] === 'memory') return { name: 'memory' }
  if (parts.length === 1 && parts[0] === 'sessions') return { name: 'sessions' }
  if (parts.length === 2 && parts[0] === 'sessions') return { name: 'session', sessionId: parts[1] }
  if (parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'summary') return { name: 'summary', sessionId: parts[1] }
  return null
}

function parseLimit(searchParams) {
  const raw = searchParams.get('limit')
  if (raw === null) return DEFAULT_LIMIT
  if (!/^[0-9]+$/.test(raw)) throw new ApiError(400, 'invalid_limit', `limit must be an integer between 1 and ${MAX_LIMIT}.`)
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ApiError(400, 'invalid_limit', `limit must be an integer between 1 and ${MAX_LIMIT}.`)
  return limit
}

/**
 * Returns the stored session only when it belongs to the token workspace. An unknown id, a
 * malformed id, a deleted session and a foreign session are indistinguishable: all four are
 * `404 not_found`, and the caller cannot learn whether the id exists.
 */
function ownSession(sessions, entry, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new ApiError(404, 'not_found', 'Session not found.')
  const session = sessions.repo.getSession(sessionId)
  if (!session || session.workspaceId !== entry.workspaceId || session.status === 'deleted') throw new ApiError(404, 'not_found', 'Session not found.')
  return session
}

/**
 * `tokens` is the validated array from `parsePublicApiTokens`. The API is enabled only when at
 * least one token and the stored session service exist; otherwise every path is
 * `404 public_api_disabled`.
 */
export function createPublicApi({ tokens = [], sessions, summaries } = {}) {
  const enabled = Array.isArray(tokens) && tokens.length > 0 && Boolean(sessions)

  async function route(req, res, pathname, requestId) {
    if (!enabled) throw new ApiError(404, 'public_api_disabled', 'The public API is not enabled.')
    const entry = authenticatePublicToken(tokens, req.headers.authorization)
    if (!entry) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      throw new ApiError(401, 'unauthorized', 'A valid public API token is required.')
    }
    const match = matchRoute(pathname)
    if (!match) throw new ApiError(404, 'not_found', 'Not found.')
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      throw new ApiError(405, 'method_not_allowed', 'Only GET is supported.')
    }
    if (match.name === 'me') {
      return sendJson(res, 200, { token: { name: entry.name, scopes: [...entry.scopes], workspaceId: entry.workspaceId }, requestId })
    }
    if (match.name === 'sessions') {
      requireScope(entry, 'sessions:read')
      const limit = parseLimit(new URL(req.url, 'http://localhost').searchParams)
      // The repository filters by workspace before the limit, so a busy foreign workspace cannot
      // push this token's own rows out of the result.
      const own = sessions.listSessions({ limit, workspaceId: entry.workspaceId })
      return sendJson(res, 200, { sessions: own.map((row) => pick(row, SESSION_FIELDS)), requestId })
    }
    if (match.name === 'session') {
      requireScope(entry, 'sessions:read')
      const session = ownSession(sessions, entry, match.sessionId)
      const detail = sessions.getSessionDetail(session.id)
      return sendJson(res, 200, {
        session: pick(detail.session, SESSION_FIELDS),
        turns: detail.turns.map((turn) => pick(turn, TURN_FIELDS)),
        gaps: detail.gaps.map((gap) => pick(gap, GAP_FIELDS)),
        coverage: { declared: detail.session.coverageDeclared, pendingTranscriptions: sessions.repo.countPendingTranscriptionJobs(detail.session.id) },
        requestId
      })
    }
    if (match.name === 'summary') {
      requireScope(entry, 'summaries:read')
      const session = ownSession(sessions, entry, match.sessionId)
      const summary = summaries?.getLatestSummary(session.id)
      if (!summary) throw new ApiError(404, 'not_found', 'Summary not found.')
      return sendJson(res, 200, { summary: pick(summary, SUMMARY_FIELDS), requestId })
    }
    if (match.name === 'memory') {
      requireScope(entry, 'memory:read')
      const items = listWorkspaceMemoryItems({ repo: sessions.repo, workspaceId: entry.workspaceId, status: 'approved' })
      return sendJson(res, 200, { items: items.map((item) => pick(item, MEMORY_FIELDS)), requestId })
    }
    throw new ApiError(404, 'not_found', 'Not found.')
  }

  return { enabled, route }
}
