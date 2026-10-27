import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGateway, loadConfig } from '../server/gateway.mjs'
import { createRequestLog, requestEntry, safeRoute } from '../server/log.mjs'

const auth = { Authorization: 'Bearer local-demo-token-only' }

async function start(t) {
  const server = createGateway(loadConfig({ DEMO_MODE: '1' }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for the request log.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('gateway records one content-free line per request', async (t) => {
  const { server, base } = await start(t)
  const response = await fetch(`${base}/api/health?token=SECRET-TOKEN&transcript=PRIVATE`, { headers: auth })
  assert.equal(response.status, 200)
  await response.text()
  const id = response.headers.get('x-request-id')
  await waitFor(() => server.requestLog.find(id))
  const entry = server.requestLog.find(id)
  assert.equal(entry.method, 'GET')
  assert.equal(entry.route, '/api/health')
  assert.equal(entry.status, 200)
  assert.equal(entry.code, undefined)
  assert.equal(entry.stage, 'health')
  assert.ok(Number.isFinite(entry.durationMs))
  assert.equal(server.requestLog.size(), 1)
  assert.doesNotMatch(server.requestLog.export(), /SECRET-TOKEN|PRIVATE|local-demo-token-only/)
})

test('gateway records rejection and not-found error codes without query strings', async (t) => {
  const { server, base } = await start(t)
  const denied = await fetch(`${base}/api/health`)
  assert.equal(denied.status, 401)
  const deniedId = denied.headers.get('x-request-id')
  await waitFor(() => server.requestLog.find(deniedId))
  assert.equal(server.requestLog.find(deniedId).code, 'unauthorized')

  const missing = await fetch(`${base}/api/missing?transcript=PRIVATE&token=SECRET`, { headers: auth })
  assert.equal(missing.status, 404)
  const missingId = missing.headers.get('x-request-id')
  await waitFor(() => server.requestLog.find(missingId))
  const entry = server.requestLog.find(missingId)
  assert.equal(entry.code, 'not_found')
  assert.equal(entry.route, '/api/missing')
  assert.doesNotMatch(server.requestLog.export(), /PRIVATE|SECRET|transcript/)
})

test('request ring keeps the last 200 entries', () => {
  const log = createRequestLog()
  for (let i = 0; i < 201; i++) log.record({ requestId: `r-${i}`, method: 'GET', route: `/api/${i}?token=SECRET`, status: 200, durationMs: i })
  assert.equal(log.size(), 200)
  assert.equal(log.snapshot()[0].requestId, 'r-1')
  assert.equal(log.snapshot().at(-1).requestId, 'r-200')
  assert.doesNotMatch(log.export(), /SECRET|token=/)
})

test('route and entry allowlists drop queries, tokens and free text', () => {
  assert.equal(safeRoute('/api/sessions/abc/start?token=SECRET#frag'), '/api/sessions/abc/start')
  assert.equal(safeRoute(undefined), '/')
  assert.equal(safeRoute(null), '/')
  assert.equal(safeRoute('api/health'), '/api/health')
  assert.equal(safeRoute('/api/a b'), '/api/a_20b')
  assert.equal(safeRoute('http://[bad'), '/')
  assert.equal(safeRoute('/api/' + 'x'.repeat(300)).length, 200)
  const entry = requestEntry({ requestId: 'SECRET TOKEN', method: 'POST', route: '/api/chat?token=SECRET', status: 400, durationMs: 3.4, code: 'PRIVATE transcript' })
  assert.equal(entry.requestId, 'invalid')
  assert.equal(entry.method, 'POST')
  assert.equal(entry.route, '/api/chat')
  assert.equal(entry.durationMs, 3.4)
  assert.equal(entry.code, undefined)
  assert.doesNotMatch(JSON.stringify(entry), /SECRET|PRIVATE|transcript/)
})

test('request log tolerates invalid fields, a failing writer and clears its ring', () => {
  const written = []
  const log = createRequestLog({ write: (entry) => written.push(entry) })
  assert.throws(() => createRequestLog({ limit: 0 }))
  assert.throws(() => createRequestLog({ limit: 1001 }))
  assert.throws(() => createRequestLog({ limit: '200' }))
  const invalid = requestEntry({ requestId: 42, method: 42, route: '/api/x', status: 999, durationMs: -1, code: 42, stage: 42 })
  assert.equal(invalid.requestId, 'invalid')
  assert.equal(invalid.method, 'UNKNOWN')
  assert.equal(invalid.status, 0)
  assert.equal(invalid.durationMs, 0)
  assert.equal(invalid.code, undefined)
  assert.equal(invalid.stage, undefined)
  const nonNumeric = requestEntry({ status: '400', durationMs: '3' })
  assert.equal(nonNumeric.status, 0)
  assert.equal(nonNumeric.durationMs, 0)
  assert.equal(requestEntry().route, '/')
  log.record({ requestId: 'r-1', method: 'GET', route: '/api/health', status: 200, durationMs: 1 })
  assert.equal(written.length, 1)
  log.clear()
  assert.equal(log.size(), 0)
  const failing = createRequestLog({
    write: () => {
      throw new Error('PRIVATE')
    }
  })
  assert.doesNotThrow(() => failing.record({ requestId: 'r-2', method: 'GET', route: '/api/health', status: 200, durationMs: 1 }))
  assert.equal(failing.size(), 1)
})
