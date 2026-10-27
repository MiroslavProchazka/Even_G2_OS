import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContinuousController } from '../src/continuous'
import { simulateUtterance } from '../src/continuous-demo'
import { diagnostics } from '../src/diagnostics'
import { HINT_MIN_SPACING_MS, HintFeedback, HintPolicy, HintsController, type HintsControl, type HintsState } from '../src/hints'
import type { AssistantPort } from '../src/controller'
import type { SessionClient } from '../src/session-api'
import { bindHints, hintsPanel } from '../src/sessions/panels/hints'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

const answeringApi: AssistantPort = {
  async transcribe() {
    return 'Dneska je hezky.'
  },
  async chat(_text, _history, _signal, delta) {
    delta('Hint')
  }
}

function setup(t: any, api: AssistantPort = answeringApi, options: { enabled?: boolean } = {}) {
  let clock = 1000
  const policy = new HintPolicy({ now: () => clock, enabled: options.enabled })
  const audio = {
    starts: 0,
    stops: 0,
    async start() {
      this.starts++
    },
    async stop() {
      this.stops++
    }
  }
  const controller = new ContinuousController(audio, api, () => {}, { now: () => clock, hintPolicy: policy })
  t.after(() => controller.pause())
  return { controller, policy, audio, advance: (ms: number) => (clock += ms), clock: () => clock }
}

test('automatic hints are off by default and the live transcript survives', async (t) => {
  let chats = 0
  const { controller, policy } = setup(t, {
    async transcribe() {
      return 'Dneska je hezky.'
    },
    async chat() {
      chats++
    }
  })
  assert.equal(policy.enabled, false)
  assert.equal(policy.minSpacingMs, HINT_MIN_SPACING_MS)
  assert.equal(policy.decide('unsolicited'), 'suppress')
  await controller.start()
  simulateUtterance(controller)
  await tick()
  assert.equal(chats, 0)
  assert.equal(controller.state.transcript, 'Dneska je hezky.')
  assert.equal(controller.state.reply, undefined)
  assert.equal(controller.state.hintsSuppressed, 1)
  assert.match(controller.state.notice, /Hints are off/)
})

test('automatic hints keep a hard 30-second spacing measured from the last shown hint', async (t) => {
  let chats = 0
  const { controller, policy, advance } = setup(t, {
    async transcribe() {
      return 'Dneska je hezky.'
    },
    async chat(_text, _history, _signal, delta) {
      delta(`Hint ${++chats}`)
    }
  })
  policy.setEnabled(true)
  await controller.start()
  simulateUtterance(controller)
  await tick()
  assert.equal(controller.state.reply?.answer, 'Hint 1')
  assert.equal(policy.lastShownAt, 1000)

  simulateUtterance(controller)
  await tick()
  assert.equal(chats, 1)
  assert.match(controller.state.notice, /Another hint is visible/)

  advance(10_000)
  controller.tickHint()
  assert.equal(controller.state.reply, undefined)

  simulateUtterance(controller)
  await tick()
  assert.equal(chats, 1)
  assert.equal(controller.state.transcript, 'Dneska je hezky.')
  assert.match(controller.state.notice, /spacing not reached/)
  assert.equal(policy.lastShownAt, 1000)

  advance(19_999)
  simulateUtterance(controller)
  await tick()
  assert.equal(chats, 1)
  assert.equal(policy.lastShownAt, 1000)

  advance(1)
  simulateUtterance(controller)
  await tick()
  assert.equal(chats, 2)
  assert.equal(controller.state.reply?.answer, 'Hint 2')
  assert.equal(policy.lastShownAt, 31_000)
})

test('an explicit Ask bypasses the toggle, the pause, a visible hint and the spacing clock', async (t) => {
  let chats = 0
  const { controller, policy, advance } = setup(t, {
    async transcribe() {
      return 'Dneska je hezky.'
    },
    async chat(_text, _history, _signal, delta) {
      delta(`Hint ${++chats}`)
    }
  })
  policy.setEnabled(true)
  policy.pause()
  await controller.start()
  simulateUtterance(controller)
  await tick()
  assert.equal(chats, 0)
  assert.equal(controller.state.transcript, 'Dneska je hezky.')
  assert.match(controller.state.notice, /Hints are paused/)

  assert.equal(await controller.askHint('What should I ask?'), true)
  assert.equal(controller.state.reply?.answer, 'Hint 1')
  assert.equal(policy.lastShownAt, undefined)
  assert.equal(policy.remainingMs(), 0)

  advance(5000)
  assert.equal(await controller.askHint('And now?'), true)
  assert.equal(controller.state.reply?.answer, 'Hint 2')
  assert.equal(policy.lastShownAt, undefined)
  assert.equal(controller.state.transcript, 'Dneska je hezky.')
})

