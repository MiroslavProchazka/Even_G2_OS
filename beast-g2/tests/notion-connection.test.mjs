import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CredentialStore } from '../server/integrations/notion/credentials.mjs'
import { NotionConnection } from '../server/integrations/notion/connection.mjs'
import { NotionMcp, toolData } from '../server/integrations/notion/mcp.mjs'
import { createWorkContext } from '../server/work-context/index.mjs'

const workspaceId = 'a'.repeat(32)
const redirectUri = 'http://127.0.0.1:8787/api/notion/callback'
const metadata = { authorization_endpoint: 'https://mcp.notion.com/authorize', token_endpoint: 'https://mcp.notion.com/token', registration_endpoint: 'https://mcp.notion.com/register' }
function fixture(options = {}) {
  let record = null
  const store = {
    read: () => record,
    write: (value) => {
      record = value
    },
    clear: () => {
      record = null
    }
  }
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('oauth-protected-resource')) return Response.json({ authorization_servers: ['https://mcp.notion.com'] })
    if (String(url).includes('oauth-authorization-server')) return Response.json(options.metadata || metadata)
    if (String(url).endsWith('/register')) return Response.json(options.client || { client_id: 'synthetic-client' })
    if (options.exchange) return options.exchange(init)
    return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 })
  }
  const mcp = {
    initialize: async function () {
      return this
    },
    call: async () => ({ workspace: { id: options.workspace || workspaceId } })
  }
  const connection = new NotionConnection({ store, redirectUri, workspaceId, fetchImpl, makeMcp: () => mcp, now: options.now || (() => 1000) })
  return { connection, store, calls, mcp }
}
async function connect(f) {
  const { authorizationUrl } = await f.connection.begin()
  const url = new URL(authorizationUrl)
  return f.connection.callback(new URLSearchParams({ state: url.searchParams.get('state'), code: 'synthetic-code' }))
}

test('Notion credentials are authenticated encrypted, private and never stored as plaintext', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notion-credentials-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'private', 'credentials.enc')
  const store = new CredentialStore(file, 'ab'.repeat(32))
  assert.equal(store.read(), null)
  store.write({ token: 'synthetic-secret' })
  assert.deepEqual(store.read(), { token: 'synthetic-secret' })
  assert.equal(readFileSync(file, 'utf8').includes('synthetic-secret'), false)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const other = new CredentialStore(file, 'cd'.repeat(32))
  assert.throws(() => other.read())
  writeFileSync(file, 'invalid')
  assert.throws(() => store.read(), /Cannot read/)
  store.clear()
  store.clear()
  assert.equal(store.read(), null)
  assert.throws(() => new CredentialStore(file, 'wrong'), /64 hexadecimal/)
})

test('OAuth enforces PKCE, single-use state, configured workspace and server-only tokens', async () => {
  const f = fixture()
  assert.equal(f.connection.status().connected, false)
  const { authorizationUrl } = await f.connection.begin()
  const url = new URL(authorizationUrl),
    state = url.searchParams.get('state')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge').length, 43)
  assert.equal(url.searchParams.get('resource'), 'https://mcp.notion.com/mcp')
  await assert.rejects(f.connection.callback(new URLSearchParams({ code: 'x', state: 'wrong' })), { code: 'notion_oauth_state' })
  const params = new URLSearchParams({ code: 'x', state })
  assert.deepEqual(await f.connection.callback(params), { connected: true })
  assert.equal(f.connection.status().workspaceId, workspaceId)
  assert.equal(JSON.stringify(f.connection.status()).includes('synthetic-access'), false)
  await assert.rejects(f.connection.callback(params), { code: 'notion_oauth_state' })
  const exchange = f.calls.find((call) => call.url.endsWith('/token'))
  assert.equal(new URLSearchParams(exchange.init.body).get('code_verifier').length, 43)
  assert.equal(await f.connection.client(), f.mcp)
  f.connection.disconnect()
  assert.equal(f.connection.status().connected, false)
  await assert.rejects(f.connection.client(), { code: 'notion_reconnect' })
})

