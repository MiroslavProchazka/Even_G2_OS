import type { AudioPort, State } from './controller'
import { deadline } from './deadline'
import { pages } from './display'
import { Segmenter, type VadOptions } from './vad'

/** A caption is one short line; anything longer is cut instead of growing the lens frame. */
export const CAPTION_CHARS = 160
/** Captions keep a bounded rolling history in memory and never write it anywhere. */
export const CAPTION_HISTORY = 50

export type CaptionLine = { id: number; text: string; at: number }
export type CaptionPhase = 'off' | 'starting' | 'listening' | 'transcribing' | 'paused' | 'error'
export type CaptionsState = {
  phase: CaptionPhase
  microphone: 'off' | 'on' | 'unknown'
  /** The newest final line, shown on the glasses and the phone. */
  caption: string
  /** At most CAPTION_HISTORY lines, oldest first. Cleared by stop. */
  lines: CaptionLine[]
  queued: number
  dropped: number
  error: string
  notice: string
}
export type CaptionsOptions = {
  now?: () => number
  vad?: Partial<VadOptions>
  requestMs?: number
  /** Returns the mode that already holds the microphone. Captions refuse to take it over. */
  microphoneOwner?: () => string | undefined
}
export type CaptionsListener = (state: CaptionsState) => void
/** The surface the phone panel needs; a fake implements it in tests. */
export type CaptionsControl = {
  state: CaptionsState
  start(): Promise<boolean>
  pause(): Promise<void>
  resume(): Promise<boolean>
  stop(): Promise<void>
  clear(): void
  statusLine(): string
  subscribe(listener: CaptionsListener): () => void
}

const off = (): CaptionsState => ({ phase: 'off', microphone: 'off', caption: '', lines: [], queued: 0, dropped: 0, error: '', notice: 'Captions are off. Nothing is stored.' })

/**
 * Live captions without a stored session. It reuses the VAD segmenter and the microphone port from continuous mode, but it only
 * asks for final transcription: no chat, no archive, no SessionClient and no session API. The text lives in this object and
 * disappears on stop.
 */
