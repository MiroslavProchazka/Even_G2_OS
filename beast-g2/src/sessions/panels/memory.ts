import type { MemoryItem, MemoryKind, MemoryStatus, Session, SessionTurn } from '../../session-api'
import type { SessionsDeps } from '../../sessions'
import { describeError, formatClock, formatDate } from '../../sessions-view'
import { button, el } from './dom'

const KIND_OPTIONS: Array<{ kind: MemoryKind; label: string }> = [
  { kind: 'decision', label: 'Decision' },
  { kind: 'commitment', label: 'Commitment' },
  { kind: 'fact', label: 'Fact' },
  { kind: 'preference', label: 'Preference' },
  { kind: 'open_question', label: 'Open question' }
]

const KIND_LABELS: Record<MemoryKind, string> = Object.fromEntries(KIND_OPTIONS.map((option) => [option.kind, option.label])) as Record<MemoryKind, string>

const STATUS_LABELS: Record<MemoryStatus, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Superseded'
}

function shorten(text: string, limit: number) {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean
}

/**
 * Memory for one stored session. The panel is explicit retrieval only: a user proposes a claim from an exact transcript
 * turn, then approves, rejects or replaces it. Nothing is injected into a conversation or a hint automatically.
 *
 * The session picker follows the host's session list when `onSessions` exists and falls back to `client.list` otherwise.
 * Memory and the session detail load in parallel, because the proposal form needs the detail's turns and revisions while
 * the list needs only the memory items.
 */
