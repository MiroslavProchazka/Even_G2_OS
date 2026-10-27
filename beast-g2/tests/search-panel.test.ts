import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchPanel } from '../src/sessions/panels/search'
import type { SearchResult } from '../src/session-api'
import type { SessionClient } from '../src/session-api'
import type { SessionPanelHost } from '../src/sessions'

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const result = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  sessionId: 'ses_1',
  sessionName: 'Rozpočet',
  turnId: 'trn_1',
  revision: 2,
  startMs: 65_000,
  endMs: 95_000,
  snippet: '[Zrušit] schůzku kvůli rozpočtu',
  sessionCreatedAt: Date.UTC(2026, 9, 26, 9, 0),
  sessionStartedAt: Date.UTC(2026, 9, 26, 9, 1),
  ...overrides
})

class FakeSearchClient {
  calls: Array<{ query: string; limit: number; signal?: AbortSignal }> = []
  results: SearchResult[] = []
  failure: Error | null = null

  search(query: string, limit = 50, options?: { signal?: AbortSignal }) {
    this.calls.push({ query, limit, signal: options?.signal })
    if (this.failure) return Promise.reject(this.failure)
    return Promise.resolve({ results: this.results })
  }
}

class ControlledSearchClient {
  calls: Array<{ query: string; signal?: AbortSignal; resolve: (value: { results: SearchResult[] }) => void }> = []

  search(query: string, _limit = 50, options?: { signal?: AbortSignal }) {
    let resolve!: (value: { results: SearchResult[] }) => void
    const promise = new Promise<{ results: SearchResult[] }>((done, reject) => {
      resolve = done
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
    this.calls.push({ query, signal: options?.signal, resolve })
    return promise
  }
}

function mount(client: unknown) {
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
  searchPanel.mount(container as unknown as HTMLElement, { client: client as SessionClient, writerId: 'phone', host })
  const input = find(container, (element) => element.tagName === 'INPUT')!
  return { dom, container, input, selected, errors }
}

test('typing a query renders hits and clicking a hit selects the session', async (t) => {
  const client = new FakeSearchClient()
  client.results = [result()]
  const { dom, container, input, selected } = mount(client)
  t.after(dom.restore)

  input.value = 'zrusit'
  input.dispatch('input')
  await wait(320)
  await settle()

  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].query, 'zrusit')
  assert.equal(client.calls[0].limit, 20)
  assert.match(container.textContent, /Rozpočet/)
  assert.match(container.textContent, /Zrušit/)
  assert.match(container.textContent, /1 match/)

  const hit = find(container, (element) => element.tagName === 'BUTTON' && element.className === 'search-result')!
  hit.click()
  await settle()
  assert.deepEqual(selected, ['ses_1'])
})

test('typing is debounced and only the last query is sent', async (t) => {
  const client = new FakeSearchClient()
  const { dom, input } = mount(client)
  t.after(dom.restore)

  input.value = 'zr'
  input.dispatch('input')
  await wait(100)
  input.value = 'zrusit'
  input.dispatch('input')
  await wait(320)
  await settle()

  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].query, 'zrusit')
})

test('a new search aborts the previous request and keeps the newest answer', async (t) => {
  const client = new ControlledSearchClient()
  const { dom, container, input } = mount(client)
  t.after(dom.restore)

  input.value = 'first'
  input.dispatch('input')
  await wait(300)
  await settle()
  assert.equal(client.calls.length, 1)

  input.value = 'second'
  input.dispatch('input')
  await wait(300)
  await settle()
  assert.equal(client.calls.length, 2)
  assert.equal(client.calls[0].signal?.aborted, true)
  assert.equal(client.calls[1].signal?.aborted, false)

  client.calls[1].resolve({ results: [result({ sessionName: 'Druhá', turnId: 'trn_2' })] })
  await settle()
  assert.match(container.textContent, /Druhá/)
  assert.doesNotMatch(container.textContent, /Rozpočet/)
})

test('an empty result set says No matches', async (t) => {
  const client = new FakeSearchClient()
  client.results = []
  const { dom, container, input } = mount(client)
  t.after(dom.restore)

  input.value = 'nic'
  input.dispatch('input')
  await wait(320)
  await settle()

  assert.match(container.textContent, /No matches/)
})

test('a failed search is reported through the host error line', async (t) => {
  const client = new FakeSearchClient()
  client.failure = new Error('boom')
  const { dom, container, input, errors } = mount(client)
  t.after(dom.restore)

  input.value = 'zrusit'
  input.dispatch('input')
  await wait(320)
  await settle()

  assert.deepEqual(errors, ['Unexpected error. Refresh and try again.'])
  assert.doesNotMatch(container.textContent, /Zrušit/)
})
