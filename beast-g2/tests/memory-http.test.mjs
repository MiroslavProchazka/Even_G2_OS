import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGateway, loadConfig } from '../server/gateway.mjs'
import { createSessions } from '../server/sessions/index.mjs'
import { makeWav } from '../server/sessions/wav.mjs'

async function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-memory-http-'))
  const config = loadConfig({
    DEMO_MODE: '1',
    SESSION_DATA_DIR: dir,
    SESSION_DB_PATH: path.join(dir, 'sessions.sqlite'),
    RATE_LIMIT: '1000'
  })
  const sessions = createSessions({
    config,
    transcribe: async ({ sequence }) => (sequence === 0 ? 'Rozpočet na projekt je 120 tisíc korun' : 'Termín schůzky je v pátek'),
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

async function storedSession(base, sessions, name = 'HTTP memory') {
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
  const detail = await fetch(`${base}/api/sessions/${session.id}`, { headers: auth })
  assert.equal(detail.status, 200)
  return { session, turns: (await detail.json()).turns }
}

function memoryUrl(base, sessionId) {
  return `${base}/api/sessions/${sessionId}/memory`
}

async function propose(base, sessionId, turn, overrides = {}) {
  return fetch(memoryUrl(base, sessionId), {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ turnId: turn.id, revision: turn.revision, kind: 'decision', text: 'Rozpočet je 120 tisíc korun.', ...overrides })
  })
}