test('wrong workspace, denied login, expired state and unsafe endpoints fail without persisting tokens', async () => {
  const wrong = fixture({ workspace: 'b'.repeat(32) })
  await assert.rejects(connect(wrong), { code: 'notion_workspace_mismatch' })
  assert.equal(wrong.store.read(), null)
  const f = fixture(),
    start = await f.connection.begin(),
    state = new URL(start.authorizationUrl).searchParams.get('state')
  await assert.rejects(f.connection.callback(new URLSearchParams({ state, error: 'access_denied' })), { code: 'notion_oauth_denied' })
  const expiry = fixture()
  await expiry.connection.begin()
  expiry.connection.now = () => 99999999
  await assert.rejects(expiry.connection.callback(new URLSearchParams()), { code: 'notion_oauth_state' })
  for (const token_endpoint of ['http://mcp.notion.com/token', 'https://evil.example/token', 'broken']) {
    const unsafe = fixture({ metadata: { ...metadata, token_endpoint } })
    await assert.rejects(unsafe.connection.begin(), { code: 'notion_oauth_metadata' })
  }
  await assert.rejects(fixture({ client: {} }).connection.begin(), { code: 'notion_registration' })
  for (const config of [{ redirectUri: 'http://example.com/api/notion/callback' }, { redirectUri: 'https://example.com/wrong' }, { workspaceId: 'wrong' }])
    assert.throws(() => new NotionConnection({ store: f.store, redirectUri, workspaceId, ...config }))
})

test('rotating tokens refresh once for concurrent requests and preserve the verified workspace', async () => {
  let refreshes = 0
  const f = fixture({
    exchange: async (init) => {
      if (new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
        refreshes++
        await new Promise((resolve) => setTimeout(resolve, 5))
        return Response.json({ access_token: 'refreshed', refresh_token: 'rotated', expires_in: 1000 })
      }
      return Response.json({ access_token: 'initial', refresh_token: 'original', expires_in: 1 })
    }
  })
  await connect(f)
  await Promise.all([f.connection.client(), f.connection.client()])
  assert.equal(refreshes, 1)
  assert.equal(f.store.read().tokens.refresh_token, 'rotated')
  assert.equal(f.store.read().workspaceId, workspaceId)
})

test('disconnect during refresh cannot resurrect credentials and cancellation cannot return a client', async () => {
  let release
  const f = fixture({
    exchange: async (init) => {
      if (new URLSearchParams(init.body).get('grant_type') === 'refresh_token')
        await new Promise((resolve) => {
          release = resolve
        })
      return Response.json({ access_token: 'synthetic', refresh_token: 'synthetic-refresh', expires_in: 1 })
    }
  })
  await connect(f)
  const pending = f.connection.client()
  await new Promise((resolve) => setTimeout(resolve, 0))
  f.connection.disconnect()
  release()
  await assert.rejects(pending, { code: 'notion_connection_changed' })
  assert.equal(f.store.read(), null)
  const next = fixture()
  await connect(next)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(next.connection.client(controller.signal), { name: 'AbortError' })
})

test('a cancelled refresh waiter returns promptly while shared token rotation finishes safely', async () => {
  let release
  const f = fixture({
    exchange: async (init) => {
      if (new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
        await new Promise((resolve) => {
          release = resolve
        })
        return Response.json({ access_token: 'new-access', refresh_token: 'rotated', expires_in: 3600 })
      }
      return Response.json({ access_token: 'old-access', refresh_token: 'old-refresh', expires_in: 1 })
    }
  })
  await connect(f)
  const controller = new AbortController()
  const pending = f.connection.client(controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  const rotation = f.connection.refreshing
  release()
  await rotation
  assert.equal(f.store.read().tokens.refresh_token, 'rotated')
})

test('missing refresh tokens, malformed exchanges and disconnect during authorization fail closed', async () => {
  const f = fixture()
  await connect(f)
  f.store.write({ ...f.store.read(), expires: 0, tokens: { access_token: 'synthetic' } })
  await assert.rejects(f.connection.client(), { code: 'notion_reconnect' })
  await assert.rejects(connect(fixture({ exchange: async () => Response.json({}) })), { code: 'notion_reconnect' })
  const next = fixture()
  const identity = next.connection.identity.bind(next.connection)
  next.connection.identity = async (...args) => {
    const result = await identity(...args)
    next.connection.disconnect()
    return result
  }
  await assert.rejects(connect(next), { code: 'notion_connection_changed' })
  assert.equal(next.store.read(), null)
})

test('work context is opt-in and demo cannot contact external providers', () => {
  assert.equal(createWorkContext({}, {}), undefined)
  assert.throws(() => createWorkContext({ demo: true }, { WORK_CONTEXT_ENABLED: '1' }), /live gateway/)
  const work = createWorkContext(
    { dataDir: '/tmp/unused-synthetic', chatUrl: 'https://beast.example.com' },
    { WORK_CONTEXT_ENABLED: '1', NOTION_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), NOTION_REDIRECT_URI: redirectUri, NOTION_WORKSPACE_ID: workspaceId }
  )
  assert.equal(typeof work.ask, 'function')
})

