import type { QaAnswer, Session } from '../../session-api'
import type { SessionsDeps } from '../../sessions'
import { citationLabel, describeError, formatDate } from '../../sessions-view'
import { button, el } from './dom'

/**
 * Questions about one stored session. The panel picks a session, sends one question and renders the answer with an
 * evidence badge and citation chips. A citation chip opens the session through the host, so the list and the detail stay
 * owned by `initSessions`. An `insufficient` answer is a normal result, not an error: it is shown as a plain message.
 */
export const qaPanel = {
  id: 'qa',
  mount(section: HTMLElement, deps: SessionsDeps) {
    const wrapper = el('div', 'sessions-qa')
    wrapper.append(el('h3', undefined, 'Questions about a session'))

    const form = el('form', 'sessions-qa-form')

    const sessionLabel = el('label', undefined, 'Session')
    const session = el('select')
    session.name = 'session'
    session.setAttribute('aria-label', 'Session to ask about')
    sessionLabel.append(session)

    const questionLabel = el('label', undefined, 'Question')
    const question = el('input')
    question.type = 'text'
    question.name = 'question'
    question.maxLength = 500
    question.placeholder = 'What did we agree about the budget?'
    question.setAttribute('aria-label', 'Question about the selected session')
    questionLabel.append(question)

    const submit = button('Ask', '', 'submit')
    form.append(sessionLabel, questionLabel, submit)

    const status = el('p', 'hint sessions-qa-status')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const result = el('div', 'sessions-qa-answer')

    wrapper.append(el('p', 'hint', 'Answers come only from the final transcript and the summary of the selected session. Every answer cites the turns it rests on.'), form, status, result)
    section.append(wrapper)

    let token = 0
    let controller: AbortController | null = null

    function renderAnswer(answer: QaAnswer, sessionId: string) {
      result.replaceChildren()
      const head = el('div', 'session-section-head')
      const sufficient = answer.evidence === 'sufficient'
      head.append(
        el(
          'span',
          sufficient ? 'session-badge qa-evidence qa-evidence-sufficient' : 'session-badge qa-evidence qa-evidence-insufficient',
          sufficient ? 'Supported by transcript' : 'Not enough evidence'
        )
      )
      result.append(head, el('p', sufficient ? 'qa-answer-text' : 'qa-answer-text qa-answer-insufficient', answer.text))
      if (!sufficient || !answer.citations.length) return
      const chips = el('div', 'session-citations qa-citations')
      for (const citation of answer.citations) {
        const quote = citation.quote.length > 120 ? `${citation.quote.slice(0, 117).trimEnd()}…` : citation.quote
        const chip = button(`${citationLabel(citation)} · ${quote}`, 'session-citation qa-citation')
        chip.title = citation.quote
        chip.addEventListener('click', () => {
          void deps.host?.select(sessionId)
        })
        chips.append(chip)
      }
      result.append(chips)
    }

    async function ask() {
      const sessionId = session.value
      const text = question.value.trim()
      result.replaceChildren()
      status.textContent = ''
      if (!sessionId) {
        deps.host?.error('Select a session to ask about.')
        return
      }
      if (!text) {
        deps.host?.error('Enter a question.')
        question.focus()
        return
      }
      controller?.abort()
      const abort = new AbortController()
      controller = abort
      const current = ++token
      submit.disabled = true
      status.textContent = 'Asking…'
      try {
        const response = await deps.client.ask(sessionId, text, { signal: abort.signal })
        if (current !== token || abort.signal.aborted) return
        status.textContent = ''
        renderAnswer(response.answer, sessionId)
      } catch (error) {
        if (current !== token || abort.signal.aborted) return
        status.textContent = ''
        deps.host?.error(describeError(error))
      } finally {
        if (current === token) {
          controller = null
          submit.disabled = false
        }
      }
    }

    async function loadSessions() {
      try {
        const { sessions } = await deps.client.list(50)
        renderSessions(sessions)
      } catch (error) {
        session.disabled = true
        submit.disabled = true
        deps.host?.error(describeError(error))
      }
    }

    function renderSessions(items: Session[]) {
      const previous = session.value
      session.replaceChildren()
      for (const item of items) {
        const option = el('option', undefined, `${item.name} · ${formatDate(item.startedAt ?? item.createdAt)}`)
        option.value = item.id
        session.append(option)
      }
      if (!items.length) {
        session.disabled = true
        submit.disabled = true
        status.textContent = 'No stored sessions yet.'
        return
      }
      session.disabled = false
      submit.disabled = controller !== null
      status.textContent = ''
      session.value = items.some((item) => item.id === previous) ? previous : items[0]!.id
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void ask()
    })

    const unsubscribe = deps.host?.onSessions?.((items) => renderSessions(items))
    if (!unsubscribe) void loadSessions()
  }
}
