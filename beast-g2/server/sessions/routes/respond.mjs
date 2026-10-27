// Shared responder helpers for the /api/sessions route modules.
// The dispatcher (http.mjs) owns the fallback 404 and re-exports the 405 helper.
import { sendJson } from '../../http-util.mjs'

export function methodNotAllowed(res, allowed, requestId) {
  res.setHeader('Allow', allowed.join(', '))
  return sendJson(res, 405, { error: 'method_not_allowed', message: `Use ${allowed.join(', ')}.`, requestId })
}

export function notFound(res, requestId) {
  return sendJson(res, 404, { error: 'not_found', requestId })
}
