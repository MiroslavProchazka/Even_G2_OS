import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGateway, loadConfig } from '../server/gateway.mjs'
import { createRequestLog } from '../server/log.mjs'
import { authenticatePublicToken, parsePublicApiTokens, requireScope } from '../server/api/scopes.mjs'
import { createSessions } from '../server/sessions/index.mjs'
import { proposeMemoryItem, setMemoryStatus, supersedeMemoryItem } from '../server/sessions/memory.mjs'
import { makeWav } from '../server/sessions/wav.mjs'

const WORKSPACE = 'default'
const READER = `reader-${'a'.repeat(40)}`
const SESSIONS_ONLY = `sessions-${'b'.repeat(40)}`
const SUMMARIES_ONLY = `summaries-${'c'.repeat(40)}`
const FOREIGN = `foreign-${'d'.repeat(40)}`
const TOKENS = [
  { name: 'reader', token: READER, scopes: ['sessions:read', 'summaries:read', 'memory:read'], workspaceId: WORKSPACE },
  { name: 'sessions-only', token: SESSIONS_ONLY, scopes: ['sessions:read'], workspaceId: WORKSPACE },
  { name: 'summaries-only', token: SUMMARIES_ONLY, scopes: ['summaries:read'], workspaceId: WORKSPACE },
  { name: 'foreign', token: FOREIGN, scopes: ['sessions:read', 'summaries:read', 'memory:read'], workspaceId: 'other' }
]

const gatewayAuth = { Authorization: 'Bearer local-demo-token-only' }
const json = { ...gatewayAuth, 'Content-Type': 'application/json' }
const reader = { Authorization: `Bearer ${READER}` }

function sessionId(character) {
  return `ses_${character.repeat(32)}`
}

async function setup(t, { enabled = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-public-api-'))
  const config = loadConfig({
    DEMO_MODE: '1',
    SESSION_DATA_DIR: dir,
    SESSION_DB_PATH: path.join(dir, 'sessions.sqlite'),
    RATE_LIMIT: '1000',
    PUBLIC_API_ENABLED: enabled ? '1' : '0',
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
  const requestLog = createRequestLog()
  const server = createGateway({ ...config, sessions: sessions.service, summaries: sessions.summary, requestLog })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await sessions.worker.stop()
    server.closeAllConnections()
    server.close()
    sessions.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { base: `http://127.0.0.1:${server.address().port}`, server, sessions, requestLog }
}

async function storedSession(base, sessions, name = 'Public API session') {
  const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ name, language: 'cs' }) })
  assert.equal(created.status, 201)
  const session = (await created.json()).session
  const started = await fetch(`${base}/api/sessions/${session.id}/start`, { method: 'POST', headers: json, body: JSON.stringify({ writerId: 'public' }) })
  assert.equal(started.status, 200)
  const imported = await fetch(`${base}/api/sessions/${session.id}/import`, {
    method: 'POST',
    headers: { ...gatewayAuth, 'Content-Type': 'audio/wav', 'X-Writer-Id': 'public' },
    body: makeWav(60_000)
  })
  assert.equal(imported.status, 202)
  await sessions.worker.tick()
  const detail = await fetch(`${base}/api/sessions/${session.id}`, { headers: gatewayAuth })
  assert.equal(detail.status, 200)
  const body = await detail.json()
  return { session: body.session, turns: body.turns }
}

function seedWorkspace(sessions, id = 'other') {
  sessions.repo.db.prepare(`INSERT INTO workspace (id, provider_profile, retention_days, created_at) VALUES (?, '{}', 30, ?) ON CONFLICT(id) DO NOTHING`).run(id, Date.now())
}

function seedSession(sessions, { id, workspaceId = WORKSPACE, name = 'Seeded', createdAt, status = 'ended' }) {
  return sessions.repo.createSession({
    id,
    workspaceId,
    name,
    source: 'import',
    language: 'cs',
    goal: '',
    prep: '',
    timezone: 'Europe/Prague',
    status,
    captureState: 'off',
    transcriptRevision: 1,
    coverageDeclared: 'unknown',
    retentionDays: 30,
    createdAt,
    expiresAt: createdAt + 86_400_000
  })
}

