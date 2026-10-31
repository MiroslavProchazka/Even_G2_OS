import { SessionClientBase, type RequestOptions } from './session-api/client'
import type { Turn } from './api'

export type WorkAnswer = {
  status: 'answered' | 'needs_clarification' | 'insufficient_evidence'
  hint: string
  detail: string
  citations: { sourceId: string; pageId: string; title: string; url: string; excerpt: string; truncated: boolean }[]
  coverage: { retrievedAt: string; scope: 'selected_notion_results'; partial: boolean; pagesRead: number }
}

export function validateWorkResponse(answer: WorkAnswer): WorkAnswer {
  if (
    !answer ||
    !['answered', 'needs_clarification', 'insufficient_evidence'].includes(answer.status) ||
    typeof answer.hint !== 'string' ||
    !answer.hint.trim() ||
    [...answer.hint].length > 160 ||
    typeof answer.detail !== 'string' ||
    answer.detail.length > 4000 ||
    !Array.isArray(answer.citations) ||
    answer.citations.length > 10
  )
    throw new Error('Invalid work answer from gateway.')
  const coverage = answer.coverage
  if (
    !coverage ||
    coverage.scope !== 'selected_notion_results' ||
    typeof coverage.partial !== 'boolean' ||
    !Number.isInteger(coverage.pagesRead) ||
    coverage.pagesRead < 0 ||
    coverage.pagesRead > 5 ||
    !Number.isFinite(Date.parse(coverage.retrievedAt))
  )
    throw new Error('Invalid work coverage from gateway.')
  if (answer.status === 'answered' && !answer.citations.length) throw new Error('Work answer is missing evidence.')
  for (const citation of answer.citations) {
    const url = new URL(citation.url)
    const host = url.hostname
    const notion = host === 'notion.so' || host.endsWith('.notion.so') || host === 'notion.com' || host.endsWith('.notion.site')
    if (
      !notion ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      typeof citation.title !== 'string' ||
      citation.title.length > 200 ||
      typeof citation.excerpt !== 'string' ||
      citation.excerpt.length > 600
    )
      throw new Error('Invalid work source from gateway.')
  }
  return answer
}

export class WorkClient extends SessionClientBase {
  status(options?: RequestOptions) {
    return this.json<{ connected: boolean; workspaceId?: string }>('/api/notion/status', {}, options)
  }
  connect(options?: RequestOptions) {
    return this.post<{ authorizationUrl: string }>('/api/notion/connect', {}, options)
  }
  disconnect(options?: RequestOptions) {
    return this.post<{ connected: boolean }>('/api/notion/disconnect', {}, options)
  }
  async ask(question: string, history: Turn[], signal: AbortSignal) {
    const result = await this.post<{ answer: WorkAnswer }>('/api/work/ask', { question, history }, { signal, timeoutMs: 95000 })
    return validateWorkResponse(result.answer)
  }
}
