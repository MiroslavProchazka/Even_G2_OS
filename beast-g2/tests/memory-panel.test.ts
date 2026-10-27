import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MemoryItem, MemoryStatus, ProposeMemoryInput, Session, SessionClient, SessionDetail, SessionTurn, SupersedeMemoryInput } from '../src/session-api'
import type { SessionPanelHost } from '../src/sessions'
import { memoryPanel } from '../src/sessions/panels/memory'

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

function findAll(root: FakeElement, predicate: (element: FakeElement) => boolean) {
  return all(root).filter(predicate)
}

function findButton(root: FakeElement, label: string) {
  return find(root, (element) => element.tagName === 'BUTTON' && element.textContent === label)
}

function findSelect(root: FakeElement, name: string) {
  return find(root, (element) => element.tagName === 'SELECT' && element.name === name)
}

function findInput(root: FakeElement, name: string) {
  return find(root, (element) => element.tagName === 'INPUT' && element.name === name)
}

function findItem(root: FakeElement, text: string) {
  return find(root, (element) => element.className.includes('sessions-memory-item') && element.textContent.includes(text))
}

const settle = async () => {
  for (let index = 0; index < 4; index++) await new Promise((resolve) => setImmediate(resolve))
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

const turns: SessionTurn[] = [
  {
    id: 'trn_1',
    segmentId: 'seg_1',
    text: 'Rozpočet na projekt je 120 tisíc korun.',
    revision: 2,
    source: 'stt',
    startMs: 0,
    endMs: 30_000,
    createdAt: Date.UTC(2026, 9, 26, 9, 1),
    updatedAt: Date.UTC(2026, 9, 26, 9, 1)
  },
  {
    id: 'trn_2',
    segmentId: 'seg_2',
    text: 'Klient potvrdil, že to stihneme do pátku.',
    revision: 3,
    source: 'stt',
    startMs: 30_000,
    endMs: 60_000,
    createdAt: Date.UTC(2026, 9, 26, 9, 2),
    updatedAt: Date.UTC(2026, 9, 26, 9, 2)
  }
]

const detail = (overrides: Partial<SessionDetail> = {}): SessionDetail => ({
  session: session(),
  segments: [],
  turns,
  gaps: [],
  jobs: [],
  summaries: [],
  preparation: null,
  ...overrides
})

const item = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem_1',
  sessionId: 'ses_1',
  turnId: 'trn_2',
  turnRevision: 3,
  kind: 'commitment',
  text: 'Ship the client by Friday.',
  sourceQuote: 'Klient potvrdil, že to stihneme do pátku.',
  status: 'proposed',
  supersedesId: null,
  sourceDeleted: false,
  evidenceState: 'present',
  createdAt: Date.UTC(2026, 9, 26, 9, 5),
  updatedAt: Date.UTC(2026, 9, 26, 9, 5),
  approvedAt: null,
  rejectedAt: null,
  supersededAt: null,
  ...overrides
})

class FakeMemoryClient {
  sessions: Session[] = [session()]
  turns: SessionTurn[] = turns
  items: MemoryItem[] = []
  listCalls = 0
  memoryCalls: Array<{ id: string; options?: { status?: MemoryStatus | 'all'; query?: string } }> = []
  retainedCalls: Array<{ status?: MemoryStatus | 'all'; query?: string }> = []
  retainedItems: MemoryItem[] = []
  detailCalls: string[] = []
  proposals: Array<{ id: string; input: ProposeMemoryInput }> = []
  statusCalls: Array<{ id: string; memoryId: string; status: 'approved' | 'rejected' }> = []
  supersedeCalls: Array<{ id: string; memoryId: string; input: SupersedeMemoryInput }> = []
  statusFailure: Error | null = null

  async list() {
    this.listCalls++
    return { sessions: this.sessions }
  }

  async detail(id: string) {
    this.detailCalls.push(id)
    return detail({ session: session({ id }), turns: this.turns })
  }

  async memoryForSession(id: string, options?: { status?: MemoryStatus | 'all'; query?: string }) {
    this.memoryCalls.push({ id, options })
    return { items: this.items }
  }

  async listRetainedMemory(options?: { status?: MemoryStatus | 'all'; query?: string }) {
    this.retainedCalls.push(options ?? {})
    return { items: this.retainedItems }
  }

