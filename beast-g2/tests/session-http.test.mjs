import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGateway, loadConfig } from '../server/gateway.mjs'
import { createSessions } from '../server/sessions/index.mjs'
import { makeWav } from '../server/sessions/wav.mjs'

async function setup(t, { transcribe, summarize } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-session-http-'))
  const config = loadConfig({
    DEMO_MODE: '1',
    SESSION_DATA_DIR: dir,
    SESSION_DB_PATH: path.join(dir, 'sessions.sqlite'),
    RATE_LIMIT: '1000'
  })
  const sessions = createSessions({
    config,
    transcribe: transcribe ?? (async ({ sequence }) => `HTTP segment ${sequence}`),
    summarize:
      summarize ??
      (async ({ turns }) => ({
        overview: { text: 'HTTP summary.', citations: [turns[0].id] },
        decisions: [{ text: 'HTTP decision.', citations: [turns[0].id] }],
        actionCandidates: [],
        openQuestions: []
      }))
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

async function createSession(base, overrides = {}) {
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ name: 'HTTP session', language: 'cs', ...overrides })
  })
  assert.equal(response.status, 201)
  return (await response.json()).session
}

async function startSession(base, session) {
  const response = await fetch(`${base}/api/sessions/${session.id}/start`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ writerId: 'http' })
  })
  assert.equal(response.status, 200)
  return (await response.json()).session
}

test('HTTP session flow imports, transcribes, exports and deletes a stored session', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  t.after(() => release())
  const { base, sessions } = await setup(t, {
    summarize: async ({ turns }) => {
      await gate
      return {
        overview: { text: 'HTTP summary.', citations: [turns[0].id] },
        decisions: [{ text: 'HTTP decision.', citations: [turns[0].id] }],
        actionCandidates: [],
        openQuestions: []
      }
    }
  })
  const session = await createSession(base)
  await startSession(base, session)
  const imported = await fetch(`${base}/api/sessions/${session.id}/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'audio/wav', 'X-Writer-Id': 'http' },
    body: makeWav(90_000)
  })
  assert.equal(imported.status, 202)
  const result = (await imported.json()).import
  assert.equal(result.segmentsAccepted, 3)
  assert.equal(result.truncated, false)
  await sessions.worker.tick()
  const detailResponse = await fetch(`${base}/api/sessions/${session.id}`, { headers: auth })
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json()
  assert.equal(detail.turns.length, 3)
  assert.equal(detail.jobs.length, 3)
  assert.equal(
    detail.jobs.every((job) => job.state === 'done'),
    true
  )
  const ended = await fetch(`${base}/api/sessions/${session.id}/end`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ writerId: 'http', lastSequence: 2 })
  })
  assert.equal(ended.status, 200)
  const endedJson = await ended.json()
  const requested = await fetch(`${base}/api/sessions/${session.id}/summary`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({})
  })
  assert.equal(requested.status, 202)
  const pending = (await requested.json()).summary
  assert.equal(pending.status, 'pending')
  const repeatedRequest = await fetch(`${base}/api/sessions/${session.id}/summary`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({})
  })
  assert.equal(repeatedRequest.status, 202)
  assert.equal((await repeatedRequest.json()).summary.id, pending.id)
  release()
  const ready = await sessions.summary.run(pending.id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.content.overview.text, 'HTTP summary.')
  assert.equal(ready.citations.length, 1)
  const latestResponse = await fetch(`${base}/api/sessions/${session.id}/summary`, { headers: auth })
  assert.equal(latestResponse.status, 200)
  assert.equal((await latestResponse.json()).summary.id, ready.id)
  const preparationResponse = await fetch(`${base}/api/sessions/${session.id}/preparation`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ sourceSummaryId: ready.id, focus: 'Follow up' })
  })
  assert.equal(preparationResponse.status, 201)
  const preparation = (await preparationResponse.json()).preparation
  assert.equal(preparation.status, 'ready')
  assert.equal(preparation.content.source.summaryId, ready.id)
  assert.equal(preparation.content.source.sessionId, session.id)
  assert.equal(preparation.content.citations[0].date, new Date(endedJson.session.endedAt).toISOString())
  const editedResponse = await fetch(`${base}/api/sessions/${session.id}/summaries/${ready.id}`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify({ content: { ...ready.content, overview: { text: 'Edited summary.', citations: ready.content.overview.citations } } })
  })
  assert.equal(editedResponse.status, 200)
  assert.equal((await editedResponse.json()).summary.reviewStatus, 'edited')
  const stalePreparation = await fetch(`${base}/api/sessions/${session.id}/preparation`, { headers: auth })
  assert.equal((await stalePreparation.json()).preparation.status, 'stale')
  const jsonExport = await fetch(`${base}/api/sessions/${session.id}/export?format=json`, { headers: auth })
  assert.equal(jsonExport.status, 200)
  const exported = await jsonExport.json()
  assert.equal(exported.formatVersion, 2)
  assert.equal(exported.summaries.length, 1)
  assert.equal(exported.preparations.length, 1)
  assert.equal(exported.completeness.declared, 'complete')
  assert.equal(exported.completeness.transcribedSegments, 3)
  const markdown = await fetch(`${base}/api/sessions/${session.id}/export?format=markdown`, { headers: auth })
  assert.equal(markdown.status, 200)
  assert.match(markdown.headers.get('content-type'), /text\/markdown/)
  assert.match(await markdown.text(), /HTTP segment 0/)
  const list = await fetch(`${base}/api/sessions`, { headers: auth })
  assert.equal((await list.json()).sessions.length, 1)
  const deleted = await fetch(`${base}/api/sessions/${session.id}`, { method: 'DELETE', headers: auth })
  assert.equal(deleted.status, 204)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}`, { headers: auth })).status, 404)
})

