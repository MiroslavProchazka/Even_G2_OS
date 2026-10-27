// Session lifecycle, segments, import, gaps, export and turn corrections.
// Contract: match(parts) decides, handle(ctx) responds. See docs/ARCHITECTURE.md.
import { ApiError } from '../../errors.mjs'
import { readBody, readJsonBody, sendJson } from '../../http-util.mjs'
import { methodNotAllowed } from './respond.mjs'

const LIFECYCLE_ACTIONS = ['start', 'pause', 'resume', 'end']
const SESSION_ACTIONS = new Set([...LIFECYCLE_ACTIONS, 'segments', 'import', 'gaps', 'export'])

export function match(parts) {
  if (parts[0] !== 'api' || parts[1] !== 'sessions') return false
  const action = parts[3]
  if (!action) return true
  if (SESSION_ACTIONS.has(action)) return true
  return action === 'turns' && Boolean(parts[4])
}

export async function handle({ req, res, sessionId, action, sub, query, service, requestId }) {
  const method = req.method

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

  if (LIFECYCLE_ACTIONS.includes(action)) {
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

  if (method !== 'PATCH') return methodNotAllowed(res, ['PATCH'], requestId)
  const input = await readJsonBody(req, 8000)
  return sendJson(res, 200, { turn: service.correctTurn(sessionId, sub, input), requestId })
}
