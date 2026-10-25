import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionMessage, historyVisible, isBusy, modeSwitchNote, type Mode } from '../src/view'
import type { State } from '../src/controller'
import type { ContinuousState } from '../src/continuous'

const state = (phase: State['phase']) => ({ phase }) as State
const listening = (phase: ContinuousState['phase'], microphone: ContinuousState['microphone']) => ({ phase, microphone }) as ContinuousState

test('manual mode is busy only while a request is active', () => {
  for (const phase of ['starting', 'recording', 'transcribing', 'answering'] as const) assert.equal(isBusy('manual', state(phase), listening('paused', 'off')), true)
  assert.equal(isBusy('manual', state('idle'), listening('paused', 'off')), false)
  assert.equal(isBusy('manual', state('error'), listening('paused', 'off')), false)
})
test('continuous mode stays busy until paused and the microphone is off', () => {
  assert.equal(isBusy('continuous', state('idle'), listening('listening', 'on')), true)
  assert.equal(isBusy('continuous', state('idle'), listening('paused', 'unknown')), true)
  assert.equal(isBusy('continuous', state('idle'), listening('paused', 'off')), false)
  assert.equal(isBusy('continuous', state('idle'), listening('error', 'off')), false)
})
test('history is hidden in manual mode and mode switching explains a live microphone', () => {
  for (const mode of ['manual', 'continuous', 'simulation'] as Mode[]) assert.equal(historyVisible(mode), mode !== 'manual')
  assert.match(modeSwitchNote(listening('listening', 'on')), /Pause continuous listening/)
  assert.equal(modeSwitchNote(listening('paused', 'off')), '')
})
test('connection message warns only for gateway HTTP outside localhost', () => {
  const settings = { gateway: 'http://192.168.1.5:8787', token: 'x', language: 'cs', transport: 'gateway' } as const
  assert.match(connectionMessage(settings), /cleartext/)
  assert.match(connectionMessage({ ...settings, gateway: 'https://example.com' }), /Test it before recording/)
  assert.match(connectionMessage({ ...settings, transport: 'direct' }), /Test it before recording/)
})
