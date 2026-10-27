import { SAMPLE_RATE } from './audio'
import type { AudioPort } from './controller'
import { diagnostics, errorCode } from './diagnostics'
import type { SegmentUpload, SessionClient, SessionDetail } from './session-api'

export type CapturePhase = 'idle' | 'opening' | 'recording' | 'paused' | 'ending' | 'ended' | 'error'
export type CaptureState = {
  phase: CapturePhase
  sessionId: string | null
  segmentsSent: number
  segmentsPending: number
  segmentsDropped: number
  microphone: 'off' | 'on' | 'unknown'
  notice: string
  error: string
}
export type CaptureInput = { name: string; language: 'cs' | 'en' | 'auto'; goal?: string; prep?: string }
export type CaptureOptions = {
  writerId: string
  now?: () => number
  segmentMs?: number
  minFlushMs?: number
  maxBufferedSegments?: number
  retryBaseMs?: number
  maxAttempts?: number
  drainMs?: number
  onChange?: () => void
}

const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000
const MIN_SEGMENT_MS = 100
const MAX_SEGMENT_MS = 60000
const DEFAULT_SEGMENT_MS = 30000
const DEFAULT_MIN_FLUSH_MS = 1000
const DEFAULT_MAX_BUFFERED_SEGMENTS = 6
const DEFAULT_RETRY_BASE_MS = 500
const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_DRAIN_MS = 10000
const WRITER_ID = /^[A-Za-z0-9_.:-]{1,100}$/

let fallbackIds = 0

function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value!) : fallback))
}

function hex(bytes: Uint8Array) {
  let text = ''
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0')
  return text
}

/** Segment IDs are generated once and reused for every retry; the fallback keeps tests and old WebViews working. */
function segmentId() {
  const bytes = new Uint8Array(16)
  try {
    globalThis.crypto.getRandomValues(bytes)
    return `seg_${hex(bytes)}`
  } catch {
    fallbackIds = (fallbackIds + 1) % 0xffffffff
    let id = fallbackIds.toString(16).padStart(8, '0')
    while (id.length < 32)
      id += Math.floor(Math.random() * 0x100000000)
        .toString(16)
        .padStart(8, '0')
    return `seg_${id.slice(0, 32)}`
  }
}

/** 44-byte RIFF header, mono PCM16 at SAMPLE_RATE, followed by the raw little-endian samples. */
function wavBytes(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = pcm.byteLength - (pcm.byteLength % 2)
  const bytes = new Uint8Array(44 + size)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + size, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, size, true)
  bytes.set(pcm.subarray(0, size), 44)
  return bytes
}

function failureOf(error: unknown) {
  const value = error as { status?: unknown; code?: unknown }
  return { status: typeof value?.status === 'number' ? value.status : undefined, code: typeof value?.code === 'string' ? value.code : undefined }
}

/**
 * The gateway returns 200 with `duplicate: true` for a repeated segment. Older gateways answer 409 instead, so a
 * conflict means the segment is already stored unless the code names a rejected session state or a reused sequence.
 */
function isDuplicate(error: unknown) {
  const { status, code } = failureOf(error)
  return status === 409 && !['session_paused', 'session_not_active', 'sequence_conflict'].includes(code ?? '')
}

