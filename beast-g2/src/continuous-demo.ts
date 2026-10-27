import { ContinuousController } from './continuous'
import type { AssistantPort } from './controller'
import type { HintPolicy } from './hints'
/** Explicit synthetic audio, never phone/computer capture. Also used by deterministic smoke tests. */
export function pcmFrame(speech: boolean) {
  const bytes = new Uint8Array(640),
    view = new DataView(bytes.buffer)
  for (let i = 0; i < 320; i++) view.setInt16(i * 2, speech ? (i % 2 ? 2200 : -2200) : 0, true)
  return bytes
}
export function simulateUtterance(controller: ContinuousController) {
  for (let i = 0; i < 15; i++) controller.onPcm(pcmFrame(false))
  for (let i = 0; i < 30; i++) controller.onPcm(pcmFrame(true))
  for (let i = 0; i < 105; i++) controller.onPcm(pcmFrame(false))
}
export function createContinuousDemo(changed: () => void, hintPolicy?: HintPolicy) {
  let index = 0
  const transcripts = ['Dneska je pěkné počasí.', 'Jak funguje Beast G2?', 'Jak funguje Beast G2?', 'Kdo ví, že jo?', 'Co znamená průběžný poslech?']
  const api: AssistantPort = {
    async transcribe(_wav, signal) {
      signal.throwIfAborted()
      return transcripts[index++ % transcripts.length]
    },
    async chat(text, _history, signal, delta) {
      if (text.startsWith('You support the wearer')) {
        signal.throwIfAborted()
        delta(
          JSON.stringify({
            show: true,
            hint: '[DEMO] Ujasni si hlavní cíl rozhovoru.',
            detail: 'Simulovaná kontextová nápověda. Zeptej se na požadovaný výsledek a ověř, zda mu obě strany rozumějí stejně.'
          })
        )
        return
      }
      signal.throwIfAborted()
      delta(`[SIMULATED] ${text} `)
      await Promise.resolve()
      signal.throwIfAborted()
      delta('Toto je demo průběžného poslechu bez mikrofonu a bez Beast volání.')
    }
  }
  let silence: ReturnType<typeof setInterval> | undefined
  const controller = new ContinuousController(
    {
      async start() {
        silence = setInterval(() => controller.onPcm(pcmFrame(false)), 20)
      },
      async stop() {
        clearInterval(silence)
      }
    },
    api,
    changed,
    { hintPolicy }
  )
  return controller
}
