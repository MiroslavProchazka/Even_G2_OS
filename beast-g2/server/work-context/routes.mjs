import { ApiError } from '../errors.mjs'
import { readJsonBody, sendJson } from '../http-util.mjs'

export const NOTION_CALLBACK = '/api/notion/callback'

export async function routeWork({ req, res, route, work, requestId, signal }) {
  const allowed = {
    '/api/work/ask': ['POST'],
    '/api/notion/status': ['GET'],
    '/api/notion/connect': ['POST'],
    '/api/notion/disconnect': ['POST'],
    [NOTION_CALLBACK]: ['GET']
  }
  if (!allowed[route]) throw new ApiError(404, 'not_found', 'Route not found.')
  if (!allowed[route].includes(req.method)) {
    res.setHeader('Allow', allowed[route].join(', '))
    return sendJson(res, 405, { error: 'method_not_allowed', requestId })
  }
  if (!work) throw new ApiError(503, 'work_disabled', 'Work context is not configured on this gateway.')
  let result
  if (route === '/api/notion/status') result = work.connection.status()
  if (route === '/api/notion/connect') result = await work.connection.begin(signal)
  if (route === '/api/notion/disconnect') result = work.connection.disconnect()
  if (route === NOTION_CALLBACK) {
    res.setHeader('Referrer-Policy', 'no-referrer')
    result = await work.connection.callback(new URL(req.url, 'http://localhost').searchParams, signal)
  }
  if (route === '/api/work/ask') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, 'content_type', 'Use application/json.')
    result = { answer: await work.ask(await readJsonBody(req, 24000), signal) }
  }
  return sendJson(res, 200, { ...result, requestId })
}
