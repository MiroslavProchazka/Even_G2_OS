export type WebSource = { id: number; title: string; url: string; published?: string }
export type WebEvidence = { sources: WebSource[]; retrievedAt: string }
export type ChatOptions = { format?: 'cue'; webQuery?: string; onSources?: (evidence: WebEvidence) => void }
import { diagnostics, errorCode, type Stage } from './diagnostics'
import { linkAbort, readLines } from './transport'
export type Settings = { gateway: string; token: string; language: 'cs' | 'en' | 'auto'; transport?: 'gateway' | 'direct'; chatModel?: string; sttModel?: string; sttPrompt?: string }
export type Turn = { role: 'user' | 'assistant'; content: string }
export function gatewayUrl(base: string, path: string) {
  const url = new URL(base)
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    throw new Error('Gateway must be an origin without path, credentials, query or fragment.')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname))))
    throw new Error('Use HTTPS, or HTTP on a local development network.')
  return new URL(path, url).href
}
export function isInsecureGateway(base: string) {
  const url = new URL(base)
  return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}
export class GatewayClient {
  constructor(private settings: () => Settings) {}
  private async request(path: string, init: RequestInit, signal?: AbortSignal) {
    const s = this.settings()
    const stage: Stage = path.includes('transcrib') ? 'stt' : path.includes('chat') ? 'chat' : 'health'
    const trace = diagnostics.span(stage, { transport: 'gateway' })
    if (!s.token) {
      trace.end('error')
      throw new Error('Enter the API key or gateway token first.')
    }
    const link = linkAbort(signal, 95000)
    try {
      const response = await fetch(gatewayUrl(s.gateway, path), { ...init, headers: { ...init.headers, Authorization: `Bearer ${s.token}` }, signal: link.signal, cache: 'no-store' })
      trace.mark('response.headers', { status: response.status })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { message?: string; requestId?: string }
        throw new Error(`${data.message || `Gateway HTTP ${response.status}`}${data.requestId ? ` [${data.requestId}]` : ''}`)
      }
      // Keep cancellation and timeout connected until the consumer finishes the body.
      return {
        response,
        fail: (error: unknown) => trace.end('error', { code: link.timeout.aborted ? 'timeout' : errorCode(error, signal) }),
        release: () => {
          link.release()
          trace.end()
        }
      }
    } catch (error) {
      trace.end('error', { code: link.timeout.aborted ? 'timeout' : errorCode(error, signal) })
      link.release()
      throw error
    }
  }
  async health() {
    const { response, release, fail } = await this.request('/api/health', {})
    try {
      return (await response.json()) as { mode: string; models: { chat: string; stt: string } }
    } catch (error) {
      fail(error)
      throw error
    } finally {
      release()
    }
  }
  async transcribe(wav: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    const { response, release, fail } = await this.request(
      `/api/transcribe?language=${this.settings().language}`,
      { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Blob([wav], { type: 'audio/wav' }) },
      signal
    )
    try {
      const data = (await response.json()) as { text?: string }
      if (typeof data.text !== 'string') throw new Error('Invalid transcript response.')
      return data.text
    } catch (error) {
      fail(error)
      throw error
    } finally {
      release()
    }
  }
  async chat(text: string, history: Turn[], signal: AbortSignal, delta: (text: string) => void, options?: ChatOptions) {
    const { response, release, fail } = await this.request(
      '/api/chat',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, history, format: options?.format, webQuery: options?.webQuery }) },
      signal
    )
    if (!response.body) {
      const error = new Error('Gateway returned no response stream.')
      fail(error)
      release()
      throw error
    }
    let completed = false
    const consume = (line: string) => {
      if (completed || !line.trim()) return
      const event = JSON.parse(line) as { type: string; text?: string; message?: string; requestId?: string; sources?: WebSource[]; retrievedAt?: string }
      if (event.type === 'delta' && typeof event.text === 'string') delta(event.text)
      if (event.type === 'sources') {
        if (!Array.isArray(event.sources) || !event.sources.length || event.sources.length > 5 || typeof event.retrievedAt !== 'string') throw new Error('Invalid web sources.')
        for (const source of event.sources) {
          const url = new URL(source.url)
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || typeof source.title !== 'string' || source.title.length > 200 || !Number.isInteger(source.id))
            throw new Error('Invalid web source.')
        }
        options?.onSources?.({ sources: event.sources, retrievedAt: event.retrievedAt })
      }
      if (event.type === 'done') completed = true
      if (event.type === 'error') throw new Error(`${event.message || 'Gateway stream failed.'} [${event.requestId || 'no-id'}]`)
    }
    try {
      for await (const line of readLines(response.body, 'Gateway frame exceeds limit.')) {
        consume(line)
        if (completed) break
      }
      if (!completed) throw new Error('Connection ended before the answer completed.')
    } catch (error) {
      fail(error)
      throw error
    } finally {
      release()
    }
  }
}
