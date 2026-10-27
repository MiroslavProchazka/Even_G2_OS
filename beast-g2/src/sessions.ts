import { diagnostics } from './diagnostics'
import { SessionApiError } from './session-api'
import type { Session, SessionClient, SessionDetail, SessionLanguage, SessionSummary, SummaryActionCandidate, SummaryCitation, SummaryContent, SummaryItem } from './session-api'
import { mountSessionPanels } from './sessions/panels'
import { button, el } from './sessions/panels/dom'
import {
  citationLabel,
  coverageLabel,
  deadlineLabel,
  describeError,
  formatClock,
  formatDate,
  formatDuration,
  gapLabel,
  glassesStatus,
  jobCounts,
  languageLabel,
  latestSummary,
  pollDelay,
  RecorderError,
  sessionDurationMs,
  sessionStatusLabel,
  sortSessions,
  sourceLabel,
  summaryBadge
} from './sessions-view'

export type SessionRecorder = {
  open(input: { name: string; language: SessionLanguage; goal?: string; prep?: string }): Promise<string>
  attach(id: string): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  end(): Promise<void>
}

/** The values a panel collects before the host creates a session. */
export type NewSessionInput = { name: string; language: SessionLanguage; goal: string; prep: string }

/**
 * The handle `initSessions` gives every registered panel. The host owns busy state, the status and error lines, the list
 * and the selection, so panels never reach into each other.
 */
export type SessionPanelHost = {
  /** Registers a control so the host disables it while a session action runs. */
  gate<T extends HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(target: T, enabled: () => boolean): T
  /** Shows a validation message in the section alert line. */
  error(text: string): void
  /** Creates a session (or starts recording) and selects it. Resolves true when the session exists. */
  create(input: NewSessionInput): Promise<boolean>
  /** Selects an existing session and loads its detail, so a panel can open a search or memory hit. */
  select(id: string): Promise<void>
}

export type SessionsDeps = {
  client: SessionClient
  writerId: string
  now?: () => number
  recorder?: SessionRecorder
  canConnect?: () => boolean
  onGlassesStatus?: (text: string) => void
  /** Supplied by `initSessions` for registered panels; callers of `initSessions` never set it. */
  host?: SessionPanelHost
}

export type SessionsHandle = { refresh(): Promise<void>; dispose(): void }

type GatedElement = HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
type Gated = { el: GatedElement; enabled: () => boolean }
type ItemEditRow = { kind: 'item'; section: 'decisions' | 'openQuestions'; original: SummaryItem; text: HTMLTextAreaElement; remove: HTMLInputElement }
type ActionEditRow = { kind: 'action'; original: SummaryActionCandidate; text: HTMLTextAreaElement; owner: HTMLInputElement; dueText: HTMLInputElement; remove: HTMLInputElement }
type EditRow = ItemEditRow | ActionEditRow

function humanize(value: string | null | undefined) {
  return value ? value.replaceAll('_', ' ') : 'unknown reason'
}

