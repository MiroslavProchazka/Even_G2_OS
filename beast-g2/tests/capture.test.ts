import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StoredSessionCapture, type CaptureOptions, type CaptureState } from '../src/capture'
import { SessionApiError, type CreateSessionInput, type SegmentUpload, type Session, type SessionClient, type SessionDetail, type SessionSegment, type SessionStatus } from '../src/session-api'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function until(predicate: () => boolean, label = 'condition') {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await tick()
  }
  assert.fail(`Timed out waiting for ${label}`)
}

const pcm = (ms: number) => new Uint8Array(ms * 32)

function makeSession(status: SessionStatus): Session {
  return {
    id: 'ses_1',
    name: 'Monday call',
    source: 'g2',
    language: 'cs',
    goal: '',
    prep: '',
    timezone: 'Europe/Prague',
    status,
    captureState: 'off',
    transcriptRevision: 0,
    coverageDeclared: 'unknown',
    retentionDays: 30,
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    expiresAt: 0,
    endReason: null
  }
}

function makeSegment(sequence: number, startMs: number, endMs: number): SessionSegment {
  return { id: `seg_${sequence}`, sequence, startMs, endMs, state: 'accepted', audioBytes: (endMs - startMs) * 32, createdAt: 0, audioExpiresAt: 0, transcribedAt: null }
}

function makeDetail(status: SessionStatus, segments: SessionSegment[] = []): SessionDetail {
  return { session: makeSession(status), segments, turns: [], gaps: [], jobs: [], summaries: [], preparation: null }
}

class FakeAudio {
  starts = 0
  stops = 0
  failStart = false
  async start() {
    this.starts++
    if (this.failStart) throw new Error('G2 microphone unavailable')
  }
  async stop() {
    this.stops++
  }
}

class FakeClient {
  calls: string[] = []
  uploads: SegmentUpload[] = []
  ends: { writerId: string; lastSequence?: number }[] = []
  gaps: { startMs: number; endMs?: number | null; reason: string }[] = []
  signals: (AbortSignal | undefined)[] = []
  created: CreateSessionInput | undefined
  status: SessionStatus = 'draft'
  segments: SessionSegment[] = []
  uploadsToFail = 0
  uploadError: unknown = new Error('gateway unreachable')
  endError: unknown = undefined
  uploadGate: Promise<void> | undefined
  endGate: Promise<void> | undefined
  attempts = 0

  async create(input: CreateSessionInput) {
    this.calls.push('create')
    this.created = input
    return { session: makeSession('draft') }
  }
  async detail() {
    this.calls.push('detail')
    return makeDetail(this.status, this.segments)
  }
  async start() {
    this.calls.push('start')
    this.status = 'active'
    return { session: makeSession('active') }
  }
  async pause() {
    this.calls.push('pause')
    this.status = 'paused'
    return { session: makeSession('paused') }
  }
  async resume() {
    this.calls.push('resume')
    this.status = 'active'
    return { session: makeSession('active') }
  }
  async end(_id: string, input: { writerId: string; lastSequence?: number }) {
    this.calls.push('end')
    if (this.endGate) await this.endGate
    if (this.endError) throw this.endError
    this.ends.push(input)
    this.status = 'ended'
    return { session: makeSession('ended') }
  }
  async uploadSegment(_id: string, segment: SegmentUpload, options?: { signal?: AbortSignal }) {
    this.calls.push('upload')
    this.uploads.push(segment)
    this.signals.push(options?.signal)
    this.attempts++
    if (this.uploadGate) await this.gated(options?.signal)
    if (this.uploadsToFail > 0) {
      this.uploadsToFail--
      throw this.uploadError
    }
    return { segment: makeSegment(segment.sequence, segment.startMs, segment.endMs), duplicate: false }
  }
  async addGap(_id: string, gap: { startMs: number; endMs?: number | null; reason: string }) {
    this.calls.push('gap')
    this.gaps.push(gap)
    return { gap: { id: 'gap_1', startMs: gap.startMs, endMs: gap.endMs ?? null, reason: gap.reason, state: 'open', createdAt: 0, resolvedAt: null } }
  }
  private gated(signal?: AbortSignal) {
    const gate = this.uploadGate!
    if (!signal) return gate
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'))
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      void gate.then(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      })
    })
  }
}

