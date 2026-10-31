import type { Settings, Turn } from './api'
import type { WorkAnswer } from './work-api'

type WorkApi = { ask(question: string, history: Turn[], signal: AbortSignal): Promise<WorkAnswer> }

/** Bounded, memory-only context. Credential changes invalidate both history and in-flight output. */
export class WorkConversation {
  private history: Turn[] = []
  private active?: AbortController
  private generation = 0
  private fingerprint = ''
  constructor(
    private readonly settings: () => Settings,
    private readonly api: WorkApi
  ) {}
  reset() {
    this.generation++
    this.active?.abort()
    this.active = undefined
    this.history = []
  }
  cancel() {
    this.active?.abort()
  }
  private connection() {
    const s = this.settings()
    return JSON.stringify([s.gateway, s.token, s.transport])
  }
  async ask(question: string, signal: AbortSignal) {
    const fingerprint = this.connection()
    if (fingerprint !== this.fingerprint) {
      this.reset()
      this.fingerprint = fingerprint
    }
    if (this.settings().transport !== 'gateway') throw new Error('Select Custom gateway to use Notion. Direct Beast cannot read work context.')
    if (!question.trim() || question.length > 2000) throw new Error('Work questions must contain 1–2000 characters.')
    if (this.active) throw new Error('A work question is already running. Wait or cancel it.')
    const active = new AbortController(),
      generation = this.generation
    this.active = active
    const abort = () => active.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) active.abort()
    try {
      active.signal.throwIfAborted()
      const answer = await this.api.ask(question, [...this.history], active.signal)
      active.signal.throwIfAborted()
      if (generation !== this.generation || fingerprint !== this.connection()) throw new Error('Work connection changed. Ask again.')
      this.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer.detail || answer.hint })
      this.history = this.history.slice(-4)
      return answer
    } finally {
      signal.removeEventListener('abort', abort)
      if (this.active === active) this.active = undefined
    }
  }
}
