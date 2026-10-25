import { createContinuousDemo, simulateUtterance } from '../src/continuous-demo'
const c = createContinuousDemo(() => {})
try {
  await c.start()
  for (let i = 0; i < 5; i++) {
    simulateUtterance(c)
    await new Promise<void>(resolve => setImmediate(resolve))
    console.log(`Segment ${i + 1}: ${c.state.notice}`)
  }
  console.log(`Visible: ${c.state.reply?.answer}`)
  c.showLatest()
  console.log(`Latest: ${c.state.reply?.answer}`)
  if (c.state.ignored !== 0 || !c.state.reply?.answer.includes('SIMULATED')) throw new Error('Demo contract failed')
} finally { await c.pause(); console.log(`Microphone: ${c.state.microphone} (${c.state.phase}); no device or network used.`) }