test('HTTP segment headers are idempotent and reject conflicting content', async (t) => {
  const { base } = await setup(t)
  const session = await createSession(base)
  await startSession(base, session)
  const upload = (id, body) =>
    fetch(`${base}/api/sessions/${session.id}/segments`, {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'audio/wav',
        'X-Writer-Id': 'http',
        'X-Segment-Id': id,
        'X-Sequence': '0',
        'X-Start-Ms': '0',
        'X-End-Ms': '1000'
      },
      body
    })
  const id = `seg_${'a'.repeat(32)}`
  const first = await upload(id, makeWav(1000))
  assert.equal(first.status, 201)
  assert.equal((await first.json()).duplicate, false)
  const second = await upload(id, makeWav(1000))
  assert.equal(second.status, 200)
  assert.equal((await second.json()).duplicate, true)
  const conflict = await upload(id, makeWav(1000, 4))
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error, 'segment_conflict')
})

test('HTTP sessions require auth, expose session capability and allow CORS writes', async (t) => {
  const { base } = await setup(t)
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401)
  const health = await fetch(`${base}/api/health`, { headers: auth })
  assert.equal((await health.json()).sessions, true)
  const preflight = await fetch(`${base}/api/sessions/ses_${'a'.repeat(32)}`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'DELETE',
      'Access-Control-Request-Headers': 'authorization,x-writer-id'
    }
  })
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/)
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Writer-Id/)
})

test('HTTP sessions reject import before start, bad export formats and bad WAV bodies', async (t) => {
  const { base } = await setup(t)
  const session = await createSession(base)
  const beforeStart = await fetch(`${base}/api/sessions/${session.id}/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'audio/wav', 'X-Writer-Id': 'http' },
    body: makeWav(1000)
  })
  assert.equal(beforeStart.status, 409)
  assert.equal((await beforeStart.json()).error, 'session_not_active')
  await startSession(base, session)
  const badFormat = await fetch(`${base}/api/sessions/${session.id}/export?format=xml`, { headers: auth })
  assert.equal(badFormat.status, 400)
  const badAudio = await fetch(`${base}/api/sessions/${session.id}/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'audio/wav', 'X-Writer-Id': 'http' },
    body: Buffer.from('not a wav')
  })
  assert.equal(badAudio.status, 400)
  assert.equal((await badAudio.json()).error, 'invalid_audio')
  const gap = await fetch(`${base}/api/sessions/${session.id}/gaps`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ startMs: 1000, endMs: 2000, reason: 'network' })
  })
  assert.equal(gap.status, 201)
  assert.equal((await gap.json()).gap.reason, 'network')
})

test('HTTP corrections preserve revisions and source links', async (t) => {
  const { base, sessions } = await setup(t)
  const session = await createSession(base)
  await startSession(base, session)
  const imported = await fetch(`${base}/api/sessions/${session.id}/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'audio/wav', 'X-Writer-Id': 'http' },
    body: makeWav(1000)
  })
  assert.equal(imported.status, 202)
  await sessions.worker.tick()
  const detailBefore = await fetch(`${base}/api/sessions/${session.id}`, { headers: auth })
  const before = await detailBefore.json()
  assert.equal(before.turns.length, 1)
  const corrected = await fetch(`${base}/api/sessions/${session.id}/turns/${before.turns[0].id}`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify({ text: 'Ručně opravený text' })
  })
  assert.equal(corrected.status, 200)
  assert.equal((await corrected.json()).turn.revision, 2)
  const detailAfter = await fetch(`${base}/api/sessions/${session.id}`, { headers: auth })
  const after = await detailAfter.json()
  assert.equal(after.turns[0].text, 'Ručně opravený text')
  assert.equal(after.session.transcriptRevision, 2)
})

test('deleting a session is idempotent and removes stored audio', async (t) => {
  const { base, sessions } = await setup(t)
  const session = await createSession(base)
  await startSession(base, session)
  const imported = await fetch(`${base}/api/sessions/${session.id}/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'audio/wav', 'X-Writer-Id': 'http' },
    body: makeWav(1000)
  })
  assert.equal(imported.status, 202)
  const segment = sessions.repo.listSegments(session.id)[0]
  assert.ok(segment)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}`, { method: 'DELETE', headers: auth })).status, 204)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}`, { method: 'DELETE', headers: auth })).status, 204)
  assert.equal(sessions.repo.getSegment(segment.id), null)
})
