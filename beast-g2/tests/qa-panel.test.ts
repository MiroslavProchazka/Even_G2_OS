import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QaResponse, Session, SessionClient } from '../src/session-api'
import type { SessionPanelHost } from '../src/sessions'
import { qaPanel } from '../src/sessions/panels/qa'

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
  required = false
  rows = 0
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

  removeAttribute(name: string) {
    this.attrs.delete(name)
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

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 'ses_1',
    name: 'Rozpočet',
    source: 'import',
    language: 'cs',
    goal: '',
    prep: '',
    timezone: 'Europe/Prague',
    status: 'ended',
    captureState: 'off',
    transcriptRevision: 1,
    coverageDeclared: 'complete',
    retentionDays: 30,
    createdAt: Date.UTC(2026, 9, 26, 9, 0),
    startedAt: Date.UTC(2026, 9, 26, 9, 1),
    endedAt: Date.UTC(2026, 9, 26, 9, 30),
    expiresAt: Date.UTC(2026, 10, 25, 9, 0),
    endReason: null,
    ...overrides
  }) as Session

const cited = (overrides: Partial<QaResponse> = {}): QaResponse => ({
  answer: {
    text: 'Rozpočet je 120 tisíc korun.',
    evidence: 'sufficient',
    citations: [{ turnId: 'trn_1', revision: 1, startMs: 65_000, endMs: 95_000, quote: 'Rozpočet na projekt je 120 tisíc korun.' }]
  },
  requestId: 'req_1',
  ...overrides
})

class FakeQaClient {
  calls: Array<{ id: string; question: string; signal?: AbortSignal }> = []
  response: QaResponse = cited()
  failure: Error | null = null

  async list() {
    return { sessions: [session()] }
  }

  ask(id: string, question: string, options?: { signal?: AbortSignal }) {
    this.calls.push({ id, question, signal: options?.signal })
    if (this.failure) return Promise.reject(this.failure)
    return Promise.resolve(this.response)
  }
}

function mount(client: FakeQaClient) {
  const dom = installDom()
  const container = new FakeElement('div')
  const selected: string[] = []
  const errors: string[] = []
  const host: SessionPanelHost = {
    gate: (target) => target,
    error: (text) => errors.push(text),
    create: async () => false,
    select: async (id) => {
      selected.push(id)
    }
  }
  qaPanel.mount(container as unknown as HTMLElement, { client: client as unknown as SessionClient, writerId: 'phone', host })
  return { dom, container, selected, errors }
}

function questionInput(container: FakeElement) {
  return find(container, (element) => element.tagName === 'INPUT' && element.name === 'question')!
}

test('Ask sends the question and renders the answer with a citation chip that opens the session', async (t) => {
  const client = new FakeQaClient()
  const { dom, container, selected, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  const input = questionInput(container)
  input.value = '  Jaký je rozpočet?  '
  find(container, (element) => element.tagName === 'BUTTON' && element.textContent === 'Ask')!.click()
  await settle()

  assert.deepEqual(
    client.calls.map((call) => [call.id, call.question]),
    [['ses_1', 'Jaký je rozpočet?']]
  )
  assert.match(container.textContent, /Rozpočet je 120 tisíc korun/)
  assert.match(container.textContent, /Supported by transcript/)
  assert.deepEqual(errors, [])

  const chip = find(container, (element) => element.tagName === 'BUTTON' && element.className.includes('qa-citation'))!
  assert.match(chip.textContent, /\[01:05\]/)
  assert.match(chip.textContent, /Rozpočet na projekt/)
  chip.click()
  await settle()
  assert.deepEqual(selected, ['ses_1'])
})

test('an insufficient answer is shown as a clear message, not as an error', async (t) => {
  const client = new FakeQaClient()
  client.response = {
    answer: { text: 'The transcript does not contain enough evidence to answer this question.', evidence: 'insufficient', citations: [] },
    requestId: 'req_2'
  }
  const { dom, container, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  questionInput(container).value = 'Kolik stojí raketa?'
  find(container, (element) => element.tagName === 'BUTTON' && element.textContent === 'Ask')!.click()
  await settle()

  assert.match(container.textContent, /not contain enough evidence/i)
  assert.match(container.textContent, /Not enough evidence/)
  assert.equal(
    find(container, (element) => element.className.includes('qa-citation')),
    undefined
  )
  assert.deepEqual(errors, [])
})

test('an empty question is refused before the gateway call', async (t) => {
  const client = new FakeQaClient()
  const { dom, container, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  find(container, (element) => element.tagName === 'BUTTON' && element.textContent === 'Ask')!.click()
  await settle()

  assert.equal(client.calls.length, 0)
  assert.deepEqual(errors, ['Enter a question.'])
})

test('a gateway failure is reported through the host error line', async (t) => {
  const client = new FakeQaClient()
  client.failure = new Error('boom')
  const { dom, container, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  questionInput(container).value = 'rozpočet'
  find(container, (element) => element.tagName === 'BUTTON' && element.textContent === 'Ask')!.click()
  await settle()

  assert.deepEqual(errors, ['Unexpected error. Refresh and try again.'])
  assert.doesNotMatch(container.textContent, /Supported by transcript/)
})
