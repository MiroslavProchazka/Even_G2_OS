// Summary and preparation routes. They are disabled when no summary service is configured.
// Contract: match(parts) decides, handle(ctx) responds. See docs/ARCHITECTURE.md.
import { readJsonBody, sendJson } from '../../http-util.mjs'
import { methodNotAllowed } from './respond.mjs'

const SUMMARY_ACTIONS = new Set(['summary', 'summaries', 'preparation', 'preparations'])

export function match(parts) {
  return parts[0] === 'api' && parts[1] === 'sessions' && SUMMARY_ACTIONS.has(parts[3])
}

export async function handle({ req, res, sessionId, action, sub, summary, requestId }) {
  const method = req.method
  if (!summary) return sendJson(res, 404, { error: 'summaries_disabled', message: 'Summaries are not enabled.', requestId })

  if (action === 'summary') {
    if (method === 'GET') {
      const result = sub ? summary.getSummary(sessionId, sub) : summary.getLatestSummary(sessionId)
      return sendJson(res, 200, { summary: result, requestId })
    }
    if (method === 'POST') {
      const input = await readJsonBody(req, 16000)
      const result = summary.requestSummary(sessionId, input)
      return sendJson(res, result.summary.status === 'pending' ? 202 : 200, { ...result, requestId })
    }
    return methodNotAllowed(res, ['GET', 'POST'], requestId)
  }

  if (action === 'summaries') {
    if (method === 'GET') {
      if (sub) return sendJson(res, 200, { summary: summary.getSummary(sessionId, sub), requestId })
      return sendJson(res, 200, { summaries: summary.listSummaries(sessionId), requestId })
    }
    if (method === 'PATCH' && sub) {
      const input = await readJsonBody(req, 200000)
      return sendJson(res, 200, { summary: summary.updateSummary(sessionId, sub, input), requestId })
    }
    return methodNotAllowed(res, ['GET', 'PATCH'], requestId)
  }

  if (action === 'preparation') {
    if (method === 'GET') {
      const result = sub ? summary.getPreparation(sessionId, sub) : summary.getLatestPreparation(sessionId)
      return sendJson(res, 200, { preparation: result, requestId })
    }
    if (method === 'POST') {
      const input = await readJsonBody(req, 16000)
      return sendJson(res, 201, { preparation: summary.createPreparation(sessionId, input), requestId })
    }
    return methodNotAllowed(res, ['GET', 'POST'], requestId)
  }

  if (method === 'GET') return sendJson(res, 200, { preparations: summary.listPreparations(sessionId), requestId })
  return methodNotAllowed(res, ['GET'], requestId)
}
