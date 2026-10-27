import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../server/sessions/http.mjs'
import { routes } from '../server/sessions/routes/index.mjs'
import { sendJson } from '../server/http-util.mjs'

function fakeRequest({ method = 'GET', url = '/api/sessions', headers = {}, body } = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    }
  }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    destroyed: false,
    body: '',
    finished: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers = {}) {
      this.statusCode = status
      for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value
      this.headersSent = true
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk
      this.finished = true
    }
  }
}

async function dispatch(registry, { method = 'GET', url = '/api/sessions', headers = {}, service = {}, summary } = {}) {
  const res = fakeResponse()
  const handled = await createRouter(registry)({ req: fakeRequest({ method, url, headers }), res, route: new URL(url, 'http://localhost').pathname, service, summary, requestId: 'req-test' })
  return { handled, res }
}

test('a route module appended to the registry is dispatched without editing http.mjs', async () => {
  const seen = []
  const widgetRoute = {
    match: (parts) => parts[3] === 'widgets',
    handle: async (ctx) => {
      seen.push(ctx.sessionId)
      return sendJson(ctx.res, 200, { widget: ctx.sub, requestId: ctx.requestId })
    }
  }

  const { res } = await dispatch([...routes, widgetRoute], { url: '/api/sessions/ses_1/widgets/w1' })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { widget: 'w1', requestId: 'req-test' })
  assert.deepEqual(seen, ['ses_1'])
})

test('the dispatcher calls only the first matching route module', async () => {
  const calls = []
  const first = {
    match: () => true,
    handle: async () => {
      calls.push('first')
    }
  }
  const second = {
    match: () => true,
    handle: async () => {
      calls.push('second')
    }
  }

  await dispatch([first, second], { url: '/api/sessions/ses_1/anything' })

  assert.deepEqual(calls, ['first'])
})

test('an unmatched /api/sessions path falls through to the dispatcher 404', async () => {
  const { res } = await dispatch(routes, { url: '/api/sessions/ses_1/unknown' })

  assert.equal(res.statusCode, 404)
  assert.deepEqual(JSON.parse(res.body), { error: 'not_found', requestId: 'req-test' })
})

test('paths outside /api/sessions are not handled by the dispatcher', async () => {
  const { handled, res } = await dispatch(routes, { url: '/api/health' })

  assert.equal(handled, false)
  assert.equal(res.statusCode, 0)
  assert.equal(res.finished, false)
})

test('the real registry keeps the session list and disabled summaries contracts', async () => {
  const listed = await dispatch(routes, {
    url: '/api/sessions?limit=5',
    service: { listSessions: ({ limit }) => [{ id: 'ses_1', limit }] }
  })
  assert.equal(listed.res.statusCode, 200)
  assert.deepEqual(JSON.parse(listed.res.body), { sessions: [{ id: 'ses_1', limit: '5' }], requestId: 'req-test' })

  const disabled = await dispatch(routes, { url: '/api/sessions/ses_1/summary' })
  assert.equal(disabled.res.statusCode, 404)
  assert.deepEqual(JSON.parse(disabled.res.body), { error: 'summaries_disabled', message: 'Summaries are not enabled.', requestId: 'req-test' })
})

test('the real registry keeps the method-not-allowed contract', async () => {
  const { res } = await dispatch(routes, { method: 'PUT', url: '/api/sessions/ses_1/export' })

  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET')
  assert.deepEqual(JSON.parse(res.body), { error: 'method_not_allowed', message: 'Use GET.', requestId: 'req-test' })
})
