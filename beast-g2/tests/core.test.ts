import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PcmBuffer, MAX_PCM_BYTES } from '../src/audio'
import { AssistantController } from '../src/controller'
import { pages, LatestDisplay } from '../src/display'
import { gatewayUrl } from '../src/api'

test('PCM chunks preserve byte order and produce canonical WAV', () => {
  const pcm = new PcmBuffer(); pcm.add(new Uint8Array([1, 2, 3])); pcm.add(new Uint8Array([4, 5, 6]))
  const wav = pcm.wav(), view = new DataView(wav.buffer)
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF'); assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(40, true), 6); assert.deepEqual([...wav.slice(44)], [1, 2, 3, 4, 5, 6])
})
test('audio memory is bounded to thirty seconds and ignores overflow', () => {
  const pcm = new PcmBuffer(); assert.equal(pcm.add(new Uint8Array(MAX_PCM_BYTES + 100)), true)
  pcm.add(new Uint8Array(200)); assert.equal(pcm.wav().length, MAX_PCM_BYTES + 44); pcm.clear(); assert.equal(pcm.bytes, 0)
})
test('cancelled transcription cannot start a stale chat request', async () => {
  let resolve!: (text: string) => void, calls = 0
  const pending = new Promise<string>(r => { resolve = r })
  const controller = new AssistantController({ async start() {}, async stop() {} }, { transcribe: () => pending, async chat() { calls++ } }, () => {})
  await controller.tap(); controller.onPcm(new Uint8Array(6400)); const finishing = controller.finish()
  await Promise.resolve(); await controller.cancel(); resolve('stale question'); await finishing
  assert.equal(calls, 0); assert.equal(controller.state.phase, 'idle')
})
test('late stream chunks after cancellation do not overwrite a new answer', async () => {
  let emit!: (value: string) => void, resolve!: () => void
  const controller = new AssistantController({ async start() {}, async stop() {} }, { async transcribe() { return '' }, async chat(_text, _history, _signal, delta) { emit = delta; await new Promise<void>(r => { resolve = r }) } }, () => {})
  const pending = controller.ask('hello'); emit('partial'); await controller.cancel(); emit('stale'); resolve(); await pending
  assert.equal(controller.state.answer, ''); assert.equal(controller.state.phase, 'idle')
})
test('slow display writer coalesces intermediate states', async () => {
  const writes: string[] = []; let release!: () => void
  const blocked = new Promise<void>(r => { release = r })
  const display = new LatestDisplay(async text => { writes.push(text); if (text === 'one') await blocked }, error => { throw error }, 1)
  display.update('one'); display.update('two'); display.update('three'); release()
  await new Promise(r => setTimeout(r, 30)); display.dispose(); assert.deepEqual(writes, ['one', 'three'])
})
test('pagination preserves Czech text and stays inside a conservative display budget', () => {
  const text = 'Příliš žluťoučký kůň úpěl ďábelské ódy. '.repeat(30)
  const result = pages(text); assert.ok(result.length > 1)
  for (const page of result) { assert.ok(new TextEncoder().encode(page).length < 900); assert.ok(page.split('\n').every(line => [...line].length <= 40)) }
})
test('gateway configuration rejects credentials and non-network URL schemes', () => {
  assert.throws(() => gatewayUrl('https://user:secret@example.com', '/api/chat'))
  assert.throws(() => gatewayUrl('javascript:alert(1)', '/api/chat'))
  assert.equal(gatewayUrl('http://127.0.0.1:8787', '/api/chat'), 'http://127.0.0.1:8787/api/chat')
})
