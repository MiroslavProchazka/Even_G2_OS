import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGateway, loadConfig } from '../server/gateway.mjs'
import { createSessions } from '../server/sessions/index.mjs'
import { openDatabase } from '../server/sessions/db.mjs'
import { Repository } from '../server/sessions/repository.mjs'
import { SessionService } from '../server/sessions/service.mjs'
import { SummaryService } from '../server/sessions/summary.mjs'
import { TranscriptionWorker } from '../server/sessions/worker.mjs'
import { makeWav } from '../server/sessions/wav.mjs'
import { createBriefingService, selectSessionIds } from '../server/briefing/briefing.mjs'

const defaultGenerate = async ({ turns }) => ({
  overview: { text: 'Shrnutí schůzky.', citations: [turns[0].id] },
  decisions: [{ text: 'Rozpočet byl schválen.', citations: [turns[0].id] }],
  actionCandidates: [{ text: 'Poslat podklady.', owner: 'Jana', due: null, dueText: 'do pátku', conditional: false, citations: [turns[1].id] }],
  openQuestions: [{ text: 'Kdo schválí rozpočet?', citations: [turns[1].id] }]
})

function setup(t, { generate } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-briefing-'))
  const db = openDatabase(path.join(dir, 'sessions.sqlite'))
  const repo = new Repository(db)
  const service = new SessionService({ repo, dataDir: dir })
  const worker = new TranscriptionWorker({
    service,
    repo,
    transcribe: async ({ sequence }) => `Přepis segmentu ${sequence}`,
    backoffMs: 0
  })
  const summary = new SummaryService({ repo, generate: generate ?? defaultGenerate })
  service.attachSummaryService(summary)
  t.after(async () => {
    await worker.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, db, repo, service, worker, summary }
}

function recorded(service, worker, name, count = 2) {
  const session = service.createSession({ name, language: 'cs' })
  service.startSession(session.id, { writerId: 'test' })
  for (let sequence = 0; sequence < count; sequence++) {
    service.acceptSegment(
      session.id,
      {
        id: `seg_${randomUUID().replaceAll('-', '')}`,
        sequence,
        startMs: sequence * 1000,
        endMs: sequence * 1000 + 1000,
        audio: makeWav(1000, sequence + 1)
      },
      { writerId: 'test' }
    )
  }
  return session
}

async function summarized(service, worker, summary, name, count = 2) {
  const session = recorded(service, worker, name, count)
  await worker.tick()
  const ended = service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  const ready = await summary.run(requested.summary.id)
  assert.equal(ready.status, 'ready')
  return { session: ended, summary: ready, sessionTurns: service.getSessionDetail(session.id).turns }
}

function briefing(service, sessionIds) {
  return createBriefingService({ service }).build(sessionIds)
}

test('briefing builds verified items from the latest summaries of two selected sessions', async (t) => {
  const { service, worker, summary } = setup(t)
  const first = await summarized(service, worker, summary, 'První schůzka')
  const second = await summarized(service, worker, summary, 'Druhá schůzka')
  const result = briefing(service, [first.session.id, second.session.id])

  assert.equal(result.maxSessions, 3)
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(
    result.sources.map((source) => source.sessionId),
    [first.session.id, second.session.id]
  )
  for (const [index, source] of result.sources.entries()) {
    const expected = [first, second][index]
    assert.equal(source.sessionName, expected.session.name)
    assert.equal(source.sessionDate, new Date(expected.session.endedAt).toISOString())
    assert.equal(source.summaryId, expected.summary.id)
    assert.equal(source.summaryCreatedAt, new Date(expected.summary.readyAt).toISOString())
    assert.equal(source.summaryStatus, 'ready')
    assert.equal(source.reviewStatus, 'unreviewed')
    assert.equal(source.transcriptRevision, expected.session.transcriptRevision)
    assert.equal(source.summaryTranscriptRevision, expected.summary.transcriptRevision)
    assert.equal(source.verification, 'verified')
    assert.equal(source.reason, null)
    assert.equal(source.coverage.declared, 'complete')
  }

  assert.deepEqual(
    result.items.map((item) => item.kind),
    ['overview', 'overview', 'decision', 'decision', 'commitment', 'commitment', 'open_question', 'open_question']
  )
  assert.deepEqual(
    result.items.map((item) => item.id),
    [
      `${first.summary.id}:overview`,
      `${second.summary.id}:overview`,
      `${first.summary.id}:decision:0`,
      `${second.summary.id}:decision:0`,
      `${first.summary.id}:commitment:${first.summary.actionCandidates[0].id}`,
      `${second.summary.id}:commitment:${second.summary.actionCandidates[0].id}`,
      `${first.summary.id}:open_question:0`,
      `${second.summary.id}:open_question:0`
    ]
  )
  const turns = new Map([...first.sessionTurns, ...second.sessionTurns].map((turn) => [turn.id, turn]))
  for (const item of result.items) {
    assert.equal(item.verification, 'verified')
    assert.equal(item.source.verification, 'verified')
    assert.ok([first.session.id, second.session.id].includes(item.source.sessionId))
    assert.match(item.source.summaryId, /^sum_[a-f0-9]{32}$/)
    assert.equal(item.source.sessionDate, result.sources.find((source) => source.sessionId === item.source.sessionId).sessionDate)
    assert.equal(item.source.summaryCreatedAt, result.sources.find((source) => source.sessionId === item.source.sessionId).summaryCreatedAt)
    assert.ok(item.citations.length > 0)
    for (const citation of item.citations) {
      assert.match(citation.turnId, /^turn_[a-f0-9]{32}$/)
      assert.equal(citation.turnRevision, turns.get(citation.turnId).revision)
      assert.equal(citation.quote, turns.get(citation.turnId).text)
      assert.equal(Number.isInteger(citation.startMs), true)
      assert.equal(Number.isInteger(citation.endMs), true)
    }
    if (item.kind === 'commitment') {
      assert.equal(item.owner, 'Jana')
      assert.equal(item.due, null)
      assert.equal(item.dueText, 'do pátku')
      assert.equal(item.conditional, false)
    } else {
      assert.equal(item.owner, null)
      assert.equal(item.due, null)
      assert.equal(item.dueText, null)
      assert.equal(item.conditional, false)
    }
  }
})

test('briefing rejects an empty selection and more than three unique sessions', async (t) => {
  const { service, worker } = setup(t)
  const sessions = []
  for (let index = 0; index < 4; index++) sessions.push(recorded(service, worker, `Výběr ${index}`, 1))
  await worker.tick()

  assert.throws(
    () => selectSessionIds([]),
    (error) => error.status === 400 && error.code === 'empty_selection'
  )
  assert.throws(
    () => briefing(service, []),
    (error) => error.status === 400 && error.code === 'empty_selection'
  )
  assert.throws(
    () =>
      briefing(
        service,
        sessions.map((session) => session.id)
      ),
    (error) => error.status === 400 && error.code === 'too_many_sessions'
  )
  const deduplicated = briefing(service, [sessions[0].id, sessions[1].id, sessions[2].id, sessions[0].id])
  assert.equal(deduplicated.sources.length, 3)
  assert.deepEqual(
    deduplicated.sources.map((source) => source.sessionId),
    [sessions[0].id, sessions[1].id, sessions[2].id]
  )

  for (const value of ['ses_1', [42], ['  '], [sessions[0].id, '']]) {
    assert.throws(
      () => selectSessionIds(value),
      (error) => error.status === 400 && error.code === 'invalid_selection'
    )
  }
})

test('briefing marks a selected session without a summary unverified and contributes no items', async (t) => {
  const { service, worker, summary } = setup(t)
  const withoutSummary = recorded(service, worker, 'Bez souhrnu')
  await worker.tick()
  const verified = await summarized(service, worker, summary, 'Souhrn')

  const result = briefing(service, [withoutSummary.id, verified.session.id])
  assert.equal(result.sources.length, 2)
  const missing = result.sources[0]
  assert.equal(missing.sessionId, withoutSummary.id)
  assert.equal(missing.verification, 'unverified')
  assert.equal(missing.reason, 'no_summary')
  assert.equal(missing.summaryId, null)
  assert.equal(missing.summaryCreatedAt, null)
  assert.equal(missing.summaryStatus, null)
  assert.equal(missing.reviewStatus, null)
  assert.equal(missing.summaryTranscriptRevision, null)
  assert.equal(missing.coverage, null)
  assert.equal(result.sources[1].verification, 'verified')
  assert.equal(result.sources[1].reason, null)
  assert.equal(result.items.length, 4)
  assert.ok(result.items.every((item) => item.source.sessionId === verified.session.id))
})

test('briefing marks a summary stale after a turn correction and contributes no items', async (t) => {
  const { service, worker, summary } = setup(t)
  const verified = await summarized(service, worker, summary, 'Oprava přepisu')
  service.correctTurn(verified.session.id, verified.sessionTurns[0].id, { text: 'Opravený přepis.' })

  const result = briefing(service, [verified.session.id])
  assert.equal(result.sources[0].verification, 'unverified')
  assert.equal(result.sources[0].reason, 'summary_stale')
  assert.equal(result.sources[0].summaryStatus, 'stale')
  assert.deepEqual(result.items, [])
})

test('briefing marks a ready summary bound to an older transcript revision unverified', async (t) => {
  const { service, worker, summary, repo } = setup(t)
  const verified = await summarized(service, worker, summary, 'Změna přepisu')
  repo.updateSession(verified.session.id, { transcriptRevision: verified.session.transcriptRevision + 1 })

  const result = briefing(service, [verified.session.id])
  assert.equal(result.sources[0].verification, 'unverified')
  assert.equal(result.sources[0].reason, 'transcript_changed')
  assert.equal(result.sources[0].summaryStatus, 'ready')
  assert.equal(result.sources[0].summaryTranscriptRevision, verified.session.transcriptRevision)
  assert.equal(result.sources[0].transcriptRevision, verified.session.transcriptRevision + 1)
  assert.deepEqual(result.items, [])
})

test('briefing rejects a summary that cites a turn missing from the summary citations', async (t) => {
  const { service, worker, summary, repo } = setup(t)
  const verified = await summarized(service, worker, summary, 'Chybějící citace')
  const missingTurn = `turn_${'f'.repeat(32)}`
  const content = {
    ...verified.summary.content,
    overview: { ...verified.summary.content.overview, citations: [missingTurn] }
  }
  repo.updateSummary(verified.summary.id, { contentJson: JSON.stringify(content) })

  const result = briefing(service, [verified.session.id])
  assert.equal(result.sources[0].verification, 'unverified')
  assert.equal(result.sources[0].reason, 'citation_missing')
  assert.deepEqual(result.items, [])
})

test('briefing rejects a stale citation revision and malformed summary content', async (t) => {
  const { service, worker, summary, repo, db } = setup(t)
  const verified = await summarized(service, worker, summary, 'Zastaralá citace')
  service.correctTurn(verified.session.id, verified.sessionTurns[0].id, { text: 'Opravený přepis.' })
  const corrected = service.getSessionDetail(verified.session.id)
  // The summary stays ready and is rebound to the new transcript revision, but its stored citations keep the old turn
  // revision. That is the citation_stale state a partial write would leave behind.
  db.prepare('UPDATE summaries SET status = ?, stale_reason = NULL, transcript_revision = ? WHERE id = ?').run('ready', corrected.session.transcriptRevision, verified.summary.id)

  const staleCitation = briefing(service, [verified.session.id])
  assert.equal(staleCitation.sources[0].verification, 'unverified')
  assert.equal(staleCitation.sources[0].reason, 'citation_stale')
  assert.deepEqual(staleCitation.items, [])

  repo.updateSummary(verified.summary.id, {
    contentJson: JSON.stringify({ overview: { text: 'Bez citací.', citations: [] } })
  })
  const invalid = briefing(service, [verified.session.id])
  assert.equal(invalid.sources[0].verification, 'unverified')
  assert.equal(invalid.sources[0].reason, 'summary_invalid')
  assert.deepEqual(invalid.items, [])
})

test('briefing reports pending and failed summaries as unverified', async (t) => {
  const { service, worker, summary, repo } = setup(t, {
    generate: async () => {
      throw new Error('provider down')
    }
  })
  const pendingSession = recorded(service, worker, 'Čekající souhrn', 1)
  await worker.tick()
  service.endSession(pendingSession.id, { writerId: 'test' })
  const requested = summary.requestSummary(pendingSession.id)

  const pending = briefing(service, [pendingSession.id])
  assert.equal(pending.sources[0].verification, 'unverified')
  assert.equal(pending.sources[0].reason, 'summary_pending')
  assert.equal(pending.sources[0].summaryStatus, 'pending')
  assert.deepEqual(pending.items, [])

  await assert.rejects(() => summary.run(requested.summary.id), /provider down/)
  const failed = briefing(service, [pendingSession.id])
  assert.equal(failed.sources[0].verification, 'unverified')
  assert.equal(failed.sources[0].reason, 'summary_failed')
  assert.equal(failed.sources[0].summaryStatus, 'failed')
  assert.deepEqual(failed.items, [])
  assert.equal(repo.listSummaries(pendingSession.id).length, 1)
})

function httpSetup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-briefing-http-'))
  const config = loadConfig({
    DEMO_MODE: '1',
    SESSION_DATA_DIR: dir,
    SESSION_DB_PATH: path.join(dir, 'sessions.sqlite'),
    RATE_LIMIT: '1000'
  })
  const sessions = createSessions({
    config,
    transcribe: async ({ sequence }) => (sequence === 0 ? 'Rozpočet na projekt je 120 tisíc korun' : 'Termín schůzky je v pátek'),
    summarize: defaultGenerate
  })
  const server = createGateway({ ...config, sessions: sessions.service, summaries: sessions.summary })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(async () => {
        await sessions.worker.stop()
        server.closeAllConnections()
        server.close()
        sessions.db.close()
        rmSync(dir, { recursive: true, force: true })
      })
      resolve({ base: `http://127.0.0.1:${server.address().port}`, server, sessions })
    })
  })
}

