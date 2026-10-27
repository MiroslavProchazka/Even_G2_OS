import type { RequestOptions } from './client'
import { QaEndpoints } from './qa'

/** The kind of claim a memory item stores. */
export type MemoryKind = 'decision' | 'commitment' | 'fact' | 'preference' | 'open_question'

/** A proposal is stored but not trusted until it is approved. Superseded items stay for history. */
export type MemoryStatus = 'proposed' | 'approved' | 'rejected' | 'superseded'

/** `lost` means the cited turn is gone or its revision no longer exists, so the quote cannot be checked. */
export type MemoryEvidenceState = 'present' | 'lost'

export type MemoryItem = {
  id: string
  sessionId: string
  turnId: string
  turnRevision: number
  kind: MemoryKind
  text: string
  sourceQuote: string
  status: MemoryStatus
  supersedesId: string | null
  sourceDeleted: boolean
  evidenceState: MemoryEvidenceState
  createdAt: number
  updatedAt: number
  approvedAt: number | null
  rejectedAt: number | null
  supersededAt: number | null
}

export type MemoryList = { items: MemoryItem[]; requestId?: string }
export type MemoryResponse = { item: MemoryItem; requestId?: string }
export type SupersedeMemoryResponse = { item: MemoryItem; superseded: MemoryItem; requestId?: string }

export type MemoryQuery = { status?: MemoryStatus | 'all'; query?: string }
export type ProposeMemoryInput = { turnId: string; revision: number; kind: MemoryKind; text: string }
export type SupersedeMemoryInput = { text: string; kind?: MemoryKind }

/**
 * Memory items for one stored session. A proposal keeps the exact turn id and revision it came from, so the gateway can
 * prove the source still exists. Approval, rejection and replacement are explicit user actions; nothing here is injected
 * into a conversation automatically.
 *
 * `SessionClient` in `session.ts` extends this class, so the memory domain adds its routes without touching the QA,
 * search, summary or session domains.
 */
export class MemoryEndpoints extends QaEndpoints {
  memoryForSession(id: string, options?: MemoryQuery & RequestOptions) {
    const { status, query, ...request } = options ?? {}
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    if (query) params.set('query', query)
    const queryString = params.toString()
    const suffix = queryString ? `?${queryString}` : ''
    return this.json<MemoryList>(`/api/sessions/${encodeURIComponent(id)}/memory${suffix}`, {}, request)
  }

  /**
   * Items kept after their source session was deleted. This is the only cross-session memory read: the item has no session
   * row left to open, so the panel lists it separately and marks its evidence as lost.
   */
  listRetainedMemory(options?: MemoryQuery & RequestOptions) {
    const { status, query, ...request } = options ?? {}
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    if (query) params.set('query', query)
    const queryString = params.toString()
    const suffix = queryString ? `?${queryString}` : ''
    return this.json<MemoryList>(`/api/memory${suffix}`, {}, request)
  }

  proposeMemory(id: string, input: ProposeMemoryInput, options?: RequestOptions) {
    return this.post<MemoryResponse>(`/api/sessions/${encodeURIComponent(id)}/memory`, input, options)
  }

  setMemoryStatus(id: string, memoryId: string, status: 'approved' | 'rejected', options?: RequestOptions) {
    return this.json<MemoryResponse>(
      `/api/sessions/${encodeURIComponent(id)}/memory/${encodeURIComponent(memoryId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) },
      options
    )
  }

  supersedeMemory(id: string, memoryId: string, input: SupersedeMemoryInput, options?: RequestOptions) {
    return this.post<SupersedeMemoryResponse>(`/api/sessions/${encodeURIComponent(id)}/memory/${encodeURIComponent(memoryId)}/supersede`, input, options)
  }
}
