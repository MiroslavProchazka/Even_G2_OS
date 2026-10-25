import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Segmenter } from '../src/vad'
import { ContinuousController } from '../src/continuous'
import { createContinuousDemo, pcmFrame, simulateUtterance } from '../src/continuous-demo'
import type { AssistantPort } from '../src/controller'
const tick = () => new Promise<void>((r) => setImmediate(r))
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const frames = (s: Segmenter, speech: boolean, count: number) => {
  for (let i = 0; i < count; i++) s.push(pcmFrame(speech))
}
const normalApi: AssistantPort = {
  async transcribe() {
    return 'Jak funguje G2?'
  },
  async chat(_t, _h, _s, delta) {
    delta('Odpověď.')
  }
}
function setup(t: any, api = normalApi, options: ConstructorParameters<typeof ContinuousController>[3] = {}) {
  const audio = {
    starts: 0,
    stops: 0,
    async start() {
      this.starts++
    },
    async stop() {
      this.stops++
    }
  }
  const c = new ContinuousController(audio, api, () => {}, options)
  t.after(() => c.pause())
  return { c, audio }
}
test('VAD ignores silence and short noises, preserves preroll and matches odd packet boundaries', () => {
  const whole: Uint8Array[] = [],
    split: Uint8Array[] = []
  const a = new Segmenter((w) => whole.push(w)),
    b = new Segmenter((w) => split.push(w))
  frames(a, false, 200)
  frames(a, true, 4)
  frames(a, false, 40)
  assert.equal(whole.length, 0)
  a.reset()
  const input = new Uint8Array(640 * 150)
  for (let i = 15; i < 45; i++) input.set(pcmFrame(true), i * 640)
  a.push(input)
  for (let i = 0; i < input.length; i += 137) b.push(input.subarray(i, i + 137))
  assert.equal(whole.length, 1)
  assert.deepEqual(split, whole)
  const samples = new Int16Array(whole[0].buffer, 44)
  assert.equal(samples[0], 0)
  assert.ok(samples.some((x) => x !== 0))
  assert.ok(whole[0].length < 960044)
})
test('VAD rejects oversized utterance without sending incomplete speech and recovers after silence', () => {
  const output: Uint8Array[] = []
  let exceeded = 0
  const s = new Segmenter(
    (w) => output.push(w),
    {},
    undefined,
    undefined,
    () => exceeded++
  )
  frames(s, true, 1600)
  assert.equal(output.length, 0)
  assert.equal(exceeded, 1)
  frames(s, false, 100)
  frames(s, true, 30)
  frames(s, false, 100)
  assert.equal(output.length, 1)
  assert.throws(() => new Segmenter(() => {}, { maxSegmentMs: Infinity }))
})

test('all finalized speech including repeated statements reaches Beast and hints advance after ten seconds', async (t) => {
  let clock = 1000,
    chats = 0
  const { c } = setup(
    t,
    {
      async transcribe() {
        return 'Dneska je hezky.'
      },
      async chat(_t, _h, _s, delta) {
        delta(`Hint ${++chats}`)
      }
    },
    { now: () => clock }
  )
  await c.start()
  simulateUtterance(c)
  await tick()
  simulateUtterance(c)
  await tick()
  assert.equal(chats, 2)
  assert.equal(c.state.reply?.answer, 'Hint 1')
  clock += 9999
  c.tickHint()
  assert.equal(c.state.reply?.answer, 'Hint 1')
  clock++
  c.tickHint()
  assert.equal(c.state.reply?.answer, 'Hint 2')
  clock += 10000
  c.tickHint()
  assert.equal(c.state.reply, undefined)
  assert.equal(c.state.unread, 0)
})

