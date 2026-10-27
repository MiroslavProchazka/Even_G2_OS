import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGateway, loadConfig } from '../server/gateway.mjs'
import { createSessions } from '../server/sessions/index.mjs'
import { makeWav } from '../server/sessions/wav.mjs'

async function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-search-http-'))
  const config = loadConfig({
    DEMO_MODE: '1',
    SESSION_DATA_DIR: dir,
    SESSION_DB_PATH: path.join(dir, 'sessions.sqlite'),
    RATE_LIMIT: '1000'
  })
  const sessions = createSessions({
    config,
    transcribe: async ({ sequence }) => (sequence === 0 ? 'Zrušit schůzku, rozpočet a termín' : 'Rozpočet schválen'),
    summarize: async () => ({})
  })
  const server = createGateway({ ...config, sessions: sessions.service, summaries: sessions.summary })
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

const auth = { Authorization: 'Bearer local-demo-token-only' }
const json = { ...auth, 'Content-Type': 'application/json' }

async function storedSession(base, sessions, name = 'HTTP search') {
  const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ name, language: 'cs' }) })
  assert.equal(created.status, 201)
  const session = (await created.json()).session
  const started = await fetch(`${base}/api/sessions/${session.id}/start`, { method: 'POST', headers: json, body: JSON.stringify({ writerId: 'http' }) })
  assert.equal(started.status, 200)
  const imported = await fetch(`${base}/api/sessions/${session.id}/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'audio/wav', 'X-Writer-Id': 'http' },
    body: makeWav(60_000)
  })
  assert.equal(imported.status, 202)
  await sessions.worker.tick()
  return session
}

test('HTTP search finds Czech transcript text without diacritics', async (t) => {
  const { base, sessions } = await setup(t)
  const session = await storedSession(base, sessions)

  const found = await fetch(`${base}/api/sessions/search?q=zrusit`, { headers: auth })
  assert.equal(found.status, 200)
  const body = await found.json()
  assert.equal(body.requestId.length > 0, true)
  assert.equal(body.results.length, 1)
  const [result] = body.results
  assert.equal(result.sessionId, session.id)
  assert.equal(result.sessionName, 'HTTP search')
  assert.equal(result.revision, 1)
  assert.equal(result.startMs, 0)
  assert.equal(result.endMs, 30_000)
  assert.match(result.snippet, /\[Zrušit\]/)
  assert.equal(typeof result.turnId, 'string')

  const all = await fetch(`${base}/api/sessions/search?q=${encodeURIComponent('rozpočet')}&limit=500`, { headers: auth })
  assert.equal((await all.json()).results.length, 2)
  const one = await fetch(`${base}/api/sessions/search?q=${encodeURIComponent('rozpočet')}&limit=0`, { headers: auth })
  assert.equal((await one.json()).results.length, 1)
})

test('HTTP search rejects an empty query and a non-GET method', async (t) => {
  const { base } = await setup(t)
  const empty = await fetch(`${base}/api/sessions/search?q=`, { headers: auth })
  assert.equal(empty.status, 400)
  assert.equal((await empty.json()).error, 'query_required')

  const missing = await fetch(`${base}/api/sessions/search`, { headers: auth })
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error, 'query_required')

  const post = await fetch(`${base}/api/sessions/search?q=zrusit`, { method: 'POST', headers: json, body: '{}' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET')
})

test('the search route does not shadow /api/sessions/:id', async (t) => {
  const { base, sessions } = await setup(t)
  const session = await storedSession(base, sessions, 'Detail survives')

  const detail = await fetch(`${base}/api/sessions/${session.id}`, { headers: auth })
  assert.equal(detail.status, 200)
  const body = await detail.json()
  assert.equal(body.session.id, session.id)
  assert.equal(body.session.name, 'Detail survives')

  const list = await fetch(`${base}/api/sessions`, { headers: auth })
  assert.equal(list.status, 200)
  assert.equal((await list.json()).sessions.length, 1)
})

test('a deleted session disappears from HTTP search results', async (t) => {
  const { base, sessions } = await setup(t)
  const session = await storedSession(base, sessions, 'Smazaná')
  assert.equal((await (await fetch(`${base}/api/sessions/search?q=zrusit`, { headers: auth })).json()).results.length, 1)

  const deleted = await fetch(`${base}/api/sessions/${session.id}`, { method: 'DELETE', headers: auth })
  assert.equal(deleted.status, 204)
  const after = await fetch(`${base}/api/sessions/search?q=zrusit`, { headers: auth })
  assert.equal(after.status, 200)
  assert.deepEqual((await after.json()).results, [])
})
