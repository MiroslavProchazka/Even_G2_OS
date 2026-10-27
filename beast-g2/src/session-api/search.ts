import type { RequestOptions } from './client'
import { SummaryEndpoints } from './summary'

/** One transcript passage that matched a full-text query. `startMs` and `endMs` are offsets inside the session. */
export type SearchResult = {
  sessionId: string
  sessionName: string
  turnId: string
  revision: number
  startMs: number
  endMs: number
  snippet: string
  sessionCreatedAt: number
  sessionStartedAt: number | null
}

export type SearchResponse = { results: SearchResult[] }

/**
 * Full-text search over the final transcript. `SessionClient` in `session.ts` extends this class, so the search domain adds
 * its route without touching the session or summary domains.
 */
export class SearchEndpoints extends SummaryEndpoints {
  search(query: string, limit = 50, options?: RequestOptions) {
    const bounded = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.trunc(limit))) : 50
    const params = new URLSearchParams({ q: query, limit: String(bounded) })
    return this.json<SearchResponse>(`/api/sessions/search?${params.toString()}`, {}, options)
  }
}
