import type { DiagnosticEvent } from './diagnostics'
export function percent(value?: number) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? `${Math.round(value)}%` : '--' }
export class StatusMonitor {
  glasses?: number
  phone?: number
  connected?: boolean
  online = true
  downlink?: number
  private sequence = 0
  private samples: { ok: boolean; at: number }[] = []
  consume(events: DiagnosticEvent[]) {
    for (const event of events) {
      if (event.sequence <= this.sequence) continue
      this.sequence = event.sequence
      if (!['health','stt','chat'].includes(event.stage) || event.event !== 'request.end' || event.details.code === 'cancelled') continue
      this.samples.push({ ok: event.level !== 'error', at: Date.parse(event.at) }); this.samples = this.samples.slice(-5)
    }
  }
  header(running: boolean, now = Date.now()) {
    const recent = this.samples.filter(s => now - s.at < 60000), last = recent.at(-1)
    const signal = !this.online ? 'x OFF' : !last ? '? NET' : !last.ok ? '! API' : recent.some(s => !s.ok) ? '~ API' : '+ API'
    const speed = this.online && this.downlink !== undefined && Number.isFinite(this.downlink) && this.downlink >= 0 ? `~${this.downlink.toFixed(1)}M` : '--M'
    return { left: `${this.connected === false ? 'G! ' : ''}${signal} ${speed} ${running ? 'RUN' : 'IDLE'}`, right: `G${percent(this.glasses)} P${percent(this.phone)}` }
  }
}