test('a model failure shows no hint and does not change the live transcript', async (t) => {
  let chats = 0
  const { controller, policy } = setup(t, {
    async transcribe() {
      return 'Dneska je hezky.'
    },
    async chat() {
      chats++
      throw new Error('offline')
    }
  })
  policy.setEnabled(true)
  await controller.start()
  simulateUtterance(controller)
  await tick()
  assert.equal(chats, 1)
  assert.equal(controller.state.reply, undefined)
  assert.equal(controller.state.transcript, 'Dneska je hezky.')
  assert.match(controller.state.error, /offline/)
  assert.equal(policy.lastShownAt, undefined)

  assert.equal(await controller.askHint('What should I ask?'), false)
  assert.equal(controller.state.reply, undefined)
  assert.equal(controller.state.transcript, 'Dneska je hezky.')
  assert.equal(controller.state.hintsSuppressed, 0)
})

test('the policy refuses a hint while another one is visible and never lowers the hard spacing', () => {
  let clock = 1000
  const policy = new HintPolicy({ now: () => clock })
  policy.setEnabled(true)
  assert.equal(policy.decide('unsolicited', { visible: true }), 'suppress')
  assert.equal(policy.blockedBy({ visible: true }), 'visible')
  assert.equal(policy.setSpacing(10_000), false)
  assert.equal(policy.minSpacingMs, HINT_MIN_SPACING_MS)
  assert.equal(policy.setSpacing(60_000), true)
  assert.equal(policy.decide('unsolicited'), 'show-unsolicited')
  policy.noteShown('show-unsolicited')
  clock += 60_000
  assert.equal(policy.decide('unsolicited'), 'show-unsolicited')
  assert.equal(policy.decide('ask'), 'show-ask')
})

test('the local feedback counts contain no hint text, transcript or prompt', () => {
  diagnostics.clear()
  const feedback = new HintFeedback()
  assert.deepEqual(feedback.rate('useful'), { useful: 1, distracting: 0 })
  assert.deepEqual(feedback.rate('useful'), { useful: 2, distracting: 0 })
  assert.deepEqual(feedback.rate('distracting'), { useful: 2, distracting: 1 })
  const events = diagnostics.snapshot().filter((event) => event.event === 'hint.feedback')
  assert.equal(events.length, 3)
  assert.deepEqual(events.at(-1)!.details, { code: 'distracting', useful: 2, distracting: 1 })
  assert.doesNotMatch(JSON.stringify(events.map((event) => event.details)), /hint|transcript|prompt|text/i)
  assert.match(JSON.stringify(events), /"useful":2/)
})

test('the hints controller starts off, enforces the floor and exposes local counts', () => {
  const controller = new HintsController(new HintPolicy())
  assert.deepEqual(controller.state, { enabled: false, paused: false, minSpacingMs: 30_000, lastShownAt: undefined, useful: 0, distracting: 0 })
  assert.match(controller.statusLine(), /Hints off/)
  assert.equal(controller.setSpacing(10_000), false)
  assert.equal(controller.state.minSpacingMs, 30_000)
  assert.equal(controller.setSpacing(60_000), true)
  controller.setEnabled(true)
  assert.match(controller.statusLine(), /at least 60 s/)
  controller.pause()
  assert.match(controller.statusLine(), /paused/)
  controller.resume()
  controller.rate('useful')
  controller.rate('distracting')
  assert.equal(controller.state.useful, 1)
  assert.equal(controller.state.distracting, 1)
})

type FakeEvent = { preventDefault: () => void; target: FakeElement }

