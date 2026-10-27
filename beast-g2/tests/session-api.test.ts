import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionApiError, SessionClient } from '../src/session-api'
import type { SessionPreparation, SessionSummary, SummaryContent } from '../src/session-api'
import type { Settings } from '../src/api'
const settings: Settings = { gateway: 'https://gateway.example.com', token: 'test-only-secret', language: 'cs' }
function stub(t: any, handler: typeof fetch) {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = handler
}
test('session list clamps the limit and sends the bearer token', async (t) => {
  let url = '',
    headers: Record<string, string> = {}
  stub(t, async (input, init) => {
    url = String(input)
    headers = init!.headers as Record<string, string>
    return Response.json({ sessions: [] })
  })
  assert.deepEqual(await new SessionClient(() => settings).list(500), { sessions: [] })
  assert.equal(url, 'https://gateway.example.com/api/sessions?limit=100')
  assert.equal(headers.Authorization, 'Bearer test-only-secret')
})
test('segment upload carries sequence, timing and a WAV body', async (t) => {
  let headers: Record<string, string> = {},
    body: Blob | undefined
  stub(t, async (_input, init) => {
    headers = init!.headers as Record<string, string>
    body = init!.body as Blob
    return Response.json({ segment: { id: 'seg_1' }, duplicate: false }, { status: 201 })
  })
  const wav = new Uint8Array(44 + 640)
  const result = await new SessionClient(() => settings).uploadSegment('ses_1', { segmentId: 'seg_1', sequence: 2, startMs: 60000, endMs: 90000, wav, writerId: 'phone' })
  assert.equal(result.duplicate, false)
  assert.equal(headers['X-Segment-Id'], 'seg_1')
  assert.equal(headers['X-Sequence'], '2')
  assert.equal(headers['X-Start-Ms'], '60000')
  assert.equal(headers['X-End-Ms'], '90000')
  assert.equal(headers['Content-Type'], 'audio/wav')
  assert.equal(body!.type, 'audio/wav')
})
test('a gateway failure keeps its status, code and request id', async (t) => {
  stub(t, async () => Response.json({ error: 'session_paused', message: 'Session is paused.', requestId: 'req_1' }, { status: 409 }))
  await assert.rejects(
    () => new SessionClient(() => settings).pause('ses_1', 'phone'),
    (error: unknown) => error instanceof SessionApiError && error.status === 409 && error.code === 'session_paused' && error.requestId === 'req_1'
  )
})
test('deletion accepts an empty 204 response', async (t) => {
  stub(t, async (_input, init) => {
    assert.equal(init!.method, 'DELETE')
    return new Response(null, { status: 204 })
  })
  await new SessionClient(() => settings).remove('ses_1')
})
test('export returns the raw Markdown body', async (t) => {
  let url = ''
  stub(t, async (input) => {
    url = String(input)
    return new Response('# Session\n')
  })
  assert.equal(await new SessionClient(() => settings).export('ses_1', 'markdown'), '# Session\n')
  assert.equal(url, 'https://gateway.example.com/api/sessions/ses_1/export?format=markdown')
})
test('a missing token fails before any request is made', async (t) => {
  let called = false
  stub(t, async () => {
    called = true
    return Response.json({})
  })
  await assert.rejects(() => new SessionClient(() => ({ ...settings, token: '' })).detail('ses_1'), /API key or gateway token/)
  assert.equal(called, false)
})

test('the public barrel keeps the whole client surface on one prototype', () => {
  const client = new SessionClient(() => settings) as unknown as Record<string, unknown>
  const methods = [
    'create',
    'list',
    'detail',
    'remove',
    'start',
    'pause',
    'resume',
    'end',
    'uploadSegment',
    'addGap',
    'correctTurn',
    'export',
    'requestSummary',
    'summary',
    'summaries',
    'updateSummary',
    'createPreparation',
    'preparation',
    'preparations',
    'memoryForSession',
    'proposeMemory',
    'setMemoryStatus',
    'supersedeMemory'
  ]
  for (const name of methods) assert.equal(typeof client[name], 'function', `${name} is missing from the barrel contract`)
})

test('a summary request through the barrel posts to the summary route', async (t) => {
  let url = '',
    method = '',
    body = ''
  stub(t, async (input, init) => {
    url = String(input)
    method = init!.method ?? 'GET'
    body = String(init!.body ?? '')
    return Response.json({ summary: { id: 'sum_1' }, created: true })
  })
  const result: { summary: SessionSummary; created: boolean } = await new SessionClient(() => settings).requestSummary('ses_1', { force: true })
  assert.equal(result.created, true)
  assert.equal(url, 'https://gateway.example.com/api/sessions/ses_1/summary')
  assert.equal(method, 'POST')
  assert.equal(body, JSON.stringify({ force: true }))
})