function setup(overrides: Partial<CaptureOptions> = {}, client = new FakeClient()) {
  const audio = new FakeAudio()
  const changes: CaptureState[] = []
  const capture = new StoredSessionCapture(audio, client as unknown as SessionClient, {
    writerId: 'phone',
    retryBaseMs: 1,
    onChange: () => changes.push({ ...capture.state }),
    ...overrides
  })
  return { capture, audio, client, changes }
}

function wavHeader(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const text = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4))
  return {
    riff: text(0),
    wave: text(8),
    fmt: text(12),
    data: text(36),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    size: view.getUint32(40, true)
  }
}

test('open creates a G2 session, starts the microphone and cuts 30 second WAV segments', async () => {
  const { capture, audio, client } = setup()
  const id = await capture.open({ name: 'Monday call', language: 'cs', goal: 'Decide the plan', prep: 'Read notes' })
  assert.equal(id, 'ses_1')
  assert.equal(capture.state.phase, 'recording')
  assert.equal(capture.state.microphone, 'on')
  assert.equal(capture.state.sessionId, 'ses_1')
  assert.equal(audio.starts, 1)
  assert.deepEqual(client.calls, ['create', 'start'])
  assert.deepEqual(client.created, { name: 'Monday call', language: 'cs', source: 'g2', goal: 'Decide the plan', prep: 'Read notes' })

  const input = pcm(65000)
  for (let offset = 0; offset < input.length; offset += 100000) capture.onPcm(input.subarray(offset, offset + 100000))
  await until(() => capture.state.segmentsSent === 2)
  assert.equal(client.uploads.length, 2)
  const [first, second] = client.uploads
  assert.equal(first.sequence, 0)
  assert.equal(first.startMs, 0)
  assert.equal(first.endMs, 30000)
  assert.equal(second.sequence, 1)
  assert.equal(second.startMs, 30000)
  assert.equal(second.endMs, 60000)
  assert.match(first.segmentId, /^seg_[a-f0-9]{32}$/)
  assert.match(second.segmentId, /^seg_[a-f0-9]{32}$/)
  assert.notEqual(first.segmentId, second.segmentId)
  assert.equal(first.wav.length, 44 + 960000)
  const header = wavHeader(first.wav)
  assert.equal(header.riff, 'RIFF')
  assert.equal(header.wave, 'WAVE')
  assert.equal(header.fmt, 'fmt ')
  assert.equal(header.data, 'data')
  assert.equal(header.channels, 1)
  assert.equal(header.rate, 16000)
  assert.equal(header.bits, 16)
  assert.equal(header.size, 960000)
  assert.equal(first.endMs - first.startMs, (first.wav.length - 44) / 32)
  assert.equal(capture.state.segmentsPending, 0)
  assert.equal(capture.state.segmentsDropped, 0)
})

test('pause flushes a partial segment and pauses the gateway only after its upload', async () => {
  const { capture, audio, client } = setup()
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(5000))
  await capture.pause()
  assert.equal(client.uploads.length, 1)
  assert.deepEqual({ sequence: client.uploads[0].sequence, startMs: client.uploads[0].startMs, endMs: client.uploads[0].endMs }, { sequence: 0, startMs: 0, endMs: 5000 })
  assert.equal(client.uploads[0].wav.length, 44 + 160000)
  assert.deepEqual(client.calls, ['create', 'start', 'upload', 'pause'])
  assert.equal(audio.starts, 1)
  assert.equal(audio.stops, 1)
  assert.equal(capture.state.phase, 'paused')
  assert.equal(capture.state.microphone, 'off')
  assert.equal(capture.state.segmentsSent, 1)
  assert.equal(capture.state.segmentsPending, 0)
  capture.onPcm(pcm(1000))
  await tick()
  assert.equal(client.uploads.length, 1)
})