class FakeElement {
  tagName: string
  className = ''
  children: FakeElement[] = []
  listeners = new Map<string, Array<(event: FakeEvent) => void>>()
  hidden = false
  disabled = false
  checked = false
  value = ''
  type = ''
  private text = ''
  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }
  get textContent(): string {
    return this.children.length ? this.children.map((child) => child.textContent).join('') : this.text
  }
  set textContent(value: string) {
    this.text = value
    this.children = []
  }
  append(...nodes: Array<FakeElement | string>) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeElement('#text') : node
      if (typeof node === 'string') child.textContent = node
      this.children.push(child)
    }
  }
  replaceChildren(...nodes: Array<FakeElement | string>) {
    this.children = []
    this.text = ''
    this.append(...nodes)
  }
  setAttribute() {}
  addEventListener(type: string, listener: (event: FakeEvent) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }
  dispatch(type: string) {
    const event: FakeEvent = { preventDefault() {}, target: this }
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  click() {
    this.dispatch('click')
  }
}

class FakeDocument {
  createElement(tagName: string) {
    return new FakeElement(tagName)
  }
}

function installDom() {
  const previousDocument = globalThis.document
  globalThis.document = new FakeDocument() as unknown as Document
  return () => {
    globalThis.document = previousDocument
  }
}

function all(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => all(child))]
}

function find(root: FakeElement, predicate: (element: FakeElement) => boolean) {
  return all(root).find(predicate)
}

function findButton(root: FakeElement, label: string) {
  return find(root, (element) => element.tagName === 'BUTTON' && element.textContent === label)
}

test('the hints panel is opt-in, states the local boundary and drives a fake controller', async (t) => {
  const restore = installDom()
  t.after(restore)
  const calls: string[] = []
  let state: HintsState = { enabled: false, paused: false, minSpacingMs: 30_000, lastShownAt: undefined, useful: 0, distracting: 0 }
  const fake: HintsControl = {
    get state() {
      return state
    },
    setEnabled(enabled) {
      calls.push(`enable:${enabled}`)
      state = { ...state, enabled }
    },
    setSpacing(ms) {
      calls.push(`spacing:${ms}`)
      if (ms < 30_000) return false
      state = { ...state, minSpacingMs: ms }
      return true
    },
    pause() {
      calls.push('pause')
      state = { ...state, paused: true }
    },
    resume() {
      calls.push('resume')
      state = { ...state, paused: false }
    },
    rate(rating) {
      calls.push(`rate:${rating}`)
      state = { ...state, [rating]: state[rating] + 1 }
    },
    statusLine() {
      if (!state.enabled) return 'Hints off · automatic hints are opt-in'
      return state.paused ? 'Hints on · automatic hints paused' : `Hints on · automatic hints at least ${state.minSpacingMs / 1000} s apart`
    },
    subscribe(listener) {
      void listener
      return () => {}
    }
  }
  bindHints(fake)
  t.after(() => bindHints(undefined))
  const section = new FakeElement('div')
  hintsPanel.mount(section as unknown as HTMLElement, { client: {} as SessionClient, writerId: 'phone' })
  assert.match(section.textContent, /off by default/)
  assert.match(section.textContent, /local counts only/)
  assert.match(section.textContent, /Hints off/)
  const toggle = find(section, (element) => element.tagName === 'INPUT' && element.type === 'checkbox')!
  assert.equal(toggle.checked, false)
  const spacing = find(section, (element) => element.tagName === 'SELECT')!
  assert.equal(spacing.value, '30000')
  toggle.checked = true
  toggle.dispatch('change')
  assert.deepEqual(calls, ['enable:true'])
  assert.match(section.textContent, /Hints on/)
  findButton(section, 'Pause hints')!.click()
  assert.deepEqual(calls, ['enable:true', 'pause'])
  assert.match(section.textContent, /paused/)
  findButton(section, 'Resume hints')!.click()
  assert.deepEqual(calls, ['enable:true', 'pause', 'resume'])
  spacing.value = '60000'
  spacing.dispatch('change')
  assert.ok(calls.includes('spacing:60000'))
  findButton(section, 'Useful')!.click()
  findButton(section, 'Distracting')!.click()
  assert.deepEqual(calls.slice(-2), ['rate:useful', 'rate:distracting'])
  assert.match(section.textContent, /Useful 1 · Distracting 1/)
})
