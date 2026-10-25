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
