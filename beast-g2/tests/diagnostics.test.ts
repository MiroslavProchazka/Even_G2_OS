import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dependencies, version } from '../package.json'
import { Diagnostics } from '../src/diagnostics'
test('diagnostics ring is bounded and metadata allowlist excludes secrets and content', () => {
  const logs = new Diagnostics(3)
  logs.record('app', 'state.changed', { phase: 'recording', bytes: 12, token: 'SECRET', transcript: 'PRIVATE', url: 'https://private/?key=SECRET' } as any)
  logs.record('app', 'SECRET')
  logs.record('app', 'state.changed', { phase: 'PRIVATE' })
  const output = logs.export()
  assert.doesNotMatch(output, /SECRET|PRIVATE|https/)
  assert.match(output, /recording/)
  for (let i = 0; i < 10; i++) logs.record('audio', 'pcm.received', { bytes: i })
  assert.equal(logs.snapshot().length, 3)
  assert.equal(logs.snapshot().at(-1)!.details.bytes, 9)
})
test('diagnostics snapshots are isolated, span ends once and listener cannot break capture', () => {
  const logs = new Diagnostics()
  logs.subscribe(() => {
    throw new Error('listener failure')
  })
  const span = logs.span('stt')
  span.end('error', { status: 400 })
  span.end()
  const snapshot = logs.snapshot()
  snapshot[0].event = 'changed'
  assert.equal(logs.snapshot()[0].event, 'request.start')
  assert.equal(logs.snapshot().length, 2)
  assert.equal(logs.snapshot()[1].level, 'error')
  assert.equal(logs.snapshot()[1].traceId, span.id)
})
test('exported diagnostics take version and SDK from package metadata', () => {
  const exported = JSON.parse(new Diagnostics().export())
  assert.equal(exported.version, version)
  assert.equal(exported.sdk, dependencies['@evenrealities/even_hub_sdk'])
})
test('session spans carry opaque identifiers and a failed action records a code without content', () => {
  const logs = new Diagnostics(20)
  const span = logs.span('session', { sessionId: 'sess-42', segmentId: 'seg.3', jobId: 'job_7', transport: 'gateway' })
  span.mark('response.headers', { status: 500 })
  span.fail(new Error('PRIVATE transcript text'))
  span.fail(new Error('SECOND failure'))
  const events = JSON.parse(logs.export()).events
  assert.equal(events.length, 3)
  for (const event of events) {
    assert.equal(event.details.sessionId, 'sess-42')
    assert.equal(event.details.segmentId, 'seg.3')
    assert.equal(event.details.jobId, 'job_7')
  }
  const ended = events.at(-1)
  assert.equal(ended.event, 'request.end')
  assert.equal(ended.level, 'error')
  assert.equal(ended.details.code, 'operation_failed')
  assert.doesNotMatch(logs.export(), /PRIVATE|SECOND|transcript/)
})
test('diagnostics drops content-like identifiers and keeps the last 200 events', () => {
  const logs = new Diagnostics(200)
  logs.record('session', 'session.started', { sessionId: 'PRIVATE transcript', jobId: 'x'.repeat(100) })
  assert.doesNotMatch(logs.export(), /PRIVATE|transcript/)
  for (let i = 0; i < 201; i++) logs.record('session', 'session.started', { sessionId: `s-${i}` })
  const snapshot = logs.snapshot()
  assert.equal(snapshot.length, 200)
  assert.equal(snapshot[0].details.sessionId, 's-1')
  assert.equal(snapshot.at(-1)!.details.sessionId, 's-200')
})
test('failed spans map timeouts and coded errors to allowlisted codes', () => {
  const logs = new Diagnostics(10)
  logs.span('session', { sessionId: 'sess-1' }).fail(new DOMException('PRIVATE', 'TimeoutError'))
  logs.span('session', { sessionId: 'sess-2' }).fail(Object.assign(new Error('PRIVATE'), { code: 'invalid_response' }))
  logs.span('session', { sessionId: 'sess-3' }).fail(new TypeError('PRIVATE'))
  const codes = JSON.parse(logs.export())
    .events.filter((event: { event: string }) => event.event === 'request.end')
    .map((event: { details: { code?: string } }) => event.details.code)
  assert.deepEqual(codes, ['timeout', 'invalid_response', 'network'])
  assert.doesNotMatch(logs.export(), /PRIVATE/)
})
