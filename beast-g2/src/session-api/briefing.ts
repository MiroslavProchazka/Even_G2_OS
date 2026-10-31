import type { RequestOptions } from './client'
import { MemoryEndpoints } from './memory'
import type { SummaryCoverage } from './summary'

/** A source is verified only when its latest ready summary still matches the transcript revision and every citation resolves. */
export type BriefingVerification = 'verified' | 'unverified'

/** Why the gateway could not verify a source. An unverified source contributes no claims. */
export type BriefingSourceReason = 'no_summary' | 'summary_pending' | 'summary_failed' | 'summary_stale' | 'transcript_changed' | 'citation_missing' | 'citation_stale' | 'summary_invalid'

export type BriefingSource = {
  sessionId: string
  sessionName: string
  sessionDate: string
  summaryId: string | null
  summaryCreatedAt: string | null
  summaryStatus: 'ready' | 'stale' | 'pending' | 'failed' | null
  reviewStatus: 'unreviewed' | 'reviewed' | 'edited' | null
  transcriptRevision: number
  summaryTranscriptRevision: number | null
  verification: BriefingVerification
  reason: BriefingSourceReason | null
  coverage: SummaryCoverage | null
}

export type BriefingCitation = { turnId: string; turnRevision: number; startMs: number; endMs: number; quote: string }

export type BriefingItemKind = 'overview' | 'decision' | 'commitment' | 'open_question'

/**
 * One claim in the briefing. An item exists only when its source is verified, so every item carries the exact summary and
 * the citations that prove it. `due` is the resolved date, `dueText` the original wording when no date could be resolved.
 */
export type BriefingItem = {
  id: string
  kind: BriefingItemKind
  text: string
  owner: string | null
  due: string | null
  dueText: string | null
  conditional: boolean
  verification: 'verified'
  source: { sessionId: string; sessionName: string; sessionDate: string; summaryId: string; summaryCreatedAt: string; verification: 'verified' }
  citations: BriefingCitation[]
}

export type Briefing = { generatedAt: string; maxSessions: number; sources: BriefingSource[]; items: BriefingItem[] }

export type CreateBriefingInput = { sessionIds: string[] }

/**
 * Cross-session briefing over stored sessions. The gateway aggregates the latest ready summaries deterministically; the
 * client never calls a model or an external source. A session that cannot be verified is still listed as a source, with no
 * claims, so the user sees which input was skipped and why.
 *
 * `SessionClient` in `session.ts` extends this class, so the briefing domain adds its route without touching the memory,
 * QA, search, summary or session domains.
 */
export class BriefingEndpoints extends MemoryEndpoints {
  createBriefing(input: CreateBriefingInput, options?: RequestOptions) {
    return this.post<{ briefing: Briefing }>('/api/briefing', input, options)
  }
}
