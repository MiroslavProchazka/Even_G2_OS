import type { SessionLanguage } from '../../session-api'
import type { SessionsDeps } from '../../sessions'
import { languageLabel } from '../../sessions-view'
import { button, el } from './dom'

/**
 * The first sessions panel. It owns the "new session" form and hands trimmed values to the host, which creates the
 * session, refreshes the list and selects it. The host also supplies gating and the error line, so the panel keeps no state.
 */
export const newSessionPanel = {
  id: 'new-session',
  mount(section: HTMLElement, deps: SessionsDeps) {
    const host = deps.host
    if (!host) throw new Error('The new session panel needs the sessions host.')

    const wrapper = el('details', 'sessions-new')
    wrapper.append(el('summary', undefined, 'New session'))
    const form = el('form', 'sessions-create')

    const nameLabel = el('label', undefined, 'Name')
    const name = el('input')
    name.name = 'name'
    name.maxLength = 200
    name.required = true
    name.placeholder = 'Monday call'
    nameLabel.append(name)

    const languageLabelElement = el('label', undefined, 'Language')
    const language = el('select')
    language.name = 'language'
    for (const value of ['cs', 'en', 'auto'] as const) {
      const option = el('option', undefined, languageLabel(value))
      option.value = value
      language.append(option)
    }
    language.value = 'cs'
    languageLabelElement.append(language)

    const goalLabel = el('label', undefined, 'Goal (optional)')
    const goal = el('textarea')
    goal.name = 'goal'
    goal.maxLength = 4000
    goal.rows = 2
    goal.placeholder = 'What should this conversation achieve?'
    goalLabel.append(goal)

    const prepLabel = el('label', undefined, 'Preparation notes (optional)')
    const prep = el('textarea')
    prep.name = 'prep'
    prep.maxLength = 4000
    prep.rows = 2
    prep.placeholder = 'People, context and facts to have ready.'
    prepLabel.append(prep)

    const submit = host.gate(button(deps.recorder ? 'Start recording' : 'Create session', '', 'submit'), () => true)
    form.append(nameLabel, languageLabelElement, goalLabel, prepLabel, submit)
    form.append(
      el(
        'p',
        'hint',
        deps.recorder ? 'Recording starts immediately. Pause or end it from the session below.' : 'Creates a draft session. Import audio with npm run session:import, then request a summary here.'
      )
    )
    const create = async () => {
      const sessionName = name.value.trim()
      if (!sessionName) {
        host.error('Enter a session name.')
        name.focus()
        return
      }
      const created = await host.create({ name: sessionName, language: language.value as SessionLanguage, goal: goal.value.trim(), prep: prep.value.trim() })
      if (!created) return
      name.value = ''
      goal.value = ''
      prep.value = ''
      language.value = 'cs'
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void create()
    })
    for (const control of [name, language, goal, prep]) host.gate(control, () => true)
    wrapper.append(form)
    section.append(wrapper)
  }
}
