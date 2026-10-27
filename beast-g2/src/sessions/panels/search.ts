import type { SearchResult } from '../../session-api'
import type { SessionsDeps } from '../../sessions'
import { describeError, formatClock, formatDate } from '../../sessions-view'
import { button, el } from './dom'

const DEBOUNCE_MS = 250
const RESULT_LIMIT = 20

/**
 * Full-text search over stored transcripts. Typing is debounced, a new request aborts the previous one and only the newest
 * answer is rendered. A hit opens the session through the host, so the list and the detail stay owned by `initSessions`.
 */
export const searchPanel = {
  id: 'search',
  mount(section: HTMLElement, deps: SessionsDeps) {
    const wrapper = el('div', 'sessions-search')
    const form = el('form', 'sessions-search-form')

    const input = el('input')
    input.type = 'search'
    input.name = 'q'
    input.maxLength = 200
    input.placeholder = 'Search transcripts'
    input.setAttribute('aria-label', 'Search transcripts')

    const submit = button('Search', '', 'submit')
    form.append(input, submit)

    const status = el('p', 'hint sessions-search-status')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const list = el('ul', 'sessions-search-results')

    wrapper.append(el('h3', undefined, 'Search transcripts'), form, status, list)
    section.append(wrapper)

    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | null = null
    let token = 0

    function clear() {
      list.replaceChildren()
      status.textContent = ''
    }

    function renderResults(results: SearchResult[]) {
      list.replaceChildren()
      if (!results.length) {
        status.textContent = 'No matches'
        return
      }
      status.textContent = `${results.length} match${results.length === 1 ? '' : 'es'}`
      for (const result of results) {
        const item = el('li')
        const row = button('', 'search-result')
        row.append(el('span', 'search-result-name', result.sessionName))
        row.append(el('span', 'search-result-meta', `${formatDate(result.sessionStartedAt ?? result.sessionCreatedAt)} · ${formatClock(result.startMs)}`))
        row.append(el('span', 'search-result-snippet', result.snippet))
        row.addEventListener('click', () => {
          void deps.host?.select(result.sessionId)
        })
        item.append(row)
        list.append(item)
      }
    }

    async function run(query: string) {
      const text = query.trim()
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      controller?.abort()
      controller = null
      const current = ++token
      if (!text) {
        clear()
        return
      }
      const abort = new AbortController()
      controller = abort
      status.textContent = 'Searching…'
      try {
        const response = await deps.client.search(text, RESULT_LIMIT, { signal: abort.signal })
        if (current !== token || abort.signal.aborted) return
        renderResults(response.results)
      } catch (error) {
        if (current !== token || abort.signal.aborted) return
        clear()
        deps.host?.error(describeError(error))
      }
    }

    function schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void run(input.value)
      }, DEBOUNCE_MS)
    }

    input.addEventListener('input', schedule)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void run(input.value)
    })
  }
}