  async proposeMemory(id: string, input: ProposeMemoryInput) {
    this.proposals.push({ id, input })
    return { item: item({ sessionId: id, turnId: input.turnId, turnRevision: input.revision, kind: input.kind, text: input.text }) }
  }

  async setMemoryStatus(id: string, memoryId: string, status: 'approved' | 'rejected') {
    this.statusCalls.push({ id, memoryId, status })
    if (this.statusFailure) throw this.statusFailure
    return { item: item({ id: memoryId, status }) }
  }

  async supersedeMemory(id: string, memoryId: string, input: SupersedeMemoryInput) {
    this.supersedeCalls.push({ id, memoryId, input })
    return { item: item({ id: 'mem_new', text: input.text }), superseded: item({ id: memoryId }) }
  }
}

function mount(client: FakeMemoryClient, options: { sessions?: Session[]; subscribe?: boolean } = {}) {
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
  memoryPanel.mount(container as unknown as HTMLElement, { client: client as unknown as SessionClient, writerId: 'phone', host })
  return { dom, container, selected, errors, notify: (sessions: Session[]) => notify?.(sessions) }
}

test('a proposal sends the exact turn id and revision from the session detail', async (t) => {
  const client = new FakeMemoryClient()
  const { dom, container, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  assert.deepEqual(client.memoryCalls, [{ id: 'ses_1', options: { status: 'all' } }])
  const turnSelect = findSelect(container, 'turn')!
  assert.deepEqual(
    turnSelect.children.map((option) => option.value),
    ['trn_1', 'trn_2']
  )

  turnSelect.value = 'trn_2'
  findSelect(container, 'kind')!.value = 'commitment'
  findInput(container, 'text')!.value = '  Ship the client by Friday.  '
  findButton(container, 'Propose memory')!.click()
  await settle()

  assert.deepEqual(client.proposals, [{ id: 'ses_1', input: { turnId: 'trn_2', revision: 3, kind: 'commitment', text: 'Ship the client by Friday.' } }])
  assert.equal(client.memoryCalls.length, 2)
  assert.equal(findInput(container, 'text')!.value, '')
  assert.deepEqual(errors, [])
})

test('approve and reject call the status route and reload the list', async (t) => {
  const client = new FakeMemoryClient()
  client.items = [item({ id: 'mem_1', text: 'First claim' }), item({ id: 'mem_2', text: 'Second claim' })]
  const { dom, container, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  findButton(findItem(container, 'First claim')!, 'Approve')!.click()
  await settle()
  assert.deepEqual(client.statusCalls, [{ id: 'ses_1', memoryId: 'mem_1', status: 'approved' }])

  findButton(findItem(container, 'Second claim')!, 'Reject')!.click()
  await settle()
  assert.deepEqual(client.statusCalls, [
    { id: 'ses_1', memoryId: 'mem_1', status: 'approved' },
    { id: 'ses_1', memoryId: 'mem_2', status: 'rejected' }
  ])
  assert.equal(client.memoryCalls.length, 3)
  assert.deepEqual(errors, [])
})

test('a replacement calls supersedeMemory and reloads the list', async (t) => {
  const client = new FakeMemoryClient()
  client.items = [item({ id: 'mem_1', status: 'approved', text: 'Ship on Friday.' })]
  const { dom, container, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  findButton(findItem(container, 'Ship on Friday.')!, 'Replace')!.click()
  const replacement = findInput(container, 'replacement')!
  assert.equal(replacement.value, 'Ship on Friday.')
  replacement.value = '  Ship on Thursday.  '
  client.items = [item({ id: 'mem_2', status: 'superseded', text: 'Ship on Thursday.', supersedesId: 'mem_1' })]
  findButton(container, 'Save replacement')!.click()
  await settle()

  assert.deepEqual(client.supersedeCalls, [{ id: 'ses_1', memoryId: 'mem_1', input: { text: 'Ship on Thursday.' } }])
  assert.equal(client.memoryCalls.length, 2)
  assert.match(container.textContent, /Superseded/)
  assert.match(container.textContent, /Ship on Thursday/)
  assert.deepEqual(errors, [])
})

test('a failed action is reported through the host error line', async (t) => {
  const client = new FakeMemoryClient()
  client.items = [item({ id: 'mem_1', text: 'A claim to approve' })]
  client.statusFailure = new Error('boom')
  const { dom, container, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  findButton(findItem(container, 'A claim to approve')!, 'Approve')!.click()
  await settle()

  assert.deepEqual(errors, ['Unexpected error. Refresh and try again.'])
  assert.equal(client.memoryCalls.length, 1)
})

test('a lost source disables the source link and says the evidence is lost', async (t) => {
  const client = new FakeMemoryClient()
  client.items = [
    item({ id: 'mem_1', text: 'Deleted source', sourceDeleted: true }),
    item({ id: 'mem_2', text: 'Lost evidence', evidenceState: 'lost' }),
    item({ id: 'mem_3', text: 'Present source' })
  ]
  const { dom, container, selected, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  const sourceButtons = findAll(container, (element) => element.tagName === 'BUTTON' && element.textContent === 'Open source')
  assert.equal(sourceButtons.length, 3)
  assert.equal(sourceButtons[0]!.disabled, true)
  assert.equal(sourceButtons[1]!.disabled, true)
  assert.equal(sourceButtons[2]!.disabled, false)
  assert.equal((container.textContent.match(/Source deleted · evidence lost/g) ?? []).length, 2)

  sourceButtons[0]!.click()
  sourceButtons[1]!.click()
  assert.deepEqual(selected, [])
  sourceButtons[2]!.click()
  await settle()
  assert.deepEqual(selected, ['ses_1'])
  assert.deepEqual(errors, [])
})

test('the empty state clears when memory items arrive', async (t) => {
  const client = new FakeMemoryClient()
  const { dom, container, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  assert.match(container.textContent, /No memory items for this session yet/)

  client.items = [item({ text: 'A new claim' })]
  findInput(container, 'text')!.value = 'A new claim'
  findButton(container, 'Propose memory')!.click()
  await settle()

  assert.doesNotMatch(container.textContent, /No memory items for this session yet/)
  assert.match(container.textContent, /A new claim/)
  assert.equal(client.memoryCalls.length, 2)
  assert.deepEqual(errors, [])
})

test('a session-list refresh fills the picker and preserves the selected id', async (t) => {
  const client = new FakeMemoryClient()
  const { dom, container, notify } = mount(client, { sessions: [] })
  t.after(dom.restore)
  await settle()

  const select = findSelect(container, 'session')!
  assert.equal(select.disabled, true)
  assert.equal(select.children.length, 0)

  notify([session({ id: 'ses_2', name: 'Second' })])
  await settle()
  assert.equal(select.disabled, false)
  assert.deepEqual(
    select.children.map((option) => option.value),
    ['ses_2']
  )
  assert.equal(select.value, 'ses_2')
  assert.ok(client.memoryCalls.some((call) => call.id === 'ses_2'))

  notify([session({ id: 'ses_1', name: 'First' }), session({ id: 'ses_2', name: 'Second' })])
  await settle()
  assert.equal(select.value, 'ses_2')
})

test('kept memory stays visible and read-only after its source session is gone', async (t) => {
  const client = new FakeMemoryClient()
  client.retainedItems = [item({ id: 'mem_kept', sessionId: 'ses_deleted', text: 'Kept claim', sourceDeleted: true, evidenceState: 'lost' })]
  const { dom, container, errors } = mount(client)
  t.after(dom.restore)
  await settle()

  assert.match(container.textContent, /Kept memory/)
  assert.match(container.textContent, /Kept claim/)
  assert.equal(client.retainedCalls.length, 1)
  assert.equal(client.retainedCalls[0]!.status, 'all')
  const source = findButton(container, 'Open source')!
  assert.equal(source.disabled, true)
  assert.equal(findAll(container, (element) => element.tagName === 'BUTTON' && element.textContent === 'Approve').length, 0)
  assert.deepEqual(errors, [])
})

test('the panel falls back to client.list when the host has no session subscription', async (t) => {
  const client = new FakeMemoryClient()
  const { dom, container, errors } = mount(client, { subscribe: false })
  t.after(dom.restore)
  await settle()

  assert.equal(client.listCalls, 1)
  const select = findSelect(container, 'session')!
  assert.deepEqual(
    select.children.map((option) => option.value),
    ['ses_1']
  )
  assert.equal(select.value, 'ses_1')
  assert.deepEqual(errors, [])
})
