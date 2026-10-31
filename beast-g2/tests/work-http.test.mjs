import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGateway, loadConfig } from '../server/gateway.mjs'
import { ApiError } from '../server/errors.mjs'
import { WorkContextService } from '../server/work-context/service.mjs'

const headers = { Authorization: 'Bearer local-demo-token-only', 'Content-Type': 'application/json' }
const answer = { status: 'answered', hint: 'Synthetic answer', detail: 'Synthetic detail', citations: [], coverage: {} }
async function setup(t, work, options = {}) {
  const config = loadConfig({ DEMO_MODE: '1', RATE_LIMIT: '1000' })
  const server = createGateway({ ...config, work, ...options })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (route, init = {}) => fetch(base + route, { headers, ...init })
  return { base, call, server }
}
const work = () => ({
  ask: async () => answer,
  connection: {
    status: () => ({ connected: true }),
    begin: async () => ({ authorizationUrl: 'https://mcp.notion.com/authorize' }),
    disconnect: () => ({ connected: false }),
    callback: async () => {
      throw new ApiError(400, 'notion_oauth_state', 'Invalid state.')
    }
  }
})

test('work HTTP authenticates all operations except the state-validated callback', async (t) => {
  const { call } = await setup(t, work())
  for (const route of ['/api/work/ask', '/api/notion/status', '/api/notion/connect', '/api/notion/disconnect']) assert.equal((await call(route, { method: 'POST', headers: {} })).status, 401)
  const callback = await call('/api/notion/callback?state=invalid&code=private-code', { headers: {} })
  assert.equal(callback.status, 400)
  assert.equal((await callback.json()).error, 'notion_oauth_state')
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer')
  assert.equal((await call('/api/notion/callback', { method: 'POST', headers: {} })).status, 401)
})

test('work routes have explicit methods, feature availability, content types and bounded JSON', async (t) => {
  const { call } = await setup(t, work())
  assert.equal((await call('/api/work/ask')).status, 405)
  assert.equal((await call('/api/notion/unknown')).status, 404)
  assert.equal((await call('/api/work/ask', { method: 'POST', headers: { Authorization: headers.Authorization, 'Content-Type': 'text/plain' }, body: 'x' })).status, 415)
  assert.equal((await call('/api/work/ask', { method: 'POST', body: '{broken' })).status, 400)
  assert.equal((await call('/api/work/ask', { method: 'POST', body: 'x'.repeat(24001) })).status, 413)
  const disabled = await setup(t)
  assert.equal((await disabled.call('/api/notion/status')).status, 503)
  assert.equal((await (await call('/api/notion/status')).json()).connected, true)
  assert.equal((await (await call('/api/notion/connect', { method: 'POST' })).json()).authorizationUrl, 'https://mcp.notion.com/authorize')
  assert.equal((await (await call('/api/notion/disconnect', { method: 'POST' })).json()).connected, false)
})

test('HTTP work question returns canonical citations from fetched evidence', async (t) => {
  const page = { title: 'Synthetic meeting', url: 'https://notion.so/synthetic', text: 'Petr potvrdil dokončení návrhu.' }
  let step = 0
  const service = new WorkContextService({
    connection: { revision: 0, client: async () => ({ call: async (name) => (name === 'notion-search' ? { results: [{ id: 'synthetic', ...page }] } : page) }) },
    generate: async () => (++step === 1 ? { query: 'Petr' } : { status: 'answered', hint: 'Návrh je hotový.', detail: 'Petr potvrdil dokončení.', citations: [{ sourceId: 'N1', excerpt: page.text }] })
  })
  const { call } = await setup(t, service)
  const response = await call('/api/work/ask', { method: 'POST', body: JSON.stringify({ question: 'Co dlužím Petrovi?' }) })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.answer.citations[0].url, page.url)
  assert.equal(body.answer.coverage.pagesRead, 1)
  assert.ok(body.requestId)
})

test('work capacity does not block existing chat or disconnect', async (t) => {
  const releases = []
  const synthetic = work()
  synthetic.ask = () => new Promise((resolve) => releases.push(() => resolve(answer)))
  const { call } = await setup(t, synthetic)
  const pending = [call('/api/work/ask', { method: 'POST', body: '{}' }), call('/api/work/ask', { method: 'POST', body: '{}' })]
  while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal((await call('/api/work/ask', { method: 'POST', body: '{}' })).status, 429)
  assert.equal((await call('/api/notion/disconnect', { method: 'POST' })).status, 200)
  const chat = await call('/api/chat', { method: 'POST', body: JSON.stringify({ text: 'hello' }) })
  assert.equal(chat.status, 200)
  await chat.text()
  releases.forEach((release) => release())
  assert.deepEqual(
    (await Promise.all(pending)).map((response) => response.status),
    [200, 200]
  )
})

test('work requests abort on deadline and client disconnect; logs omit queries and provider errors', async (t) => {
  let aborted = false
  const synthetic = work()
  synthetic.ask = (_input, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(new Error('SYNTHETIC PRIVATE BODY'))
        },
        { once: true }
      )
    )
  const { call, server } = await setup(t, synthetic, { timeout: 20 })
  const response = await call('/api/work/ask?private=secret', { method: 'POST', body: '{}' })
  assert.equal(response.status, 504)
  assert.equal(aborted, true)
  assert.equal(JSON.stringify(server.requestLog.snapshot()).includes('secret'), false)
  assert.equal(JSON.stringify(await response.json()).includes('PRIVATE'), false)
  const controller = new AbortController()
  const pending = call('/api/work/ask', { method: 'POST', body: '{}', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('work transport maps unexpected failures and CORS rejection without exposing error contents', async (t) => {
  const synthetic = work()
  synthetic.ask = async () => {
    throw new Error('SYNTHETIC PRIVATE BODY')
  }
  const { call } = await setup(t, synthetic)
  const response = await call('/api/work/ask', { method: 'POST', body: '{}' })
  assert.equal(response.status, 502)
  assert.equal(JSON.stringify(await response.json()).includes('PRIVATE'), false)
  assert.equal((await call('/api/notion/status', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403)
})
