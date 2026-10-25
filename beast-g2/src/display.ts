import { deadline } from './deadline'
import type { State } from './controller'
const labels: Record<State['phase'], string> = {
  idle: 'READY',
  starting: 'OPENING MIC',
  recording: 'LISTENING',
  transcribing: 'TRANSCRIBING',
  answering: 'BEAST',
  done: 'ANSWER',
  error: 'ERROR',
  interrupted: 'INTERRUPTED'
}
export function pages(text: string): string[] {
  const lines: string[] = []
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if ([...line, ...word].length + 1 > 40 && line) {
        lines.push(line)
        line = ''
      }
      let rest = [...word]
      while (rest.length > 40) {
        if (line) {
          lines.push(line)
          line = ''
        }
        lines.push(rest.slice(0, 40).join(''))
        rest = rest.slice(40)
      }
      if (rest.length) line += (line ? ' ' : '') + rest.join('')
    }
    lines.push(line)
  }
  const result: string[] = []
  for (let i = 0; i < lines.length; i += 5) result.push(lines.slice(i, i + 5).join('\n'))
  return result.length ? result : ['']
}
export function hud(state: State, page: number) {
  const content =
    state.phase === 'error' ? state.error : state.answer || state.transcript || (state.phase === 'recording' ? 'Speak, then tap to send.' : 'Tap to ask Beast.\nDouble tap: exit.\nSwipe: read answer.')
  const all = pages(content),
    index = Math.min(Math.max(0, page), all.length - 1)
  return { text: `BEAST / ${labels[state.phase]}${state.phase === 'recording' ? ` ${state.seconds}s` : ''}\n\n${all[index]}\n\n${index + 1}/${all.length}`, count: all.length }
}
// A single in-flight bridge write and one latest pending value; no queue of stale tokens.
export class LatestDisplay {
  private latest?: string
  private last?: string
  private running = false
  private disposed = false
  private requested?: string
  constructor(
    private write: (text: string) => Promise<void>,
    private failed: (error: unknown, text?: string) => void,
    private interval = 300,
    private timeoutMs = 8000,
    private delivered: (text: string) => void = () => {}
  ) {}
  update(text: string) {
    this.requested = text
    if (this.disposed || text === (this.latest ?? this.last)) return
    this.latest = text
    if (!this.running) void this.flush()
  }
  retry() {
    if (this.disposed || !this.requested) return false
    this.last = undefined
    this.update(this.requested)
    return true
  }
  dispose() {
    this.disposed = true
    this.latest = undefined
  }
  private async flush() {
    this.running = true
    while (!this.disposed && this.latest !== undefined) {
      const next = this.latest
      this.latest = undefined
      for (let attempt = 0; attempt < 3 && !this.disposed; attempt++) {
        try {
          await deadline(this.write(next), this.timeoutMs)
          this.last = next
          if (!this.disposed) this.delivered(next)
          break
        } catch (error) {
          const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
          if (timedOut) this.dispose() // Never overlap an unresolved native write.
          if (timedOut || attempt === 2) {
            this.failed(error, next)
            break
          }
          await new Promise((resolve) => setTimeout(resolve, this.interval))
          if (this.latest !== undefined && this.latest !== next) break // Prefer newer state to stale retries.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.interval))
    }
    this.running = false
  }
}

/** Live transcript and a separate hint share the lens; continuous mode never needs swipes. */
export function continuousHud(state: import('./continuous').ContinuousState) {
  const lines = (text: string) => pages(text).flatMap((page) => page.split('\n'))
  const transcript = lines(state.transcript || (state.microphone === 'on' ? 'Listening…' : 'Microphone off'))
    .slice(-2)
    .join('\n')
  const answer = state.reply?.hint || state.reply?.answer || state.streaming
  const hint = lines(answer || (state.error ? `Error: ${state.error}` : state.phase === 'transcribing' ? 'Transcribing…' : state.phase === 'answering' ? 'Beast is thinking…' : ''))
  const visible = hint.slice(0, 3)
  if (hint.length > 3) visible[2] = [...visible[2]].slice(0, 37).join('') + '…'
  return `YOU / ${state.microphone.toUpperCase()}\n${transcript}\n\n${!answer && state.error ? 'ERROR' : state.streaming && !state.reply ? 'BEAST …' : state.reply?.evidence ? 'BEAST / WEB' : 'BEAST'}\n${visible.join('\n')}`
}