test('pause discards a partial shorter than minFlushMs', async () => {
  const { capture, client } = setup({ minFlushMs: 1000 })
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(500))
  await capture.pause()
  assert.equal(client.uploads.length, 0)
  assert.equal(capture.state.segmentsSent, 0)
  assert.equal(capture.state.segmentsDropped, 0)
  assert.equal(capture.state.segmentsPending, 0)
})

test('end flushes the tail, reports lastSequence and ends the session', async () => {
  const { capture, audio, client } = setup()
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(2000))
  await capture.end()
  assert.equal(client.uploads.length, 1)
  assert.equal(client.uploads[0].startMs, 0)
  assert.equal(client.uploads[0].endMs, 2000)
  assert.deepEqual(client.ends, [{ writerId: 'phone', lastSequence: 0 }])
  assert.equal(capture.state.phase, 'ended')
  assert.equal(capture.state.microphone, 'off')
  assert.equal(audio.stops, 1)
})

test('pause, resume and end preserve upload order and the highest sequence', async () => {
  const { capture, client } = setup()
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(30000))
  await until(() => capture.state.segmentsSent === 1)
  await capture.pause()
  await capture.resume()
  capture.onPcm(pcm(30000))
  await until(() => capture.state.segmentsSent === 2)
  await capture.end()
  assert.deepEqual(client.calls, ['create', 'start', 'upload', 'pause', 'resume', 'upload', 'end'])
  assert.deepEqual(
    client.uploads.map((upload) => upload.sequence),
    [0, 1]
  )
  assert.deepEqual(
    client.uploads.map((upload) => upload.startMs),
    [0, 30000]
  )
  assert.deepEqual(
    client.uploads.map((upload) => upload.endMs),
    [30000, 60000]
  )
  assert.equal(client.ends[0].lastSequence, 1)
  assert.equal(capture.state.segmentsSent, 2)
  assert.equal(capture.state.phase, 'ended')
})

test('a failed upload retries the same segment id and sequence with exponential backoff', async () => {
  const { capture, client } = setup({ maxAttempts: 3, retryBaseMs: 100 })
  const waits: number[] = []
  ;(capture as any).wait = async (ms: number) => {
    waits.push(ms)
  }
  client.uploadsToFail = 2
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(30000))
  await until(() => capture.state.segmentsSent === 1)
  assert.equal(client.uploads.length, 3)
  assert.deepEqual(
    client.uploads.map((upload) => upload.segmentId),
    [client.uploads[0].segmentId, client.uploads[0].segmentId, client.uploads[0].segmentId]
  )
  assert.deepEqual(
    client.uploads.map((upload) => upload.sequence),
    [0, 0, 0]
  )
  assert.deepEqual(waits, [100, 200])
  assert.equal(capture.state.segmentsDropped, 0)
  assert.equal(client.gaps.length, 0)
})

test('a duplicate 409 response counts as an accepted segment', async () => {
  const { capture, client } = setup()
  client.uploadsToFail = 1
  client.uploadError = new SessionApiError(409, 'duplicate', 'Segment already stored.')
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(30000))
  await until(() => capture.state.segmentsSent === 1)
  assert.equal(client.uploads.length, 1)
  assert.equal(capture.state.segmentsDropped, 0)
  assert.equal(client.gaps.length, 0)
  assert.equal(capture.state.phase, 'recording')
})

