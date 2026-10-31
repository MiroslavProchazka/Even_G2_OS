import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createGateway, loadConfig } from '../server/gateway.mjs'
import { createRequestLog } from '../server/log.mjs'
import { createSessions } from '../server/sessions/index.mjs'
import { loadMcpConfig } from '../server/mcp/config.mjs'
import { proposeMemoryItem, setMemoryStatus } from '../server/sessions/memory.mjs'
import { makeWav } from '../server/sessions/wav.mjs'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = 'default'
const READER = `reader-${'a'.repeat(40)}`
const SESSIONS_ONLY = `sessions-${'b'.repeat(40)}`
const FOREIGN = `foreign-${'c'.repeat(40)}`
const TOKENS = [
  { name: 'reader', token: READER, scopes: ['sessions:read', 'summaries:read', 'memory:read'], workspaceId: WORKSPACE },
  { name: 'sessions-only', token: SESSIONS_ONLY, scopes: ['sessions:read'], workspaceId: WORKSPACE },
  { name: 'foreign', token: FOREIGN, scopes: ['sessions:read', 'summaries:read', 'memory:read'], workspaceId: 'other' }
]
const gatewayAuth = { Authorization: 'Bearer local-demo-token-only' }
const json = { ...gatewayAuth, 'Content-Type': 'application/json' }

async function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-mcp-'))
  const config = loadConfig({
    DEMO_MODE: '1',
    SESSION_DATA_DIR: dir,
    SESSION_DB_PATH: path.join(dir, 'sessions.sqlite'),
    RATE_LIMIT: '1000',
    PUBLIC_API_ENABLED: '1',
    PUBLIC_API_TOKENS: JSON.stringify(TOKENS)
  })
  const sessions = createSessions({
    config,
    transcribe: async ({ sequence }) => (sequence === 0 ? 'Rozpočet na projekt je 120 tisíc korun' : 'Termín schůzky je v pátek'),
    summarize: async ({ turns }) => ({
      overview: { text: 'Shrnutí schůzky.', citations: [turns[0].id] },
      decisions: [{ text: 'Rozpočet je 120 tisíc korun.', citations: [turns[0].id] }],
      actionCandidates: [],
      openQuestions: []
    })
  })
  const server = createGateway({ ...config, sessions: sessions.service, summaries: sessions.summary, requestLog: createRequestLog() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await sessions.worker.stop()
    server.closeAllConnections()
    server.close()
    sessions.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { base: `http://127.0.0.1:${server.address().port}`, sessions }
}

async function storedSession(base, sessions) {
  const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'MCP session', language: 'cs' }) })
  assert.equal(created.status, 201)
  const session = (await created.json()).session
  const started = await fetch(`${base}/api/sessions/${session.id}/start`, { method: 'POST', headers: json, body: JSON.stringify({ writerId: 'mcp' }) })
  assert.equal(started.status, 200)
  const imported = await fetch(`${base}/api/sessions/${session.id}/import`, {
    method: 'POST',
    headers: { ...gatewayAuth, 'Content-Type': 'audio/wav', 'X-Writer-Id': 'mcp' },
    body: makeWav(60_000)
  })
  assert.equal(imported.status, 202)
  await sessions.worker.tick()
  const ended = await fetch(`${base}/api/sessions/${session.id}/end`, { method: 'POST', headers: json, body: JSON.stringify({ writerId: 'mcp' }) })
  assert.equal(ended.status, 200)
  const detail = await fetch(`${base}/api/sessions/${session.id}`, { headers: gatewayAuth })
  assert.equal(detail.status, 200)
  return await detail.json()
}

function childEnv(extra) {
  const env = {}
  for (const [key, value] of Object.entries({ ...process.env, ...extra })) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

async function connect(t, base, token = READER) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(APP, 'server/mcp/server.mjs')],
    cwd: APP,
    env: childEnv({ PUBLIC_API_URL: base, PUBLIC_API_TOKEN: token }),
    stderr: 'pipe'
  })
  const client = new Client({ name: 'beast-g2-test', version: '1.0.0' })
  await client.connect(transport)
  t.after(async () => {
    await client.close()
  })
  return client
}

function parse(result) {
  assert.equal(result.content[0].type, 'text')
  return JSON.parse(result.content[0].text)
}

test('server exposes four read-only tools', async (t) => {
  const { base } = await setup(t)
  const client = await connect(t, base)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_session', 'get_session_summary', 'list_memory', 'list_sessions'])
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name)
  }
})

test('list_sessions returns only the token workspace without transcript text', async (t) => {
  const { base, sessions } = await setup(t)
  const stored = await storedSession(base, sessions)
  const client = await connect(t, base)
  const body = parse(await client.callTool({ name: 'list_sessions', arguments: { limit: 10 } }))
  assert.deepEqual(
    body.sessions.map((session) => session.id),
    [stored.session.id]
  )
  assert.equal(JSON.stringify(body).includes('Rozpočet na projekt'), false)
  const foreign = await connect(t, base, FOREIGN)
  const foreignBody = parse(await foreign.callTool({ name: 'list_sessions', arguments: {} }))
  assert.deepEqual(foreignBody.sessions, [])
})