function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export class StoredSessionCapture {
  readonly state: CaptureState = { phase: 'idle', sessionId: null, segmentsSent: 0, segmentsPending: 0, segmentsDropped: 0, microphone: 'off', notice: '', error: '' }
  private readonly writerId: string
  private readonly segmentMs: number
  private readonly segmentBytes: number
  private readonly minFlushBytes: number
  private readonly maxBufferedSegments: number
  private readonly retryBaseMs: number
  private readonly maxAttempts: number
  private readonly drainMs: number
  private readonly onChange?: () => void
  private readonly lifecycle = new AbortController()
  private readonly requests = new AbortController()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly resumers = new Set<() => void>()
  private readonly deadlines = new Set<() => void>()
  private readonly idleResolvers: (() => void)[] = []
  private sessionId: string | null = null
  private sequence = 0
  private cursorMs = 0
  private lastSequence: number | undefined
  private queue: SegmentUpload[] = []
  private uploading = false
  private disposed = false
  private chunks: Uint8Array[] = []
  private buffered = 0
  private elapsed = 0
  private runningSince: number | undefined
  private idlePromise: Promise<void> | undefined

  constructor(
    private audio: AudioPort,
    private client: SessionClient,
    private options: CaptureOptions
  ) {
    if (!WRITER_ID.test(options.writerId)) throw new Error('Writer id must be 1-100 characters of A-Z, a-z, 0-9, _, ., : or -.')
    this.writerId = options.writerId
    this.segmentMs = bounded(options.segmentMs, DEFAULT_SEGMENT_MS, MIN_SEGMENT_MS, MAX_SEGMENT_MS)
    this.segmentBytes = this.segmentMs * BYTES_PER_MS
    this.minFlushBytes = Math.min(this.segmentBytes, bounded(options.minFlushMs, DEFAULT_MIN_FLUSH_MS, MIN_SEGMENT_MS, this.segmentMs) * BYTES_PER_MS)
    this.maxBufferedSegments = bounded(options.maxBufferedSegments, DEFAULT_MAX_BUFFERED_SEGMENTS, 1, 1000)
    this.retryBaseMs = bounded(options.retryBaseMs, DEFAULT_RETRY_BASE_MS, 0, 60000)
    this.maxAttempts = bounded(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 100)
    this.drainMs = bounded(options.drainMs, DEFAULT_DRAIN_MS, 0, 300000)
    this.onChange = options.onChange
  }

  private now() {
    return (this.options.now ?? Date.now)()
  }

  private set(patch: Partial<CaptureState>) {
    const changed = (Object.keys(patch) as (keyof CaptureState)[]).some((key) => this.state[key] !== patch[key])
    if (!changed) return
    Object.assign(this.state, patch)
    if (!this.disposed) this.onChange?.()
  }

  private fail(error: unknown, notice: string) {
    this.set({ phase: 'error', microphone: this.state.microphone === 'off' ? 'off' : 'unknown', notice, error: String(error) })
  }

  private elapsedMs() {
    return this.elapsed + (this.runningSince === undefined ? 0 : Math.max(0, this.now() - this.runningSince))
  }

  private stopClock() {
    if (this.runningSince === undefined) return
    this.elapsed += Math.max(0, this.now() - this.runningSince)
    this.runningSince = undefined
  }

  /** A timer that dispose can cancel so no retry or drain deadline outlives the capture. */
  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.disposed) return resolve()
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.resumers.delete(resolve)
        resolve()
      }, ms)
      this.timers.add(timer)
      this.resumers.add(resolve)
    })
  }

  private deadline(ms: number): { promise: Promise<boolean>; cancel: () => void } {
    let cancel = () => {}
    const promise = new Promise<boolean>((resolve) => {
      if (this.disposed) return resolve(true)
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.deadlines.delete(cancel)
        resolve(true)
      }, ms)
      this.timers.add(timer)
      cancel = () => {
        clearTimeout(timer)
        this.timers.delete(timer)
        this.deadlines.delete(cancel)
        resolve(false)
      }
      this.deadlines.add(cancel)
    })
    return { promise, cancel }
  }

  private append(chunk: Uint8Array) {
    this.chunks.push(new Uint8Array(chunk))
    this.buffered += chunk.byteLength
  }

  private take(size: number) {
    const out = new Uint8Array(size)
    let offset = 0
    while (offset < size && this.chunks.length) {
      const chunk = this.chunks[0]
      const count = Math.min(chunk.byteLength, size - offset)
      out.set(chunk.subarray(0, count), offset)
      offset += count
      if (count === chunk.byteLength) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(count)
    }
    this.buffered -= offset
    return out
  }

  private clearBuffer() {
    this.chunks = []
    this.buffered = 0
  }

  private flushPartial() {
    const size = this.buffered - (this.buffered % 2)
    if (size < this.minFlushBytes) {
      this.clearBuffer()
      return
    }
    const pcm = this.take(size)
    this.clearBuffer()
    this.emitSegment(pcm, size / BYTES_PER_MS)
  }

  private emitSegment(pcm: Uint8Array, durationMs: number) {
    const sequence = this.sequence++
    const startMs = this.cursorMs
    const endMs = startMs + Math.max(1, Math.round(durationMs))
    this.cursorMs = endMs
    this.enqueue({ segmentId: segmentId(), sequence, startMs, endMs, wav: wavBytes(pcm), writerId: this.writerId })
  }

  private enqueue(segment: SegmentUpload) {
    if (this.queue.length >= this.maxBufferedSegments) {
      const dropped = this.queue.shift()
      if (dropped) this.drop(dropped)
    }
    this.queue.push(segment)
    this.syncPending()
    void this.drain()
  }

  private syncPending() {
    this.set({ segmentsPending: this.queue.length + (this.uploading ? 1 : 0) })
  }

  private drop(segment: SegmentUpload) {
    this.set({ segmentsDropped: this.state.segmentsDropped + 1 })
    void this.recordGap(segment)
  }

  /** A gap is best effort: losing the gap record must never stop capture. */
  private async recordGap(segment: SegmentUpload) {
    const sessionId = this.sessionId
    if (!sessionId || this.disposed) return
    try {
      await this.client.addGap(sessionId, { startMs: segment.startMs, endMs: segment.endMs, reason: 'network' }, { signal: this.lifecycle.signal })
    } catch {
      /* Capture continues even when the gateway cannot store the gap. */
    }
  }

  private settleIdle() {
    if (this.uploading || this.queue.length) return
    const resolvers = this.idleResolvers.splice(0)
    this.idlePromise = undefined
    for (const resolve of resolvers) resolve()
  }

  private waitForIdle(): Promise<void> {
    if (!this.uploading && !this.queue.length) return Promise.resolve()
    if (!this.idlePromise) this.idlePromise = new Promise<void>((resolve) => this.idleResolvers.push(resolve))
    return this.idlePromise
  }

  private async drainWithin(ms: number): Promise<boolean> {
    if (!this.uploading && !this.queue.length) return true
    const deadline = this.deadline(ms)
    const expired = await Promise.race([this.waitForIdle().then(() => false), deadline.promise])
    deadline.cancel()
    return !expired
  }

  private confirm(segment: SegmentUpload, status?: number) {
    this.lastSequence = this.lastSequence === undefined ? segment.sequence : Math.max(this.lastSequence, segment.sequence)
    this.set({ segmentsSent: this.state.segmentsSent + 1 })
    diagnostics.record('session', 'segment.uploaded', status === undefined ? { bytes: segment.wav.length } : { bytes: segment.wav.length, status })
  }

  private async upload(segment: SegmentUpload) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.disposed) return
      try {
        await this.client.uploadSegment(this.sessionId!, segment, { signal: this.requests.signal })
        if (this.disposed) return
        this.confirm(segment)
        return
      } catch (error) {
        if (this.disposed) return
        if (this.requests.signal.aborted) {
          this.drop(segment)
          return
        }
        if (isDuplicate(error)) {
          this.confirm(segment, 409)
          return
        }
        diagnostics.record('session', 'segment.upload_failed', { status: failureOf(error).status, code: errorCode(error, this.requests.signal) }, 'warn')
        if (attempt >= this.maxAttempts) break
        await this.wait(this.retryBaseMs * 2 ** (attempt - 1))
      }
    }
    if (!this.disposed) this.drop(segment)
  }

  private async drain() {
    if (this.uploading || this.disposed) return
    this.uploading = true
    this.syncPending()
    try {
      while (!this.disposed && this.queue.length) {
        const segment = this.queue.shift()!
        this.syncPending()
        await this.upload(segment)
      }
    } finally {
      this.uploading = false
      this.syncPending()
      this.settleIdle()
    }
  }

  private async startAudio() {
    this.set({ microphone: 'unknown', notice: 'Opening G2 microphone', error: '' })
    try {
      await this.audio.start()
      if (this.disposed) {
        try {
          await this.audio.stop()
        } catch {
          /* Disposed while the microphone was opening; the stop is best effort. */
        }
        return
      }
      this.runningSince = this.now()
      this.set({ phase: 'recording', microphone: 'on', notice: 'Recording · stored session' })
    } catch (error) {
      if (this.disposed) throw error
      this.set({ phase: 'error', microphone: 'unknown', error: String(error), notice: 'Microphone unavailable' })
      try {
        await this.audio.stop()
      } catch {
        /* The start failure is preserved; stop remains best effort. */
      }
      throw error
    }
  }

  private async stopAudio() {
    this.stopClock()
    try {
      await this.audio.stop()
      if (!this.disposed) this.set({ microphone: 'off' })
    } catch {
      if (!this.disposed) this.set({ microphone: 'unknown' })
    }
  }

  private seed(detail: SessionDetail) {
    let next = 0
    let cursor = 0
    for (const segment of detail.segments) {
      next = Math.max(next, segment.sequence + 1)
      cursor = Math.max(cursor, segment.endMs)
    }
    this.sequence = next
    this.cursorMs = cursor
  }

  async open(input: CaptureInput): Promise<string> {
    if (this.disposed) throw new Error('Capture has been disposed.')
    if (this.sessionId !== null) throw new Error('A session is already open.')
    this.set({ phase: 'opening', notice: 'Creating session', error: '' })
    try {
      const { session } = await this.client.create({ name: input.name, language: input.language, source: 'g2', goal: input.goal, prep: input.prep }, { signal: this.lifecycle.signal })
      if (this.disposed) throw new Error('Capture has been disposed.')
      this.sessionId = session.id
      this.set({ sessionId: session.id })
      diagnostics.record('session', 'session.created', { phase: 'starting' })
      await this.client.start(session.id, this.writerId, { signal: this.lifecycle.signal })
      diagnostics.record('session', 'session.started', { phase: 'recording' })
      await this.startAudio()
      return session.id
    } catch (error) {
      if (!this.disposed && this.state.phase !== 'error') this.fail(error, 'Session could not start')
      throw error
    }
  }

  async attach(id: string): Promise<void> {
    if (this.disposed) throw new Error('Capture has been disposed.')
    if (this.sessionId !== null) throw new Error('A session is already open.')
    this.set({ phase: 'opening', notice: 'Loading session', error: '' })
    try {
      const detail = await this.client.detail(id, { signal: this.lifecycle.signal })
      if (detail.session.status === 'ended') throw new Error('Session has ended.')
      this.sessionId = id
      this.seed(detail)
      this.set({ sessionId: id })
      if (detail.session.status === 'draft') {
        await this.client.start(id, this.writerId, { signal: this.lifecycle.signal })
        diagnostics.record('session', 'session.started', { phase: 'recording' })
      } else if (detail.session.status === 'paused') {
        await this.client.resume(id, this.writerId, { signal: this.lifecycle.signal })
        diagnostics.record('session', 'session.started', { phase: 'recording' })
      }
      await this.startAudio()
    } catch (error) {
      if (!this.disposed && this.state.phase !== 'error') this.fail(error, 'Session could not be attached')
      throw error
    }
  }

  /** Starts capture audio for an open session; open() and attach() already do this, so it mainly retries a failed microphone start. */
  async start(): Promise<void> {
    if (this.disposed) throw new Error('Capture has been disposed.')
    if (!this.sessionId) throw new Error('No session is open.')
    if (this.state.phase === 'recording') return
    if (this.state.phase === 'paused') return this.resume()
    if (this.state.phase === 'ended') throw new Error('Session has ended.')
    if (this.state.phase === 'ending') throw new Error('Session is ending.')
    await this.startAudio()
  }

  async pause(): Promise<void> {
    if (this.disposed || this.state.phase !== 'recording' || !this.sessionId) return
    this.set({ phase: 'paused', microphone: 'unknown', notice: 'Pausing · finishing uploads', error: '' })
    await this.stopAudio()
    this.flushPartial()
    await this.waitForIdle()
    if (this.disposed) return
    try {
      await this.client.pause(this.sessionId, this.writerId, { signal: this.lifecycle.signal })
    } catch (error) {
      if (!this.disposed) this.fail(error, 'Pause failed')
      throw error
    }
    diagnostics.record('session', 'session.paused', { phase: 'paused' })
    this.set({ phase: 'paused', microphone: 'off', notice: 'Paused · microphone off' })
  }

  async resume(): Promise<void> {
    if (this.disposed || this.state.phase !== 'paused' || !this.sessionId) return
    try {
      await this.client.resume(this.sessionId, this.writerId, { signal: this.lifecycle.signal })
    } catch (error) {
      if (!this.disposed) this.fail(error, 'Resume failed')
      throw error
    }
    if (this.disposed) return
    diagnostics.record('session', 'session.started', { phase: 'recording' })
    await this.startAudio()
  }

  async end(): Promise<void> {
    if (this.disposed || !this.sessionId || !['recording', 'paused', 'error'].includes(this.state.phase)) return
    this.set({ phase: 'ending', microphone: 'unknown', notice: 'Ending session', error: '' })
    await this.stopAudio()
    this.flushPartial()
    const drained = await this.drainWithin(this.drainMs)
    if (!drained && !this.disposed) {
      this.requests.abort()
      while (this.queue.length) {
        const segment = this.queue.shift()
        if (segment) this.drop(segment)
      }
      this.syncPending()
    }
    if (this.disposed) return
    try {
      const input: { writerId: string; lastSequence?: number } = { writerId: this.writerId }
      if (this.lastSequence !== undefined) input.lastSequence = this.lastSequence
      await this.client.end(this.sessionId, input, { signal: this.lifecycle.signal })
    } catch (error) {
      if (!this.disposed) this.fail(error, 'End failed')
      throw error
    }
    diagnostics.record('session', 'session.ended', { phase: 'ended' })
    this.set({ phase: 'ended', microphone: 'off', notice: 'Session ended' })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearBuffer()
    this.queue = []
    this.lifecycle.abort()
    this.requests.abort()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    const resumers = [...this.resumers]
    this.resumers.clear()
    for (const resolve of resumers) resolve()
    const deadlines = [...this.deadlines]
    this.deadlines.clear()
    for (const cancel of deadlines) cancel()
    for (const resolve of this.idleResolvers.splice(0)) resolve()
    this.idlePromise = undefined
    try {
      await this.audio.stop()
    } catch {
      /* The physical microphone state is unknown after dispose; the session is left as it was. */
    }
  }

  onPcm(chunk: Uint8Array) {
    if (this.disposed || this.state.phase !== 'recording' || chunk.byteLength === 0) return
    this.append(chunk)
    while (this.buffered >= this.segmentBytes) {
      const pcm = this.take(this.segmentBytes)
      this.emitSegment(pcm, this.segmentMs)
    }
  }

  statusLine(): string {
    const sent = `S${this.state.segmentsSent}`
    const dropped = this.state.segmentsDropped > 0 ? ` D${this.state.segmentsDropped}` : ''
    let line: string
    switch (this.state.phase) {
      case 'recording':
        line = `REC ${clock(this.elapsedMs())} ${sent}${dropped}`
        break
      case 'paused':
        line = `PAUSED ${sent}${dropped}`
        break
      case 'opening':
        line = 'OPENING'
        break
      case 'ending':
        line = `ENDING ${sent}`
        break
      case 'ended':
        line = `ENDED ${sent}${dropped}`
        break
      case 'error':
        line = this.state.microphone === 'unknown' ? 'ERR MIC' : 'ERR UPLOAD'
        break
      default:
        line = 'IDLE'
    }
    return line.slice(0, 40)
  }
}