async function patch(base, sessionId, memoryId, body) {
  return fetch(`${memoryUrl(base, sessionId)}/${memoryId}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) })
}

async function list(base, sessionId, query = '') {
  const response = await fetch(`${memoryUrl(base, sessionId)}${query}`, { headers: auth })
  return { response, body: await response.json() }
}

test('HTTP memory proposes, hides proposed items, approves and replaces them', async (t) => {
  const { base, sessions } = await setup(t)
  const { session, turns } = await storedSession(base, sessions)

  const created = await propose(base, session.id, turns[0])
  assert.equal(created.status, 201)
  const proposal = await created.json()
  assert.equal(proposal.requestId.length > 0, true)
  assert.match(proposal.item.id, /^mem_[a-f0-9]{32}$/)
  assert.equal(proposal.item.status, 'proposed')
  assert.equal(proposal.item.kind, 'decision')
  assert.equal(proposal.item.turnId, turns[0].id)
  assert.equal(proposal.item.turnRevision, turns[0].revision)
  assert.equal(proposal.item.sourceQuote, turns[0].text)
  assert.equal(proposal.item.sourceDeleted, false)
  assert.equal(proposal.item.evidenceState, 'present')
  assert.equal(proposal.item.approvedAt, null)

  const hidden = await list(base, session.id)
  assert.equal(hidden.response.status, 200)
  assert.deepEqual(hidden.body.items, [])

  const proposed = await list(base, session.id, '?status=proposed')
  assert.deepEqual(
    proposed.body.items.map((item) => item.id),
    [proposal.item.id]
  )
  const all = await list(base, session.id, '?status=all')
  assert.equal(all.body.items.length, 1)

  const approved = await patch(base, session.id, proposal.item.id, { status: 'approved' })
  assert.equal(approved.status, 200)
  const approvedBody = await approved.json()
  assert.equal(approvedBody.item.status, 'approved')
  assert.equal(approvedBody.item.approvedAt > 0, true)
  assert.equal(approvedBody.item.rejectedAt, null)

  const visible = await list(base, session.id)
  assert.deepEqual(
    visible.body.items.map((item) => item.id),
    [proposal.item.id]
  )

  const single = await fetch(`${memoryUrl(base, session.id)}/${proposal.item.id}`, { headers: auth })
  assert.equal(single.status, 200)
  assert.equal((await single.json()).item.id, proposal.item.id)

  const again = await patch(base, session.id, proposal.item.id, { status: 'approved' })
  assert.equal(again.status, 200)
  assert.equal((await again.json()).item.approvedAt, approvedBody.item.approvedAt)

  const conflict = await patch(base, session.id, proposal.item.id, { status: 'rejected' })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error, 'invalid_transition')

  const replaced = await fetch(`${memoryUrl(base, session.id)}/${proposal.item.id}/supersede`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ kind: 'commitment', text: 'Rozpočet schválíme do pátku.' })
  })
  assert.equal(replaced.status, 201)
  const replacedBody = await replaced.json()
  assert.equal(replacedBody.item.status, 'proposed')
  assert.equal(replacedBody.item.kind, 'commitment')
  assert.equal(replacedBody.item.supersedesId, proposal.item.id)
  assert.equal(replacedBody.item.turnId, turns[0].id)
  assert.equal(replacedBody.superseded.status, 'superseded')
  assert.equal(replacedBody.superseded.text, proposal.item.text)

  assert.deepEqual((await list(base, session.id)).body.items, [])
  const history = await list(base, session.id, '?status=all')
  assert.deepEqual(history.body.items.map((item) => item.status).sort(), ['proposed', 'superseded'])

  for (const id of [proposal.item.id, replacedBody.item.id]) {
    const hiddenSingle = await fetch(`${memoryUrl(base, session.id)}/${id}`, { headers: auth })
    assert.equal(hiddenSingle.status, 404)
  }
})

test('HTTP memory rejects a stale revision, a foreign turn and invalid input', async (t) => {
  const { base, sessions } = await setup(t)
  const first = await storedSession(base, sessions, 'First session')
  const second = await storedSession(base, sessions, 'Second session')

  const stale = await propose(base, first.session.id, first.turns[0], { revision: first.turns[0].revision + 1 })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error, 'stale_revision')

  const foreign = await propose(base, first.session.id, second.turns[0])
  assert.equal(foreign.status, 404)
  const foreignBody = await foreign.json()
  assert.equal(foreignBody.error, 'not_found')
  assert.ok(!JSON.stringify(foreignBody).includes(second.turns[0].text), 'the error does not echo transcript text')

  const unknownTurn = await propose(base, first.session.id, { id: `turn_${'a'.repeat(32)}`, revision: 1 })
  assert.equal(unknownTurn.status, 404)

  const badKind = await propose(base, first.session.id, first.turns[0], { kind: 'other' })
  assert.equal(badKind.status, 400)
  assert.equal((await badKind.json()).error, 'invalid_kind')

  for (const text of ['', '   ', 'x'.repeat(501)]) {
    const invalid = await propose(base, first.session.id, first.turns[0], { text })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error, 'invalid_text')
  }

  const malformed = await fetch(memoryUrl(base, first.session.id), { method: 'POST', headers: json, body: '{' })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error, 'invalid_json')

  const missing = await propose(base, `ses_${'f'.repeat(32)}`, first.turns[0])
  assert.equal(missing.status, 404)

  const badStatus = await patch(base, first.session.id, `mem_${'a'.repeat(32)}`, { status: 'approved' })
  assert.equal(badStatus.status, 404)
  const invalidStatus = await patch(base, first.session.id, `mem_${'a'.repeat(32)}`, { status: 'proposed' })
  assert.equal(invalidStatus.status, 400)
  assert.equal((await invalidStatus.json()).error, 'invalid_status')

  assert.equal(sessions.db.prepare('SELECT COUNT(*) AS count FROM memory_items').get().count, 0)
})

test('HTTP memory retrieval folds Czech diacritics and never crosses sessions', async (t) => {
  const { base, sessions } = await setup(t)
  const first = await storedSession(base, sessions, 'Folding session')
  const second = await storedSession(base, sessions, 'Foreign session')

  const created = await propose(base, first.session.id, first.turns[0], { text: 'Zrušit schůzku kvůli rozpočtu.' })
  const proposal = (await created.json()).item
  const approved = await patch(base, first.session.id, proposal.id, { status: 'approved' })
  assert.equal(approved.status, 200)

  const folded = await list(base, first.session.id, '?query=ZRUSIT+SCHUZKU')
  assert.equal(folded.response.status, 200)
  assert.deepEqual(
    folded.body.items.map((item) => item.id),
    [proposal.id]
  )
  const partial = await list(base, first.session.id, '?query=rozpoctu')
  assert.deepEqual(
    partial.body.items.map((item) => item.id),
    [proposal.id]
  )
  const missing = await list(base, first.session.id, '?query=nerozpoznane')
  assert.deepEqual(missing.body.items, [])

  const foreign = await propose(base, second.session.id, second.turns[0], { text: 'Cizí položka.' })
  const foreignItem = (await foreign.json()).item
  await patch(base, second.session.id, foreignItem.id, { status: 'approved' })

  const firstAll = await list(base, first.session.id, '?status=all')
  assert.ok(firstAll.body.items.every((item) => item.id !== foreignItem.id))
  const secondAll = await list(base, second.session.id, '?status=all')
  assert.deepEqual(
    secondAll.body.items.map((item) => item.id),
    [foreignItem.id]
  )

  const tooLong = await list(base, first.session.id, `?query=${'x'.repeat(201)}`)
  assert.equal(tooLong.response.status, 400)
  assert.equal(tooLong.body.error, 'invalid_query')
  const badStatus = await list(base, first.session.id, '?status=deleted')
  assert.equal(badStatus.response.status, 400)
  assert.equal(badStatus.body.error, 'invalid_status')
})

test('HTTP memory applies the source-deletion rule with and without keepMemory', async (t) => {
  const { base, sessions } = await setup(t)
  const kept = await storedSession(base, sessions, 'Kept session')
  const keptProposal = (await (await propose(base, kept.session.id, kept.turns[0])).json()).item
  assert.equal((await patch(base, kept.session.id, keptProposal.id, { status: 'approved' })).status, 200)

  const keptDelete = await fetch(`${base}/api/sessions/${kept.session.id}?keepMemory=1`, { method: 'DELETE', headers: auth })
  assert.equal(keptDelete.status, 204)
  const survivor = sessions.db.prepare('SELECT status, source_deleted AS sourceDeleted, evidence_state AS evidenceState, text FROM memory_items WHERE id = ?').get(keptProposal.id)
  assert.deepEqual(survivor, { status: 'approved', sourceDeleted: 1, evidenceState: 'lost', text: keptProposal.text })
  const gone = await fetch(`${base}/api/sessions/${kept.session.id}/memory?status=all`, { headers: auth })
  assert.equal(gone.status, 404)

  const dropped = await storedSession(base, sessions, 'Dropped session')
  const droppedProposal = (await (await propose(base, dropped.session.id, dropped.turns[0])).json()).item
  assert.equal((await patch(base, dropped.session.id, droppedProposal.id, { status: 'approved' })).status, 200)
  const droppedDelete = await fetch(`${base}/api/sessions/${dropped.session.id}`, { method: 'DELETE', headers: auth })
  assert.equal(droppedDelete.status, 204)
  assert.equal(sessions.db.prepare('SELECT COUNT(*) AS count FROM memory_items WHERE session_id = ?').get(dropped.session.id).count, 0)
})

test('the memory route keeps the session detail, search and method contracts intact', async (t) => {
  const { base, sessions } = await setup(t)
  const { session, turns } = await storedSession(base, sessions, 'Route order')

  const created = await propose(base, session.id, turns[0])
  const proposal = (await created.json()).item

  const detail = await fetch(`${base}/api/sessions/${session.id}`, { headers: auth })
  assert.equal(detail.status, 200)
  assert.equal((await detail.json()).session.name, 'Route order')

  const search = await fetch(`${base}/api/sessions/search?q=rozpocet`, { headers: auth })
  assert.equal(search.status, 200)
  assert.equal((await search.json()).results.length, 1)

  const listed = await fetch(`${base}/api/sessions`, { headers: auth })
  assert.equal(listed.status, 200)
  assert.equal((await listed.json()).sessions.length, 1)

  const notMatched = await fetch(`${memoryUrl(base, session.id)}/${proposal.id}/unknown`, { headers: auth })
  assert.equal(notMatched.status, 404)

  const put = await fetch(memoryUrl(base, session.id), { method: 'PUT', headers: json, body: '{}' })
  assert.equal(put.status, 405)
  assert.equal(put.headers.get('allow'), 'GET, POST')
  const postItem = await fetch(`${memoryUrl(base, session.id)}/${proposal.id}`, { method: 'POST', headers: json, body: '{}' })
  assert.equal(postItem.status, 405)
  assert.equal(postItem.headers.get('allow'), 'GET, PATCH')
  const getSupersede = await fetch(`${memoryUrl(base, session.id)}/${proposal.id}/supersede`, { headers: auth })
  assert.equal(getSupersede.status, 405)
  assert.equal(getSupersede.headers.get('allow'), 'POST')
})
