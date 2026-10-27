import type { CaptionsControl, CaptionsState } from '../../captions'
import type { SessionsDeps } from '../../sessions'
import { button, el } from './dom'

let bound: { control: CaptionsControl; activate?: () => Promise<void> } | undefined

/**
 * main.ts binds the single captions controller before `initSessions` mounts the panels. `activate` lets the phone's Start
 * button select captions mode first, so the glasses PCM reaches this mode instead of another one.
 */
export function bindCaptions(control: CaptionsControl | undefined, activate?: () => Promise<void>) {
  bound = control ? { control, activate } : undefined
}

const running = (state: CaptionsState) => state.microphone !== 'off' || ['starting', 'listening', 'transcribing'].includes(state.phase)

/**
 * The captions panel. It only drives the controller that main.ts bound; it never creates a session and never touches the
 * session API. The mode is deliberately transient, so the panel shows a bounded in-memory history and says so.
 */
export const captionsPanel = {
  id: 'captions',
  mount(section: HTMLElement, deps: SessionsDeps) {
    const wrapper = el('details', 'sessions-captions')
    wrapper.append(el('summary', undefined, 'Captions'))
    wrapper.append(el('p', 'hint', 'Live captions on the glasses and this phone. Nothing is stored: no session, no transcript, no audio. Stopping clears the text.'))
    const status = el('p', 'captions-status')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const live = el('p', 'captions-live')
    const history = el('ol', 'captions-lines')
    const actions = el('div', 'actions')
    const toggle = deps.host ? deps.host.gate(button('Start captions'), () => true) : button('Start captions')
    const clear = deps.host ? deps.host.gate(button('Clear captions', 'secondary'), () => true) : button('Clear captions', 'secondary')
    actions.append(toggle, clear)
    wrapper.append(status, live, history, actions)
    section.append(wrapper)

    const render = () => {
      const binding = bound
      if (!binding) {
        status.textContent = 'Captions are not available on this page.'
        live.textContent = ''
        history.replaceChildren()
        history.hidden = true
        toggle.disabled = true
        clear.disabled = true
        return
      }
      const control = binding.control
      const state = control.state
      status.textContent = control.statusLine()
      live.textContent = state.phase === 'error' && state.error ? state.error : state.caption || 'No caption yet.'
      toggle.textContent = running(state) ? 'Stop captions' : 'Start captions'
      clear.disabled = !state.caption && !state.lines.length
      history.replaceChildren()
      for (const line of [...state.lines].reverse()) history.append(el('li', 'captions-line', line.text))
      history.hidden = state.lines.length === 0
    }

    const start = async () => {
      const binding = bound
      if (!binding) return
      await binding.activate?.()
      await binding.control.start()
    }
    toggle.addEventListener('click', () => {
      const binding = bound
      if (!binding) return
      if (running(binding.control.state)) void binding.control.stop()
      else void start()
    })
    clear.addEventListener('click', () => {
      bound?.control.clear()
    })
    bound?.control.subscribe(render)
    render()
  }
}
