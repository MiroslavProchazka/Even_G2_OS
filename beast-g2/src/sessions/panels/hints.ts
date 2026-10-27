import type { HintsControl } from '../../hints'
import type { SessionsDeps } from '../../sessions'
import { button, el } from './dom'

let bound: HintsControl | undefined

/** main.ts binds the single hints controller before `initSessions` mounts the panels. */
export function bindHints(control: HintsControl | undefined) {
  bound = control
}

const SPACING_OPTIONS = [30_000, 60_000, 120_000]

/**
 * The hints panel. Automatic hints are opt-in and off by default; the panel can raise the hard 30-second
 * spacing but never lower it. Pausing hints only pauses automatic hints, not transcription. Feedback buttons
 * increment two local counters; no hint text, transcript or prompt is stored.
 */
export const hintsPanel = {
  id: 'hints',
  mount(section: HTMLElement, deps: SessionsDeps) {
    const wrapper = el('details', 'sessions-hints')
    wrapper.append(el('summary', undefined, 'Hints'))
    wrapper.append(
      el(
        'p',
        'hint',
        'Contextual hints are off by default. Turning them on is an explicit action. Automatic hints are spaced at least 30 seconds apart. Useful / Distracting ratings are local counts only: no hint text, no transcript and no prompt leave this page.'
      )
    )
    const status = el('p', 'hints-status')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const toggleLabel = el('label', 'hints-toggle')
    const toggle = el('input')
    toggle.type = 'checkbox'
    toggle.checked = false
    toggleLabel.append(toggle, ' Enable contextual hints')
    const spacingLabel = el('label', 'hints-spacing')
    const spacing = el('select')
    for (const ms of SPACING_OPTIONS) {
      const option = el('option', undefined, `${ms / 1000} seconds`)
      option.value = String(ms)
      spacing.append(option)
    }
    spacingLabel.append(spacing, ' minimum spacing between automatic hints')
    const actions = el('div', 'actions')
    const pause = button('Pause hints', 'secondary')
    const useful = button('Useful')
    const distracting = button('Distracting', 'secondary')
    const counts = el('p', 'hints-feedback')
    actions.append(pause, useful, distracting)
    wrapper.append(toggleLabel, spacingLabel, status, actions, counts)
    section.append(wrapper)

    const render = () => {
      const control = bound
      if (!control) {
        status.textContent = 'Hints are not available on this page.'
        toggle.disabled = true
        spacing.disabled = true
        pause.disabled = true
        useful.disabled = true
        distracting.disabled = true
        counts.textContent = ''
        return
      }
      const state = control.state
      toggle.checked = state.enabled
      toggle.disabled = false
      spacing.value = String(state.minSpacingMs)
      spacing.disabled = !state.enabled
      pause.textContent = state.paused ? 'Resume hints' : 'Pause hints'
      pause.disabled = !state.enabled
      useful.disabled = false
      distracting.disabled = false
      status.textContent = control.statusLine()
      counts.textContent = `Useful ${state.useful} · Distracting ${state.distracting} · local counts only`
    }

    toggle.addEventListener('change', () => {
      bound?.setEnabled(toggle.checked)
      render()
    })
    spacing.addEventListener('change', () => {
      if (!bound) return
      if (!bound.setSpacing(Number(spacing.value))) {
        spacing.value = String(bound.state.minSpacingMs)
        deps.host?.error('Automatic hints need at least 30 seconds of spacing.')
      }
      render()
    })
    pause.addEventListener('click', () => {
      if (!bound) return
      if (bound.state.paused) bound.resume()
      else bound.pause()
      render()
    })
    useful.addEventListener('click', () => {
      bound?.rate('useful')
      render()
    })
    distracting.addEventListener('click', () => {
      bound?.rate('distracting')
      render()
    })
    bound?.subscribe(render)
    render()
  }
}