export function initSessions(deps: SessionsDeps): SessionsHandle {
  const now = deps.now ?? (() => Date.now())
  const main = document.querySelector<HTMLElement>('main')
  if (!main) throw new Error('Stored sessions need a <main> element.')

  let sessions: Session[] = []
  let selectedId: string | null = null
  let detail: SessionDetail | null = null
  let detailFailed = false
  let busy = false
  let disposed = false
  let editing: { summaryId: string } | null = null
  let summaryNotice: { text: string; label: string } | null = null
  let partialAllowed = false
  let lastGlasses = ''
  let listToken = 0
  let detailToken = 0
  let pollSequence = 0
  let poll: { token: number; sessionId: string; startedAt: number } | null = null
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  let highlightedTurn: HTMLElement | null = null
  let summarySection: HTMLElement | null = null
  let preparationSection: HTMLElement | null = null
  let listGated: Gated[] = []
  let detailGated: Gated[] = []
  let summaryGated: Gated[] = []
  let preparationGated: Gated[] = []
  const persistentGated: Gated[] = []
  const revokeTimers = new Set<ReturnType<typeof setTimeout>>()
  const turnElements = new Map<string, HTMLElement>()

  const section = el('section', 'sessions')
  section.setAttribute('aria-label', 'Stored sessions')
  const statusLine = el('p', 'sessions-status')
  statusLine.setAttribute('role', 'status')
  statusLine.setAttribute('aria-live', 'polite')
  const errorLine = el('p', 'sessions-error')
  errorLine.setAttribute('role', 'alert')
  const list = el('ul', 'sessions-list')
  const countLine = el('p', 'hint')
  const emptyState = el('p', 'sessions-empty', 'No stored sessions yet. Create one below, or import audio with npm run session:import.')
  const detailPane = el('div', 'session-detail')

  const listPane = el('div', 'sessions-list-pane')
  listPane.append(el('h3', undefined, 'Recent sessions'))
  const listActions = el('div', 'actions')
  const refreshButton = button('Refresh', 'secondary')
  refreshButton.addEventListener('click', () => {
    void refresh()
  })
  listActions.append(refreshButton)
  listPane.append(listActions, countLine, emptyState, list)

  const columns = el('div', 'sessions-columns')
  columns.append(listPane, detailPane)

  const panelSection = el('div', 'sessions-panels')

  section.append(el('p', 'eyebrow', 'STORED SESSIONS'), el('h2', undefined, 'Conversations'))
  section.append(
    el(
      'p',
      'hint',
      'Stored sessions keep the final transcript, known coverage gaps and traceable summaries on your gateway. Nothing is recorded until you start a session, and a summary never replaces the transcript.'
    )
  )
  section.append(statusLine, errorLine, columns, panelSection)
  main.append(section)

  const panelHost: SessionPanelHost = {
    gate: (target, enabled) => gate(target, enabled, persistentGated),
    error: (text) => showErrorText(text),
    create: (input) => createSession(input),
    select: (id) => selectSession(id)
  }
  mountSessionPanels(panelSection, { ...deps, host: panelHost })

  function gate<T extends GatedElement>(target: T, enabled: () => boolean, group: Gated[]): T {
    group.push({ el: target, enabled })
    target.disabled = busy || !enabled()
    return target
  }

  function applyGated() {
    for (const group of [persistentGated, listGated, detailGated, summaryGated, preparationGated]) {
      for (const entry of group) entry.el.disabled = busy || !entry.enabled()
    }
  }

  function showStatus(text: string) {
    statusLine.textContent = text
  }

  function showError(error: unknown) {
    errorLine.textContent = describeError(error)
  }

  function showErrorText(text: string) {
    errorLine.textContent = text
  }

  function emitGlasses(text: string) {
    try {
      deps.onGlassesStatus?.(text)
    } catch {
      /* An optional glasses display must not break the phone UI. */
    }
  }

  function renderStatus() {
    const selected = detail?.session ?? sessions.find((session) => session.id === selectedId) ?? null
    const position = selected ? Math.max(1, sessions.findIndex((session) => session.id === selected.id) + 1) : 0
    const text = glassesStatus(selected, position, busy)
    if (text === lastGlasses) return
    lastGlasses = text
    emitGlasses(text)
  }

  function setBusy(value: boolean) {
    busy = value
    applyGated()
    renderStatus()
  }

  async function run(task: () => Promise<void>) {
    if (busy || disposed) return
    setBusy(true)
    errorLine.textContent = ''
    try {
      await task()
    } catch (error) {
      if (!disposed) {
        showError(error)
        // A failed recording still created the session on the gateway; show it so it can be ended or deleted.
        if (error instanceof RecorderError) await loadList()
      }
    } finally {
      if (disposed) busy = false
      else setBusy(false)
    }
  }

  /**
   * Recorder failures come from the phone, not the gateway, so their own message is shown. Gateway failures keep the
   * code-based wording and never leak a stack trace.
   */
  async function record<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (error instanceof SessionApiError) throw error
      throw new RecorderError(error instanceof Error ? error.message : String(error))
    }
  }

  function renderList() {
    listGated = []
    list.replaceChildren()
    emptyState.hidden = sessions.length > 0
    countLine.textContent = sessions.length ? `${sessions.length} stored session${sessions.length === 1 ? '' : 's'}` : 'No stored sessions'
    for (const session of sessions) {
      const item = el('li')
      const row = gate(button('', 'session-row'), () => true, listGated)
      if (session.id === selectedId) {
        row.classList.add('session-row-selected')
        row.setAttribute('aria-current', 'true')
      }
      row.append(el('span', 'session-row-name', session.name))
      const meta = [
        formatDate(session.startedAt ?? session.createdAt),
        formatDuration(sessionDurationMs(session, now())),
        sessionStatusLabel(session.status, session.captureState),
        coverageLabel(session.coverageDeclared),
        sourceLabel(session.source)
      ]
      row.append(el('span', 'session-row-meta', meta.join(' · ')))
      row.addEventListener('click', () => {
        void selectSession(session.id)
      })
      item.append(row)
      list.append(item)
    }
    applyGated()
  }

  function renderDetail() {
    detailGated = []
    summaryGated = []
    preparationGated = []
    summarySection = null
    preparationSection = null
    turnElements.clear()
    detailPane.replaceChildren()
    if (!selectedId) {
      detailPane.append(el('p', 'sessions-placeholder', 'Select a session to see its transcript, coverage gaps and summary.'))
      applyGated()
      return
    }
    if (!detail) {
      detailPane.append(el('p', 'sessions-placeholder', detailFailed ? 'Session detail could not be loaded. Refresh to try again.' : 'Loading session…'))
      applyGated()
      return
    }

    const session = detail.session
    const head = el('div', 'session-detail-head')
    const titleRow = el('div', 'session-detail-title')
    titleRow.append(el('h3', undefined, session.name), el('span', `session-badge session-badge-${session.status}`, sessionStatusLabel(session.status, session.captureState)))
    head.append(titleRow)
    const meta = [
      formatDate(session.startedAt ?? session.createdAt),
      `Duration ${formatDuration(sessionDurationMs(session, now()))}`,
      sourceLabel(session.source),
      languageLabel(session.language),
      coverageLabel(session.coverageDeclared)
    ]
    head.append(el('p', 'session-meta', meta.join(' · ')))
    head.append(el('p', 'session-meta', [`Created ${formatDate(session.createdAt)}`, `Expires ${formatDate(session.expiresAt)}`, `Transcript revision ${session.transcriptRevision}`].join(' · ')))
    if (session.endReason) head.append(el('p', 'session-meta', `End reason: ${session.endReason.replaceAll('_', ' ')}`))
    if (session.goal) head.append(el('p', 'session-note', `Goal: ${session.goal}`))
    if (session.prep) head.append(el('p', 'session-note', `Preparation notes: ${session.prep}`))
    detailPane.append(head)

    const actions = el('div', 'actions')
    const start = gate(button('Start'), () => session.status === 'draft', detailGated)
    start.addEventListener('click', () => {
      void act('start')
    })
    const pause = gate(button('Pause', 'secondary'), () => session.status === 'active', detailGated)
    pause.addEventListener('click', () => {
      void act('pause')
    })
    const resume = gate(button('Resume', 'secondary'), () => session.status === 'paused', detailGated)
    resume.addEventListener('click', () => {
      void act('resume')
    })
    const end = gate(button('End', 'secondary'), () => session.status === 'active' || session.status === 'paused', detailGated)
    end.addEventListener('click', () => {
      void act('end')
    })
    const exportButton = gate(button('Export Markdown', 'secondary'), () => true, detailGated)
    exportButton.addEventListener('click', () => {
      void exportMarkdown()
    })
    const deleteButton = gate(button('Delete', 'secondary'), () => true, detailGated)
    deleteButton.addEventListener('click', () => {
      void removeSession()
    })
    const reload = gate(button('Refresh session', 'secondary'), () => true, detailGated)
    reload.addEventListener('click', () => {
      void refresh()
    })
    actions.append(start, pause, resume, end, exportButton, deleteButton, reload)
    detailPane.append(actions)

    const transcript = el('section', 'session-transcript')
    transcript.append(el('h4', undefined, 'Transcript'))
    if (!detail.turns.length) transcript.append(el('p', 'hint', 'No final transcript yet. Transcription jobs appear below.'))
    else {
      const turns = el('ol', 'session-turns')
      for (const turn of [...detail.turns].sort((a, b) => a.startMs - b.startMs)) {
        const item = el('li', 'session-turn')
        item.setAttribute('data-turn-id', turn.id)
        item.append(el('span', 'session-turn-time', `[${formatClock(turn.startMs)}]`), el('span', 'session-turn-text', turn.text))
        if (turn.source === 'manual') item.append(el('span', 'session-turn-origin', 'edited'))
        turns.append(item)
        turnElements.set(turn.id, item)
      }
      transcript.append(turns)
    }
    detailPane.append(transcript)

    const gaps = el('section', 'session-gaps')
    gaps.append(el('h4', undefined, 'Coverage gaps'))
    if (!detail.gaps.length) gaps.append(el('p', 'hint', 'No known coverage gaps.'))
    else {
      const gapList = el('ul', 'session-gap-list')
      for (const gap of detail.gaps) gapList.append(el('li', 'session-gap', `${gapLabel(gap)} · ${gap.state}`))
      gaps.append(gapList)
    }
    detailPane.append(gaps)

    summarySection = el('section', 'session-summary')
    detailPane.append(summarySection)
    renderSummary()

    preparationSection = el('section', 'session-preparation')
    detailPane.append(preparationSection)
    renderPreparation()

    const jobs = el('section', 'session-jobs')
    const counts = jobCounts(detail.jobs)
    jobs.append(el('h4', undefined, 'Transcription jobs'))
    jobs.append(el('p', undefined, `${counts.pending} pending · ${counts.failed} failed · ${counts.done} done`))
    if (counts.failed) jobs.append(el('p', 'session-warning', 'Some segments failed transcription. Check the coverage gaps.'))
    if (session.status === 'ended' && counts.pending) jobs.append(el('p', 'hint', 'Session ended; transcript still finishing.'))
    detailPane.append(jobs)
    applyGated()
  }

  function summaryStatusText(summary: SessionSummary) {
    if (summary.status === 'pending') return 'Summary is generating.'
    if (summary.status === 'failed') return 'Summary generation failed.'
    if (summary.status === 'stale') return 'Summary is stale and may not match the current transcript.'
    return `Summary ready ${formatDate(summary.readyAt ?? summary.createdAt)} · transcript revision ${summary.transcriptRevision}`
  }

  function summaryBadgeClass(summary: SessionSummary | null) {
    return `session-badge-${summary?.status ?? 'none'}`
  }

  function citationChips(ids: string[] | undefined, citations: Map<string, SummaryCitation>, interactive: boolean): HTMLElement | null {
    if (!ids?.length) return null
    const wrapper = el('div', 'session-citations')
    for (const turnId of ids) {
      const citation = citations.get(turnId)
      const label = citation ? citationLabel(citation) : '[citation unavailable]'
      if (!interactive) {
        wrapper.append(el('span', 'session-citation session-citation-static', label))
        continue
      }
      const chip = button(label, 'session-citation')
      chip.addEventListener('click', () => focusTurn(turnId))
      wrapper.append(chip)
    }
    return wrapper
  }

  function focusTurn(turnId: string) {
    if (disposed) return
    const turn = turnElements.get(turnId)
    if (!turn) {
      showStatus('The cited turn is not in this transcript. It may belong to an older revision.')
      return
    }
    if (highlightTimer !== undefined) clearTimeout(highlightTimer)
    if (highlightedTurn && highlightedTurn !== turn) highlightedTurn.classList.remove('session-turn-cited')
    highlightedTurn = turn
    turn.classList.add('session-turn-cited')
    if (typeof turn.scrollIntoView === 'function') turn.scrollIntoView({ block: 'center', behavior: 'smooth' })
    highlightTimer = setTimeout(() => {
      turn.classList.remove('session-turn-cited')
      highlightedTurn = null
      highlightTimer = undefined
    }, 2600)
  }

  function renderSummaryContent(content: Partial<SummaryContent>, citations: SummaryCitation[], interactive: boolean): HTMLElement {
    const wrapper = el('div', 'session-summary-content')
    const citationMap = new Map(citations.map((citation) => [citation.turnId, citation]))
    if (content.overview?.text) {
      wrapper.append(el('p', 'session-summary-overview', content.overview.text))
      const overviewChips = citationChips(content.overview.citations, citationMap, interactive)
      if (overviewChips) wrapper.append(overviewChips)
    }
    if (content.decisions?.length) {
      wrapper.append(el('h5', undefined, 'Decisions'))
      const listElement = el('ul', 'session-summary-list')
      for (const item of content.decisions) {
        const row = el('li', 'session-summary-item')
        row.append(el('p', undefined, item.text))
        const chips = citationChips(item.citations, citationMap, interactive)
        if (chips) row.append(chips)
        listElement.append(row)
      }
      wrapper.append(listElement)
    }
    const actions = content.actionCandidates ?? []
    if (actions.length) {
      wrapper.append(el('h5', undefined, 'Action candidates'))
      const listElement = el('ul', 'session-summary-list')
      for (const candidate of actions) {
        const row = el('li', 'session-summary-item')
        row.append(el('p', undefined, candidate.text))
        row.append(el('p', 'session-action-meta', `Owner: ${candidate.owner?.trim() || 'unassigned'} · Due: ${deadlineLabel(candidate)}${candidate.conditional ? ' · conditional' : ''}`))
        const chips = citationChips(candidate.citations, citationMap, interactive)
        if (chips) row.append(chips)
        listElement.append(row)
      }
      wrapper.append(listElement)
    }
    if (content.openQuestions?.length) {
      wrapper.append(el('h5', undefined, 'Open questions'))
      const listElement = el('ul', 'session-summary-list')
      for (const item of content.openQuestions) {
        const row = el('li', 'session-summary-item')
        row.append(el('p', undefined, item.text))
        const chips = citationChips(item.citations, citationMap, interactive)
        if (chips) row.append(chips)
        listElement.append(row)
      }
      wrapper.append(listElement)
    }
    if (!content.overview?.text && !content.decisions?.length && !actions.length && !content.openQuestions?.length) wrapper.append(el('p', 'hint', 'The summary has no content.'))
    return wrapper
  }

  function renderSummary() {
    if (!summarySection) return
    summaryGated = []
    summarySection.replaceChildren()
    const summary = detail ? latestSummary(detail.summaries) : null
    const head = el('div', 'session-section-head')
    head.append(el('h4', undefined, 'Summary'), el('span', `session-badge ${summaryBadgeClass(summary)}`, summaryBadge(summary)))
    summarySection.append(head)

    if (detail && detail.session.status !== 'ended') {
      const label = el('label', 'session-partial')
      const checkbox = el('input')
      checkbox.type = 'checkbox'
      checkbox.checked = partialAllowed
      checkbox.addEventListener('change', () => {
        partialAllowed = checkbox.checked
      })
      label.append(checkbox, 'Allow partial summary (session not ended)')
      gate(checkbox, () => !poll, summaryGated)
      summarySection.append(label)
    }

    if (summary) {
      summarySection.append(el('p', 'session-summary-status', summaryStatusText(summary)))
      if (summary.status === 'pending' || summary.status === 'failed') {
        if (summary.status === 'failed') summarySection.append(el('p', 'session-error-detail', 'Summary generation failed. Request a new summary to retry.'))
      } else {
        summarySection.append(renderSummaryContent({ ...summary.content, actionCandidates: summary.content.actionCandidates ?? summary.actionCandidates }, summary.citations, true))
        if (summary.status === 'stale') summarySection.append(el('p', 'session-stale', `Stale: ${humanize(summary.staleReason)}. Regenerate for a current version.`))
        if (summary.reviewStatus === 'edited') summarySection.append(el('p', 'hint', `Manually edited ${formatDate(summary.editedAt ?? summary.updatedAt)}. Automatic regeneration needs force.`))
      }
    } else summarySection.append(el('p', 'hint', 'No summary yet. Request one after the transcript is ready.'))

    if (poll && detail && poll.sessionId === detail.session.id) {
      const seconds = Math.max(0, Math.floor((now() - poll.startedAt) / 1000))
      summarySection.append(el('p', 'session-poll', `Generating summary · ${seconds}s elapsed · checking every 2 seconds`))
    }

    if (summaryNotice) {
      const notice = el('div', 'session-notice')
      notice.append(el('p', 'session-notice-text', summaryNotice.text))
      const force = gate(button(summaryNotice.label), () => !poll, summaryGated)
      force.addEventListener('click', () => {
        summaryNotice = null
        void requestSummary(true)
      })
      notice.append(force)
      summarySection.append(notice)
    }

    const request = gate(button(summary?.status === 'stale' ? 'Regenerate summary' : 'Request summary'), () => !poll, summaryGated)
    request.addEventListener('click', () => {
      void requestSummary(false)
    })
    summarySection.append(request)

    if (summary?.status === 'ready') {
      const edit = gate(button(editing?.summaryId === summary.id ? 'Close editor' : 'Edit summary', 'secondary'), () => !poll, summaryGated)
      edit.addEventListener('click', () => {
        editing = editing?.summaryId === summary.id ? null : { summaryId: summary.id }
        renderSummary()
      })
      summarySection.append(edit)
    }

    if (editing && summary && editing.summaryId === summary.id) summarySection.append(renderSummaryEdit(summary))
    applyGated()
  }

  function itemEditor(sectionName: 'decisions' | 'openQuestions', item: SummaryItem, index: number, rows: EditRow[]): HTMLElement {
    const fieldset = el('fieldset', 'session-edit-item')
    fieldset.append(el('legend', undefined, `${sectionName === 'decisions' ? 'Decision' : 'Open question'} ${index + 1}`))
    const textLabel = el('label', undefined, 'Text')
    const text = el('textarea')
    text.maxLength = 1000
    text.rows = 2
    text.value = item.text
    textLabel.append(text)
    const removeLabel = el('label', 'session-edit-remove')
    const remove = el('input')
    remove.type = 'checkbox'
    removeLabel.append(remove, 'Remove this item')
    fieldset.append(textLabel, removeLabel)
    gate(text, () => true, summaryGated)
    gate(remove, () => true, summaryGated)
    rows.push({ kind: 'item', section: sectionName, original: item, text, remove })
    return fieldset
  }

  function actionEditor(candidate: SummaryActionCandidate, index: number, rows: EditRow[]): HTMLElement {
    const fieldset = el('fieldset', 'session-edit-item')
    fieldset.append(el('legend', undefined, `Action candidate ${index + 1}`))
    const textLabel = el('label', undefined, 'Text')
    const text = el('textarea')
    text.maxLength = 1000
    text.rows = 2
    text.value = candidate.text
    textLabel.append(text)
    const ownerLabel = el('label', undefined, 'Owner')
    const owner = el('input')
    owner.maxLength = 100
    owner.value = candidate.owner ?? ''
    owner.placeholder = 'unassigned'
    ownerLabel.append(owner)
    const dueLabel = el('label', undefined, 'Deadline wording')
    const dueText = el('input')
    dueText.maxLength = 200
    dueText.value = candidate.dueText ?? ''
    dueText.placeholder = 'next week'
    dueLabel.append(dueText)
    const removeLabel = el('label', 'session-edit-remove')
    const remove = el('input')
    remove.type = 'checkbox'
    removeLabel.append(remove, 'Remove this item')
    fieldset.append(textLabel, ownerLabel, dueLabel)
    if (candidate.due) fieldset.append(el('p', 'hint', `Normalized deadline: ${candidate.due}`))
    if (candidate.conditional) fieldset.append(el('p', 'hint', 'Conditional proposal. Keep the wording explicit.'))
    fieldset.append(removeLabel)
    gate(text, () => true, summaryGated)
    gate(owner, () => true, summaryGated)
    gate(dueText, () => true, summaryGated)
    gate(remove, () => true, summaryGated)
    rows.push({ kind: 'action', original: candidate, text, owner, dueText, remove })
    return fieldset
  }

  function renderSummaryEdit(summary: SessionSummary): HTMLElement {
    const form = el('form', 'session-summary-edit')
    const rows: EditRow[] = []
    const overviewLabel = el('label', undefined, 'Overview')
    const overview = el('textarea')
    overview.maxLength = 4000
    overview.rows = 3
    overview.value = summary.content.overview?.text ?? ''
    overviewLabel.append(overview)
    gate(overview, () => true, summaryGated)
    form.append(overviewLabel)
    for (const [index, item] of (summary.content.decisions ?? []).entries()) form.append(itemEditor('decisions', item, index, rows))
    for (const [index, candidate] of (summary.content.actionCandidates ?? summary.actionCandidates ?? []).entries()) form.append(actionEditor(candidate, index, rows))
    for (const [index, item] of (summary.content.openQuestions ?? []).entries()) form.append(itemEditor('openQuestions', item, index, rows))
    form.append(el('p', 'hint', 'Removing an item is allowed. Adding items is not, because every new item would need its own citation.'))
    const save = gate(button('Save changes', '', 'submit'), () => true, summaryGated)
    const cancel = gate(button('Cancel', 'secondary'), () => true, summaryGated)
    cancel.addEventListener('click', () => {
      editing = null
      renderSummary()
    })
    form.append(save, cancel)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void saveSummary(summary, overview, rows)
    })
    return form
  }

  function renderPreparation() {
    if (!preparationSection || !detail) return
    preparationGated = []
    preparationSection.replaceChildren()
    preparationSection.append(el('h4', undefined, 'Preparation for this session'))
    const preparation = detail.preparation
    if (preparation) {
      const head = el('div', 'session-section-head')
      const source = preparation.content.source
      head.append(el('p', 'session-meta', `${source?.sessionName || 'Unknown source session'} · ${formatDate(source?.sessionDate)}`))
      head.append(el('span', preparation.status === 'stale' ? 'session-badge session-badge-stale' : 'session-badge', preparation.status === 'stale' ? 'Stale' : 'Ready'))
      preparationSection.append(head)
      preparationSection.append(el('p', 'session-preparation-focus', `Focus: ${preparation.content.focus || preparation.focus || 'No focus set'}`))
      if (preparation.status === 'stale') preparationSection.append(el('p', 'session-stale', `This preparation is stale: ${humanize(preparation.staleReason)}. It stays a snapshot.`))
      preparationSection.append(renderSummaryContent(preparation.content.summary, preparation.content.citations, false))
      const citations = preparation.content.citations ?? []
      if (citations.length) {
        preparationSection.append(el('h5', undefined, 'Source passages'))
        const citationList = el('ul', 'session-preparation-citations')
        for (const citation of citations) citationList.append(el('li', undefined, `${citationLabel(citation)} · ${formatDate(citation.date)}`))
        preparationSection.append(citationList)
      }
    } else {
      preparationSection.append(el('p', 'hint', 'No preparation yet. Select a ready summary to snapshot it for the next conversation.'))
    }

    const ready = detail.summaries.filter((summary) => summary.status === 'ready')
    if (!ready.length) {
      preparationSection.append(el('p', 'hint', 'A ready summary is required before you can create a preparation.'))
      applyGated()
      return
    }
    const form = el('form', 'session-preparation-form')
    const sourceLabelElement = el('label', undefined, 'Source summary')
    const source = el('select')
    for (const summary of ready) {
      const option = el('option', undefined, `${formatDate(summary.createdAt)} · revision ${summary.transcriptRevision}`)
      option.value = summary.id
      source.append(option)
    }
    sourceLabelElement.append(source)
    const focusLabel = el('label', undefined, 'Focus for the next conversation (optional)')
    const focus = el('textarea')
    focus.maxLength = 4000
    focus.rows = 2
    focus.placeholder = 'What should the next conversation build on?'
    focusLabel.append(focus)
    gate(source, () => true, preparationGated)
    gate(focus, () => true, preparationGated)
    const submit = gate(button('Use as preparation', '', 'submit'), () => true, preparationGated)
    form.append(sourceLabelElement, focusLabel, submit)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void createPreparation(source, focus)
    })
    preparationSection.append(form)
    applyGated()
  }

  async function loadList() {
    const token = ++listToken
    try {
      const result = await deps.client.list(50)
      if (disposed || token !== listToken) return
      sessions = sortSessions(result.sessions)
      renderList()
      renderStatus()
    } catch (error) {
      if (disposed || token !== listToken) return
      countLine.textContent = 'Sessions unavailable'
      emptyState.hidden = true
      showError(error)
    }
  }

  async function loadDetail(id: string) {
    const token = ++detailToken
    try {
      const result = await deps.client.detail(id)
      if (disposed || token !== detailToken || selectedId !== id) return
      detail = result
      detailFailed = false
      renderDetail()
      renderStatus()
    } catch (error) {
      if (disposed || token !== detailToken || selectedId !== id) return
      detail = null
      detailFailed = true
      showError(error)
      renderDetail()
      renderStatus()
    }
  }

  async function selectSession(id: string) {
    if (disposed) return
    if (selectedId !== id) {
      cancelPoll()
      editing = null
      summaryNotice = null
      partialAllowed = false
    }
    selectedId = id
    detail = null
    detailFailed = false
    detailToken++
    renderList()
    renderDetail()
    renderStatus()
    await loadDetail(id)
  }

  function clearSelection() {
    cancelPoll()
    selectedId = null
    detail = null
    detailFailed = false
    editing = null
    summaryNotice = null
    partialAllowed = false
    renderList()
    renderDetail()
    renderStatus()
  }

  async function refreshSelected() {
    await loadList()
    if (!selectedId) return
    if (!sessions.some((session) => session.id === selectedId)) {
      clearSelection()
      return
    }
    await loadDetail(selectedId)
  }

  async function refresh() {
    if (disposed) return
    await run(async () => {
      await loadList()
      if (!selectedId) return
      if (!sessions.some((session) => session.id === selectedId)) {
        clearSelection()
        return
      }
      await loadDetail(selectedId)
    })
  }

  async function createSession(values: NewSessionInput): Promise<boolean> {
    if (busy || disposed) return false
    const input = { name: values.name, language: values.language, ...(values.goal ? { goal: values.goal } : {}), ...(values.prep ? { prep: values.prep } : {}) }
    let created = false
    await run(async () => {
      let id: string
      if (deps.recorder) {
        id = await record(() => deps.recorder!.open(input))
        diagnostics.record('session', 'session.created')
        showStatus('Recording started. Pause or end it from the session below.')
      } else {
        const { session } = await deps.client.create({ ...input, source: 'import' })
        id = session.id
        diagnostics.record('session', 'session.created')
        showStatus('Session created. Import audio with npm run session:import, then request a summary.')
      }
      if (!id) throw new Error('The recorder did not return a session.')
      created = true
      await loadList()
      await selectSession(id)
    })
    return created
  }

  async function act(kind: 'start' | 'pause' | 'resume' | 'end') {
    if (!detail || busy || disposed) return
    const session = detail.session
    const recorder = deps.recorder
    await run(async () => {
      if (recorder) {
        if (kind === 'start') {
          await record(() => recorder.attach(session.id))
          diagnostics.record('session', 'session.started')
          showStatus('Recording started for this session.')
          await refreshSelected()
          return
        }
        if (kind === 'pause') await record(() => recorder.pause())
        if (kind === 'resume') await record(() => recorder.resume())
        if (kind === 'end') await record(() => recorder.end())
      } else {
        if (kind === 'start') await deps.client.start(session.id, deps.writerId)
        if (kind === 'pause') await deps.client.pause(session.id, deps.writerId)
        if (kind === 'resume') await deps.client.resume(session.id, deps.writerId)
        if (kind === 'end') await deps.client.end(session.id, { writerId: deps.writerId })
      }
      diagnostics.record('session', kind === 'pause' ? 'session.paused' : kind === 'end' ? 'session.ended' : 'session.started')
      showStatus(
        kind === 'start'
          ? 'Session started.'
          : kind === 'resume'
            ? 'Session resumed.'
            : kind === 'pause'
              ? 'Session paused. Accepted audio still finishes.'
              : 'Session ended. Accepted audio still finishes.'
      )
      await refreshSelected()
    })
  }

  async function requestSummary(force: boolean) {
    if (!detail || busy || disposed || poll) return
    const sessionId = detail.session.id
    const allowPartial = partialAllowed
    summaryNotice = null
    await run(async () => {
      try {
        const { summary } = await deps.client.requestSummary(sessionId, { allowPartial, force })
        if (disposed || selectedId !== sessionId) return
        diagnostics.record('session', 'summary.requested', { status: summary.status === 'pending' ? 202 : 200 })
        applySummary(summary)
        if (summary.status === 'pending') {
          beginPoll(sessionId)
          showStatus('Summary requested. Checking every 2 seconds for up to 2 minutes.')
        } else if (summary.status === 'failed') {
          showStatus('Summary request finished with a failure.')
        } else {
          showStatus(`Summary is ${summary.status}.`)
        }
        renderSummary()
      } catch (error) {
        if (disposed || selectedId !== sessionId) return
        if (error instanceof SessionApiError && (error.code === 'summary_edited' || error.code === 'summary_stale')) {
          summaryNotice = {
            text: describeError(error),
            label: error.code === 'summary_edited' ? 'Regenerate and replace edit' : 'Regenerate summary'
          }
          renderSummary()
          return
        }
        throw error
      }
    })
  }

  function applySummary(summary: SessionSummary) {
    if (!detail || detail.session.id !== summary.sessionId) return
    const others = detail.summaries.filter((item) => item.id !== summary.id)
    detail = { ...detail, summaries: [summary, ...others].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)) }
  }

  function cancelPoll() {
    pollSequence++
    poll = null
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer)
      pollTimer = undefined
    }
  }

  function beginPoll(sessionId: string) {
    cancelPoll()
    const token = pollSequence
    poll = { token, sessionId, startedAt: now() }
    schedulePoll(token)
  }

  function schedulePoll(token: number) {
    if (disposed || !poll || poll.token !== token) return
    const elapsed = Math.max(0, now() - poll.startedAt)
    const delay = pollDelay(elapsed)
    if (delay === null) {
      poll = null
      showStatus('Summary is still generating after two minutes. Refresh the session to check again.')
      renderSummary()
      return
    }
    pollTimer = setTimeout(() => {
      pollTimer = undefined
      void pollSummary(token)
    }, delay)
  }

  async function pollSummary(token: number) {
    const current = poll
    if (disposed || !current || current.token !== token || selectedId !== current.sessionId) return
    const sessionId = current.sessionId
    try {
      const { summary } = await deps.client.summary(sessionId)
      if (disposed || !poll || poll.token !== token || selectedId !== sessionId) return
      if (!summary) {
        cancelPoll()
        showErrorText('No summary is available yet. Refresh the session to check again.')
        renderSummary()
        return
      }
      if (summary.status === 'ready' || summary.status === 'stale') {
        const seconds = Math.max(0, Math.round((now() - current.startedAt) / 1000))
        applySummary(summary)
        cancelPoll()
        showStatus(`Summary ready after ${seconds}s.`)
        renderSummary()
        renderStatus()
        return
      }
      if (summary.status === 'failed') {
        applySummary(summary)
        cancelPoll()
        showErrorText('Summary generation failed. Request a new summary to retry.')
        renderSummary()
        return
      }
      applySummary(summary)
      renderSummary()
      schedulePoll(token)
    } catch (error) {
      if (disposed || !poll || poll.token !== token) return
      cancelPoll()
      showError(error)
      renderSummary()
    }
  }

  async function saveSummary(summary: SessionSummary, overview: HTMLTextAreaElement, rows: EditRow[]) {
    if (!detail || busy || disposed) return
    const sessionId = detail.session.id
    const overviewText = overview.value.trim()
    if (!overviewText) {
      showErrorText('Overview text cannot be empty.')
      overview.focus()
      return
    }
    for (const row of rows) {
      if (row.remove.checked) continue
      if (!row.text.value.trim()) {
        showErrorText('Every kept item needs text. Remove it instead of leaving it empty.')
        row.text.focus()
        return
      }
    }
    const content: SummaryContent = {
      schemaVersion: summary.content.schemaVersion ?? 1,
      overview: { text: overviewText, citations: summary.content.overview?.citations ?? [] },
      decisions: rows
        .filter((row): row is ItemEditRow => row.kind === 'item' && row.section === 'decisions' && !row.remove.checked)
        .map((row) => ({ text: row.text.value.trim(), citations: row.original.citations })),
      actionCandidates: rows
        .filter((row): row is ActionEditRow => row.kind === 'action' && !row.remove.checked)
        .map((row) => ({
          text: row.text.value.trim(),
          owner: row.owner.value.trim() || null,
          due: row.original.due,
          dueText: row.dueText.value.trim() || null,
          conditional: row.original.conditional,
          citations: row.original.citations
        })),
      openQuestions: rows
        .filter((row): row is ItemEditRow => row.kind === 'item' && row.section === 'openQuestions' && !row.remove.checked)
        .map((row) => ({ text: row.text.value.trim(), citations: row.original.citations }))
    }
    await run(async () => {
      const { summary: updated } = await deps.client.updateSummary(sessionId, summary.id, content)
      if (disposed || selectedId !== sessionId) return
      applySummary(updated)
      editing = null
      if (detail && detail.preparation && detail.preparation.sourceSummaryId === updated.id && detail.preparation.status === 'ready') {
        detail = { ...detail, preparation: { ...detail.preparation, status: 'stale', staleReason: 'summary_edited' } }
      }
      showStatus('Summary saved as a manual edit. Regenerate only if you want to replace it.')
      renderSummary()
      renderPreparation()
    })
  }

  async function createPreparation(source: HTMLSelectElement, focus: HTMLTextAreaElement) {
    if (!detail || busy || disposed) return
    const sourceSummaryId = source.value
    if (!sourceSummaryId) {
      showErrorText('Select a ready summary first.')
      return
    }
    const sessionId = detail.session.id
    const focusText = focus.value.trim()
    await run(async () => {
      const { preparation } = await deps.client.createPreparation(sessionId, { sourceSummaryId, ...(focusText ? { focus: focusText } : {}) })
      if (disposed || selectedId !== sessionId || !detail) return
      detail = { ...detail, preparation }
      diagnostics.record('session', 'preparation.created')
      showStatus('Preparation saved as a snapshot of the selected summary.')
      focus.value = ''
      renderPreparation()
    })
  }

  async function exportMarkdown() {
    if (!detail || busy || disposed) return
    const session = detail.session
    await run(async () => {
      const markdown = await deps.client.export(session.id, 'markdown')
      if (disposed) return
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${session.id}.md`
      link.click()
      const timer = setTimeout(() => {
        revokeTimers.delete(timer)
        URL.revokeObjectURL(url)
      }, 10000)
      revokeTimers.add(timer)
      showStatus('Markdown export downloaded.')
    })
  }

  async function removeSession() {
    if (!detail || busy || disposed) return
    const session = detail.session
    if (!window.confirm(`Delete "${session.name}" with its transcript, summary and audio? This cannot be undone.`)) return
    await run(async () => {
      await deps.client.remove(session.id)
      if (disposed) return
      cancelPoll()
      selectedId = null
      detail = null
      detailFailed = false
      editing = null
      summaryNotice = null
      await loadList()
      renderList()
      renderDetail()
      renderStatus()
      showStatus('Session deleted.')
    })
  }

  function dispose() {
    if (disposed) return
    disposed = true
    cancelPoll()
    if (highlightTimer !== undefined) {
      clearTimeout(highlightTimer)
      highlightTimer = undefined
    }
    for (const timer of revokeTimers) clearTimeout(timer)
    revokeTimers.clear()
    highlightedTurn = null
    turnElements.clear()
    section.remove()
    lastGlasses = ''
    emitGlasses('')
  }

  renderList()
  renderDetail()
  renderStatus()
  if (!deps.canConnect || deps.canConnect()) void refresh()

  return { refresh, dispose }
}
