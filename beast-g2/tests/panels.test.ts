import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initSessions, type SessionPanelHost } from '../src/sessions'
import { mountSessionPanels, registerSessionPanel } from '../src/sessions/panels'
import type { CreateSessionInput, Session, SessionClient, SessionDetail } from '../src/session-api'

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

  remove() {
    if (!this.parent) return
    const index = this.parent.children.indexOf(this)
    if (index >= 0) this.parent.children.splice(index, 1)
    this.parent = null
  }
}

class FakeDocument {
  main = new FakeElement('main')
  querySelector(selector: string) {
    return selector === 'main' ? this.main : null
  }
  createElement(tagName: string) {
    return new FakeElement(tagName)
  }
}

function installDom() {
  const document = new FakeDocument()
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  globalThis.document = document as unknown as Document
  globalThis.window = { confirm: () => true } as unknown as Window & typeof globalThis
  return {
    document,
    restore() {
      globalThis.document = previousDocument
      globalThis.window = previousWindow
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

function findButton(root: FakeElement, label: string) {
  return find(root, (element) => element.tagName === 'BUTTON' && element.textContent === label)
}

function findForm(root: FakeElement, className: string) {
  return find(root, (element) => element.tagName === 'FORM' && element.className === className)
}

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 'ses_1',
    name: 'Monday call',
    source: 'import',
    language: 'cs',
    goal: '',
    prep: '',
    timezone: 'Europe/Prague',
    status: 'draft',
    captureState: 'off',
    transcriptRevision: 0,
    coverageDeclared: 'unknown',
    retentionDays: 30,
    createdAt: Date.UTC(2026, 9, 26, 9, 0),
    startedAt: null,
    endedAt: null,
    expiresAt: Date.UTC(2026, 10, 25, 9, 0),
    endReason: null,
    ...overrides
  }) as Session

const detail = (overrides: Partial<SessionDetail> = {}): SessionDetail => ({ session: session(), segments: [], turns: [], gaps: [], jobs: [], summaries: [], preparation: null, ...overrides })

const host = (): SessionPanelHost => ({ gate: (target) => target, error: () => {}, create: async () => false })

class FakeClient {
  calls: Array<{ method: string; args: unknown[] }> = []
  sessions: Session[] = []
  details = new Map<string, SessionDetail>()

  async list(limit = 50) {
    this.calls.push({ method: 'list', args: [limit] })
    return { sessions: this.sessions }
  }

  async detail(id: string) {
    this.calls.push({ method: 'detail', args: [id] })
    return this.details.get(id) ?? detail({ session: session({ id }) })
  }

  async create(input: CreateSessionInput) {
    this.calls.push({ method: 'create', args: [input] })
    return { session: session({ id: 'ses_new', name: input.name, language: input.language ?? 'cs', goal: input.goal ?? '', prep: input.prep ?? '', source: 'import' }) }
  }
}

test('a registered panel is mounted with the section and the deps', (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const seen: Array<{ writerId: string; tag: string }> = []
  registerSessionPanel({
    id: 'test-panel',
    mount(section, deps) {
      seen.push({ writerId: deps.writerId, tag: section.tagName })
      const marker = dom.document.createElement('p') as unknown as HTMLElement
      marker.className = 'test-panel'
      marker.textContent = 'Registered panel content'
      section.append(marker)
    }
  })
  const container = new FakeElement('div')
  mountSessionPanels(container as unknown as HTMLElement, { client: new FakeClient() as unknown as SessionClient, writerId: 'phone', host: host() })
  assert.deepEqual(seen, [{ writerId: 'phone', tag: 'DIV' }])
  assert.match(container.textContent, /Registered panel content/)
})

test('registering the same panel id twice replaces the earlier panel', (t) => {
  const dom = installDom()
  t.after(dom.restore)
  registerSessionPanel({ id: 'duplicate-panel', mount: (section) => section.append('first panel') })
  registerSessionPanel({ id: 'duplicate-panel', mount: (section) => section.append('second panel') })
  const container = new FakeElement('div')
  mountSessionPanels(container as unknown as HTMLElement, { client: new FakeClient() as unknown as SessionClient, writerId: 'phone', host: host() })
  assert.doesNotMatch(container.textContent, /first panel/)
  assert.match(container.textContent, /second panel/)
})

test('initSessions mounts the registered panels next to the new session form', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  registerSessionPanel({ id: 'init-panel', mount: (section) => section.append('Panel mounted by initSessions') })
  const client = new FakeClient()
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  assert.match(section.textContent, /Panel mounted by initSessions/)
  assert.match(section.textContent, /New session/)
  assert.ok(findForm(section, 'sessions-create'))
  handle.dispose()
})

test('the new session panel creates a session through the host', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.details.set('ses_new', detail({ session: session({ id: 'ses_new', name: 'Fresh call' }) }))
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  const form = findForm(section, 'sessions-create')!
  const name = find(form, (element) => element.name === 'name')!
  name.value = 'Fresh call'
  findButton(form, 'Create session')!.click()
  await settle()
  assert.deepEqual(client.calls.find((call) => call.method === 'create')!.args[0], { name: 'Fresh call', language: 'cs', source: 'import' })
  assert.match(find(section, (element) => element.className === 'sessions-status')!.textContent, /Session created/)
  assert.match(section.textContent, /Fresh call/)
  assert.equal(name.value, '')
  handle.dispose()
})

test('the new session panel refuses an empty name without calling the gateway', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  const form = findForm(section, 'sessions-create')!
  const name = find(form, (element) => element.name === 'name')!
  findButton(form, 'Create session')!.click()
  await settle()
  assert.equal(client.calls.filter((call) => call.method === 'create').length, 0)
  assert.match(find(section, (element) => element.className === 'sessions-error')!.textContent, /Enter a session name/)
  assert.equal(name.focused, true)
  handle.dispose()
})
