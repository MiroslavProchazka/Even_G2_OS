const MAX_ENTRIES = 200
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/
const METHOD = /^[A-Z]{3,10}$/
const STAGES = new Set(['stt', 'chat', 'sessions', 'briefing', 'public', 'health', 'app', 'other'])

/** Path only: a query string, fragment or unexpected character never reaches the log. */
export function safeRoute(value) {
  let pathname
  try {
    pathname = new URL(String(value ?? ''), 'http://localhost').pathname
  } catch {
    return '/'
  }
  const cleaned = pathname.replace(/[^A-Za-z0-9._~/-]/g, '_').slice(0, 200)
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`
}

/**
 * Builds the only shape the request log may contain. Every field is validated against a fixed allowlist so a token,
 * transcript, prompt, query string or provider body cannot pass through even if a caller supplies it by mistake.
 */
export function requestEntry(input = {}) {
  const entry = {
    at: new Date().toISOString(),
    event: 'request.finished',
    requestId: typeof input.requestId === 'string' && REQUEST_ID.test(input.requestId) ? input.requestId : 'invalid',
    method: typeof input.method === 'string' && METHOD.test(input.method) ? input.method : 'UNKNOWN',
    route: safeRoute(input.route),
    status: Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : 0,
    durationMs: Number.isFinite(input.durationMs) && input.durationMs >= 0 ? Math.round(input.durationMs * 100) / 100 : 0
  }
  if (typeof input.code === 'string' && ERROR_CODE.test(input.code)) entry.code = input.code
  if (typeof input.stage === 'string' && STAGES.has(input.stage)) entry.stage = input.stage
  return entry
}

/**
 * Bounded, dependency-free request ring. The optional writer receives the same structured entry, so stdout and the
 * in-memory inspection surface never disagree.
 */
export function createRequestLog({ write, limit = MAX_ENTRIES } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid request log capacity.')
  const entries = []
  const snapshot = () => entries.map((entry) => ({ ...entry }))
  return {
    record(input) {
      const entry = requestEntry(input)
      entries.push(entry)
      if (entries.length > limit) entries.splice(0, entries.length - limit)
      try {
        write?.(entry)
      } catch {
        /* Logging must never break a response. */
      }
      return entry
    },
    snapshot,
    find(requestId) {
      return snapshot().find((entry) => entry.requestId === requestId)
    },
    size() {
      return entries.length
    },
    clear() {
      entries.length = 0
    },
    export() {
      return JSON.stringify({ format: 'beast-g2-request-log-v1', capacity: limit, entries: snapshot() }, null, 2)
    }
  }
}

export { MAX_ENTRIES }