test('slow API never overlaps and pending queue keeps newest two, dropping stale segments', async (t) => {
  const blocked = deferred<string>()
  let calls = 0,
    active = 0,
    maxActive = 0,
    clock = 1000
  const { c } = setup(
    t,
    {
      async transcribe() {
        calls++
        active++
        maxActive = Math.max(active, maxActive)
        const result = calls === 1 ? await blocked.promise : 'Dneska je hezky.'
        active--
        return result
      },
      ...{ chat: normalApi.chat }
    },
    { now: () => clock }
  )
  await c.start()
  for (let i = 0; i < 6; i++) simulateUtterance(c)
  assert.equal(c.state.queued, 2)
  assert.equal(c.state.dropped, 3)
  assert.equal(calls, 1)
  clock += 30001
  blocked.resolve('Jak funguje G2?')
  await tick()
  assert.equal(calls, 1)
  assert.equal(c.state.dropped, 5)
  assert.equal(maxActive, 1)
})
test('new speech during chat queues instead of cancelling current answer', async (t) => {
  const chat = deferred<void>()
  let calls = 0
  const { c } = setup(t, {
    async transcribe() {
      return ++calls === 1 ? 'Jak funguje G2?' : 'Co znamená VAD?'
    },
    async chat(text, _h, signal, delta) {
      if (text.startsWith('Jak')) {
        await chat.promise
        assert.equal(signal.aborted, false)
      }
      delta(text)
    }
  })
  await c.start()
  simulateUtterance(c)
  await tick()
  simulateUtterance(c)
  assert.equal(c.state.phase, 'answering')
  assert.equal(c.state.queued, 1)
  chat.resolve()
  await tick()
  assert.equal(calls, 2)
  assert.match(c.state.reply!.answer, /Jak/)
  assert.match(c.state.latest!.answer, /Co/)
})
test('pause aborts work and clears queue/pre-roll; late inference cannot reply after explicit resume', async (t) => {
  const blocked = deferred<string>()
  let calls = 0,
    oldSignal: AbortSignal | undefined
  const { c, audio } = setup(t, {
    async transcribe(_w, signal) {
      oldSignal = signal
      return ++calls === 1 ? blocked.promise : 'Co znamená VAD?'
    },
    chat: normalApi.chat
  })
  await c.start()
  simulateUtterance(c)
  simulateUtterance(c)
  await c.pause(true)
  assert.equal(oldSignal?.aborted, true)
  assert.equal(c.state.queued, 0)
  assert.equal(c.state.microphone, 'off')
  assert.equal(c.state.phase, 'interrupted')
  c.onPcm(pcmFrame(true))
  await c.start()
  blocked.resolve('Jak funguje G2?')
  await tick()
  assert.equal(c.state.reply, undefined)
  assert.equal(audio.starts, 2)
  simulateUtterance(c)
  await tick()
  assert.equal(c.state.reply?.transcript, 'Co znamená VAD?')
})
test('cancel during native start cannot restart until late open has been stopped', async (t) => {
  const opened = deferred<void>()
  const commands: string[] = []
  const c = new ContinuousController(
    {
      start() {
        commands.push('start')
        return opened.promise
      },
      async stop() {
        commands.push('stop')
      }
    },
    normalApi,
    () => {}
  )
  t.after(() => c.pause())
  const pending = c.start()
  await c.pause()
  await c.start()
  assert.deepEqual(commands, ['start', 'stop'])
  opened.resolve()
  await pending
  assert.deepEqual(commands, ['start', 'stop', 'stop'])
  assert.equal(c.state.microphone, 'off')
})
test('simulation runs same VAD and automatic hint path without any device or network', async (t) => {
  const c = createContinuousDemo(() => {})
  t.after(() => c.pause())
  await c.start()
  for (let i = 0; i < 5; i++) {
    simulateUtterance(c)
    await tick()
  }
  assert.equal(c.state.ignored, 0)
  assert.match(c.state.reply!.answer, /SIMULATED/)
  assert.ok(c.state.latest)
  assert.equal(c.state.microphone, 'on')
})
test('PCM silence is healthy but a missing audio stream interrupts until explicit resume', async (t) => {
  let clock = 1000
  const { c } = setup(t, normalApi, { now: () => clock })
  await c.start()
  clock += 9000
  c.onPcm(pcmFrame(false))
  await c.checkAudioHealth()
  assert.equal(c.state.phase, 'listening')
  clock += 8001
  await c.checkAudioHealth()
  assert.equal(c.state.phase, 'interrupted')
  assert.equal(c.state.microphone, 'off')
  assert.match(c.state.notice, /No G2 audio/)
  c.onPcm(pcmFrame(true))
  assert.equal(c.state.phase, 'interrupted')
  await c.start()
  assert.equal(c.state.phase, 'listening')
})
test('failed chat releases the pipeline and clears incomplete hint', async (t) => {
  let calls = 0
  const { c } = setup(t, {
    transcribe: normalApi.transcribe,
    async chat(_t, _h, _s, delta) {
      delta('partial')
      if (++calls === 1) throw new Error('offline')
    }
  })
  await c.start()
  simulateUtterance(c)
  await tick()
  assert.equal(c.state.reply, undefined)
  assert.match(c.state.error, /offline/)
  simulateUtterance(c)
  await tick()
  assert.equal(calls, 2)
  assert.equal(c.state.reply?.answer, 'partial')
})
test('native stop rejection leaves microphone unknown and blocks unsafe restart', async (t) => {
  let reject = true,
    starts = 0
  const c = new ContinuousController(
    {
      async start() {
        starts++
      },
      async stop() {
        if (reject) throw new Error('BLE lost')
      }
    },
    normalApi,
    () => {}
  )
  t.after(() => {
    reject = false
    return c.pause()
  })
  await c.start()
  await c.pause()
  assert.equal(c.state.microphone, 'unknown')
  await c.start()
  assert.equal(starts, 1)
  reject = false
  await c.pause()
  await c.start()
  assert.equal(starts, 2)
})

