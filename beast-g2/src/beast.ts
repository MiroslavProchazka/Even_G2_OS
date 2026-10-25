import { diagnostics, errorCode, type Stage } from './diagnostics'
import type { Settings, Turn, ChatOptions } from './api'
export function beastUrl(base: string, path: string) {
  const url = new URL(base)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Beast API needs an HTTPS base URL without credentials, query or fragment.')
  return `${url.href.replace(/\/+$/, '')}/${path}`
}
export class BeastClient {
  constructor(private settings: () => Settings) {}
  private async request(path: string, init: RequestInit, signal?: AbortSignal) {
    const s = this.settings()
    const stage: Stage = path.includes('transcrib') ? 'stt' : path.includes('chat') ? 'chat' : 'health'
    const trace = diagnostics.span(stage, { transport: 'direct' })
    if (!s.token) { trace.end('error'); throw new Error('Enter the API key or gateway token first.') }
    const timeout = AbortSignal.timeout(90000), controller = new AbortController(), abort = () => controller.abort()
    const release = () => { signal?.removeEventListener('abort', abort); timeout.removeEventListener('abort', abort); trace.end() }
    signal?.addEventListener('abort', abort, { once: true }); timeout.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    try {
      const response = await fetch(beastUrl(s.gateway, path), { ...init, headers: { ...init.headers, Authorization: `Bearer ${s.token}` }, signal: controller.signal, cache: 'no-store' })
      trace.mark('response.headers', { status: response.status })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Beast HTTP ${response.status} (${path}; model ${path.startsWith('audio/') ? s.sttModel || 'whisper-live' : s.chatModel || 'beast/big'}). Check endpoint, model and key.`) }
      return { response, release, fail: (error: unknown) => trace.end('error', { code: timeout.aborted ? 'timeout' : errorCode(error, signal) }) }
    } catch (error) { trace.end('error', { code: timeout.aborted ? 'timeout' : errorCode(error, signal) }); release(); throw error }
  }
  async health() {
    const { response, release, fail } = await this.request('models', {})
    try {
      const result = await response.json() as { data?: { id: string }[] }
      if (!Array.isArray(result.data)) throw new Error('Beast did not return an OpenAI-compatible model list.')
      const s = this.settings(), chat = s.chatModel || 'beast/big', stt = s.sttModel || 'whisper-live'
      if (!result.data.some(model => model.id === chat)) throw new Error(`Chat model ${chat} is missing. Available: ${result.data.slice(0, 30).map(model => model.id).join(', ')}`)
      return { mode: 'direct', models: { chat, stt } }
    } catch (error) { fail(error); throw error } finally { release() }
  }
  async transcribe(wav: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    const s = this.settings(), form = new FormData()
    form.set('file', new Blob([wav], { type: 'audio/wav' }), 'question.wav'); form.set('model', s.sttModel || 'whisper-live'); form.set('response_format', 'json')
    if (s.sttPrompt?.trim()) form.set('prompt', s.sttPrompt.trim().slice(0, 300))
    if (s.language !== 'auto') form.set('language', s.language)
    const { response, release, fail } = await this.request('audio/transcriptions', { method: 'POST', body: form }, signal)
    try { const result = await response.json() as { text?: string }; if (typeof result.text !== 'string' || result.text.length > 4000) throw new Error('Invalid Beast transcript.'); return result.text.trim() } catch (error) { fail(error); throw error } finally { release() }
  }
  async chat(text: string, history: Turn[], signal: AbortSignal, delta: (text: string) => void, options?: ChatOptions) {
    if (options?.webQuery !== undefined) throw new Error('Web search requires a configured custom gateway. Direct Beast cannot search.')
    const { response, release, fail } = await this.request('chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.settings().chatModel || 'beast/big', stream: true, max_tokens: 512, messages: [{ role: 'system', content: options?.format === 'cue' ? 'Return only a JSON object with show (boolean), hint (at most 120 characters) and detail (full explanation). Use the spoken language. Do not claim live facts or tools. Set show=false when no useful cue is needed.' : 'Answer the question in its language. Use plain text and at most two short sentences, ideally under 200 characters, as a glanceable smart-glasses hint. Do not claim live information or tools you do not have.' }, ...history, { role: 'user', content: text }] }) }, signal)
    if (!response.body) { const error = new Error('Beast returned no stream.'); fail(error); release(); throw error }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', data = '', complete = false, chars = 0
    const event = () => {
      if (!data || complete) { data = ''; return }
      if (data.trim() === '[DONE]') { complete = true; data = ''; return }
      const part = JSON.parse(data) as { error?: unknown; choices?: { delta?: { content?: string }; finish_reason?: string }[] }; data = ''
      if (part.error) throw new Error('Beast reported a streaming error.')
      const choice = part.choices?.[0], text = choice?.delta?.content
      if (typeof text === 'string') { chars += text.length; if (chars > 12000) throw new Error('Beast answer exceeds limit.'); delta(text) }
      if (choice?.finish_reason === 'stop' || choice?.finish_reason === 'length') complete = true
      if (choice?.finish_reason === 'content_filter') throw new Error('Beast declined the answer.')
    }
    const line = (value: string) => { if (value === '') event(); else if (value.startsWith('data:')) { data += (data ? '\n' : '') + value.slice(5).replace(/^ /, ''); if (data.length > 65536) throw new Error('Beast stream frame exceeds limit.') } }
    try {
      while (!complete) {
        const { value, done } = await reader.read(); pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
        if (pending.length > 65536) throw new Error('Beast stream line exceeds limit.')
        let match
        while (!complete && (match = /\r\n|\n|\r(?!$)/.exec(pending))) { line(pending.slice(0, match.index)); pending = pending.slice(match.index + match[0].length) }
        if (done) { if (pending && !complete) line(pending.replace(/\r$/, '')); event(); break }
      }
      if (!complete) throw new Error('Beast stream ended before completion.')
    } catch (error) { fail(error); throw error } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); release() }
  }
}
