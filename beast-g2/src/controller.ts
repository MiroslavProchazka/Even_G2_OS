import { PcmBuffer } from './audio'
import type { Turn, ChatOptions } from './api'
export type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'answering' | 'done' | 'error' | 'interrupted'
export type State = { phase: Phase; transcript: string; answer: string; error: string; seconds: number }
export interface AudioPort { start(): Promise<void>; stop(): Promise<void> }
export interface AssistantPort { transcribe(wav: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string>; chat(text: string, history: Turn[], signal: AbortSignal, delta: (text: string) => void, options?: ChatOptions): Promise<void> }
export class AssistantController {
  state: State = { phase: 'idle', transcript: '', answer: '', error: '', seconds: 0 }
  private pcm = new PcmBuffer()
  private history: Turn[] = []
  private sequence = 0
  private request?: AbortController
  private micStarting = false
  private stopping = 0
  private micUnknown = false
  private recordingTimer?: ReturnType<typeof setTimeout>
  constructor(private audio: AudioPort, private api: AssistantPort, private changed: (state: State) => void) {}
  private set(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.changed(this.state) }
  async tap() {
    if (this.state.phase === 'recording') return this.finish()
    if (this.micUnknown || this.micStarting || this.stopping || ['transcribing', 'answering'].includes(this.state.phase)) return
    const id = ++this.sequence; this.pcm.clear(); this.micStarting = true
    this.set({ phase: 'starting', transcript: '', answer: '', error: '', seconds: 0 })
    try {
      this.micUnknown = true
      await this.audio.start()
      if (id !== this.sequence) { await this.audio.stop(); this.micUnknown = false; return }
      this.micUnknown = false
      this.set({ phase: 'recording' })
      this.recordingTimer = setTimeout(() => { void this.finish() }, 30000)
    } catch (error) {
      try { await this.audio.stop(); this.micUnknown = false } catch { /* Preserve the start failure; cancellation can retry stop. */ }
      if (id === this.sequence) this.set({ phase: 'error', error: String(error) })
    }
    finally { this.micStarting = false }
  }
  onPcm(chunk: Uint8Array) {
    if (!['starting', 'recording'].includes(this.state.phase)) return
    const full = this.pcm.add(chunk), seconds = Math.floor(this.pcm.bytes / 32000)
    if (seconds !== this.state.seconds) this.set({ seconds })
    if (full && this.state.phase === 'recording') void this.finish()
  }
  async finish() {
    if (this.state.phase !== 'recording') return
    clearTimeout(this.recordingTimer)
    const id = this.sequence; this.request = new AbortController(); const signal = this.request.signal
    this.set({ phase: 'transcribing' })
    try {
      this.micUnknown = true
      await this.audio.stop(); this.micUnknown = false
      if (id !== this.sequence) return
      if (this.pcm.bytes < 3200) throw new Error('Recording is too short. Speak for at least a moment.')
      const wav = this.pcm.wav(); this.pcm.clear()
      const text = (await this.api.transcribe(wav, signal)).trim()
      if (id !== this.sequence) return
      if (!text) throw new Error('No speech recognized. Try again.')
      await this.answer(text, id, signal)
    } catch (error) { if (id === this.sequence) this.set({ phase: 'error', error: String(error) }) }
    finally { if (id === this.sequence) { this.pcm.clear(); this.request = undefined } }
  }
  async ask(text: string) {
    if (this.micUnknown || this.micStarting || this.stopping || ['recording', 'transcribing', 'answering'].includes(this.state.phase)) return
    text = text.trim(); if (!text || text.length > 4000) return
    const id = ++this.sequence; this.request = new AbortController()
    this.set({ transcript: text, answer: '', error: '', seconds: 0 })
    try { await this.answer(text, id, this.request.signal) }
    catch (error) { if (id === this.sequence) this.set({ phase: 'error', error: String(error) }) }
    finally { if (id === this.sequence) this.request = undefined }
  }
  private async answer(text: string, id: number, signal: AbortSignal) {
    this.set({ phase: 'answering', transcript: text, answer: '' })
    await this.api.chat(text, this.history, signal, delta => {
      if (id !== this.sequence) return
      if (this.state.answer.length + delta.length > 12000) { this.request?.abort(); throw new Error('Answer exceeds limit.') }
      this.set({ answer: this.state.answer + delta })
    })
    if (id !== this.sequence) return
    if (!this.state.answer.trim()) throw new Error('The model returned an empty answer.')
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: this.state.answer.slice(0, 4000) })
    this.history = this.history.slice(-6)
    this.set({ phase: 'done' })
  }
  async cancel(interrupted = false) {
    const id = ++this.sequence; this.stopping++; this.request?.abort(); this.request = undefined; clearTimeout(this.recordingTimer); this.pcm.clear()
    this.micUnknown = true
    this.set({ phase: interrupted ? 'interrupted' : 'idle', answer: '', error: '' })
    try { await this.audio.stop(); this.micUnknown = false } catch (error) { if (id === this.sequence) this.set({ phase: 'error', error: `Could not stop microphone: ${String(error)}` }) }
    finally { this.stopping-- }
  }
  clearHistory() { this.history = [] }
}