async function get(base, pathname, headers = reader) {
  const response = await fetch(`${base}${pathname}`, { headers })
  return { response, body: await response.json() }
}

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for the request log.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('disabled public API returns public_api_disabled on every public path', async (t) => {
  const { base } = await setup(t, { enabled: false })
  for (const pathname of [
    '/api/public',
    '/api/public/me',
    '/api/public/sessions',
    `/api/public/sessions/${sessionId('9')}`,
    `/api/public/sessions/${sessionId('9')}/summary`,
    '/api/public/memory',
    '/api/public/unknown'
  ]) {
    const { response, body } = await get(base, pathname)
    assert.equal(response.status, 404, pathname)
    assert.equal(body.error, 'public_api_disabled', pathname)
    assert.equal(body.requestId.length > 0, true)
  }
  const posted = await fetch(`${base}/api/public/me`, { method: 'POST', headers: reader })
  assert.equal(posted.status, 404)
  assert.equal((await posted.json()).error, 'public_api_disabled')
})

test('public routes reject missing, malformed, unknown and gateway tokens', async (t) => {
  const { base } = await setup(t)
  const cases = [{}, { Authorization: 'Bearer' }, { Authorization: 'Basic abc' }, { Authorization: `Bearer ${'unknown-'.repeat(5)}` }, gatewayAuth]
  for (const headers of cases) {
    const { response, body } = await get(base, '/api/public/me', headers)
    assert.equal(response.status, 401)
    assert.equal(body.error, 'unauthorized')
  }
  const wrongRoute = await fetch(`${base}/api/sessions`, { headers: reader })
  assert.equal(wrongRoute.status, 401)
  assert.equal((await wrongRoute.json()).error, 'unauthorized')
  const health = await fetch(`${base}/api/health`, { headers: reader })
  assert.equal(health.status, 401)
})

test('me returns the token name, scopes and workspace without the token value', async (t) => {
  const { base } = await setup(t)
  const { response, body } = await get(base, '/api/public/me')
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(body.token).sort(), ['name', 'scopes', 'workspaceId'])
  assert.equal(body.token.name, 'reader')
  assert.deepEqual(body.token.scopes, ['sessions:read', 'summaries:read', 'memory:read'])
  assert.equal(body.token.workspaceId, WORKSPACE)
  assert.equal(typeof body.requestId, 'string')
  assert.equal(JSON.stringify(body).includes(READER), false)
})

test('session list contains only the token workspace, newest first', async (t) => {
  const { base, sessions } = await setup(t)
  seedSession(sessions, { id: sessionId('1'), name: 'Older own', createdAt: 1000 })
  seedSession(sessions, { id: sessionId('2'), name: 'Newer own', createdAt: 3000 })
  seedWorkspace(sessions)
  seedSession(sessions, { id: sessionId('3'), name: 'Foreign', workspaceId: 'other', createdAt: 2000 })
  const { response, body } = await get(base, '/api/public/sessions')
  assert.equal(response.status, 200)
  assert.deepEqual(
    body.sessions.map((session) => session.name),
    ['Newer own', 'Older own']
  )
  assert.deepEqual(Object.keys(body.sessions[0]).sort(), ['coverageDeclared', 'createdAt', 'endedAt', 'id', 'language', 'name', 'source', 'startedAt', 'status', 'transcriptRevision'])
  assert.equal(JSON.stringify(body).includes('Foreign'), false)
  assert.equal(JSON.stringify(body).includes('audioPath'), false)
  assert.equal(JSON.stringify(body).includes('turnCount'), false)
})

test('session limit applies after the workspace filter', async (t) => {
  const { base, sessions } = await setup(t)
  seedWorkspace(sessions, 'other')
  seedSession(sessions, { id: sessionId('a'), name: 'Own', createdAt: 1 })
  for (let index = 0; index < 100; index++) {
    seedSession(sessions, {
      id: `ses_${index.toString(16).padStart(32, '0')}`,
      name: `Foreign ${index}`,
      workspaceId: 'other',
      createdAt: 1000 + index
    })
  }
  const { response, body } = await get(base, '/api/public/sessions?limit=1')
  assert.equal(response.status, 200)
  assert.deepEqual(
    body.sessions.map((session) => session.name),
    ['Own']
  )
})

