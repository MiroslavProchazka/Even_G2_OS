import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionApiError, SessionClient } from '../src/session-api'
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
