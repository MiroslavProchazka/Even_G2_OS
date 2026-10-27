import type { RequestOptions } from './client'
import { SearchEndpoints } from './search'

/** One transcript passage an answer rests on. `quote` is the cited turn text, cut to a chip-sized excerpt. */
export type QaCitation = {
  turnId: string
  revision: number
  startMs: number
  endMs: number
  quote: string
}

/**
 * `sufficient` means every citation was checked against the current transcript revision. `insufficient` means the
 * transcript had no evidence; the answer then carries an explicit message and no citations.
 */
export type QaEvidence = 'sufficient' | 'insufficient'

export type QaAnswer = { text: string; evidence: QaEvidence; citations: QaCitation[] }

export type QaResponse = { answer: QaAnswer; requestId: string }

/**
 * Questions about one stored session. `SessionClient` in `session.ts` extends this class, so the QA domain adds its route
 * without touching the session, summary or search domains.
 */
export class QaEndpoints extends SearchEndpoints {
  ask(id: string, question: string, options?: RequestOptions) {
    return this.json<QaResponse>(`/api/sessions/${encodeURIComponent(id)}/qa`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) }, options)
  }
}
