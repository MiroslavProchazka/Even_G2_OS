import type { WebEvidence } from './api'
import { conversationPrompt, webQuery, parseCue, ReplyHistory, type ConversationConfig } from './conversation'
import { diagnostics } from './diagnostics'
import type { AssistantPort, AudioPort, State } from './controller'
import type { Turn } from './api'
import { Segmenter, type VadOptions } from './vad'
export type ListeningPhase = 'paused' | 'starting' | 'listening' | 'transcribing' | 'answering' | 'interrupted' | 'error'
export type Reply = { id: number; transcript: string; answer: string; hint?: string; evidence?: WebEvidence }
export type ContinuousState = { phase: ListeningPhase; microphone: 'off' | 'on' | 'unknown'; queued: number; dropped: number; ignored: number; notice: string; error: string; reply?: Reply; latest?: Reply; unread: number; repliesDropped: number; transcript: string; streaming: string; hintPage: number }
export class ContinuousController {
  state: ContinuousState = { phase: 'paused', microphone: 'off', queued: 0, dropped: 0, ignored: 0, notice: '', error: '', unread: 0, repliesDropped: 0, transcript: '', streaming: '', hintPage: 0 }
  readonly archive = new ReplyHistory()
  private conversation: ConversationConfig = { mode: 'direct', notes: '' }
  private replies: Reply[] = []
  private vad: Segmenter
  private generation = 0
  private starting = false
  private stopping = 0
  private running = false
  private queue: { wav: Uint8Array<ArrayBuffer>; at: number; utterance: number }[] = []
  private request?: AbortController
  private history: Turn[] = []
  private previewRequest?: AbortController
  private previewPending?: Uint8Array<ArrayBuffer>
  private utterance = 0
  private hintTimer?: ReturnType<typeof setInterval>
  private hintStarted: number | undefined
  private nextReplyId = 0
  private hintSpace?: () => void
  private enabled = false
  private lastAudio = 0
  private watchdog?: ReturnType<typeof setInterval>
  constructor(private audio: AudioPort, private api: AssistantPort, private changed: () => void, private options: { now?: () => number; vad?: Partial<VadOptions>; watchdogMs?: number; replyMs?: number; requestMs?: number; previews?: boolean; requireDisplayAck?: boolean } = {}) {
    this.vad = new Segmenter(wav => { this.cancelPreview(); this.enqueue(wav) }, options.vad,
      wav => { if (options.previews !== false) { this.previewPending = wav; void this.preview() } },
      () => { this.cancelPreview(); this.set({ transcript: '', error: '' }) },
      () => { this.cancelPreview(); this.set({ error: 'Speech exceeded 30 seconds. Pause for 2 seconds, then try a shorter utterance.' }) })
  }
  private cancelPreview() { this.utterance++; this.previewPending = undefined; this.previewRequest?.abort(); this.previewRequest = undefined }
  private async bounded<T>(work: (signal: AbortSignal) => Promise<T>, request: AbortController, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort!: () => void
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(request.signal.reason ?? new DOMException('Cancelled', 'AbortError'))
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
      timer = setTimeout(() => request.abort(new DOMException('Beast response timed out. Try again.', 'TimeoutError')), ms)
    })
    try { return await Promise.race([stopped, work(request.signal)]) }
    finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort) }
  }
  private async preview() {
    if (this.previewRequest || !this.previewPending || !this.enabled) return
    const wav = this.previewPending; this.previewPending = undefined
    const request = new AbortController(), id = this.utterance, generation = this.generation
    this.previewRequest = request
    try {
      const text = await this.bounded(signal => this.api.transcribe(wav, signal), request, 8000)
      if (!request.signal.aborted && id === this.utterance && generation === this.generation && this.enabled) this.set({ transcript: text.trim() })
    } catch { /* Final transcription is authoritative; transient previews may fail. */ }
    finally { if (this.previewRequest === request) { this.previewRequest = undefined; void this.preview() } }
  }
  private showReply(reply: Reply) {
    this.hintSpace?.(); this.hintSpace = undefined
    clearInterval(this.hintTimer); this.hintStarted = undefined
    this.set({ reply, notice: this.options.requireDisplayAck ? 'Waiting for glasses delivery.' : 'Hint ready.', hintPage: 0, streaming: '', latest: this.replies[0], unread: this.replies.length })
    if (!this.options.requireDisplayAck) this.acknowledgeHint(reply.id)
  }
  acknowledgeHint(id: number) {
    if (!this.enabled || this.state.reply?.id !== id || this.hintStarted !== undefined) return
    this.hintStarted = this.now()
    this.hintTimer = setInterval(() => this.tickHint(), 250)
    diagnostics.record('continuous', 'answer.shown', { chars: this.state.reply.answer.length })
    this.set({ notice: 'Hint delivered · clears after 10 seconds.' })
  }
  configureConversation(config: ConversationConfig) {
    if (this.enabled || this.starting || this.stopping || config.notes.length > 1500 || !['direct','context'].includes(config.mode)) return false
    this.conversation = { ...config }; this.history = []; return true
  }
  setSpeechThreshold(threshold: number) {
    if (this.enabled || this.starting || this.stopping || ![300,600,1000].includes(threshold)) return false
    this.vad.options.threshold = threshold; return true
  }
  tickHint() {
    if (!this.state.reply || this.hintStarted === undefined) return
    const elapsed = this.now() - this.hintStarted, duration = this.options.replyMs ?? 10000
    if (elapsed >= duration) {
      clearInterval(this.hintTimer); diagnostics.record('continuous', 'answer.expired')
      const next = this.replies.shift()
      if (next) this.showReply(next)
      else this.set({ reply: undefined, hintPage: 0, latest: undefined, unread: 0, notice: 'Listening · next hint appears automatically.' })
    }
  }
  checkAudioHealth() {
    if (this.enabled && !this.starting && this.now() - this.lastAudio > (this.options.watchdogMs ?? 8000)) return this.pause(true, 'No G2 audio received. Check connection, then resume explicitly.')
    return Promise.resolve()
  }
  private now() { return (this.options.now ?? Date.now)() }
  private set(patch: Partial<ContinuousState>) { this.state = { ...this.state, ...patch }; this.changed() }
  async start() {
    if (this.enabled || this.starting || this.stopping || this.state.microphone !== 'off') return
    const id = ++this.generation; this.starting = true; this.vad.reset(); this.queue = []; this.enabled = true
    this.set({ phase: 'starting', microphone: 'unknown', queued: 0, notice: 'Opening G2 microphone', error: '' })
    try {
      await this.audio.start()
      if (id !== this.generation) { await this.audio.stop(); return }
      this.lastAudio = this.now()
      this.set({ microphone: 'on', phase: 'listening', notice: 'Listening · live transcript, send after 2 seconds of silence' })
      this.watchdog = setInterval(() => { void this.checkAudioHealth() }, 1000)
    } catch (error) {
      let microphone: ContinuousState['microphone'] = 'off'
      try { await this.audio.stop() } catch { microphone = 'unknown' }
      if (id === this.generation) { this.enabled = false; this.queue = []; this.vad.reset(); this.set({ phase: 'error', microphone, queued: 0, error: String(error) }) }
    } finally { this.starting = false; if (this.enabled) void this.drain() }
  }
  onPcm(chunk: Uint8Array) { if (!this.enabled || !['starting', 'listening', 'transcribing', 'answering'].includes(this.state.phase)) return; this.lastAudio = this.now(); this.vad.push(chunk) }
  private enqueue(wav: Uint8Array<ArrayBuffer>) {
    if (!this.enabled) return
    if (this.queue.length >= 2) { this.queue.shift(); this.state.dropped++; diagnostics.record('continuous', 'segment.dropped', { dropped: this.state.dropped }, 'warn') }
    diagnostics.record('continuous', 'segment.queued', { bytes: wav.length, queued: this.queue.length + 1 }); this.queue.push({ wav, at: this.now(), utterance: this.utterance }); this.set({ queued: this.queue.length })
    void this.drain()
  }
  private async drain() {
    if (this.running || this.starting || !this.enabled) return
    this.running = true
    try {
      while (this.enabled && this.queue.length) {
        if (this.replies.length >= 3) { await new Promise<void>(resolve => { this.hintSpace = resolve }); if (!this.enabled) break }
        if (!this.queue.length) continue
        const item = this.queue.shift()!, id = this.generation
        this.set({ queued: this.queue.length })
        if (this.now() - item.at > 30000) { this.set({ dropped: this.state.dropped + 1, notice: 'Skipped stale audio segment.' }); continue }
        const request = new AbortController(); this.request = request
        let answer = ''
        try {
          this.set({ phase: 'transcribing', error: '' })
          const text = (await this.bounded(signal => this.api.transcribe(item.wav, signal), request, this.options.requestMs ?? 20000)).trim()
          if (id !== this.generation || !this.enabled) continue
          if (item.utterance === this.utterance) this.set({ transcript: text })
          if (!text) { this.set({ ignored: this.state.ignored + 1, notice: 'No speech recognized.' }); continue }
          this.set({ phase: 'answering', notice: 'Answering · microphone stays on; at most two queued segments.' })
          const config = { ...this.conversation }
          let evidence: WebEvidence | undefined
          const query = webQuery(text, config.web)
          await this.bounded(signal => this.api.chat(conversationPrompt(text, config), [...this.history], signal, delta => {
            if (id !== this.generation || request.signal.aborted) return
            if (answer.length + delta.length > 12000) { request.abort(); throw new Error('Answer exceeds limit.') }
            answer += delta; if (config.mode === 'direct' && !query) this.set({ streaming: answer })
          }, { format: config.mode === 'context' ? 'cue' : undefined, webQuery: query, onSources: value => { if (id === this.generation && !request.signal.aborted) evidence = value } }), request, this.options.requestMs ?? 30000)
          if (id !== this.generation || !this.enabled) continue
          if (query && !evidence) throw new Error('Gateway did not return web evidence. Update the gateway before using search.')
          if (!answer.trim()) throw new Error('Empty answer.')
          let hint: string | undefined
          if (config.mode === 'context') {
            const cue = parseCue(answer)
            if (!cue.show) { this.history.push({ role: 'user', content: text }); this.history = this.history.slice(-6); this.set({ ignored: this.state.ignored + 1, streaming: '', notice: 'Conversation noted · no useful cue needed.' }); continue }
            hint = cue.hint; answer = cue.detail
          }
          this.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer.slice(0, 4000) }); this.history = this.history.slice(-6)
          this.archive.add({ transcript: text, answer, hint, evidence, mode: config.mode })
          // Each completed hint gets ten seconds, then the next advances automatically.
          diagnostics.record('continuous', 'answer.ready', { chars: answer.length }); const reply = { id: ++this.nextReplyId, transcript: text, answer, hint, evidence }
          if (this.state.reply) {
            this.replies.push(reply)
            this.set({ latest: this.replies[0], unread: this.replies.length, streaming: '', notice: `${this.replies.length} hints waiting · advance automatically.` })
          } else this.showReply(reply)
        } catch (error) {
          if (id === this.generation && this.enabled) {
            // Surface failures and release the pipeline; partial output is not a completed hint.
            diagnostics.record('continuous', 'segment.failed', { code: 'operation_failed' }, 'error'); this.set({ streaming: '', error: String(error), notice: 'Segment failed; listening continues. No automatic audio retry.' })
          }
        } finally {
          if (this.request === request) this.request = undefined
          if (id === this.generation && this.enabled) this.set({ phase: 'listening' })
        }
      }
    } finally { this.running = false; if (this.enabled && this.queue.length) void this.drain() }
  }
  async pause(interrupted = false, notice = 'Paused · microphone off; resume explicitly.') {
    const id = ++this.generation; this.enabled = false; this.stopping++
    this.hintSpace?.(); this.hintSpace = undefined; clearInterval(this.watchdog); clearInterval(this.hintTimer); this.replies = []; this.hintStarted = undefined; this.cancelPreview(); this.request?.abort(); this.queue = []; this.vad.reset()
    this.set({ phase: interrupted ? 'interrupted' : 'paused', microphone: this.state.microphone === 'off' ? 'off' : 'unknown', queued: 0, notice, error: '', reply: undefined, latest: undefined, unread: 0, transcript: '', streaming: '' })
    try { await this.audio.stop(); if (id === this.generation) this.set({ microphone: 'off' }) }
    catch (error) { if (id === this.generation) this.set({ phase: 'error', error: `Microphone stop failed; retry pause: ${String(error)}` }) }
    finally { this.stopping-- }
  }
  showLatest() { const reply = this.replies.shift(); if (reply) this.showReply(reply) }
  clearHistory() { this.history = [] }
  viewState(): State { return { phase: this.state.reply ? 'done' : this.state.phase === 'starting' ? 'starting' : this.state.phase === 'error' ? 'error' : this.state.phase === 'interrupted' ? 'interrupted' : 'idle', transcript: this.state.transcript, answer: this.state.reply?.answer ?? this.state.streaming, error: this.state.error, seconds: 0 } }
}
