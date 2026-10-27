// Thin dispatcher for /api/sessions. Route modules live in routes/ and are ordered in
// routes/index.mjs. This file owns the prefix check, the 404 fallback and the shared
// 405 helper (routes/respond.mjs) that every route module uses.
import { routes } from './routes/index.mjs'
import { methodNotAllowed, notFound } from './routes/respond.mjs'

export { methodNotAllowed }

export function createRouter(registry = routes) {
  return async function routeSessions({ req, res, route, service, summary, requestId }) {
    const parts = route.split('/').filter(Boolean)
    if (parts[0] !== 'api' || parts[1] !== 'sessions') return false
    const ctx = {
      req,
      res,
      route,
      parts,
      sessionId: parts[2],
      action: parts[3],
      sub: parts[4],
      query: new URL(req.url, 'http://localhost').searchParams,
      service,
      summary,
      requestId
    }
    for (const module of registry) {
      if (!module.match(parts)) continue
      return module.handle(ctx)
    }
    return notFound(res, requestId)
  }
}

export const routeSessions = createRouter()