test('MCP initializes, echoes session headers, decodes JSON/text and permits only read tools', async () => {
  const calls = []
  const fetchImpl = async (_url, init) => {
    const input = JSON.parse(init.body)
    calls.push({ input, init })
    if (!input.id) return new Response(null, { status: 202 })
    const result =
      input.method === 'initialize'
        ? { protocolVersion: '2025-03-26' }
        : input.method === 'tools/list'
          ? { tools: ['notion-get-self', 'notion-search', 'notion-fetch'].map((name) => ({ name })) }
          : { content: [{ type: 'text', text: '{"workspace":{"id":"synthetic"}}' }] }
    return Response.json({ jsonrpc: '2.0', id: input.id, result }, { headers: { 'mcp-session-id': 'opaque' } })
  }
  const client = await new NotionMcp('synthetic-token', { fetchImpl }).initialize()
  assert.equal((await client.call('notion-get-self')).workspace.id, 'synthetic')
  assert.equal(calls[1].init.headers['Mcp-Session-Id'], 'opaque')
  assert.equal(calls[3].init.headers['MCP-Protocol-Version'], '2025-03-26')
  await assert.rejects(client.call('notion-update-page'), { code: 'notion_tool_denied' })
  assert.deepEqual(toolData({ structuredContent: { results: [] } }), { results: [] })
  assert.deepEqual(toolData({ content: [{ type: 'text', text: '<page>content</page>' }] }), { text: '<page>content</page>' })
  for (const result of [{ isError: true }, { structuredContent: { error: 'denied' } }, { content: [{ type: 'text', text: '{"error":"denied"}' }] }, {}]) assert.throws(() => toolData(result))
})

test('MCP accepts SSE replies and rejects auth errors, broken replies and missing tool capabilities', async () => {
  const client = new NotionMcp('synthetic', {
    fetchImpl: async (_url, init) =>
      new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: { ok: true } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  })
  assert.deepEqual(await client.rpc('test', {}), { ok: true })
  for (const status of [401, 403]) {
    client.fetch = async () => new Response('SECRET', { status })
    await assert.rejects(client.rpc('test', {}), { code: status === 401 ? 'notion_reconnect' : 'notion_unavailable' })
  }
  for (const response of ['broken', '{"id":999,"result":{}}']) {
    client.fetch = async () => new Response(response)
    await assert.rejects(client.rpc('test', {}))
  }
  client.rpc = async (method) => (method === 'initialize' ? { protocolVersion: 'unknown' } : {})
  await assert.rejects(client.initialize(), { code: 'notion_protocol' })
  client.rpc = async (method) => (method === 'initialize' ? { protocolVersion: '2025-03-26' } : {})
  await assert.rejects(client.initialize(), { code: 'notion_tools_missing' })
})

test('MCP handles fragmented UTF-8 SSE, ignores notifications and cancels an open stream after its reply', async () => {
  let cancelled = false
  const fetchImpl = async (_url, init) => {
    const id = JSON.parse(init.body).id
    const bytes = new TextEncoder().encode(`: keepalive\r\n\r\ndata: {"method":"progress"}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { text: 'Příliš žluťoučký' } })}\r\n\r\n`)
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        },
        cancel() {
          cancelled = true
        }
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  }
  const client = new NotionMcp('synthetic', { fetchImpl })
  assert.deepEqual(await client.rpc('test', {}), { text: 'Příliš žluťoučký' })
  assert.equal(cancelled, true)
})
