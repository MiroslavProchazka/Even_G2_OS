export type Level = 'info' | 'warn' | 'error'
export type Stage = 'app' | 'sdk' | 'mic' | 'audio' | 'stt' | 'chat' | 'health' | 'display' | 'continuous'
export type Details = { status?: number; durationMs?: number; bytes?: number; frames?: number; queued?: number; dropped?: number; ignored?: number; chars?: number; ageMs?: number; rms?: number; peak?: number; phase?: string; transport?: string; code?: string }
export type DiagnosticEvent = { sequence: number; at: string; elapsedMs: number; level: Level; stage: Stage; event: string; traceId?: string; details: Details }
const numeric = ['status', 'durationMs', 'bytes', 'frames', 'queued', 'dropped', 'ignored', 'chars', 'ageMs', 'rms', 'peak'] as const
const events = new Set(['request.start','request.end','response.headers','state.changed','bridge.waiting','bridge.connected','bridge.failed','diagnostics.cleared','runtime.error','runtime.rejection','visibility.changed','session.started','pcm.received','segment.queued','segment.dropped','transcript.ignored','answer.ready','answer.shown','answer.expired','answer.dropped','segment.failed','dispose.stop_failed'])
const categories = new Set(['direct','gateway','idle','starting','recording','transcribing','answering','done','error','interrupted','paused','listening','off','on','unknown','manual','continuous','simulation','network','timeout','cancelled','invalid_response','operation_failed','uncaught_error','unhandled_rejection','bridge_unavailable','hidden','visible'])
/** Strict metadata allowlist: no prompts, transcripts, answers, PCM, URLs, headers or exception messages. */
function safeDetails(input: Details) {
  const output: Details = {}
  for (const key of numeric) if (typeof input[key] === 'number' && Number.isFinite(input[key])) output[key] = Math.round(input[key]! * 100) / 100
  for (const key of ['phase','transport','code'] as const) if (typeof input[key] === 'string' && categories.has(input[key]!)) output[key] = input[key]
  return output
}
export class Diagnostics {
  private events: DiagnosticEvent[] = []
  private sequence = 0
  private traces = 0
  private started = Date.now()
  private listeners = new Set<() => void>()
  constructor(private capacity = 400) { if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error('Invalid diagnostic capacity.') }
  record(stage: Stage, event: string, details: Details = {}, level: Level = 'info', traceId?: string) {
    if (!events.has(event)) return
    this.events.push({ sequence: ++this.sequence, at: new Date().toISOString(), elapsedMs: Date.now() - this.started, level, stage, event, ...(traceId && /^t\d+$/.test(traceId) ? { traceId } : {}), details: safeDetails(details) })
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
    for (const listener of this.listeners) { try { listener() } catch { /* Diagnostics must never interrupt capture or inference. */ } }
  }
  span(stage: Stage, details: Details = {}) {
    const id = `t${++this.traces}`, started = Date.now(); let ended = false
    this.record(stage, 'request.start', details, 'info', id)
    return { id, mark: (event: string, extra: Details = {}) => this.record(stage, event, extra, 'info', id), end: (level: Level = 'info', extra: Details = {}) => { if (ended) return; ended = true; this.record(stage, 'request.end', { ...details, ...extra, durationMs: Date.now() - started }, level, id) } }
  }
  snapshot() { return structuredClone(this.events) }
  export() { return JSON.stringify({ format: 'beast-g2-diagnostics-v1', version: '0.4.0', buildId: import.meta.env?.VITE_BUILD_ID || 'local-development', sdk: '0.0.16', exportedAt: new Date().toISOString(), capacity: this.capacity, events: this.snapshot() }, null, 2) }
  clear() { this.events = []; this.record('app', 'diagnostics.cleared') }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
}
export function errorCode(error: unknown, signal?: AbortSignal): 'cancelled' | 'timeout' | 'network' | 'operation_failed' {
  if (signal?.aborted) return 'cancelled'
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout'
  if (error instanceof TypeError) return 'network'
  return 'operation_failed'
}
export const diagnostics = new Diagnostics()