test('exhausted retries record a coverage gap and later segments still upload', async () => {
  const { capture, client } = setup({ maxAttempts: 2, retryBaseMs: 1 })
  client.uploadsToFail = 2
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(60000))
  await until(() => capture.state.segmentsDropped === 1 && capture.state.segmentsSent === 1)
  assert.deepEqual(
    client.uploads.map((upload) => upload.sequence),
    [0, 0, 1]
  )
  assert.deepEqual(client.gaps, [{ startMs: 0, endMs: 30000, reason: 'network' }])
  assert.equal(capture.state.segmentsDropped, 1)
  assert.equal(capture.state.phase, 'recording')
  capture.onPcm(pcm(30000))
  await until(() => capture.state.segmentsSent === 2)
  assert.equal(client.uploads.at(-1)!.sequence, 2)
})

test('a full pending queue drops the oldest unsent segment and records a gap', async () => {
  const { capture, client } = setup({ maxBufferedSegments: 1 })
  const gate = deferred()
  client.uploadGate = gate.promise
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(30000))
  await until(() => client.uploads.length === 1)
  capture.onPcm(pcm(90000))
  assert.equal(capture.state.segmentsDropped, 2)
  assert.equal(capture.state.segmentsPending, 2)
  gate.resolve()
  await until(() => capture.state.segmentsSent === 2 && capture.state.segmentsPending === 0)
  assert.deepEqual(
    client.uploads.map((upload) => upload.sequence),
    [0, 3]
  )
  assert.deepEqual(
    client.gaps.map((gap) => gap.startMs).sort((a, b) => a - b),
    [30000, 60000]
  )
  assert.equal(capture.state.segmentsDropped, 2)
})

test('dispose aborts an in-flight upload and suppresses callbacks', async () => {
  const { capture, client, changes } = setup()
  const gate = deferred()
  client.uploadGate = gate.promise
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(30000))
  await until(() => client.uploads.length === 1)
  const before = changes.length
  const disposing = capture.dispose()
  assert.equal(client.signals[0]?.aborted, true)
  gate.resolve()
  await disposing
  await tick()
  assert.equal(capture.state.segmentsSent, 0)
  assert.equal(capture.state.segmentsPending, 0)
  assert.equal(client.uploads.length, 1)
  assert.equal(client.gaps.length, 0)
  assert.equal(changes.length, before)
  capture.onPcm(pcm(30000))
  await tick()
  assert.equal(client.uploads.length, 1)
})

test('audio start failure ends in error, marks the microphone unknown and attempts stop', async () => {
  const { capture, audio, client } = setup()
  audio.failStart = true
  await assert.rejects(() => capture.open({ name: 'Call', language: 'cs' }), /microphone unavailable/)
  assert.equal(capture.state.phase, 'error')
  assert.equal(capture.state.microphone, 'unknown')
  assert.match(capture.state.error, /microphone unavailable/)
  assert.equal(audio.stops, 1)
  assert.ok(client.calls.includes('start'))
  assert.equal(capture.statusLine(), 'ERR MIC')

  audio.failStart = false
  await capture.start()
  assert.equal(capture.state.phase, 'recording')
  assert.equal(capture.state.microphone, 'on')
  assert.equal(audio.starts, 2)
  assert.deepEqual(client.calls, ['create', 'start'])
})

test('attach follows draft, paused, active and ended sessions', async () => {
  const draft = setup()
  draft.client.status = 'draft'
  await draft.capture.attach('ses_1')
  assert.deepEqual(draft.client.calls, ['detail', 'start'])
  assert.equal(draft.audio.starts, 1)
  assert.equal(draft.capture.state.phase, 'recording')
  assert.equal(draft.capture.state.sessionId, 'ses_1')

  const paused = setup()
  paused.client.status = 'paused'
  await paused.capture.attach('ses_1')
  assert.deepEqual(paused.client.calls, ['detail', 'resume'])
  assert.equal(paused.audio.starts, 1)

  const active = setup()
  active.client.status = 'active'
  await active.capture.attach('ses_1')
  assert.deepEqual(active.client.calls, ['detail'])
  assert.equal(active.audio.starts, 1)

  const ended = setup()
  ended.client.status = 'ended'
  await assert.rejects(() => ended.capture.attach('ses_1'), /Session has ended\./)
  assert.equal(ended.audio.starts, 0)
  assert.equal(ended.capture.state.sessionId, null)
})