export const memoryPanel = {
  id: 'memory',
  mount(section: HTMLElement, deps: SessionsDeps) {
    const wrapper = el('div', 'sessions-memory')
    wrapper.append(el('h3', undefined, 'Memory for a session'))

    const sessionLabel = el('label', undefined, 'Session')
    const sessionSelect = el('select')
    sessionSelect.name = 'session'
    sessionSelect.setAttribute('aria-label', 'Session to review memory for')
    sessionLabel.append(sessionSelect)

    const form = el('form', 'sessions-memory-form')
    const turnLabel = el('label', undefined, 'Source turn')
    const turnSelect = el('select')
    turnSelect.name = 'turn'
    turnSelect.setAttribute('aria-label', 'Transcript turn the claim comes from')
    turnLabel.append(turnSelect)

    const kindLabel = el('label', undefined, 'Kind')
    const kindSelect = el('select')
    kindSelect.name = 'kind'
    for (const option of KIND_OPTIONS) {
      const element = el('option', undefined, option.label)
      element.value = option.kind
      kindSelect.append(element)
    }
    kindSelect.value = 'decision'
    kindLabel.append(kindSelect)

    const claimLabel = el('label', undefined, 'Claim')
    const claim = el('input')
    claim.type = 'text'
    claim.name = 'text'
    claim.maxLength = 500
    claim.placeholder = 'What should be remembered?'
    claim.setAttribute('aria-label', 'Memory claim')
    claimLabel.append(claim)

    const propose = button('Propose memory', '', 'submit')
    form.append(turnLabel, kindLabel, claimLabel, propose)

    const status = el('p', 'hint sessions-memory-status')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const emptyState = el('p', 'hint sessions-memory-empty', 'No memory items for this session yet.')
    const list = el('ul', 'sessions-memory-list')

    wrapper.append(
      el('p', 'hint', 'Memory items stay proposals until you approve them. This panel is explicit retrieval only: nothing is added to a conversation or a hint automatically.'),
      sessionLabel,
      status,
      form,
      emptyState,
      list
    )
    section.append(wrapper)

    let currentSessionId: string | null = null
    let turns: SessionTurn[] = []
    let items: MemoryItem[] = []
    let replacingId: string | null = null
    let busy = false
    let token = 0

    function setBusy(value: boolean) {
      busy = value
      const ready = !value && currentSessionId !== null && turns.length > 0
      claim.disabled = !ready
      kindSelect.disabled = !ready
      turnSelect.disabled = !ready
      propose.disabled = !ready
    }

    function clearEmptyState() {
      emptyState.hidden = true
      emptyState.textContent = ''
    }

    function showEmptyState(text: string) {
      emptyState.hidden = false
      emptyState.textContent = text
    }

    function renderTurns() {
      turnSelect.replaceChildren()
      for (const turn of turns) {
        const option = el('option', undefined, `[${formatClock(turn.startMs)}] ${shorten(turn.text, 60)}`)
        option.value = turn.id
        turnSelect.append(option)
      }
      if (!turns.length) {
        const option = el('option', undefined, 'No transcript turns yet')
        option.value = ''
        turnSelect.append(option)
        turnSelect.value = ''
      } else {
        turnSelect.value = turns[0]!.id
      }
      turnSelect.disabled = busy || !currentSessionId || !turns.length
    }

    function renderItems() {
      list.replaceChildren()
      if (!items.length) {
        showEmptyState('No memory items for this session yet.')
        return
      }
      clearEmptyState()
      for (const item of items) list.append(renderItem(item))
    }

    function renderReplacement(item: MemoryItem) {
      const replacement = el('form', 'sessions-memory-replacement')
      const label = el('label', undefined, 'Replacement claim')
      const input = el('input')
      input.type = 'text'
      input.name = 'replacement'
      input.maxLength = 500
      input.value = item.text
      input.setAttribute('aria-label', 'Replacement claim')
      label.append(input)
      const save = button('Save replacement', '', 'submit')
      const cancel = button('Cancel', 'secondary')
      cancel.addEventListener('click', () => {
        replacingId = null
        renderItems()
      })
      replacement.append(label, save, cancel)
      replacement.addEventListener('submit', (event) => {
        event.preventDefault()
        void replace(item, input)
      })
      return replacement
    }

    function renderItem(item: MemoryItem) {
      const row = el('li', 'sessions-memory-item')
      const head = el('div', 'session-section-head')
      head.append(el('span', `session-badge memory-status memory-status-${item.status}`, STATUS_LABELS[item.status]), el('span', 'memory-kind', KIND_LABELS[item.kind]))
      row.append(head, el('p', 'memory-claim', item.text))
      if (item.sourceQuote) row.append(el('p', 'memory-quote', shorten(item.sourceQuote, 140)))

      const sourceLost = item.sourceDeleted || item.evidenceState === 'lost'
      const source = button('Open source', 'secondary memory-source')
      source.disabled = sourceLost
      if (sourceLost) row.append(el('p', 'memory-source-lost', 'Source deleted · evidence lost'))
      else
        source.addEventListener('click', () => {
          void deps.host?.select(item.sessionId)
        })
      row.append(source)

      const actions = el('div', 'actions memory-actions')
      if (item.status === 'proposed') {
        const approve = button('Approve', 'memory-approve')
        approve.addEventListener('click', () => {
          void setStatus(item, 'approved')
        })
        const reject = button('Reject', 'secondary memory-reject')
        reject.addEventListener('click', () => {
          void setStatus(item, 'rejected')
        })
        actions.append(approve, reject)
      }
      if ((item.status === 'proposed' || item.status === 'approved') && replacingId !== item.id) {
        const replaceButton = button('Replace', 'secondary memory-replace')
        replaceButton.addEventListener('click', () => {
          replacingId = item.id
          renderItems()
        })
        actions.append(replaceButton)
      }
      row.append(actions)
      if (replacingId === item.id) row.append(renderReplacement(item))
      return row
    }

    async function reloadItems() {
      const id = currentSessionId
      if (!id) return
      const response = await deps.client.memoryForSession(id, { status: 'all' })
      if (currentSessionId !== id) return
      items = response.items
      renderItems()
    }

    async function perform(task: () => Promise<unknown>) {
      if (busy) return
      setBusy(true)
      try {
        await task()
        await reloadItems()
      } catch (error) {
        deps.host?.error(describeError(error))
      } finally {
        setBusy(false)
      }
    }

    async function setStatus(item: MemoryItem, next: 'approved' | 'rejected') {
      await perform(() => deps.client.setMemoryStatus(item.sessionId, item.id, next))
    }

    async function replace(item: MemoryItem, input: HTMLInputElement) {
      const text = input.value.trim()
      if (!text) {
        deps.host?.error('Enter a replacement claim.')
        input.focus()
        return
      }
      await perform(async () => {
        await deps.client.supersedeMemory(item.sessionId, item.id, { text })
        replacingId = null
      })
    }

    async function proposeClaim() {
      const sessionId = currentSessionId
      if (!sessionId) {
        deps.host?.error('Select a session first.')
        return
      }
      const turn = turns.find((item) => item.id === turnSelect.value)
      if (!turn) {
        deps.host?.error('Select a transcript turn for the claim.')
        return
      }
      const text = claim.value.trim()
      if (!text) {
        deps.host?.error('Enter a claim to remember.')
        claim.focus()
        return
      }
      const kind = (kindSelect.value || 'decision') as MemoryKind
      await perform(async () => {
        await deps.client.proposeMemory(sessionId, { turnId: turn.id, revision: turn.revision, kind, text })
        claim.value = ''
      })
    }

    async function loadSession(id: string) {
      if (!id) return
      const current = ++token
      currentSessionId = id
      turns = []
      items = []
      replacingId = null
      claim.value = ''
      turnSelect.replaceChildren()
      list.replaceChildren()
      clearEmptyState()
      status.textContent = 'Loading memory…'
      setBusy(true)
      try {
        const [memory, detail] = await Promise.all([deps.client.memoryForSession(id, { status: 'all' }), deps.client.detail(id)])
        if (current !== token) return
        turns = [...detail.turns].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
        items = memory.items
        renderTurns()
        renderItems()
        status.textContent = ''
      } catch (error) {
        if (current !== token) return
        status.textContent = ''
        list.replaceChildren()
        showEmptyState('Memory could not be loaded. Refresh to try again.')
        deps.host?.error(describeError(error))
      } finally {
        if (current === token) setBusy(false)
      }
    }

    function renderSessions(sessions: Session[]) {
      const previous = sessionSelect.value || currentSessionId || ''
      sessionSelect.replaceChildren()
      for (const session of sessions) {
        const option = el('option', undefined, `${session.name} · ${formatDate(session.startedAt ?? session.createdAt)}`)
        option.value = session.id
        sessionSelect.append(option)
      }
      if (!sessions.length) {
        sessionSelect.disabled = true
        sessionSelect.value = ''
        token++
        currentSessionId = null
        turns = []
        items = []
        turnSelect.replaceChildren()
        list.replaceChildren()
        status.textContent = ''
        showEmptyState('No stored sessions yet.')
        setBusy(false)
        return
      }
      sessionSelect.disabled = false
      const next = sessions.some((session) => session.id === previous) ? previous : sessions[0]!.id
      sessionSelect.value = next
      if (next !== currentSessionId) void loadSession(next)
      else setBusy(busy)
    }

    async function loadSessions() {
      try {
        const { sessions } = await deps.client.list(50)
        renderSessions(sessions)
      } catch (error) {
        sessionSelect.disabled = true
        deps.host?.error(describeError(error))
      }
    }

    sessionSelect.addEventListener('change', () => {
      void loadSession(sessionSelect.value)
    })

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void proposeClaim()
    })

    setBusy(false)
    const unsubscribe = deps.host?.onSessions?.((sessions) => renderSessions(sessions))
    if (!unsubscribe) void loadSessions()
  }
}