test('session detail returns turns, gaps and coverage for an own session', async (t) => {
  const { base, sessions } = await setup(t)
  const { session } = await storedSession(base, sessions)
  sessions.service.addGap(session.id, { startMs: 45_000, endMs: 50_000, reason: 'network' })
  const { response, body } = await get(base, `/api/public/sessions/${session.id}`)
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(body.session).sort(), ['coverageDeclared', 'createdAt', 'endedAt', 'id', 'language', 'name', 'source', 'startedAt', 'status', 'transcriptRevision'])
  assert.equal(body.session.id, session.id)
  assert.equal(body.turns.length, 2)
  assert.deepEqual(Object.keys(body.turns[0]).sort(), ['createdAt', 'endMs', 'id', 'revision', 'startMs', 'text'])
  assert.equal(body.gaps.length, 1)
  assert.deepEqual(body.gaps[0], { startMs: 45_000, endMs: 50_000, reason: 'network' })
  assert.deepEqual(body.coverage, { declared: 'partial', pendingTranscriptions: 0 })
  assert.equal('segments' in body, false)
  assert.equal('jobs' in body, false)
  assert.equal('summaries' in body, false)
  assert.equal('preparation' in body, false)
})

test('session detail returns the same not_found for unknown, malformed, deleted and foreign ids', async (t) => {
  const { base, sessions } = await setup(t)
  const own = sessions.service.createSession({ name: 'Deleted later', language: 'cs' })
  assert.equal(sessions.service.deleteSession(own.id), true)
  seedWorkspace(sessions)
  seedSession(sessions, { id: sessionId('f'), name: 'Foreign', workspaceId: 'other', createdAt: 1000 })
  const cases = [`/api/public/sessions/${sessionId('9')}`, '/api/public/sessions/not-a-session', `/api/public/sessions/${own.id}`, `/api/public/sessions/${sessionId('f')}`]
  for (const pathname of cases) {
    const { response, body } = await get(base, pathname)
    assert.equal(response.status, 404, pathname)
    assert.equal(body.error, 'not_found', pathname)
    assert.equal(body.message, 'Session not found.', pathname)
  }
})

test('scope is checked before the session lookup', async (t) => {
  const { base } = await setup(t)
  const missing = sessionId('9')
  const summaryWithoutScope = await get(base, `/api/public/sessions/${missing}/summary`, { Authorization: `Bearer ${SESSIONS_ONLY}` })
  assert.equal(summaryWithoutScope.response.status, 403)
  assert.equal(summaryWithoutScope.body.error, 'insufficient_scope')
  const detailWithoutScope = await get(base, `/api/public/sessions/${missing}`, { Authorization: `Bearer ${SUMMARIES_ONLY}` })
  assert.equal(detailWithoutScope.response.status, 403)
  assert.equal(detailWithoutScope.body.error, 'insufficient_scope')
  const listWithoutScope = await get(base, '/api/public/sessions', { Authorization: `Bearer ${SUMMARIES_ONLY}` })
  assert.equal(listWithoutScope.response.status, 403)
  const memoryWithoutScope = await get(base, '/api/public/memory', { Authorization: `Bearer ${SESSIONS_ONLY}` })
  assert.equal(memoryWithoutScope.response.status, 403)
  assert.equal(memoryWithoutScope.body.error, 'insufficient_scope')
})

