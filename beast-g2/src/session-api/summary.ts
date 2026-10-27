import { SessionClientBase, type RequestOptions } from './client'
import type { CoverageDeclared, SessionGap } from './session'

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

/**
 * Summary and preparation routes. `SessionClient` in `session.ts` extends this class, so the summary domain adds its
 * methods without touching the session domain or the public barrel.
 */
export class SummaryEndpoints extends SessionClientBase {
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
}
