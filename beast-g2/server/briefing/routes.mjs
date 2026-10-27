// Briefing route. It is a workspace route outside the /api/sessions dispatcher and it is read-only: one POST builds a
// briefing from the latest ready summaries of 1-3 selected sessions. Contract: docs/BRIEFING.md.
import { readJsonBody, sendJson } from '../http-util.mjs'
import { methodNotAllowed, notFound } from '../sessions/routes/respond.mjs'
import { BRIEFING_MAX_BODY, createBriefingService } from './briefing.mjs'

export function match(parts) {
  return parts.length === 2 && parts[0] === 'api' && parts[1] === 'briefing'
}

export async function routeBriefing({ req, res, route, service, requestId, now }) {
  const parts = route.split('/').filter(Boolean)
  if (!match(parts)) return notFound(res, requestId)
  if (!service) return sendJson(res, 404, { error: 'sessions_disabled', message: 'Stored sessions are not enabled.', requestId })
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST'], requestId)
  const input = await readJsonBody(req, BRIEFING_MAX_BODY)
  const briefing = createBriefingService({ service, now }).build(input.sessionIds)
  return sendJson(res, 200, { briefing, requestId })
}