const auth = { Authorization: 'Bearer local-demo-token-only' }
const json = { ...auth, 'Content-Type': 'application/json' }

async function httpSession(base, sessions, name) {
  const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ name, language: 'cs' }) })
  assert.equal(created.status, 201)
  const session = (await created.json()).session
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/start`, { method: 'POST', headers: json, body: JSON.stringify({ writerId: 'http' }) })).status, 200)
  const imported = await fetch(`${base}/api/sessions/${session.id}/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'audio/wav', 'X-Writer-Id': 'http' },
    body: makeWav(60_000)
  })
  assert.equal(imported.status, 202)
  await sessions.worker.tick()
  const ended = await fetch(`${base}/api/sessions/${session.id}/end`, { method: 'POST', headers: json, body: JSON.stringify({ writerId: 'http', lastSequence: 1 }) })
  assert.equal(ended.status, 200)
  const requested = await fetch(`${base}/api/sessions/${session.id}/summary`, { method: 'POST', headers: json, body: JSON.stringify({}) })
  assert.equal(requested.status, 202)
  const pending = (await requested.json()).summary
  const ready = await sessions.summary.run(pending.id)
  assert.equal(ready.status, 'ready')
  return { session: (await ended.json()).session, summary: ready }
}

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for the request log.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('HTTP briefing returns a verified briefing, rejects invalid selections and logs the briefing stage', async (t) => {
  const { base, server, sessions } = await httpSetup(t)
  const { session, summary } = await httpSession(base, sessions, 'HTTP briefing')

  const response = await fetch(`${base}/api/briefing`, { method: 'POST', headers: json, body: JSON.stringify({ sessionIds: [session.id] }) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.requestId.length > 0, true)
  assert.equal(body.briefing.maxSessions, 3)
  assert.equal(body.briefing.sources.length, 1)
  assert.equal(body.briefing.sources[0].sessionId, session.id)
  assert.equal(body.briefing.sources[0].summaryId, summary.id)
  assert.equal(body.briefing.sources[0].reviewStatus, 'unreviewed')
  assert.equal(body.briefing.sources[0].verification, 'verified')
  assert.equal(body.briefing.items.length, 4)
  assert.ok(body.briefing.items.every((item) => item.verification === 'verified' && item.source.verification === 'verified'))

  const requestId = response.headers.get('x-request-id')
  await waitFor(() => server.requestLog.find(requestId))
  const entry = server.requestLog.find(requestId)
  assert.equal(entry.method, 'POST')
  assert.equal(entry.route, '/api/briefing')
  assert.equal(entry.status, 200)
  assert.equal(entry.stage, 'briefing')

  const empty = await fetch(`${base}/api/briefing`, { method: 'POST', headers: json, body: JSON.stringify({ sessionIds: [] }) })
  assert.equal(empty.status, 400)
  assert.equal((await empty.json()).error, 'empty_selection')

  const tooMany = await fetch(`${base}/api/briefing`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ sessionIds: [session.id, `ses_${'a'.repeat(32)}`, `ses_${'b'.repeat(32)}`, `ses_${'c'.repeat(32)}`] })
  })
  assert.equal(tooMany.status, 400)
  assert.equal((await tooMany.json()).error, 'too_many_sessions')

  const invalid = await fetch(`${base}/api/briefing`, { method: 'POST', headers: json, body: JSON.stringify({ sessionIds: [session.id, 42] }) })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error, 'invalid_selection')

  const unknown = await fetch(`${base}/api/briefing`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ sessionIds: [`ses_${'f'.repeat(32)}`] })
  })
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error, 'not_found')

  const get = await fetch(`${base}/api/briefing`, { headers: auth })
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
  assert.equal((await get.json()).error, 'method_not_allowed')

  const getSub = await fetch(`${base}/api/briefing/${session.id}`, { headers: auth })
  assert.equal(getSub.status, 404)
  const postSub = await fetch(`${base}/api/briefing/${session.id}`, { method: 'POST', headers: json, body: JSON.stringify({ sessionIds: [session.id] }) })
  assert.equal(postSub.status, 404)

  const oversized = await fetch(`${base}/api/briefing`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ sessionIds: [session.id], padding: 'x'.repeat(16001) })
  })
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).error, 'too_large')
})

test('HTTP briefing reports sessions_disabled without a session store', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-briefing-disabled-'))
  const config = loadConfig({ DEMO_MODE: '1', SESSION_DATA_DIR: dir, SESSION_DB_PATH: path.join(dir, 'sessions.sqlite') })
  const server = createGateway(config)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(`${base}/api/briefing`, { method: 'POST', headers: json, body: JSON.stringify({ sessionIds: [`ses_${'f'.repeat(32)}`] }) })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error, 'sessions_disabled')
  const health = await fetch(`${base}/api/health`, { headers: auth })
  assert.equal((await health.json()).briefing, false)
})