test('summary returns the latest ready summary with citations and 404 without one', async (t) => {
  const { base, sessions } = await setup(t)
  const { session } = await storedSession(base, sessions)
  sessions.service.endSession(session.id, { writerId: 'public' })
  const first = sessions.summary.requestSummary(session.id)
  const firstReady = await sessions.summary.run(first.summary.id)
  assert.equal(firstReady.status, 'ready')
  const { response, body } = await get(base, `/api/public/sessions/${session.id}/summary`)
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(body.summary).sort(), ['actionCandidates', 'citations', 'content', 'coverage', 'createdAt', 'editedAt', 'id', 'readyAt', 'reviewStatus', 'status', 'transcriptRevision'])
  assert.equal(body.summary.id, firstReady.id)
  assert.equal(body.summary.status, 'ready')
  assert.equal(body.summary.reviewStatus, 'unreviewed')
  assert.equal(body.summary.citations.length > 0, true)
  assert.equal(body.summary.citations[0].quote.length > 0, true)
  assert.equal(body.summary.content.overview.text, 'Shrnutí schůzky.')

  sessions.service.correctTurn(session.id, firstReady.citations[0].turnId, { text: 'Opravený přepis schůzky' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = sessions.summary.requestSummary(session.id, { force: true })
  const secondReady = await sessions.summary.run(second.summary.id)
  assert.equal(secondReady.status, 'ready')
  assert.notEqual(secondReady.id, firstReady.id)
  const latest = await get(base, `/api/public/sessions/${session.id}/summary`)
  assert.equal(latest.response.status, 200)
  assert.equal(latest.body.summary.id, secondReady.id)

  const empty = sessions.service.createSession({ name: 'No summary', language: 'cs' })
  const missing = await get(base, `/api/public/sessions/${empty.id}/summary`)
  assert.equal(missing.response.status, 404)
  assert.equal(missing.body.error, 'not_found')
})

test('memory returns approved workspace items only and never the source quote', async (t) => {
  const { base, sessions } = await setup(t)
  const { session, turns } = await storedSession(base, sessions, 'Memory source')
  const proposed = proposeMemoryItem({
    repo: sessions.repo,
    workspaceId: WORKSPACE,
    sessionId: session.id,
    turnId: turns[0].id,
    revision: turns[0].revision,
    kind: 'fact',
    text: 'Návrh zůstává neschválený.',
    now: 1000
  })
  const approved = proposeMemoryItem({
    repo: sessions.repo,
    workspaceId: WORKSPACE,
    sessionId: session.id,
    turnId: turns[1].id,
    revision: turns[1].revision,
    kind: 'decision',
    text: 'Rozpočet je 120 tisíc korun.',
    now: 2000
  })
  setMemoryStatus({ repo: sessions.repo, sessionId: session.id, memoryId: approved.id, status: 'approved', now: 2100 })
  const superseded = proposeMemoryItem({
    repo: sessions.repo,
    workspaceId: WORKSPACE,
    sessionId: session.id,
    turnId: turns[0].id,
    revision: turns[0].revision,
    kind: 'fact',
    text: 'Nahrazený záznam.',
    now: 3000
  })
  setMemoryStatus({ repo: sessions.repo, sessionId: session.id, memoryId: superseded.id, status: 'approved', now: 3100 })
  supersedeMemoryItem({ repo: sessions.repo, sessionId: session.id, memoryId: superseded.id, text: 'Nový návrh místo záznamu.', now: 4000 })

  const kept = await storedSession(base, sessions, 'Kept source')
  const keptItem = proposeMemoryItem({
    repo: sessions.repo,
    workspaceId: WORKSPACE,
    sessionId: kept.session.id,
    turnId: kept.turns[0].id,
    revision: kept.turns[0].revision,
    kind: 'commitment',
    text: 'Zůstává i po smazání zdroje.',
    now: 5000
  })
  setMemoryStatus({ repo: sessions.repo, sessionId: kept.session.id, memoryId: keptItem.id, status: 'approved', now: 5100 })
  sessions.service.deleteSession(kept.session.id, { keepMemory: true })

  sessions.repo.db
    .prepare(
      `INSERT INTO memory_items (
        id, workspace_id, session_id, turn_id, turn_revision, kind, text, source_quote, status,
        supersedes_id, source_deleted, evidence_state, created_at, updated_at, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(`mem_${'e'.repeat(32)}`, 'other', sessionId('e'), `turn_${'e'.repeat(32)}`, 1, 'fact', 'Foreign item.', 'FOREIGN-SOURCE-QUOTE', 'approved', null, 0, 'present', 6000, 6000, 6000)

  const { response, body } = await get(base, '/api/public/memory')
  assert.equal(response.status, 200)
  assert.deepEqual(
    body.items.map((item) => item.id),
    [keptItem.id, approved.id]
  )
  assert.equal(
    body.items.every((item) => item.status === 'approved'),
    true
  )
  assert.equal(
    body.items.every((item) => !('sourceQuote' in item)),
    true
  )
  assert.deepEqual(Object.keys(body.items[0]).sort(), ['approvedAt', 'createdAt', 'evidenceState', 'id', 'kind', 'sessionId', 'status', 'text', 'turnId', 'turnRevision', 'updatedAt'])
  assert.equal(body.items.find((item) => item.id === keptItem.id).evidenceState, 'lost')
  assert.equal(body.items.find((item) => item.id === keptItem.id).sessionId, kept.session.id)
  assert.equal(JSON.stringify(body).includes('Návrh zůstává neschválený.'), false)
  assert.equal(JSON.stringify(body).includes('Nahrazený záznam.'), false)
  assert.equal(JSON.stringify(body).includes('Nový návrh místo záznamu.'), false)
  assert.equal(JSON.stringify(body).includes('Foreign item.'), false)
  assert.equal(JSON.stringify(body).includes('FOREIGN-SOURCE-QUOTE'), false)
  assert.equal(JSON.stringify(body).includes('Rozpočet na projekt je 120 tisíc korun'), false)
  assert.equal(JSON.stringify(body).includes(proposed.id), false)
  assert.equal(JSON.stringify(body).includes(superseded.id), false)

  const filtered = await get(base, '/api/public/memory?status=proposed&query=Návrh')
  assert.equal(filtered.response.status, 200)
  assert.deepEqual(
    filtered.body.items.map((item) => item.id),
    [keptItem.id, approved.id]
  )
})

test('non-GET methods on public paths return 405 with Allow: GET', async (t) => {
  const { base, sessions } = await setup(t)
  const { session } = await storedSession(base, sessions)
  for (const [method, pathname] of [
    ['POST', '/api/public/sessions'],
    ['PATCH', '/api/public/memory'],
    ['DELETE', `/api/public/sessions/${session.id}`],
    ['PUT', `/api/public/sessions/${session.id}/summary`]
  ]) {
    const response = await fetch(`${base}${pathname}`, { method, headers: reader })
    assert.equal(response.status, 405, `${method} ${pathname}`)
    assert.equal(response.headers.get('allow'), 'GET', `${method} ${pathname}`)
    assert.equal((await response.json()).error, 'method_not_allowed', `${method} ${pathname}`)
  }
  // CORS preflight stays a 204 like every other gateway route; it is not a read.
  const preflight = await fetch(`${base}/api/public/me`, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  const unknown = await fetch(`${base}/api/public/unknown`, { method: 'POST', headers: reader })
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error, 'not_found')
})

test('limit is bounded and invalid values are rejected', async (t) => {
  const { base, sessions } = await setup(t)
  seedSession(sessions, { id: sessionId('1'), name: 'First', createdAt: 1000 })
  seedSession(sessions, { id: sessionId('2'), name: 'Second', createdAt: 2000 })
  seedSession(sessions, { id: sessionId('3'), name: 'Third', createdAt: 3000 })
  const fallback = await get(base, '/api/public/sessions')
  assert.equal(fallback.response.status, 200)
  assert.deepEqual(
    fallback.body.sessions.map((session) => session.name),
    ['Third', 'Second', 'First']
  )
  const one = await get(base, '/api/public/sessions?limit=1')
  assert.equal(one.response.status, 200)
  assert.deepEqual(
    one.body.sessions.map((session) => session.name),
    ['Third']
  )
  const hundred = await get(base, '/api/public/sessions?limit=100')
  assert.equal(hundred.response.status, 200)
  assert.equal(hundred.body.sessions.length, 3)
  for (const value of ['0', '101', 'abc', '1.5', '-1', '']) {
    const { response, body } = await get(base, `/api/public/sessions?limit=${value}`)
    assert.equal(response.status, 400, value)
    assert.equal(body.error, 'invalid_limit', value)
  }
})

test('invalid public token configuration throws without the token value', () => {
  const valid = `token-${'z'.repeat(40)}`
  const base = { DEMO_MODE: '1', PUBLIC_API_ENABLED: '1' }
  const cases = [
    { tokens: [{ name: 'laptop', token: 'short', scopes: ['sessions:read'], workspaceId: 'default' }], field: 'token', secret: 'short' },
    { tokens: [{ name: 'laptop', token: `with space ${'z'.repeat(30)}`, scopes: ['sessions:read'], workspaceId: 'default' }], field: 'token', secret: 'with space' },
    { tokens: [{ name: 'Laptop', token: valid, scopes: ['sessions:read'], workspaceId: 'default' }], field: 'name', secret: valid },
    { tokens: [{ name: 'laptop', token: valid, scopes: [], workspaceId: 'default' }], field: 'scopes', secret: valid },
    { tokens: [{ name: 'laptop', token: valid, scopes: ['sessions:read', 'sessions:read'], workspaceId: 'default' }], field: 'scopes', secret: valid },
    { tokens: [{ name: 'laptop', token: valid, scopes: ['write:all'], workspaceId: 'default' }], field: 'scopes', secret: valid },
    { tokens: [{ name: 'laptop', token: valid, scopes: ['sessions:read'], workspaceId: 'bad workspace' }], field: 'workspaceId', secret: valid },
    {
      tokens: [
        { name: 'laptop', token: valid, scopes: ['sessions:read'], workspaceId: 'default' },
        { name: 'laptop', token: `other-${'y'.repeat(40)}`, scopes: ['memory:read'], workspaceId: 'default' }
      ],
      field: 'name',
      secret: valid
    },
    {
      tokens: [
        { name: 'laptop', token: valid, scopes: ['sessions:read'], workspaceId: 'default' },
        { name: 'phone', token: valid, scopes: ['memory:read'], workspaceId: 'default' }
      ],
      field: 'token',
      secret: valid
    }
  ]
  for (const item of cases) {
    assert.throws(
      () => loadConfig({ ...base, PUBLIC_API_TOKENS: JSON.stringify(item.tokens) }),
      (error) => {
        assert.equal(error instanceof Error, true)
        assert.equal(error.message.includes(item.field), true, error.message)
        assert.equal(error.message.includes(item.secret), false, error.message)
        return true
      }
    )
  }
  assert.throws(() => loadConfig({ ...base, PUBLIC_API_TOKENS: '[]' }), /at least one token/)
  assert.throws(() => loadConfig({ ...base, PUBLIC_API_TOKENS: 'not json' }), /JSON array/)
  const disabled = loadConfig({ ...base, PUBLIC_API_ENABLED: '0', PUBLIC_API_TOKENS: 'not json' })
  assert.equal(disabled.publicApiEnabled, false)
  assert.deepEqual(disabled.publicApiTokens, [])
  const enabled = loadConfig({ ...base, PUBLIC_API_TOKENS: JSON.stringify([{ name: 'laptop', token: valid, scopes: ['sessions:read'], workspaceId: 'default' }]) })
  assert.equal(enabled.publicApiEnabled, true)
  assert.equal(enabled.publicApiTokens.length, 1)
  assert.equal(enabled.publicApiTokens[0].name, 'laptop')
})

test('token helpers compare digests, enforce scopes and reject malformed headers', () => {
  const tokens = parsePublicApiTokens(JSON.stringify(TOKENS))
  assert.equal(authenticatePublicToken(tokens, `Bearer ${READER}`).name, 'reader')
  assert.equal(authenticatePublicToken(tokens, `bearer ${READER}`).name, 'reader')
  assert.equal(authenticatePublicToken(tokens, `Bearer ${'x'.repeat(40)}`), null)
  assert.equal(authenticatePublicToken(tokens, `Bearer ${READER} `), null)
  assert.equal(authenticatePublicToken(tokens, undefined), null)
  assert.equal(authenticatePublicToken(tokens, READER), null)
  const entry = authenticatePublicToken(tokens, `Bearer ${READER}`)
  assert.equal(requireScope(entry, 'memory:read'), entry)
  assert.throws(
    () => requireScope(entry, 'admin:write'),
    (error) => error.status === 403 && error.code === 'insufficient_scope'
  )
})

test('request log keeps the public pathname without the query or token', async (t) => {
  const { base, requestLog } = await setup(t)
  const response = await fetch(`${base}/api/public/sessions?limit=1&token=${READER}&transcript=PRIVATE`, { headers: reader })
  assert.equal(response.status, 200)
  await response.json()
  const id = response.headers.get('x-request-id')
  await waitFor(() => requestLog.find(id))
  const entry = requestLog.find(id)
  assert.equal(entry.route, '/api/public/sessions')
  assert.equal(entry.stage, 'public')
  assert.equal(entry.status, 200)
  assert.equal(entry.code, undefined)
  assert.doesNotMatch(requestLog.export(), new RegExp(READER))
  assert.doesNotMatch(requestLog.export(), /PRIVATE|transcript|limit=/)

  const denied = await fetch(`${base}/api/public/sessions/${sessionId('9')}/summary?token=${SESSIONS_ONLY}`, { headers: { Authorization: `Bearer ${SESSIONS_ONLY}` } })
  assert.equal(denied.status, 403)
  await denied.json()
  const deniedId = denied.headers.get('x-request-id')
  await waitFor(() => requestLog.find(deniedId))
  assert.equal(requestLog.find(deniedId).code, 'insufficient_scope')
  assert.equal(requestLog.find(deniedId).route, `/api/public/sessions/${sessionId('9')}/summary`)
  assert.doesNotMatch(requestLog.export(), new RegExp(SESSIONS_ONLY))
})
