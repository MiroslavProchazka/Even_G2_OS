// Memory items of one stored session, plus the workspace-wide list of items kept after their source session was deleted.
//
//   GET   /api/memory?status=&query=                 kept items only, every status by default
//   GET   /api/sessions/:id/memory?status=&query=
//   POST  /api/sessions/:id/memory                  { turnId, revision, kind, text }
//   GET   /api/sessions/:id/memory/:memoryId         approved items only
//   PATCH /api/sessions/:id/memory/:memoryId         { status: "approved" | "rejected" }
//   POST  /api/sessions/:id/memory/:memoryId/supersede { text, kind? }
//
// Registered before routes/sessions.mjs: that module treats parts[3] as a session action. Contract:
// match(parts) decides, handle(ctx) responds. See docs/MEMORY.md.
import { ApiError } from '../../errors.mjs'
import { readJsonBody, sendJson } from '../../http-util.mjs'
import { getMemoryItem, listMemoryItems, listRetainedMemoryItems, proposeMemoryItem, setMemoryStatus, supersedeMemoryItem } from '../memory.mjs'
import { methodNotAllowed } from './respond.mjs'

export function match(parts) {
  if (parts[0] !== 'api') return false
  if (parts[1] === 'memory') return parts.length === 2
  if (parts[1] !== 'sessions' || !parts[2] || parts[3] !== 'memory') return false
  if (parts.length === 4) return true
  if (!parts[4]) return false
  if (parts.length === 5) return true
  return parts.length === 6 && parts[5] === 'supersede'
}

export async function handle({ req, res, sessionId, parts, query, service, requestId }) {
  if (parts[1] === 'memory') {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET'], requestId)
    const items = listRetainedMemoryItems({
      repo: service.repo,
      workspaceId: service.workspace.id,
      status: query.get('status') ?? undefined,
      query: query.get('query') ?? undefined
    })
    return sendJson(res, 200, { items, requestId })
  }

  const memoryId = parts[4]

  if (!memoryId) {
    if (req.method === 'GET') {
      const items = listMemoryItems({
        repo: service.repo,
        sessionId,
        status: query.get('status') ?? undefined,
        query: query.get('query') ?? undefined
      })
      return sendJson(res, 200, { items, requestId })
    }
    if (req.method === 'POST') {
      const input = await readJsonBody(req, 8000)
      const item = proposeMemoryItem({
        repo: service.repo,
        workspaceId: service.workspace.id,
        sessionId,
        turnId: input.turnId,
        revision: input.revision,
        kind: input.kind,
        text: input.text,
        now: service.now()
      })
      return sendJson(res, 201, { item, requestId })
    }
    return methodNotAllowed(res, ['GET', 'POST'], requestId)
  }

  if (parts[5] === 'supersede') {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST'], requestId)
    const input = await readJsonBody(req, 8000)
    const result = supersedeMemoryItem({
      repo: service.repo,
      sessionId,
      memoryId,
      kind: input.kind,
      text: input.text,
      now: service.now()
    })
    return sendJson(res, 201, { item: result.item, superseded: result.superseded, requestId })
  }

  if (req.method === 'GET') {
    const item = getMemoryItem({ repo: service.repo, sessionId, memoryId, approvedOnly: true })
    if (!item) throw new ApiError(404, 'not_found', 'Memory item not found.')
    return sendJson(res, 200, { item, requestId })
  }

  if (req.method === 'PATCH') {
    const input = await readJsonBody(req, 8000)
    const item = setMemoryStatus({ repo: service.repo, sessionId, memoryId, status: input.status, now: service.now() })
    return sendJson(res, 200, { item, requestId })
  }

  return methodNotAllowed(res, ['GET', 'PATCH'], requestId)
}
