import type { RequestOptions } from './client'
import { SearchEndpoints } from './search'
import type { SessionPreparation, SessionSummary } from './summary'

export { SessionApiError } from './client'

export type SessionStatus = 'draft' | 'active' | 'paused' | 'ended'
export type SessionSource = 'import' | 'g2'
export type SessionLanguage = 'cs' | 'en' | 'auto'
export type CaptureState = 'off' | 'starting' | 'on' | 'unknown'
export type CoverageDeclared = 'unknown' | 'partial' | 'complete'

export type Session = {
  id: string
  name: string
  source: SessionSource
  language: SessionLanguage
  goal: string
  prep: string
  timezone: string
  status: SessionStatus
  captureState: CaptureState
  transcriptRevision: number
  coverageDeclared: CoverageDeclared
  retentionDays: number
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  expiresAt: number
  endReason: string | null
}

export type SessionSegment = {
  id: string
  sequence: number
  startMs: number
  endMs: number
  state: 'accepted' | 'transcribed' | 'failed' | 'expired'
  audioBytes: number
  createdAt: number
  audioExpiresAt: number
  transcribedAt: number | null
}

export type SessionTurn = {
  id: string
  segmentId: string
  text: string
  revision: number
  source: 'stt' | 'manual'
  startMs: number
  endMs: number
  createdAt: number
  updatedAt: number
}

export type SessionGap = { id: string; startMs: number; endMs: number | null; reason: string; state: 'open' | 'resolved'; createdAt: number; resolvedAt: number | null }

export type SessionJob = {
  id: string
  type: 'transcribe'
  segmentId: string
  state: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  attempts: number
  maxAttempts: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export type SessionDetail = {
  session: Session
  segments: SessionSegment[]
  turns: SessionTurn[]
  gaps: SessionGap[]
  jobs: SessionJob[]
  summaries: SessionSummary[]
  preparation: SessionPreparation | null
}

export type CreateSessionInput = {
  name: string
  language?: SessionLanguage
  source?: SessionSource
  goal?: string
  prep?: string
  timezone?: string
  retentionDays?: number
}

export type SegmentUpload = { segmentId: string; sequence: number; startMs: number; endMs: number; wav: Uint8Array<ArrayBuffer>; writerId: string }

/**
 * The public session client. The class chain keeps every domain in its own module: `client.ts` owns the HTTP plumbing,
 * `summary.ts` adds summary and preparation routes, `search.ts` adds full-text search, and this class adds the session
 * routes.
 */
export class SessionClient extends SearchEndpoints {
  create(input: CreateSessionInput, options?: RequestOptions) {
    return this.json<{ session: Session }>('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, options)
  }

  list(limit = 50, options?: RequestOptions) {
    const bounded = Math.min(100, Math.max(1, Math.trunc(limit)))
    return this.json<{ sessions: Session[] }>(`/api/sessions?limit=${bounded}`, {}, options)
  }

  detail(id: string, options?: RequestOptions) {
    return this.json<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`, {}, options)
  }

  async remove(id: string, options?: RequestOptions) {
    const { response, release, fail } = await this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }, options)
    try {
      await response.body?.cancel().catch(() => {})
    } catch (error) {
      fail(error)
      throw error
    } finally {
      release()
    }
  }

  start(id: string, writerId: string, options?: RequestOptions) {
    return this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}/start`, { writerId }, options)
  }

  pause(id: string, writerId: string, options?: RequestOptions) {
    return this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}/pause`, { writerId }, options)
  }

  resume(id: string, writerId: string, options?: RequestOptions) {
    return this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}/resume`, { writerId }, options)
  }

  end(id: string, input: { writerId: string; lastSequence?: number } = { writerId: '' }, options?: RequestOptions) {
    return this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}/end`, input, options)
  }

  uploadSegment(id: string, segment: SegmentUpload, options?: RequestOptions) {
    return this.json<{ segment: SessionSegment; duplicate: boolean }>(
      `/api/sessions/${encodeURIComponent(id)}/segments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
          'X-Writer-Id': segment.writerId,
          'X-Segment-Id': segment.segmentId,
          'X-Sequence': String(segment.sequence),
          'X-Start-Ms': String(segment.startMs),
          'X-End-Ms': String(segment.endMs)
        },
        body: new Blob([segment.wav], { type: 'audio/wav' })
      },
      { ...options, timeoutMs: options?.timeoutMs ?? 60000 }
    )
  }

  addGap(id: string, gap: { startMs: number; endMs?: number | null; reason: string }, options?: RequestOptions) {
    return this.json<{ gap: SessionGap }>(`/api/sessions/${encodeURIComponent(id)}/gaps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gap) }, options)
  }

  correctTurn(id: string, turnId: string, text: string, options?: RequestOptions) {
    return this.json<{ turn: SessionTurn }>(
      `/api/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) },
      options
    )
  }

  async export(id: string, format: 'json' | 'markdown', options?: RequestOptions) {
    const { response, release, fail } = await this.request(`/api/sessions/${encodeURIComponent(id)}/export?format=${format}`, {}, { ...options, timeoutMs: options?.timeoutMs ?? 30000 })
    try {
      return await response.text()
    } catch (error) {
      fail(error)
      throw error
    } finally {
      release()
    }
  }
}
