import type { Briefing, BriefingItem, BriefingItemKind, BriefingSource, BriefingSourceReason, Session } from '../../session-api'
import type { SessionsDeps } from '../../sessions'
import { citationLabel, describeError, formatDate } from '../../sessions-view'
import { button, el } from './dom'

const MAX_SESSIONS = 3

/** A skipped source still explains itself and says plainly that it contributes nothing. */
const REASON_TEXT: Record<BriefingSourceReason, string> = {
  no_summary: 'No summary yet. This session adds no claims.',
  summary_pending: 'Summary is still processing. This session adds no claims.',
  summary_failed: 'Summary failed. This session adds no claims.',
  summary_stale: 'Summary is stale. This session adds no claims.',
  transcript_changed: 'Transcript changed after the summary. This session adds no claims.',
  citation_missing: 'A cited transcript turn is missing. This session adds no claims.',
  citation_stale: 'A cited transcript turn changed. This session adds no claims.',
  summary_invalid: 'Summary has no usable citations. This session adds no claims.'
}

const GROUPS: Array<{ kind: BriefingItemKind; title: string }> = [
  { kind: 'overview', title: 'Overview' },
  { kind: 'decision', title: 'Decisions' },
  { kind: 'commitment', title: 'Commitments' },
  { kind: 'open_question', title: 'Open questions' }
]

/**
 * Briefing over up to three stored sessions. The gateway does the aggregation deterministically from the latest ready
 * summaries and their transcript citations; this panel only picks sessions and renders the result. A session without a usable
 * summary is shown as an unverified source with the reason and no claims, never silently dropped.
 *
 * The session picker follows the host's session list when `onSessions` exists and falls back to `client.list` otherwise.
 * Selections survive a list refresh; an id that disappears from the list is dropped so the request never names a stale session.
 */