test('completed hints are never overwritten: full inbox applies backpressure until automatic expiry', async (t) => {
  let n = 0,
    clock = 1000
  const { c } = setup(
    t,
    {
      async transcribe() {
        return `What is item ${++n}?`
      },
      async chat(text, _h, _s, delta) {
        delta(text)
      }
    },
    { now: () => clock }
  )
  await c.start()
  for (let i = 0; i < 5; i++) {
    simulateUtterance(c)
    await tick()
  }
  assert.equal(n, 4)
  assert.equal(c.state.unread, 3)
  assert.equal(c.state.repliesDropped, 0)
  for (const index of [2, 3, 4, 5]) {
    clock += 10000
    c.tickHint()
    await tick()
    assert.equal(c.state.reply?.transcript, `What is item ${index}?`)
  }
})

test('VAD finalizes once at exactly two seconds of silence, never on a shorter pause', () => {
  let finals = 0
  const s = new Segmenter(() => finals++)
  frames(s, true, 50)
  frames(s, false, 99)
  assert.equal(finals, 0)
  frames(s, true, 10)
  frames(s, false, 99)
  assert.equal(finals, 0)
  frames(s, false, 1)
  assert.equal(finals, 1)
  frames(s, false, 200)
  assert.equal(finals, 1)
})
test('preview reaches the lens before silence and a late preview cannot replace final transcript', async (t) => {
  const late = deferred<string>()
  let calls = 0,
    chats = 0
  const { c } = setup(t, {
    async transcribe() {
      calls++
      return calls === 1 ? 'Průběžný přepis' : calls === 2 ? late.promise : 'Finální přepis'
    },
    async chat(_t, _h, _s, delta) {
      chats++
      delta('Hint')
    }
  })
  await c.start()
  for (let i = 0; i < 60; i++) c.onPcm(pcmFrame(true))
  await tick()
  assert.equal(c.state.transcript, 'Průběžný přepis')
  assert.equal(chats, 0)
  for (let i = 0; i < 50; i++) c.onPcm(pcmFrame(true))
  await tick()
  for (let i = 0; i < 100; i++) c.onPcm(pcmFrame(false))
  await tick()
  assert.equal(c.state.transcript, 'Finální přepis')
  assert.equal(chats, 1)
  late.resolve('Stale')
  await tick()
  assert.equal(c.state.transcript, 'Finální přepis')
})
test('streaming hint appears before completion and failed requests release pipeline with a visible error', async (t) => {
  const stalled = deferred<void>()
  let n = 0
  const { c } = setup(
    t,
    {
      transcribe: normalApi.transcribe,
      async chat(_t, _h, _s, delta) {
        if (++n === 1) {
          delta('Partial')
          await stalled.promise
          delta('Late')
        } else delta('Recovered')
      }
    },
    { requestMs: 25 }
  )
  await c.start()
  simulateUtterance(c)
  await tick()
  assert.equal(c.state.streaming, 'Partial')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.match(c.state.error, /timed out/)
  assert.equal(c.state.streaming, '')
  simulateUtterance(c)
  await tick()
  assert.equal(c.state.reply?.answer, 'Recovered')
  stalled.resolve()
  await tick()
  assert.equal(c.state.reply?.answer, 'Recovered')
  assert.equal(c.state.streaming, '')
})
test('pause clears hints and previews; late transcription cannot repopulate the lens', async (t) => {
  const pending = deferred<string>()
  const { c } = setup(t, {
    async transcribe() {
      return pending.promise
    },
    chat: normalApi.chat
  })
  await c.start()
  for (let i = 0; i < 60; i++) c.onPcm(pcmFrame(true))
  await tick()
  await c.pause()
  pending.resolve('Late')
  await tick()
  assert.equal(c.state.transcript, '')
  assert.equal(c.state.reply, undefined)
})
test('continuous HUD shows transcript and hint together without page controls', async () => {
  const { continuousHud } = await import('../src/display')
  const c = new ContinuousController({ async start() {}, async stop() {} }, normalApi, () => {})
  c.state.transcript = 'Co právě říkám'
  c.state.streaming = 'Odpověď přichází'
  const lens = continuousHud(c.state)
  assert.match(lens, /Co právě říkám/)
  assert.match(lens, /Odpověď přichází/)
})
test('hardware hints wait for matching SDK acknowledgement, then get a full ten seconds', async (t) => {
  let clock = 1000
  const { c } = setup(t, normalApi, { now: () => clock, requireDisplayAck: true })
  await c.start()
  simulateUtterance(c)
  await tick()
  const first = c.state.reply!
  clock += 30000
  c.tickHint()
  assert.equal(c.state.reply?.id, first.id)
  c.acknowledgeHint(first.id + 1)
  c.tickHint()
  assert.equal(c.state.reply?.id, first.id)
  c.acknowledgeHint(first.id)
  clock += 9999
  c.acknowledgeHint(first.id)
  c.tickHint()
  assert.equal(c.state.reply?.id, first.id)
  clock++
  c.tickHint()
  assert.equal(c.state.reply, undefined)
  await c.pause()
  c.acknowledgeHint(first.id)
  assert.equal(c.state.reply, undefined)
})
test('sensitivity can change only while paused and preserves the two-second endpoint', async (t) => {
  const { c } = setup(t)
  assert.equal(c.setSpeechThreshold(300), true)
  assert.equal(c.setSpeechThreshold(-1), false)
  await c.start()
  assert.equal(c.setSpeechThreshold(1000), false)
  await c.pause()
  assert.equal(c.setSpeechThreshold(1000), true)
})
test('a display that never acknowledges a hint cannot stall the queue forever', async (t) => {
  const { c } = setup(t, normalApi, { requireDisplayAck: true, ackMs: 10, replyMs: 20 })
  await c.start()
  simulateUtterance(c)
  await tick()
  const first = c.state.reply!
  assert.equal(c.state.repliesDropped, 0)
  for (let i = 0; i < 40 && c.state.repliesDropped === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(c.state.repliesDropped, 1)
  assert.equal(c.state.reply?.id, first.id)
  await new Promise((resolve) => setTimeout(resolve, 25))
  c.tickHint()
  assert.equal(c.state.reply, undefined)
})
