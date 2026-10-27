import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Briefing, BriefingItem, BriefingSource, Session, SessionClient } from '../src/session-api'
import type { SessionPanelHost } from '../src/sessions'
import { briefingPanel } from '../src/sessions/panels/briefing'

type FakeEvent = { preventDefault: () => void; target: FakeElement }

class FakeClassList {
  private values = new Set<string>()
  add(...names: string[]) {
    for (const name of names) this.values.add(name)
  }
  remove(...names: string[]) {
    for (const name of names) this.values.delete(name)
  }
  contains(name: string) {
    return this.values.has(name)
  }
}

class FakeElement {
  tagName: string
  className = ''
  classList = new FakeClassList()
  parent: FakeElement | null = null
  children: FakeElement[] = []
  attrs = new Map<string, string>()
  listeners = new Map<string, Array<(event: FakeEvent) => void>>()
  hidden = false
  disabled = false
  value = ''
  checked = false
  type = ''
  name = ''
  maxLength = 0
  placeholder = ''
  title = ''
  focused = false
  private text = ''

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  get textContent(): string {
    if (!this.children.length) return this.text
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.text = value
    for (const child of this.children) child.parent = null
    this.children = []
  }

  append(...nodes: Array<FakeElement | string>) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeElement('#text') : node
      if (typeof node === 'string') child.textContent = node
      child.parent = this
      this.children.push(child)
    }
  }

  replaceChildren(...nodes: Array<FakeElement | string>) {
    for (const child of this.children) child.parent = null
    this.children = []
    this.text = ''
    this.append(...nodes)
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value)
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null
  }

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
    if (this.type !== 'submit') return
    let node = this.parent
    while (node && node.tagName !== 'FORM') node = node.parent
    node?.dispatch('submit')
  }

  focus() {
    this.focused = true
  }
}

class FakeDocument {
  querySelector() {
    return null
  }
  createElement(tagName: string) {
    return new FakeElement(tagName)
  }
}

function installDom() {
  const document = new FakeDocument()
  const previousDocument = globalThis.document
  globalThis.document = document as unknown as Document
  return {
    document,
    restore() {
      globalThis.document = previousDocument
    }
  }
}

function all(root: FakeElement): FakeElement[] {
  const found: FakeElement[] = [root]
  for (const child of root.children) found.push(...all(child))
  return found
}

function find(root: FakeElement, predicate: (element: FakeElement) => boolean) {
  return all(root).find(predicate)
}

function findAll(root: FakeElement, predicate: (element: FakeElement) => boolean) {
  return all(root).filter(predicate)
}

function findButton(root: FakeElement, label: string) {
  return find(root, (element) => element.tagName === 'BUTTON' && element.textContent === label)
}

function checkboxes(root: FakeElement) {
  return findAll(root, (element) => element.tagName === 'INPUT' && element.type === 'checkbox')
}

function checkbox(root: FakeElement, id: string) {
  return checkboxes(root).find((element) => element.value === id)
}

function toggle(element: FakeElement, checked: boolean) {
  element.checked = checked
  element.dispatch('change')
}

const settle = async () => {
  for (let index = 0; index < 4; index++) await new Promise((resolve) => setImmediate(resolve))
}

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 'ses_1',
    name: 'Budget call',
    source: 'import',
    language: 'cs',
    goal: '',
    prep: '',
    timezone: 'Europe/Prague',
    status: 'ended',
    captureState: 'off',
    transcriptRevision: 3,
    coverageDeclared: 'complete',
    retentionDays: 30,
    createdAt: Date.UTC(2026, 9, 26, 9, 0),
    startedAt: Date.UTC(2026, 9, 26, 9, 1),
    endedAt: Date.UTC(2026, 9, 26, 9, 30),
    expiresAt: Date.UTC(2026, 10, 25, 9, 0),
    endReason: null,
    ...overrides
  }) as Session

const source = (overrides: Partial<BriefingSource> = {}): BriefingSource => ({
  sessionId: 'ses_1',
  sessionName: 'Budget call',
  sessionDate: '2026-10-26T12:00:00.000Z',
  summaryId: 'sum_1',
  summaryCreatedAt: '2026-10-26T12:40:00.000Z',
  summaryStatus: 'ready',
  reviewStatus: 'reviewed',
  transcriptRevision: 3,
  summaryTranscriptRevision: 3,
  verification: 'verified',
  reason: null,
  coverage: { declared: 'complete', turns: 12, pendingTranscriptions: 0, gaps: [] },
  ...overrides
})

const item = (overrides: Partial<BriefingItem> = {}): BriefingItem => ({
  id: 'bri_1',
  kind: 'overview',
  text: 'The team agreed to ship the phone client by Friday.',
  owner: null,
  due: null,
  dueText: null,
  conditional: false,
  verification: 'verified',
  source: {
    sessionId: 'ses_1',
    sessionName: 'Budget call',
    sessionDate: '2026-10-26T12:00:00.000Z',
    summaryId: 'sum_1',
    summaryCreatedAt: '2026-10-26T12:40:00.000Z',
    verification: 'verified'
  },
  citations: [{ turnId: 'trn_1', turnRevision: 3, startMs: 65_000, endMs: 95_000, quote: 'We ship the phone client by Friday.' }],
  ...overrides
})