export const briefingPanel = {
  id: 'briefing',
  mount(section: HTMLElement, deps: SessionsDeps) {
    const wrapper = el('div', 'sessions-briefing')
    wrapper.append(el('h3', undefined, 'Briefing from stored sessions'))
    wrapper.append(el('p', 'hint', 'Choose up to three stored sessions. The briefing uses only their latest ready summaries and transcript citations. It never calls an external source.'))

    const form = el('form', 'sessions-briefing-form')
    const sessionsBlock = el('fieldset', 'sessions-briefing-sessions')
    sessionsBlock.append(el('legend', undefined, 'Stored sessions'))
    const build = button('Build briefing', '', 'submit')
    form.append(sessionsBlock, build)

    const status = el('p', 'hint sessions-briefing-status')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const emptyState = el('p', 'hint sessions-briefing-empty', 'No stored sessions yet.')
    const result = el('div', 'sessions-briefing-result')

    wrapper.append(form, status, emptyState, result)
    section.append(wrapper)

    let sessions: Session[] = []
    let options: Array<{ id: string; input: HTMLInputElement }> = []
    const selected = new Set<string>()
    let busy = false
    let token = 0
    let controller: AbortController | null = null

    function syncSelection() {
      const full = selected.size >= MAX_SESSIONS
      for (const option of options) {
        const checked = selected.has(option.id)
        option.input.checked = checked
        option.input.disabled = full && !checked
      }
      build.disabled = busy || sessions.length === 0 || selected.size === 0
    }

    function renderSessions(list: Session[]) {
      sessions = list
      const available = new Set(list.map((session) => session.id))
      for (const id of [...selected]) if (!available.has(id)) selected.delete(id)

      options = []
      sessionsBlock.replaceChildren(el('legend', undefined, 'Stored sessions'))
      if (!list.length) {
        emptyState.hidden = false
        emptyState.textContent = 'No stored sessions yet.'
        syncSelection()
        return
      }
      emptyState.hidden = true
      emptyState.textContent = ''
      for (const session of list) {
        const option = el('label', 'session-briefing-option')
        const input = el('input')
        input.type = 'checkbox'
        input.name = 'session'
        input.value = session.id
        input.checked = selected.has(session.id)
        input.addEventListener('change', () => {
          if (input.checked) selected.add(session.id)
          else selected.delete(session.id)
          syncSelection()
        })
        option.append(input, `${session.name} · ${formatDate(session.startedAt ?? session.createdAt)}`)
        sessionsBlock.append(option)
        options.push({ id: session.id, input })
      }
      syncSelection()
    }

    function renderSource(source: BriefingSource) {
      const row = el('li', 'session-briefing-source')
      const head = el('div', 'session-section-head')
      const verified = source.verification === 'verified'
      head.append(
        el('span', verified ? 'session-badge' : 'session-badge session-badge-pending', verified ? 'Verified' : 'Unverified'),
        el('span', undefined, source.sessionName),
        el('span', 'hint', formatDate(source.sessionDate))
      )
      const open = button('Open session', 'secondary')
      open.addEventListener('click', () => {
        void deps.host?.select(source.sessionId)
      })
      head.append(open)
      row.append(head)
      if (!verified) row.append(el('p', 'hint', source.reason ? REASON_TEXT[source.reason] : 'This session could not be verified. This session adds no claims.'))
      return row
    }

    function renderItem(item: BriefingItem) {
      const row = el('li', 'session-briefing-item')
      row.append(el('p', undefined, item.text))

      const source = el('p', 'hint')
      source.append(`${item.source.sessionName} · ${formatDate(item.source.sessionDate)} · `, el('span', 'session-badge', 'Verified'))
      row.append(source)

      if (item.kind === 'commitment') {
        const owner = item.owner?.trim() || 'Owner not stated'
        const due = item.due?.trim() || item.dueText?.trim() || 'No deadline'
        row.append(el('p', 'hint', `Owner: ${owner} · Deadline: ${due}${item.conditional ? ' · Conditional' : ''}`))
      }

      if (item.citations.length) {
        const chips = el('div', 'session-briefing-citations session-citations')
        for (const citation of item.citations) {
          const chip = button(citationLabel(citation), 'session-citation')
          chip.title = citation.quote
          chip.addEventListener('click', () => {
            void deps.host?.select(item.source.sessionId)
          })
          chips.append(chip)
        }
        row.append(chips)
      }
      return row
    }

    function renderBriefing(briefing: Briefing) {
      result.replaceChildren()
      const verified = briefing.sources.filter((source) => source.verification === 'verified').length
      const head = el('div', 'session-section-head')
      head.append(el('h4', undefined, `Briefing · ${formatDate(briefing.generatedAt)}`))
      result.append(head, el('p', 'hint', `${verified} of ${briefing.sources.length} sources verified.`))

      const sources = el('ul')
      for (const source of briefing.sources) sources.append(renderSource(source))
      result.append(el('h5', undefined, 'Sources'), sources)

      if (!briefing.items.length) {
        result.append(el('p', 'hint', 'No verified claims in the selected sessions.'))
        return
      }
      for (const group of GROUPS) {
        const items = briefing.items.filter((item) => item.kind === group.kind)
        if (!items.length) continue
        const list = el('ul')
        for (const item of items) list.append(renderItem(item))
        result.append(el('h5', undefined, group.title), list)
      }
    }

    async function buildBriefing() {
      if (!sessions.length || !selected.size) {
        deps.host?.error('Select at least one session.')
        return
      }
      const sessionIds = sessions.filter((session) => selected.has(session.id)).map((session) => session.id)
      controller?.abort()
      const abort = new AbortController()
      controller = abort
      const current = ++token
      busy = true
      syncSelection()
      status.textContent = 'Building briefing…'
      result.replaceChildren()
      try {
        const response = await deps.client.createBriefing({ sessionIds }, { signal: abort.signal })
        if (current !== token || abort.signal.aborted) return
        status.textContent = ''
        renderBriefing(response.briefing)
      } catch (error) {
        if (current !== token || abort.signal.aborted) return
        status.textContent = ''
        deps.host?.error(describeError(error))
      } finally {
        if (current === token) {
          controller = null
          busy = false
          syncSelection()
        }
      }
    }

    async function loadSessions() {
      try {
        const { sessions: list } = await deps.client.list(50)
        renderSessions(list)
      } catch (error) {
        sessions = []
        options = []
        sessionsBlock.replaceChildren(el('legend', undefined, 'Stored sessions'))
        build.disabled = true
        deps.host?.error(describeError(error))
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void buildBriefing()
    })

    syncSelection()
    const unsubscribe = deps.host?.onSessions?.((list) => renderSessions(list))
    if (!unsubscribe) void loadSessions()
  }
}
