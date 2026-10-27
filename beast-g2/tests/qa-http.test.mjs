import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGateway, loadConfig } from '../server/gateway.mjs'
import { createSessions } from '../server/sessions/index.mjs'
import { makeWav } from '../server/sessions/wav.mjs'

async function setup(t, { answer } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-qa-http-'))
  const config = loadConfig({
    DEMO_MODE: '1',
    SESSION_DATA_DIR: dir,
    SESSION_DB_PATH: path.join(dir, 'sessions.sqlite'),
    RATE_LIMIT: '1000'
  })
  const sessions = createSessions({
    config,
    transcribe: async ({ sequence }) => (sequence === 0 ? 'Rozpočet na projekt je 120 tisíc korun' : 'Termín schůzky je v pátek'),
    summarize: async () => ({}),
    answer: answer ?? (async ({ turns }) => ({ text: 'Rozpočet je 120 tisíc korun.', citations: [{ turnId: turns[0].id, revision: turns[0].revision }] }))
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

async function storedSession(base, sessions, name = 'HTTP QA') {
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

async function detail(base, id) {
  const response = await fetch(`${base}/api/sessions/${id}`, { headers: auth })
  assert.equal(response.status, 200)
  return response.json()
}

test('HTTP QA answers with a citation and leaves the transcript revision unchanged', async (t) => {
  const { base, sessions } = await setup(t)
  const session = await storedSession(base, sessions)
  const before = await detail(base, session.id)
  assert.equal(before.turns.length, 2)
  const summaryCount = sessions.db.prepare('SELECT COUNT(*) AS count FROM summaries').get().count

  const response = await fetch(`${base}/api/sessions/${session.id}/qa`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ question: 'rozpočet' })
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.requestId.length > 0, true)
  assert.equal(body.answer.evidence, 'sufficient')
  assert.equal(body.answer.text, 'Rozpočet je 120 tisíc korun.')
  assert.equal(body.answer.citations.length, 1)
  assert.equal(body.answer.citations[0].turnId, before.turns[0].id)
  assert.equal(body.answer.citations[0].revision, before.turns[0].revision)
  assert.equal(body.answer.citations[0].startMs, 0)
  assert.equal(body.answer.citations[0].endMs, 30_000)
  assert.equal(body.answer.citations[0].quote, before.turns[0].text)

  const after = await detail(base, session.id)
  assert.equal(after.session.transcriptRevision, before.session.transcriptRevision)
  assert.deepEqual(after.turns, before.turns)
  assert.deepEqual(after.summaries, before.summaries)
  assert.equal(sessions.db.prepare('SELECT COUNT(*) AS count FROM summaries').get().count, summaryCount)
})

test('HTTP QA returns insufficient_evidence as a normal answer', async (t) => {
  const { base, sessions } = await setup(t, { answer: async () => ({ text: 'Nevím.', citations: [] }) })
  const session = await storedSession(base, sessions, 'Bez opory')

  const response = await fetch(`${base}/api/sessions/${session.id}/qa`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ question: 'rozpočet' })
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.answer.evidence, 'insufficient')
  assert.deepEqual(body.answer.citations, [])
  assert.match(body.answer.text, /enough evidence/i)
})

test('HTTP QA rejects an empty or oversized question and a non-POST method', async (t) => {
  const { base, sessions } = await setup(t)
  const session = await storedSession(base, sessions)

  for (const body of [{}, { question: '' }, { question: '   ' }]) {
    const empty = await fetch(`${base}/api/sessions/${session.id}/qa`, { method: 'POST', headers: json, body: JSON.stringify(body) })
    assert.equal(empty.status, 400)
    assert.equal((await empty.json()).error, 'question_required')
  }

  const oversized = await fetch(`${base}/api/sessions/${session.id}/qa`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ question: 'x'.repeat(501) })
  })
  assert.equal(oversized.status, 400)
  assert.equal((await oversized.json()).error, 'invalid_question')

  const get = await fetch(`${base}/api/sessions/${session.id}/qa`, { headers: auth })
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
})

test('HTTP QA maps a provider failure to 502 qa_failed without an answer', async (t) => {
  const { base, sessions } = await setup(t, {
    answer: async () => {
      throw new Error('provider down')
    }
  })
  const session = await storedSession(base, sessions, 'Selhání')

  const response = await fetch(`${base}/api/sessions/${session.id}/qa`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ question: 'rozpočet' })
  })
  assert.equal(response.status, 502)
  const body = await response.json()
  assert.equal(body.error, 'qa_failed')
  assert.equal(body.answer, undefined)
  assert.equal(body.requestId.length > 0, true)

  const after = await detail(base, session.id)
  assert.equal(after.session.transcriptRevision, 1)
  assert.equal(after.turns.length, 2)
})

test('the QA route does not shadow the session detail or the search route', async (t) => {
  const { base, sessions } = await setup(t)
  const session = await storedSession(base, sessions, 'Detail survives')

  const found = await fetch(`${base}/api/sessions/search?q=rozpocet`, { headers: auth })
  assert.equal(found.status, 200)
  assert.equal((await found.json()).results.length, 1)

  const listed = await fetch(`${base}/api/sessions`, { headers: auth })
  assert.equal(listed.status, 200)
  assert.equal((await listed.json()).sessions.length, 1)

  const detailResponse = await fetch(`${base}/api/sessions/${session.id}`, { headers: auth })
  assert.equal(detailResponse.status, 200)
  assert.equal((await detailResponse.json()).session.name, 'Detail survives')
})

test('HTTP QA rejects an unknown session', async (t) => {
  const { base } = await setup(t)

  const response = await fetch(`${base}/api/sessions/ses_${'f'.repeat(32)}/qa`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ question: 'rozpočet' })
  })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error, 'not_found')
})