const briefing = (overrides: Partial<Briefing> = {}): Briefing => ({
  generatedAt: '2026-10-26T12:45:00.000Z',
  maxSessions: 3,
  sources: [source()],
  items: [item()],
  ...overrides
})

class FakeBriefingClient {
  sessions: Session[] = [session()]
  listCalls = 0
  calls: Array<{ sessionIds: string[]; signal?: AbortSignal }> = []
  result: Briefing = briefing()
  failure: Error | null = null

  async list(limit = 50) {
    this.listCalls++
    assert.equal(limit, 50)
    return { sessions: this.sessions }
  }

  createBriefing(input: { sessionIds: string[] }, options?: { signal?: AbortSignal }) {
    this.calls.push({ sessionIds: input.sessionIds, signal: options?.signal })
    if (this.failure) return Promise.reject(this.failure)
    return Promise.resolve({ briefing: this.result })
  }
}

function mount(client: FakeBriefingClient, options: { sessions?: Session[]; subscribe?: boolean } = {}) {
  const dom = installDom()
  const container = new FakeElement('div')
  const selected: string[] = []
  const errors: string[] = []
  let notify: ((sessions: Session[]) => void) | undefined
  const host: SessionPanelHost = {
    gate: (target) => target,
    error: (text) => errors.push(text),
    create: async () => false,
    select: async (id) => {
      selected.push(id)
    },
    ...(options.subscribe === false
      ? {}
      : {
          onSessions: (listener) => {
            notify = listener
            listener(options.sessions ?? [session()])
            return () => {}
          }
        })
  }
  briefingPanel.mount(container as unknown as HTMLElement, { client: client as unknown as SessionClient, writerId: 'phone', host })
  return { dom, container, selected, errors, notify: (sessions: Session[]) => notify?.(sessions) }
}

const fourSessions = [
  session({ id: 'ses_1', name: 'First call' }),
  session({ id: 'ses_2', name: 'Second call' }),
  session({ id: 'ses_3', name: 'Third call' }),
  session({ id: 'ses_4', name: 'Fourth call' })
]

test('the panel lists sessions from the host, not a private fetch, and caps the selection at three', async (t) => {
  const client = new FakeBriefingClient()
  const { dom, container } = mount(client, { sessions: fourSessions })
  t.after(dom.restore)
  await settle()

  assert.equal(client.listCalls, 0)
  assert.match(container.textContent, /Choose up to three stored sessions\./)
  assert.equal(checkboxes(container).length, 4)

  const [first, second, third, fourth] = fourSessions.map((entry) => checkbox(container, entry.id)!)
  toggle(first!, true)
  toggle(second!, true)
  assert.equal(fourth!.disabled, false)

  toggle(third!, true)
  assert.equal(fourth!.disabled, true)
  assert.equal(first!.disabled, false)
  assert.equal(findButton(container, 'Build briefing')!.disabled, false)

  toggle(second!, false)
  assert.equal(fourth!.disabled, false)
  assert.equal(second!.disabled, false)
  assert.equal(first!.checked, true)
  assert.equal(third!.checked, true)
})

test('selections survive a list refresh and an id that disappeared is dropped', async (t) => {
  const client = new FakeBriefingClient()
  const { dom, container, notify } = mount(client, { sessions: fourSessions })
  t.after(dom.restore)
  await settle()

  toggle(checkbox(container, 'ses_1')!, true)
  toggle(checkbox(container, 'ses_2')!, true)

  notify([session({ id: 'ses_2', name: 'Second call' }), session({ id: 'ses_3', name: 'Third call' })])
  await settle()
  assert.equal(checkbox(container, 'ses_1'), undefined)
  assert.equal(checkbox(container, 'ses_2')!.checked, true)
  assert.equal(checkbox(container, 'ses_3')!.checked, false)
  assert.equal(findButton(container, 'Build briefing')!.disabled, false)
})