export class CaptionsController implements CaptionsControl {
  state: CaptionsState = off()
  private vad: Segmenter
  private listeners = new Set<CaptionsListener>()
  private generation = 0
  private enabled = false
  private starting = false
  private stopping = 0
  private running = false
  private disposed = false
  private queue: { wav: Uint8Array<ArrayBuffer>; at: number }[] = []
  private request?: AbortController
  private nextId = 0
  constructor(
    private audio: AudioPort,
    private transcribe: (wav: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<string>,
    private changed: () => void = () => {},
    private options: CaptionsOptions = {}
  ) {
    this.vad = new Segmenter(
      (wav) => this.enqueue(wav),
      options.vad,
      undefined,
      () => this.set({ notice: 'Speech detected. The caption appears after 2 seconds of silence.' }),
      () => this.set({ error: 'Speech exceeded 30 seconds. Pause for 2 seconds, then continue.', notice: '' })
    )
  }
  private now() {
    return (this.options.now ?? Date.now)()
  }
  private set(patch: Partial<CaptionsState>) {
    this.state = { ...this.state, ...patch }
    this.changed()
    for (const listener of this.listeners) listener(this.state)
  }
  subscribe(listener: CaptionsListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  /** Keeps the visible caption for reading; only stop and dispose discard the text. */
  async pause(notice = 'Captions paused · microphone off; resume explicitly.'): Promise<void> {
    if (this.disposed) return
    const id = ++this.generation
    this.enabled = false
    this.stopping++
    this.request?.abort()
    this.request = undefined
    this.queue = []
    this.vad.reset()
    this.set({ phase: 'paused', microphone: this.state.microphone === 'off' ? 'off' : 'unknown', queued: 0, error: '', notice })
    try {
      await this.audio.stop()
      if (id === this.generation) this.set({ microphone: 'off' })
    } catch (error) {
      if (id === this.generation) this.set({ phase: 'error', error: `Microphone stop failed; retry stop: ${String(error)}` })
    } finally {
      this.stopping--
    }
  }
  async resume(): Promise<boolean> {
    return this.start()
  }
  async start(): Promise<boolean> {
    if (this.disposed || this.enabled || this.starting || this.stopping || this.state.microphone !== 'off') return false
    const owner = this.options.microphoneOwner?.()
    if (owner) {
      // A second mode must never take the microphone over silently.
      this.set({ phase: 'error', error: `Microphone is in use by ${owner}. Stop it before starting captions.`, notice: 'Captions did not start.' })
      return false
    }
    const id = ++this.generation
    this.starting = true
    this.enabled = true
    this.vad.reset()
    this.queue = []
    this.set({ phase: 'starting', microphone: 'unknown', queued: 0, error: '', notice: 'Opening the microphone for captions.' })
    try {
      await this.audio.start()
      if (id !== this.generation) {
        await this.audio.stop()
        return false
      }
      this.set({ phase: 'listening', microphone: 'on', notice: 'Captions on · text appears after 2 seconds of silence. Nothing is stored.' })
      return true
    } catch (error) {
      let microphone: CaptionsState['microphone'] = 'off'
      try {
        await this.audio.stop()
      } catch {
        microphone = 'unknown'
      }
      if (id === this.generation) {
        this.enabled = false
        this.vad.reset()
        this.set({ phase: 'error', microphone, queued: 0, error: String(error), notice: 'Captions could not open the microphone.' })
      }
      return false
    } finally {
      this.starting = false
      if (this.enabled) void this.drain()
    }
  }
  onPcm(chunk: Uint8Array) {
    if (!this.enabled) return
    this.vad.push(chunk)
  }
  private enqueue(wav: Uint8Array<ArrayBuffer>) {
    if (!this.enabled) return
    if (this.queue.length >= 1) {
      this.queue.shift()
      this.set({ dropped: this.state.dropped + 1, notice: 'Skipped one caption line to stay current.' })
    }
    this.queue.push({ wav, at: this.now() })
    this.set({ queued: this.queue.length })
    void this.drain()
  }
  private async drain() {
    if (this.running || !this.enabled) return
    this.running = true
    try {
      while (this.enabled && this.queue.length) {
        const item = this.queue.shift()!,
          id = this.generation
        this.set({ queued: this.queue.length })
        if (this.now() - item.at > 30000) {
          this.set({ dropped: this.state.dropped + 1, notice: 'Skipped stale audio instead of showing a late caption.' })
          continue
        }
        const request = new AbortController()
        this.request = request
        try {
          this.set({ phase: 'transcribing' })
          const text = (await deadline(this.transcribe(item.wav, request.signal), this.options.requestMs ?? 20000)).trim()
          if (id !== this.generation || !this.enabled) continue
          if (!text) {
            this.set({ notice: 'No speech recognized in that segment.' })
            continue
          }
          this.append(text)
        } catch (error) {
          if (!request.signal.aborted) request.abort()
          if (id === this.generation && this.enabled) this.set({ error: String(error), notice: 'Caption failed; listening continues.' })
        } finally {
          if (this.request === request) this.request = undefined
          if (id === this.generation && this.enabled) this.set({ phase: 'listening' })
        }
      }
    } finally {
      this.running = false
      if (this.enabled && this.queue.length) void this.drain()
    }
  }
  private append(text: string) {
    const caption = [...text].slice(0, CAPTION_CHARS).join('')
    const lines = [...this.state.lines, { id: ++this.nextId, text: caption, at: this.now() }].slice(-CAPTION_HISTORY)
    this.set({ caption, lines, notice: `Captions on · ${lines.length}/${CAPTION_HISTORY} lines in memory. Nothing is stored.` })
  }
  /** Mirrors continuous mode: sensitivity can change only while capture is off. */
  setSpeechThreshold(threshold: number) {
    if (this.enabled || this.starting || this.stopping || ![300, 600, 1000].includes(threshold)) return false
    this.vad.options.threshold = threshold
    return true
  }
  /** Clears the text without touching the microphone. */
  clear() {
    this.set({ caption: '', lines: [], notice: this.enabled ? 'Captions cleared · still listening.' : 'Captions cleared.' })
  }
  /** Ends the mode and discards every line it held. */
  async stop(): Promise<void> {
    if (this.disposed) return
    const id = ++this.generation
    this.enabled = false
    this.stopping++
    this.request?.abort()
    this.request = undefined
    this.queue = []
    this.vad.reset()
    this.set({ phase: 'off', microphone: this.state.microphone === 'off' ? 'off' : 'unknown', caption: '', lines: [], queued: 0, error: '', notice: 'Captions stopped · text cleared.' })
    try {
      await this.audio.stop()
      if (id === this.generation) this.set({ microphone: 'off' })
    } catch (error) {
      if (id === this.generation) this.set({ phase: 'error', error: `Microphone stop failed; retry stop: ${String(error)}` })
    } finally {
      this.stopping--
    }
  }
  statusLine() {
    const state = this.state
    if (state.phase === 'error') return `Captions error · ${state.error} · nothing stored`
    if (state.phase === 'off') return 'Captions off · nothing stored'
    return `Captions ${state.phase} · mic ${state.microphone} · ${state.lines.length}/${CAPTION_HISTORY} lines · nothing stored`
  }
  viewState(): State {
    const phase: State['phase'] =
      this.state.phase === 'starting'
        ? 'starting'
        : this.state.phase === 'listening'
          ? 'recording'
          : this.state.phase === 'transcribing'
            ? 'transcribing'
            : this.state.phase === 'error'
              ? 'error'
              : this.state.phase === 'paused'
                ? 'interrupted'
                : 'idle'
    return { phase, transcript: this.state.caption, answer: this.state.notice, error: this.state.error, seconds: 0 }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    await this.stop()
    this.disposed = true
    this.listeners.clear()
  }
}

/** The lens frame: one header plus at most four caption lines, no paging. */
export function captionsHud(state: CaptionsState) {
  const label = state.phase === 'error' ? 'ERROR' : state.microphone === 'on' ? 'LIVE · NOT STORED' : `${state.phase.toUpperCase()} · NOT STORED`
  const body = state.phase === 'error' && state.error ? state.error : state.caption || (state.microphone === 'on' ? 'Listening…' : 'Captions are off.')
  const all = pages(body).flatMap((page) => page.split('\n'))
  const lines = all.slice(0, 4)
  if (all.length > 4) lines[3] = [...lines[3]].slice(0, 39).join('') + '…'
  return `CAPTIONS / ${label}\n${lines.join('\n')}`
}
