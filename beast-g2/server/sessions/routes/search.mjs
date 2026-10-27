// GET /api/sessions/search?q=&limit=50
// This module must stay before routes/sessions.mjs in routes/index.mjs: that module treats parts[2] as a session id and
// would answer `/api/sessions/search` with a session lookup. Contract: match(parts) decides, handle(ctx) responds.
import { sendJson } from '../../http-util.mjs'
import { searchSessions } from '../search.mjs'
import { methodNotAllowed } from './respond.mjs'

export function match(parts) {
  return parts[0] === 'api' && parts[1] === 'sessions' && parts[2] === 'search' && parts.length === 3
}

export async function handle({ req, res, query, service, requestId }) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET'], requestId)
  const results = searchSessions(service.repo, { query: query.get('q'), limit: query.get('limit') })
  return sendJson(res, 200, { results, requestId })
}
