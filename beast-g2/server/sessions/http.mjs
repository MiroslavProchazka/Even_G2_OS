import { ApiError } from '../errors.mjs'
import { readBody, readJsonBody, sendJson } from '../http-util.mjs'

function methodNotAllowed(res, allowed, requestId) {
  res.setHeader('Allow', allowed.join(', '))
  return sendJson(res, 405, { error: 'method_not_allowed', message: `Use ${allowed.join(', ')}.`, requestId })
}

export async function routeSessions({ req, res, route, service, summary, requestId }) {
  const parts = route.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'sessions') return false
  const sessionId = parts[2]
  const action = parts[3]
  const sub = parts[4]
  const method = req.method
  const query = new URL(req.url, 'http://localhost').searchParams

  if (!sessionId) {
    if (method === 'POST') {
      const input = await readJsonBody(req, 16000)
      return sendJson(res, 201, { session: service.createSession(input), requestId })
    }
    if (method === 'GET') {
      const limit = query.get('limit') ?? 50
      return sendJson(res, 200, { sessions: service.listSessions({ limit }), requestId })
    }
    return methodNotAllowed(res, ['GET', 'POST'], requestId)
  }

  if (!action) {
    if (method === 'GET') return sendJson(res, 200, { ...service.getSessionDetail(sessionId), requestId })
    if (method === 'DELETE') {
      service.deleteSession(sessionId)
      res.writeHead(204)
      return res.end()
    }
    return methodNotAllowed(res, ['GET', 'DELETE'], requestId)
  }

  if (action === 'start' || action === 'pause' || action === 'resume' || action === 'end') {
    if (method !== 'POST') return methodNotAllowed(res, ['POST'], requestId)
    const input = await readJsonBody(req, 16000)
    const session =
      action === 'start'
        ? service.startSession(sessionId, input)
        : action === 'pause'
          ? service.pauseSession(sessionId, input)
          : action === 'resume'
            ? service.resumeSession(sessionId, input)
            : service.endSession(sessionId, input)
    return sendJson(res, 200, { session, requestId })
  }

  if (action === 'segments') {
    if (method !== 'POST') return methodNotAllowed(res, ['POST'], requestId)
    const audio = await readBody(req, service.getLimits().maxSegmentBytes)
    const result = service.acceptSegment(
      sessionId,
      {
        id: req.headers['x-segment-id'],
        sequence: req.headers['x-sequence'],
        startMs: req.headers['x-start-ms'],
        endMs: req.headers['x-end-ms'],
        audio
      },
      { writerId: req.headers['x-writer-id'] }
    )
    return sendJson(res, result.duplicate ? 200 : 201, { ...result, requestId })
  }

  if (action === 'import') {
    if (method !== 'POST') return methodNotAllowed(res, ['POST'], requestId)
    if (!(req.headers['content-type'] || '').startsWith('audio/wav')) throw new ApiError(415, 'content_type', 'Use audio/wav.')
    const result = await service.importWav(sessionId, req, { writerId: req.headers['x-writer-id'] })
    return sendJson(res, 202, { import: result, requestId })
  }

  if (action === 'gaps') {
    if (method !== 'POST') return methodNotAllowed(res, ['POST'], requestId)
    const input = await readJsonBody(req, 16000)
    return sendJson(res, 201, { gap: service.addGap(sessionId, input), requestId })
  }

  if (action === 'export') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET'], requestId)
    const format = query.get('format') ?? 'json'
    const exported = service.exportSession(sessionId, format)
    if (format === 'markdown') {
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${sessionId}.md"`
      })
      return res.end(exported)
    }
    return sendJson(res, 200, exported)
  }

  if (action === 'turns' && sub) {
    if (method !== 'PATCH') return methodNotAllowed(res, ['PATCH'], requestId)
    const input = await readJsonBody(req, 8000)
    return sendJson(res, 200, { turn: service.correctTurn(sessionId, sub, input), requestId })
  }

  if (action === 'summary' || action === 'summaries' || action === 'preparation' || action === 'preparations') {
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

  return sendJson(res, 404, { error: 'not_found', requestId })
}
