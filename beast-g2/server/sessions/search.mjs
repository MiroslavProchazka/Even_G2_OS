// Full-text search over the final transcript. The FTS5 index and its triggers live in
// migrations/003-search.mjs; this module only turns a user query into a safe MATCH expression and reads ranked hits.
import { ApiError } from '../errors.mjs'

const MAX_TOKENS = 8
const MAX_TOKEN_CHARS = 40
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 50

// `transcript_search` is a standalone FTS5 table, so every column has to be selected explicitly. The joins keep a hit
// readable and drop a session that was soft-deleted (`sessions` has no deleted_at column: deletion sets status = 'deleted').
const SEARCH_SQL = `
  SELECT transcript_search.turn_id AS turnId,
         transcript_search.session_id AS sessionId,
         transcript_search.revision AS revision,
         s.name AS sessionName,
         s.created_at AS sessionCreatedAt,
         s.started_at AS sessionStartedAt,
         t.start_ms AS startMs,
         t.end_ms AS endMs,
         snippet(transcript_search, 3, '[', ']', '…', 12) AS snippet,
         bm25(transcript_search) AS rank
    FROM transcript_search
    JOIN sessions s ON s.id = transcript_search.session_id
    JOIN transcript_turns t ON t.id = transcript_search.turn_id
   WHERE transcript_search MATCH ?
     AND s.status != 'deleted'
   ORDER BY rank ASC, t.start_ms ASC, transcript_search.turn_id ASC
   LIMIT ?`

/**
 * Splits a user query on everything that is not a letter or a digit. FTS5 operators (OR, NOT, NEAR, `*`, quotes,
 * parentheses, column filters) cannot survive this split, and every remaining token is quoted again before it reaches
 * `MATCH`, so user input is always read as text. At most eight tokens of forty characters each are kept.
 */
export function tokenizeQuery(query) {
  return String(query ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN_CHARS))
}

/** FTS5 string literals escape a double quote by doubling it; tokens cannot contain one, but the escape stays. */
export function matchExpression(tokens) {
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}

/** The route and the client both bound the limit; a missing or malformed value falls back to the default. */
export function clampLimit(value) {
  const number = Number(value ?? DEFAULT_LIMIT)
  if (!Number.isFinite(number)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(number)))
}

/**
 * Finds transcript passages that contain every token of the query. Results are ordered by bm25 ascending (the best match
 * first) and then by the position in the session, so a query with several equally good hits reads in transcript order.
 * A query without letters or digits is a client mistake and fails with 400 `query_required`.
 */
export function searchSessions(repository, { query, limit } = {}) {
  const tokens = tokenizeQuery(query)
  if (!tokens.length) throw new ApiError(400, 'query_required', 'Enter a search query.')
  const rows = repository.db.prepare(SEARCH_SQL).all(matchExpression(tokens), clampLimit(limit))
  return rows.map(({ rank: _rank, ...result }) => result)
}