test('get_session returns turns and gaps for an own session', async (t) => {
  const { base, sessions } = await setup(t)
  const stored = await storedSession(base, sessions)
  const client = await connect(t, base)
  const body = parse(await client.callTool({ name: 'get_session', arguments: { sessionId: stored.session.id } }))
  assert.equal(body.session.id, stored.session.id)
  assert.equal(body.turns.length, stored.turns.length)
  assert.equal(Array.isArray(body.gaps), true)
  const missing = await client.callTool({ name: 'get_session', arguments: { sessionId: `ses_${'9'.repeat(32)}` } })
  assert.equal(missing.isError, true)
  assert.equal(parse(missing).error, 'not_found')
})

test('get_session_summary returns the latest summary with citations', async (t) => {
  const { base, sessions } = await setup(t)
  const stored = await storedSession(base, sessions)
  const requested = sessions.summary.requestSummary(stored.session.id)
  await sessions.summary.run(requested.summary.id)
  const client = await connect(t, base)
  const body = parse(await client.callTool({ name: 'get_session_summary', arguments: { sessionId: stored.session.id } }))
  assert.equal(body.summary.status, 'ready')
  assert.equal(body.summary.citations.length > 0, true)
  assert.equal(body.summary.content.overview.text, 'Shrnutí schůzky.')
  assert.equal(body.summary.content.overview.citations.length, 1)
})

test('get_session_summary reports a missing scope instead of a partial body', async (t) => {
  const { base, sessions } = await setup(t)
  const stored = await storedSession(base, sessions)
  const client = await connect(t, base, SESSIONS_ONLY)
  const result = await client.callTool({ name: 'get_session_summary', arguments: { sessionId: stored.session.id } })
  assert.equal(result.isError, true)
  assert.equal(parse(result).error, 'insufficient_scope')
})

test('list_memory returns approved workspace items only', async (t) => {
  const { base, sessions } = await setup(t)
  const stored = await storedSession(base, sessions)
  const proposed = proposeMemoryItem({
    repo: sessions.repo,
    workspaceId: WORKSPACE,
    sessionId: stored.session.id,
    turnId: stored.turns[0].id,
    revision: stored.turns[0].revision,
    kind: 'decision',
    text: 'Rozpočet je 120 tisíc korun.'
  })
  setMemoryStatus({ repo: sessions.repo, sessionId: stored.session.id, memoryId: proposed.id, status: 'approved' })
  const client = await connect(t, base)
  const body = parse(await client.callTool({ name: 'list_memory', arguments: {} }))
  assert.deepEqual(
    body.items.map((item) => item.id),
    [proposed.id]
  )
  assert.equal(body.items[0].status, 'approved')
})

test('an unknown tool is a protocol error, not an empty result', async (t) => {
  const { base } = await setup(t)
  const client = await connect(t, base)
  const result = await client.callTool({ name: 'delete_session', arguments: {} })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /not found|unknown/i)
})

test('MCP configuration rejects an unusable token or URL without echoing the token', () => {
  assert.throws(() => loadMcpConfig({}), /PUBLIC_API_TOKEN/)
  assert.throws(() => loadMcpConfig({ PUBLIC_API_TOKEN: 'short' }), /PUBLIC_API_TOKEN/)
  assert.throws(() => loadMcpConfig({ PUBLIC_API_TOKEN: `with space ${'a'.repeat(40)}` }), /PUBLIC_API_TOKEN/)
  assert.throws(() => loadMcpConfig({ PUBLIC_API_TOKEN: READER, PUBLIC_API_URL: 'not a url' }), /PUBLIC_API_URL/)
  assert.throws(() => loadMcpConfig({ PUBLIC_API_TOKEN: READER, PUBLIC_API_URL: 'http://gateway.example.com' }), /https/)
  assert.throws(() => loadMcpConfig({ PUBLIC_API_TOKEN: READER, PUBLIC_API_URL: 'https://user:pass@gateway.example.com' }), /credentials/)
  assert.throws(() => loadMcpConfig({ PUBLIC_API_TOKEN: READER, PUBLIC_API_URL: 'https://gateway.example.com?x=1' }), /query/)
  assert.throws(
    () => loadMcpConfig({ PUBLIC_API_TOKEN: 'short-secret-token' }),
    (error) => !error.message.includes('short-secret-token')
  )
  const local = loadMcpConfig({ PUBLIC_API_TOKEN: READER })
  assert.equal(local.baseUrl.href, 'http://127.0.0.1:8787/')
  assert.equal(local.timeoutMs, 15000)
  const remote = loadMcpConfig({ PUBLIC_API_TOKEN: READER, PUBLIC_API_URL: 'https://gateway.example.com/v1' })
  assert.equal(remote.baseUrl.href, 'https://gateway.example.com/v1')
})