test('a preparation request through the barrel patches the stored summary', async (t) => {
  let url = '',
    method = '',
    body = ''
  stub(t, async (input, init) => {
    url = String(input)
    method = init!.method ?? 'GET'
    body = String(init!.body ?? '')
    return Response.json({ summary: { id: 'sum_1' } })
  })
  const content: SummaryContent = { schemaVersion: 1, overview: { text: 'We agreed to ship.', citations: [] }, decisions: [], actionCandidates: [], openQuestions: [] }
  const result: { summary: SessionSummary } = await new SessionClient(() => settings).updateSummary('ses_1', 'sum_1', content)
  assert.equal(result.summary.id, 'sum_1')
  assert.equal(url, 'https://gateway.example.com/api/sessions/ses_1/summaries/sum_1')
  assert.equal(method, 'PATCH')
  assert.equal(body, JSON.stringify({ content }))
})

test('a preparation read through the barrel keeps the preparation type', async (t) => {
  stub(t, async () => Response.json({ preparation: null }))
  const result: { preparation: SessionPreparation | null } = await new SessionClient(() => settings).preparation('ses_1')
  assert.equal(result.preparation, null)
})

test('a memory read through the barrel sends the status and query filters', async (t) => {
  let url = ''
  stub(t, async (input) => {
    url = String(input)
    return Response.json({ items: [] })
  })
  const result = await new SessionClient(() => settings).memoryForSession('ses_1', { status: 'approved', query: 'budget plan' })
  assert.deepEqual(result.items, [])
  assert.equal(url, 'https://gateway.example.com/api/sessions/ses_1/memory?status=approved&query=budget+plan')
})

test('a memory proposal through the barrel posts the exact turn id, revision, kind and claim', async (t) => {
  let url = '',
    method = '',
    body = ''
  stub(t, async (input, init) => {
    url = String(input)
    method = init!.method ?? 'GET'
    body = String(init!.body ?? '')
    return Response.json({ item: { id: 'mem_1' } })
  })
  const result = await new SessionClient(() => settings).proposeMemory('ses_1', { turnId: 'trn_2', revision: 3, kind: 'commitment', text: 'Ship the client by Friday.' })
  assert.equal(result.item.id, 'mem_1')
  assert.equal(url, 'https://gateway.example.com/api/sessions/ses_1/memory')
  assert.equal(method, 'POST')
  assert.deepEqual(JSON.parse(body), { turnId: 'trn_2', revision: 3, kind: 'commitment', text: 'Ship the client by Friday.' })
})

test('a memory status change through the barrel patches only the status', async (t) => {
  let url = '',
    method = '',
    body = ''
  stub(t, async (input, init) => {
    url = String(input)
    method = init!.method ?? 'GET'
    body = String(init!.body ?? '')
    return Response.json({ item: { id: 'mem_1', status: 'approved' } })
  })
  const result = await new SessionClient(() => settings).setMemoryStatus('ses_1', 'mem_1', 'approved')
  assert.equal(result.item.status, 'approved')
  assert.equal(url, 'https://gateway.example.com/api/sessions/ses_1/memory/mem_1')
  assert.equal(method, 'PATCH')
  assert.deepEqual(JSON.parse(body), { status: 'approved' })
})

test('a memory replacement through the barrel posts the new claim and optional kind', async (t) => {
  let url = '',
    method = '',
    body = ''
  stub(t, async (input, init) => {
    url = String(input)
    method = init!.method ?? 'GET'
    body = String(init!.body ?? '')
    return Response.json({ item: { id: 'mem_2' }, superseded: { id: 'mem_1' } })
  })
  const result = await new SessionClient(() => settings).supersedeMemory('ses_1', 'mem_1', { text: 'Ship the client by Thursday.', kind: 'commitment' })
  assert.equal(result.item.id, 'mem_2')
  assert.equal(result.superseded.id, 'mem_1')
  assert.equal(url, 'https://gateway.example.com/api/sessions/ses_1/memory/mem_1/supersede')
  assert.equal(method, 'POST')
  assert.deepEqual(JSON.parse(body), { text: 'Ship the client by Thursday.', kind: 'commitment' })
})
