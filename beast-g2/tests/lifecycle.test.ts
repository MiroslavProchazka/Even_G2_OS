import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AssistantController } from '../src/controller'
import { attachEven, gesture } from '../src/even'
import { AudioInputSource } from '@evenrealities/even_hub_sdk'
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const api = { async transcribe() { return 'question' }, async chat(_t: string, _h: unknown, _s: AbortSignal, delta: (text: string) => void) { delta('answer') } }
test('cancel during microphone start blocks restart until late start is stopped', async () => {
  const opening = deferred<void>(); let starts = 0, stops = 0
  const c = new AssistantController({ start() { starts++; return opening.promise }, async stop() { stops++ } }, api, () => {})
  const start = c.tap(); await c.cancel(); await c.tap(); assert.equal(starts, 1)
  opening.resolve(); await start; assert.equal(stops, 2); assert.equal(c.state.phase, 'idle')
  await c.tap(); assert.equal(c.state.phase, 'recording'); await c.cancel()
})
test('cancel stop gates new work and stale stop failure cannot replace latest cancellation', async () => {
  const stopping = deferred<void>(); let calls = 0
  const c = new AssistantController({ async start() {}, stop() { return ++calls === 1 ? stopping.promise : Promise.resolve() } }, api, () => {})
  const cancel = c.cancel(); await c.ask('blocked'); assert.equal(c.state.transcript, '')
  await c.cancel(true); stopping.reject(new Error('old stop')); await cancel
  assert.equal(c.state.phase, 'interrupted'); await c.ask('fresh'); assert.equal(c.state.answer, 'answer')
})
test('duplicate finish sends one utterance and controller recovers after STT error', async () => {
  let calls = 0
  const c = new AssistantController({ async start() {}, async stop() {} }, { ...api, async transcribe() { calls++; throw new Error('offline') } }, () => {})
  await c.tap(); c.onPcm(new Uint8Array(6400)); await Promise.all([c.finish(), c.finish()])
  assert.equal(calls, 1); assert.equal(c.state.phase, 'error'); await c.ask('retry'); assert.equal(c.state.phase, 'done')
})
test('SDK serializes late microphone start, stop and dispose and accepts only glasses PCM', async () => {
  const opening = deferred<boolean>(); const calls: boolean[] = []; let callback: any, unsubscribed = false, pcm = 0
  const fake = { onEvenHubEvent(cb: any) { callback = cb; return () => { unsubscribed = true } }, async createStartUpPageContainer() { return 0 }, audioControl(enabled: boolean, source?: number) { calls.push(enabled); if (enabled) { assert.equal(source, AudioInputSource.Glasses); return opening.promise } return Promise.resolve(true) } }
  const connection = await attachEven(fake as any, 'ready', () => {}, () => { pcm++ })
  const start = connection.audio.start(); await Promise.resolve()
  callback({ audioEvent: { source: AudioInputSource.Glasses, audioPcm: new Uint8Array(2) } }); callback({ audioEvent: { source: -1, audioPcm: new Uint8Array(2) } })
  const stop = connection.audio.stop(); connection.dispose(); opening.resolve(true); await start; await stop
  assert.deepEqual(calls, [true, false]); assert.equal(pcm, 1); assert.equal(unsubscribed, true)
  await assert.rejects(connection.audio.start(), /disposed/)
})
test('SDK startup rejection unsubscribes and audio events never normalize to tap', async () => {
  let cleaned = false
  await assert.rejects(attachEven({ onEvenHubEvent() { return () => { cleaned = true } }, async createStartUpPageContainer() { return 1 } } as any, '', () => {}, () => {}), /creation failed/)
  assert.equal(cleaned, true); assert.equal(gesture({ audioEvent: {} } as any), undefined)
})
test('manual microphone stop failure blocks restart until successful explicit cancel', async () => {
  let fail = true, starts = 0
  const c = new AssistantController({ async start() { starts++ }, async stop() { if (fail) throw new Error('BLE lost') } }, api, () => {})
  await c.tap(); await c.cancel(); await c.tap(); assert.equal(starts, 1)
  fail = false; await c.cancel(); await c.tap(); assert.equal(starts, 2); await c.cancel()
})
test('SDK dispose records an unconfirmed microphone shutdown instead of claiming success', async () => {
  const { diagnostics } = await import('../src/diagnostics')
  diagnostics.clear()
  const connection = await attachEven({ onEvenHubEvent() { return () => {} }, async createStartUpPageContainer() { return 0 }, async audioControl(open: boolean) { return open } } as any, '', () => {}, () => {})
  await connection.audio.start(); connection.dispose()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(diagnostics.snapshot().some(event => event.event === 'dispose.stop_failed' && event.level === 'error'))
})
test('native timeout releases caller but never overlaps late start with queued stop', async () => {
  const opening = deferred<boolean>(); const calls: boolean[] = []
  const connection = await attachEven({ onEvenHubEvent() { return () => {} }, async createStartUpPageContainer() { return 0 }, audioControl(open: boolean) { calls.push(open); return open ? opening.promise : Promise.resolve(true) } } as any, '', () => {}, () => {}, 15)
  await assert.rejects(connection.audio.start(), { name: 'TimeoutError' })
  await assert.rejects(connection.audio.stop(), { name: 'TimeoutError' })
  assert.deepEqual(calls, [true])
  opening.resolve(true); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [true, false])
  await connection.audio.stop(); connection.dispose()
})
test('hung display reports timeout once and suppresses further writes including late settlement', async () => {
  const { LatestDisplay } = await import('../src/display')
  const pending = deferred<void>(); let writes = 0, errors = 0
  const display = new LatestDisplay(() => { writes++; return pending.promise }, () => { errors++ }, 1, 15)
  display.update('one'); display.update('two')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(errors, 1); assert.equal(writes, 1)
  pending.resolve(); display.update('three'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes, 1); display.dispose()
})
test('display retries transient rejection and acknowledges only successful delivery', async () => {
  const { LatestDisplay } = await import('../src/display')
  let attempts = 0, delivered = 0, failures = 0
  const display = new LatestDisplay(async () => { if (++attempts < 3) throw new Error('busy') }, () => { failures++ }, 1, 100, () => { delivered++ })
  display.update('hint')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(attempts, 3); assert.equal(delivered, 1); assert.equal(failures, 0); display.dispose()
})
test('late native resolution after deadline never acknowledges a dead display queue', async () => {
  const { LatestDisplay } = await import('../src/display')
  const pending = deferred<void>(); let delivered = 0
  const display = new LatestDisplay(() => pending.promise, () => {}, 1, 10, () => { delivered++ })
  display.update('old'); await new Promise(resolve => setTimeout(resolve, 20)); pending.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(delivered, 0); assert.equal(display.retry(), false)
})
