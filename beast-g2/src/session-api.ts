import { gatewayUrl, type Settings } from './api'
import { diagnostics, errorCode } from './diagnostics'
import { linkAbort } from './transport'

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

export type SummaryCitation = { turnId: string; turnRevision: number; startMs: number; endMs: number; quote: string }
export type SummaryItem = { text: string; citations: string[] }
export type SummaryActionCandidate = { text: string; owner: string | null; due: string | null; dueText: string | null; conditional: boolean; citations: string[] }
export type SummaryContent = { schemaVersion: number; overview: SummaryItem; decisions: SummaryItem[]; actionCandidates: SummaryActionCandidate[]; openQuestions: SummaryItem[] }
export type SummaryCoverage = { declared?: CoverageDeclared; turns?: number; pendingTranscriptions?: number; gaps?: SessionGap[] }
export type StoredActionCandidate = SummaryActionCandidate & { id: string; summaryId: string; createdAt: number }

/** A pending or failed summary carries `content: {}` and `coverage: {}` until the worker writes the result. */
export type SessionSummary = {
  id: string
  sessionId: string
  transcriptRevision: number
  generator: string
  promptVersion: string
  content: Partial<SummaryContent>
  coverage: SummaryCoverage
  status: 'pending' | 'ready' | 'failed' | 'stale'
  reviewStatus: 'unreviewed' | 'reviewed' | 'edited'
  staleReason: string | null
  lastError: string | null
  supersedesId: string | null
  createdAt: number
  updatedAt: number
  readyAt: number | null
  editedAt: number | null
  citations: SummaryCitation[]
  actionCandidates: StoredActionCandidate[]
}

export type PreparationSource = {
  sessionId: string
  sessionName: string
  summaryId: string
  summaryCreatedAt: string
  transcriptRevision: number
  sessionDate: string
}

export type PreparationCitation = SummaryCitation & { date: string }
export type PreparationContent = { schemaVersion: number; focus: string | null; source: PreparationSource; summary: SummaryContent; citations: PreparationCitation[] }

export type SessionPreparation = {
  id: string
  sessionId: string
  sourceSessionId: string
  sourceSummaryId: string
  sourceTranscriptRevision: number
  focus: string | null
  content: PreparationContent
  status: 'ready' | 'stale'
  staleReason: string | null
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

/** The gateway answers every session route with `{ error, message, requestId }` on failure. */
export class SessionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string
  ) {
    super(message)
    this.name = 'SessionApiError'
  }
}

type FailureBody = { error?: string; message?: string; requestId?: string }
type RequestOptions = { signal?: AbortSignal; timeoutMs?: number }

export class SessionClient {
  constructor(private settings: () => Settings) {}

  private async request(path: string, init: RequestInit = {}, options: RequestOptions = {}) {
    const s = this.settings()
    const trace = diagnostics.span('session', { transport: 'gateway' })
    if (!s.token) {
      trace.end('error', { code: 'operation_failed' })
      throw new SessionApiError(401, 'unauthorized', 'Enter the API key or gateway token first.')
    }
    const link = linkAbort(options.signal, options.timeoutMs ?? 20000)
    try {
      const response = await fetch(gatewayUrl(s.gateway, path), {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${s.token}` },
        signal: link.signal,
        cache: 'no-store'
      })
      trace.mark('response.headers', { status: response.status })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as FailureBody
        throw new SessionApiError(response.status, body.error || 'http_error', body.message || `Gateway HTTP ${response.status}`, body.requestId)
      }
      return {
        response,
        fail: (error: unknown) => trace.end('error', { code: link.timeout.aborted ? 'timeout' : errorCode(error, options.signal) }),
        release: () => {
          link.release()
          trace.end()
        }
      }
    } catch (error) {
      trace.end('error', { code: link.timeout.aborted ? 'timeout' : errorCode(error, options.signal) })
      link.release()
      throw error
    }
  }

  private async json<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    const { response, release, fail } = await this.request(path, init, options)
    try {
      return (await response.json()) as T
    } catch (error) {
      fail(error)
      throw error
    } finally {
      release()
    }
  }

  private post(path: string, body: unknown, options?: RequestOptions) {
    return this.json<{ session: Session }>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, options)
  }

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
    return this.post(`/api/sessions/${encodeURIComponent(id)}/start`, { writerId }, options)
  }

  pause(id: string, writerId: string, options?: RequestOptions) {
    return this.post(`/api/sessions/${encodeURIComponent(id)}/pause`, { writerId }, options)
  }

  resume(id: string, writerId: string, options?: RequestOptions) {
    return this.post(`/api/sessions/${encodeURIComponent(id)}/resume`, { writerId }, options)
  }

  end(id: string, input: { writerId: string; lastSequence?: number } = { writerId: '' }, options?: RequestOptions) {
    return this.post(`/api/sessions/${encodeURIComponent(id)}/end`, input, options)
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

  requestSummary(id: string, input: { allowPartial?: boolean; force?: boolean } = {}, options?: RequestOptions) {
    return this.json<{ summary: SessionSummary; created: boolean }>(
      `/api/sessions/${encodeURIComponent(id)}/summary`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
      options
    )
  }

  summary(id: string, options?: RequestOptions) {
    return this.json<{ summary: SessionSummary | null }>(`/api/sessions/${encodeURIComponent(id)}/summary`, {}, options)
  }

  summaries(id: string, options?: RequestOptions) {
    return this.json<{ summaries: SessionSummary[] }>(`/api/sessions/${encodeURIComponent(id)}/summaries`, {}, options)
  }

  updateSummary(id: string, summaryId: string, content: SummaryContent, options?: RequestOptions) {
    return this.json<{ summary: SessionSummary }>(
      `/api/sessions/${encodeURIComponent(id)}/summaries/${encodeURIComponent(summaryId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) },
      options
    )
  }

  createPreparation(id: string, input: { sourceSummaryId: string; focus?: string }, options?: RequestOptions) {
    return this.json<{ preparation: SessionPreparation }>(
      `/api/sessions/${encodeURIComponent(id)}/preparation`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
      options
    )
  }

  preparation(id: string, options?: RequestOptions) {
    return this.json<{ preparation: SessionPreparation | null }>(`/api/sessions/${encodeURIComponent(id)}/preparation`, {}, options)
  }

  preparations(id: string, options?: RequestOptions) {
    return this.json<{ preparations: SessionPreparation[] }>(`/api/sessions/${encodeURIComponent(id)}/preparations`, {}, options)
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
