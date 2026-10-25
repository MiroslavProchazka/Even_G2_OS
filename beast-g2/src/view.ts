import type { ContinuousState } from './continuous'
import type { State } from './controller'
import { isInsecureGateway, type Settings } from './api'
export type Mode = 'manual' | 'continuous' | 'simulation'
/** Pure view rules kept out of main.ts so they can be tested without a browser. */
export function isBusy(mode: Mode, state: State, listening: ContinuousState) {
  if (mode === 'manual') return ['starting', 'recording', 'transcribing', 'answering'].includes(state.phase)
  return !['paused', 'interrupted', 'error'].includes(listening.phase) || listening.microphone !== 'off'
}
export function historyVisible(mode: Mode) {
  return mode !== 'manual'
}
export function modeSwitchNote(listening: ContinuousState) {
  return listening.microphone === 'off' ? '' : 'Pause continuous listening before switching modes.'
}
export function connectionMessage(settings: Settings) {
  return settings.transport === 'gateway' && isInsecureGateway(settings.gateway)
    ? 'Connection applied. Warning: HTTP outside localhost sends the token in cleartext. Use HTTPS.'
    : 'Connection applied. Test it before recording.'
}