test('building with two sessions sends the ids in list order and renders sources and grouped items', async (t) => {
  const client = new FakeBriefingClient()
  client.result = briefing({
    sources: [
      source({ sessionId: 'ses_1', sessionName: 'First call' }),
      source({
        sessionId: 'ses_3',
        sessionName: 'Third call',
        sessionDate: '2026-10-26T12:30:00.000Z',
        summaryId: 'sum_3',
        verification: 'unverified',
        reason: 'transcript_changed'
      })
    ],
    items: [
      item(),
      item({
        id: 'bri_2',
        kind: 'commitment',
        text: 'Send the revised budget.',
        owner: 'Jana',
        dueText: 'Friday',
        conditional: true,
        citations: [{ turnId: 'trn_2', turnRevision: 4, startMs: 125_000, endMs: 155_000, quote: 'Jana sends the revised budget on Friday.' }]
      })
    ]
  })
  const { dom, container, errors } = mount(client, { sessions: fourSessions })
  t.after(dom.restore)
  await settle()

  toggle(checkbox(container, 'ses_3')!, true)
  toggle(checkbox(container, 'ses_1')!, true)
  findButton(container, 'Build briefing')!.click()
  await settle()

  assert.deepEqual(
    client.calls.map((call) => call.sessionIds),
    [['ses_1', 'ses_3']]
  )
  assert.ok(client.calls[0]!.signal)
  assert.match(container.textContent, /Briefing · 26 Oct 2026/)
  assert.match(container.textContent, /1 of 2 sources verified\./)
  assert.match(container.textContent, /The team agreed to ship the phone client by Friday\./)
  assert.match(container.textContent, /26 Oct 2026/)
  assert.match(container.textContent, /Verified/)
  assert.match(container.textContent, /Unverified/)
  assert.match(container.textContent, /Transcript changed after the summary\. This session adds no claims\./)
  assert.match(container.textContent, /Overview/)
  assert.match(container.textContent, /Commitments/)
  assert.match(container.textContent, /Owner: Jana · Deadline: Friday · Conditional/)
  assert.deepEqual(errors, [])
})

test('a source without a summary says so and contributes no claims', async (t) => {
  const client = new FakeBriefingClient()
  client.result = briefing({
    sources: [source(), source({ sessionId: 'ses_2', sessionName: 'Second call', summaryId: null, summaryStatus: null, verification: 'unverified', reason: 'no_summary' })],
    items: [item({ text: 'Only the verified claim.' })]
  })
  const { dom, container, errors } = mount(client, { sessions: fourSessions })
  t.after(dom.restore)
  await settle()

  toggle(checkbox(container, 'ses_1')!, true)
  toggle(checkbox(container, 'ses_2')!, true)
  findButton(container, 'Build briefing')!.click()
  await settle()

  assert.match(container.textContent, /No summary yet\. This session adds no claims\./)
  assert.equal(findAll(container, (element) => element.className.includes('session-briefing-item')).length, 1)
  assert.match(container.textContent, /Only the verified claim\./)
  assert.deepEqual(errors, [])
})

test('a citation chip opens the item session through the host', async (t) => {
  const client = new FakeBriefingClient()
  const { dom, container, selected, errors } = mount(client, { sessions: fourSessions })
  t.after(dom.restore)
  await settle()

  toggle(checkbox(container, 'ses_1')!, true)
  findButton(container, 'Build briefing')!.click()
  await settle()

  const chip = find(container, (element) => element.tagName === 'BUTTON' && element.className.includes('session-citation'))!
  assert.match(chip.textContent, /\[01:05\]/)
  chip.click()
  await settle()
  assert.deepEqual(selected, ['ses_1'])
  assert.deepEqual(errors, [])
})

test('an empty selection is refused before any request', async (t) => {
  const client = new FakeBriefingClient()
  const { dom, container, errors } = mount(client, { sessions: fourSessions })
  t.after(dom.restore)
  await settle()

  findButton(container, 'Build briefing')!.click()
  await settle()

  assert.deepEqual(errors, ['Select at least one session.'])
  assert.equal(client.calls.length, 0)
})

test('no stored sessions disables the build and says so', async (t) => {
  const client = new FakeBriefingClient()
  const { dom, container, errors } = mount(client, { sessions: [] })
  t.after(dom.restore)
  await settle()

  assert.equal(checkboxes(container).length, 0)
  assert.equal(findButton(container, 'Build briefing')!.disabled, true)
  assert.match(container.textContent, /No stored sessions yet\./)
  assert.deepEqual(errors, [])
})

test('a briefing failure is reported through the host error line', async (t) => {
  const client = new FakeBriefingClient()
  client.failure = new Error('boom')
  const { dom, container, errors } = mount(client, { sessions: fourSessions })
  t.after(dom.restore)
  await settle()

  toggle(checkbox(container, 'ses_1')!, true)
  findButton(container, 'Build briefing')!.click()
  await settle()

  assert.deepEqual(errors, ['Unexpected error. Refresh and try again.'])
  assert.doesNotMatch(container.textContent, /The team agreed to ship the phone client by Friday\./)
})

test('the panel falls back to client.list when the host has no session subscription', async (t) => {
  const client = new FakeBriefingClient()
  const { dom, container, errors } = mount(client, { subscribe: false })
  t.after(dom.restore)
  await settle()

  assert.equal(client.listCalls, 1)
  assert.equal(checkboxes(container).length, 1)
  assert.equal(findButton(container, 'Build briefing')!.disabled, true)
  assert.deepEqual(errors, [])
})