test('attach continues after stored segments without reusing sequence numbers', async () => {
  const { capture, client } = setup()
  client.status = 'active'
  client.segments = [makeSegment(0, 0, 30000), makeSegment(1, 30000, 60000)]
  await capture.attach('ses_1')
  capture.onPcm(pcm(30000))
  await until(() => capture.state.segmentsSent === 1)
  assert.equal(client.uploads[0].sequence, 2)
  assert.equal(client.uploads[0].startMs, 60000)
  assert.equal(client.uploads[0].endMs, 90000)
})

test('statusLine stays a short ASCII glasses label in every phase', async () => {
  let now = 0
  const { capture, client } = setup({ now: () => now })
  assert.equal(capture.statusLine(), 'IDLE')
  await capture.open({ name: 'Call', language: 'cs' })
  assert.match(capture.statusLine(), /^REC 00:00 S0$/)
  capture.onPcm(pcm(30000))
  await until(() => capture.state.segmentsSent === 1)
  now = 312000
  assert.equal(capture.statusLine(), 'REC 05:12 S1')
  await capture.pause()
  assert.equal(capture.statusLine(), 'PAUSED S1')
  await capture.resume()
  const gate = deferred()
  client.endGate = gate.promise
  const ending = capture.end()
  assert.equal(capture.statusLine(), 'ENDING S1')
  gate.resolve()
  await ending
  assert.equal(capture.statusLine(), 'ENDED S1')

  const broken = setup()
  broken.audio.failStart = true
  await assert.rejects(() => broken.capture.open({ name: 'Call', language: 'cs' }))
  assert.equal(broken.capture.statusLine(), 'ERR MIC')

  const failed = setup()
  failed.client.endError = new Error('gateway down')
  await failed.capture.open({ name: 'Call', language: 'cs' })
  await assert.rejects(() => failed.capture.end(), /gateway down/)
  assert.equal(failed.capture.statusLine(), 'ERR UPLOAD')

  for (const line of ['IDLE', capture.statusLine(), broken.capture.statusLine(), failed.capture.statusLine()]) {
    assert.ok(line.length <= 40)
    assert.match(line, /^[\x20-\x7E]+$/)
  }
})

test('end aborts a stalled drain, records gaps and still ends the session', async () => {
  const { capture, client } = setup({ drainMs: 10 })
  const gate = deferred()
  client.uploadGate = gate.promise
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(60000))
  await until(() => client.uploads.length === 1)
  await capture.end()
  await until(() => client.gaps.length === 2)
  assert.equal(client.signals[0]?.aborted, true)
  assert.equal(capture.state.segmentsDropped, 2)
  assert.equal(capture.state.segmentsPending, 0)
  assert.deepEqual(client.ends, [{ writerId: 'phone' }])
  assert.equal(capture.state.phase, 'ended')
  assert.deepEqual(
    client.gaps.map((gap) => gap.startMs).sort((a, b) => a - b),
    [0, 30000]
  )
})

test('dispose during retry backoff stops further attempts and callbacks', async () => {
  const { capture, client, changes } = setup({ maxAttempts: 4, retryBaseMs: 100 })
  const waiting = deferred()
  ;(capture as any).wait = () => waiting.promise
  client.uploadsToFail = 4
  await capture.open({ name: 'Call', language: 'cs' })
  capture.onPcm(pcm(30000))
  await until(() => client.uploads.length === 1)
  await capture.dispose()
  const before = changes.length
  waiting.resolve()
  await tick()
  assert.equal(client.uploads.length, 1)
  assert.equal(client.gaps.length, 0)
  assert.equal(changes.length, before)
})
