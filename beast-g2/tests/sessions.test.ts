import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionApiError } from '../src/session-api'
import type { CreateSessionInput, Session, SessionClient, SessionDetail, SessionLanguage, SessionPreparation, SessionSummary, SummaryContent } from '../src/session-api'
import { initSessions, type SessionRecorder } from '../src/sessions'

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
  href = ''
  download = ''
  focused = false
  scrolled = false
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

  scrollIntoView() {
    this.scrolled = true
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

const content: SummaryContent = {
  schemaVersion: 1,
  overview: { text: 'We agreed to ship.', citations: ['turn_1'] },
  decisions: [{ text: 'Ship on Friday.', citations: ['turn_1'] }],
  actionCandidates: [{ text: 'Send the plan.', owner: null, due: null, dueText: 'next week', conditional: false, citations: ['turn_2'] }],
  openQuestions: [{ text: 'Who owns the rollout?', citations: ['turn_2'] }]
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
    status: 'ended',
    captureState: 'off',
    transcriptRevision: 1,
    coverageDeclared: 'partial',
    retentionDays: 30,
    createdAt: Date.UTC(2026, 9, 26, 9, 0),
    startedAt: Date.UTC(2026, 9, 26, 9, 1),
    endedAt: Date.UTC(2026, 9, 26, 9, 11),
    expiresAt: Date.UTC(2026, 10, 25, 9, 0),
    endReason: null,
    ...overrides
  }) as Session

const summary = (overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id: 'sum_1',
    sessionId: 'ses_1',
    transcriptRevision: 1,
    generator: 'test',
    promptVersion: 'v1',
    content,
    coverage: {},
    status: 'ready',
    reviewStatus: 'unreviewed',
    staleReason: null,
    lastError: null,
    supersedesId: null,
    createdAt: Date.UTC(2026, 9, 26, 9, 12),
    updatedAt: Date.UTC(2026, 9, 26, 9, 12),
    readyAt: Date.UTC(2026, 9, 26, 9, 12),
    editedAt: null,
    citations: [
      { turnId: 'turn_1', turnRevision: 1, startMs: 5_000, endMs: 9_000, quote: 'We agreed to ship.' },
      { turnId: 'turn_2', turnRevision: 1, startMs: 65_000, endMs: 70_000, quote: 'I will send the plan next week.' }
    ],
    actionCandidates: [],
    ...overrides
  }) as SessionSummary

const preparation = (overrides: Partial<SessionPreparation> = {}): SessionPreparation => {
  const focus = overrides.focus ?? null
  return {
    id: 'prep_1',
    sessionId: 'ses_1',
    sourceSessionId: 'ses_0',
    sourceSummaryId: 'sum_1',
    sourceTranscriptRevision: 1,
    focus,
    content: {
      schemaVersion: 1,
      focus,
      source: {
        sessionId: 'ses_0',
        sessionName: 'Previous call',
        summaryId: 'sum_1',
        summaryCreatedAt: '2026-10-25T09:12:00.000Z',
        transcriptRevision: 1,
        sessionDate: '2026-10-25T09:00:00.000Z'
      },
      summary: content,
      citations: [{ turnId: 'turn_1', turnRevision: 1, startMs: 5_000, endMs: 9_000, quote: 'We agreed to ship.', date: '2026-10-25T09:00:00.000Z' }]
    },
    status: 'ready',
    staleReason: null,
    createdAt: Date.UTC(2026, 9, 26, 9, 13),
    updatedAt: Date.UTC(2026, 9, 26, 9, 13),
    ...overrides
  } as SessionPreparation
}

const detail = (overrides: Partial<SessionDetail> = {}): SessionDetail => ({
  session: session(),
  segments: [],
  turns: [
    { id: 'turn_1', segmentId: 'seg_1', text: 'We agreed to ship.', revision: 1, source: 'stt', startMs: 5_000, endMs: 9_000, createdAt: 1, updatedAt: 1 },
    { id: 'turn_2', segmentId: 'seg_2', text: 'I will send the plan next week.', revision: 1, source: 'stt', startMs: 65_000, endMs: 70_000, createdAt: 1, updatedAt: 1 }
  ],
  gaps: [{ id: 'gap_1', startMs: 30_000, endMs: 45_000, reason: 'missing_segment', state: 'open', createdAt: 1, resolvedAt: null }],
  jobs: [
    { id: 'job_1', type: 'transcribe', segmentId: 'seg_3', state: 'pending', attempts: 0, maxAttempts: 3, lastError: null, createdAt: 1, updatedAt: 1 },
    { id: 'job_2', type: 'transcribe', segmentId: 'seg_4', state: 'failed', attempts: 3, maxAttempts: 3, lastError: 'stt failed', createdAt: 1, updatedAt: 1 },
    { id: 'job_3', type: 'transcribe', segmentId: 'seg_5', state: 'done', attempts: 1, maxAttempts: 3, lastError: null, createdAt: 1, updatedAt: 1 }
  ],
  summaries: [summary()],
  preparation: null,
  ...overrides
})

class FakeClient {
  calls: Array<{ method: string; args: unknown[] }> = []
  sessions: Session[] = []
  details = new Map<string, SessionDetail>()
  createResult: Session | null = null
  requestSummaryResult: SessionSummary | null = null
  requestSummaryError: unknown = null
  summaryResult: SessionSummary | null = null
  updatedSummary: SessionSummary | null = null
  preparationResult: SessionPreparation | null = null

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args })
  }

  async list(limit = 50) {
    this.record('list', limit)
    return { sessions: this.sessions }
  }

  async detail(id: string) {
    this.record('detail', id)
    return this.details.get(id) ?? detail({ session: session({ id }) })
  }

  async create(input: CreateSessionInput) {
    this.record('create', input)
    return {
      session: this.createResult ?? session({ id: 'ses_new', name: input.name, language: input.language ?? 'cs', goal: input.goal ?? '', prep: input.prep ?? '', status: 'draft', source: 'import' })
    }
  }

  async start(id: string, writerId: string) {
    this.record('start', id, writerId)
    return { session: session({ id, status: 'active', captureState: 'starting' }) }
  }

  async pause(id: string, writerId: string) {
    this.record('pause', id, writerId)
    return { session: session({ id, status: 'paused' }) }
  }

  async resume(id: string, writerId: string) {
    this.record('resume', id, writerId)
    return { session: session({ id, status: 'active' }) }
  }

  async end(id: string, input: { writerId: string; lastSequence?: number }) {
    this.record('end', id, input)
    return { session: session({ id, status: 'ended' }) }
  }

  async requestSummary(id: string, input: { allowPartial?: boolean; force?: boolean }) {
    this.record('requestSummary', id, input)
    if (this.requestSummaryError) throw this.requestSummaryError
    return { summary: this.requestSummaryResult ?? summary({ sessionId: id, status: 'pending', content: {} }), created: true }
  }

  async summary(id: string) {
    this.record('summary', id)
    return { summary: this.summaryResult }
  }

  async updateSummary(id: string, summaryId: string, next: SummaryContent) {
    this.record('updateSummary', id, summaryId, next)
    return { summary: this.updatedSummary ?? summary({ id: summaryId, sessionId: id, content: next }) }
  }

  async createPreparation(id: string, input: { sourceSummaryId: string; focus?: string }) {
    this.record('createPreparation', id, input)
    return { preparation: this.preparationResult ?? preparation({ sessionId: id, sourceSummaryId: input.sourceSummaryId, focus: input.focus ?? null }) }
  }

  async remove(id: string) {
    this.record('remove', id)
  }

  async export(id: string, format: string) {
    this.record('export', id, format)
    return '# export'
  }
}

class FakeRecorder implements SessionRecorder {
  calls: Array<{ method: string; args: unknown[] }> = []
  nextId = 'ses_rec'
  failWith?: Error

  async open(input: { name: string; language: SessionLanguage; goal?: string; prep?: string }) {
    this.calls.push({ method: 'open', args: [input] })
    if (this.failWith) throw this.failWith
    return this.nextId
  }

  async attach(id: string) {
    this.calls.push({ method: 'attach', args: [id] })
  }

  async pause() {
    this.calls.push({ method: 'pause', args: [] })
  }

  async resume() {
    this.calls.push({ method: 'resume', args: [] })
  }

  async end() {
    this.calls.push({ method: 'end', args: [] })
  }
}

test('an empty gateway renders an honest empty state', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  assert.match(section.textContent, /No stored sessions yet/)
  assert.match(section.textContent, /npm run session:import/)
  handle.dispose()
})

test('sessions are listed newest first with date, duration, status, coverage and source', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.sessions = [
    session({ id: 'ses_old', name: 'Older call', createdAt: Date.UTC(2026, 8, 1, 12, 0), startedAt: Date.UTC(2026, 8, 1, 12, 1), endedAt: Date.UTC(2026, 8, 1, 12, 11) }),
    session({ id: 'ses_new', name: 'Newer call', createdAt: Date.UTC(2026, 9, 27, 12, 0), startedAt: Date.UTC(2026, 9, 27, 12, 0), endedAt: Date.UTC(2026, 9, 27, 12, 10) })
  ]
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  const rows = all(section).filter((element) => element.className === 'session-row')
  assert.equal(rows.length, 2)
  assert.match(rows[0]!.textContent, /Newer call/)
  assert.match(rows[0]!.textContent, /27 Oct 2026/)
  assert.match(rows[0]!.textContent, /10:00/)
  assert.match(rows[0]!.textContent, /Ended/)
  assert.match(rows[0]!.textContent, /Partial coverage/)
  assert.match(rows[0]!.textContent, /Import/)
  assert.match(rows[1]!.textContent, /Older call/)
  assert.equal(client.calls.filter((call) => call.method === 'list').at(-1)!.args[0], 50)
  handle.dispose()
})

test('a row opens detail with transcript clocks, gaps, jobs, summary and preparation', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.sessions = [session()]
  client.details.set('ses_1', detail())
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  find(section, (element) => element.className === 'session-row')!.click()
  await settle()
  assert.match(section.textContent, /\[00:05\]/)
  assert.match(section.textContent, /We agreed to ship\./)
  assert.match(section.textContent, /\[01:05\]/)
  assert.match(section.textContent, /00:30 - 00:45/)
  assert.match(section.textContent, /missing segment/)
  assert.match(section.textContent, /1 pending · 1 failed · 1 done/)
  assert.match(section.textContent, /Ship on Friday\./)
  assert.match(section.textContent, /Owner: unassigned/)
  assert.match(section.textContent, /Due: next week/)
  assert.match(section.textContent, /Who owns the rollout\?/)
  assert.match(section.textContent, /No preparation yet/)
  handle.dispose()
})

test('a citation chip scrolls to and highlights the cited turn', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.sessions = [session()]
  client.details.set('ses_1', detail())
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  find(section, (element) => element.className === 'session-row')!.click()
  await settle()
  const chip = find(section, (element) => element.className === 'session-citation' && element.textContent.startsWith('[00:05]'))!
  assert.ok(chip)
  chip.click()
  const turn = find(section, (element) => element.getAttribute('data-turn-id') === 'turn_1')!
  assert.equal(turn.classList.contains('session-turn-cited'), true)
  assert.equal(turn.scrolled, true)
  handle.dispose()
})

test('creating a session without a recorder imports a draft and explains the import command', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.createResult = session({ id: 'ses_new', name: 'Fresh call', status: 'draft' })
  client.details.set('ses_new', detail({ session: session({ id: 'ses_new', name: 'Fresh call', status: 'draft' }) }))
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  const form = findForm(section, 'sessions-create')!
  find(form, (element) => element.name === 'name')!.value = 'Fresh call'
  findButton(form, 'Create session')!.click()
  await settle()
  const call = client.calls.find((entry) => entry.method === 'create')!
  assert.deepEqual(call.args[0], { name: 'Fresh call', language: 'cs', source: 'import' })
  assert.match(section.textContent, /npm run session:import/)
  assert.match(section.textContent, /Fresh call/)
  handle.dispose()
})

test('a recorder opens the returned session and the panel shows it', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.details.set('ses_rec', detail({ session: session({ id: 'ses_rec', name: 'Live call', status: 'active', captureState: 'on' }) }))
  const recorder = new FakeRecorder()
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone', recorder })
  await settle()
  const section = dom.document.main.children[0]!
  const form = findForm(section, 'sessions-create')!
  find(form, (element) => element.name === 'name')!.value = 'Live call'
  find(form, (element) => element.name === 'language')!.value = 'en'
  find(form, (element) => element.name === 'goal')!.value = 'Ship it'
  find(form, (element) => element.name === 'prep')!.value = 'Bring notes'
  findButton(form, 'Start recording')!.click()
  await settle()
  assert.deepEqual(recorder.calls[0], { method: 'open', args: [{ name: 'Live call', language: 'en', goal: 'Ship it', prep: 'Bring notes' }] })
  assert.match(section.textContent, /Recording started/)
  assert.match(section.textContent, /Live call/)
  assert.ok(client.calls.some((call) => call.method === 'detail' && call.args[0] === 'ses_rec'))
  handle.dispose()
})

test('a recorder failure shows its own message instead of a generic error', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  const recorder = new FakeRecorder()
  recorder.failWith = new Error('G2 microphone not connected. Use a text question to test the gateway.')
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone', recorder })
  await settle()
  const section = dom.document.main.children[0]!
  const form = findForm(section, 'sessions-create')!
  find(form, (element) => element.name === 'name')!.value = 'Live call'
  findButton(form, 'Start recording')!.click()
  await settle()
  assert.match(section.textContent, /G2 microphone not connected/)
  assert.doesNotMatch(section.textContent, /Unexpected error/)
  assert.equal(client.calls.filter((call) => call.method === 'create').length, 0)
  handle.dispose()
})

test('starting a draft session with a recorder attaches instead of creating another', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.sessions = [session({ id: 'ses_draft', name: 'Draft call', status: 'draft' })]
  client.details.set('ses_draft', detail({ session: session({ id: 'ses_draft', name: 'Draft call', status: 'draft' }) }))
  const recorder = new FakeRecorder()
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone', recorder })
  await settle()
  const section = dom.document.main.children[0]!
  find(section, (element) => element.className === 'session-row')!.click()
  await settle()
  findButton(section, 'Start')!.click()
  await settle()
  assert.deepEqual(recorder.calls, [{ method: 'attach', args: ['ses_draft'] }])
  assert.equal(client.calls.filter((call) => call.method === 'create').length, 0)
  handle.dispose()
})

test('a summary conflict offers a force regeneration button', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.sessions = [session()]
  client.details.set('ses_1', detail())
  client.requestSummaryError = new SessionApiError(409, 'summary_edited', 'The summary has a manual edit.', 'req_7')
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  find(section, (element) => element.className === 'session-row')!.click()
  await settle()
  findButton(section, 'Request summary')!.click()
  await settle()
  assert.match(section.textContent, /manual edit/)
  const force = findButton(section, 'Regenerate and replace edit')
  assert.ok(force)
  force!.click()
  await settle()
  const requests = client.calls.filter((call) => call.method === 'requestSummary')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1]!.args[1], { allowPartial: false, force: true })
  handle.dispose()
})

test('start and end use the writer id and end omits an unknown last sequence', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.sessions = [session()]
  client.details.set('ses_1', detail({ session: session({ status: 'draft' }) }))
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  find(section, (element) => element.className === 'session-row')!.click()
  await settle()
  findButton(section, 'Start')!.click()
  await settle()
  assert.deepEqual(client.calls.find((call) => call.method === 'start')!.args, ['ses_1', 'phone'])

  client.details.set('ses_1', detail({ session: session({ status: 'active' }) }))
  findButton(section, 'Refresh session')!.click()
  await settle()
  findButton(section, 'End')!.click()
  await settle()
  const end = client.calls.find((call) => call.method === 'end')!
  assert.deepEqual(end.args, ['ses_1', { writerId: 'phone' }])
  handle.dispose()
})

test('manual summary editing preserves citations and only allows removal', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.sessions = [session()]
  client.details.set('ses_1', detail())
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  find(section, (element) => element.className === 'session-row')!.click()
  await settle()
  findButton(section, 'Edit summary')!.click()
  await settle()
  const overview = find(section, (element) => element.tagName === 'TEXTAREA' && element.value === 'We agreed to ship.')!
  overview.value = 'We agreed to ship on Monday.'
  const removeDecision = all(section).filter((element) => element.type === 'checkbox')[0]!
  removeDecision.checked = true
  findButton(section, 'Save changes')!.click()
  await settle()
  const call = client.calls.find((entry) => entry.method === 'updateSummary')!
  const saved = call.args[2] as SummaryContent
  assert.equal(saved.overview.text, 'We agreed to ship on Monday.')
  assert.deepEqual(saved.overview.citations, ['turn_1'])
  assert.equal(saved.decisions.length, 0)
  assert.equal(saved.actionCandidates.length, 1)
  assert.deepEqual(saved.actionCandidates[0]!.citations, ['turn_2'])
  assert.equal(saved.actionCandidates[0]!.owner, null)
  assert.equal(saved.actionCandidates[0]!.dueText, 'next week')
  assert.equal(saved.openQuestions.length, 1)
  assert.match(section.textContent, /manual edit/)
  handle.dispose()
})

test('a ready summary becomes a preparation snapshot with source date, focus and citations', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.sessions = [session()]
  client.details.set('ses_1', detail())
  client.preparationResult = preparation({ focus: 'Next steps' })
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  find(section, (element) => element.className === 'session-row')!.click()
  await settle()
  const select = find(section, (element) => element.tagName === 'SELECT')!
  select.value = 'sum_1'
  find(section, (element) => element.tagName === 'TEXTAREA' && element.placeholder === 'What should the next conversation build on?')!.value = 'Next steps'
  findButton(section, 'Use as preparation')!.click()
  await settle()
  assert.deepEqual(client.calls.find((call) => call.method === 'createPreparation')!.args, ['ses_1', { sourceSummaryId: 'sum_1', focus: 'Next steps' }])
  assert.match(section.textContent, /Previous call/)
  assert.match(section.textContent, /Focus: Next steps/)
  assert.match(section.textContent, /We agreed to ship\./)
  assert.match(section.textContent, /Source passages/)
  handle.dispose()
})

test('dispose removes the section, clears timers and resets the glasses line', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.sessions = [session()]
  client.details.set('ses_1', detail())
  const statuses: string[] = []
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone', onGlassesStatus: (text) => statuses.push(text) })
  await settle()
  const section = dom.document.main.children[0]!
  find(section, (element) => element.className === 'session-row')!.click()
  await settle()
  assert.ok(statuses.includes('SESS 1 - ENDED'))
  const calls = client.calls.length
  handle.dispose()
  assert.equal(dom.document.main.children.length, 0)
  assert.equal(statuses.at(-1), '')
  await handle.refresh()
  assert.equal(client.calls.length, calls)
})

test('gateway failures are short, actionable and never expose a stack trace', async (t) => {
  const dom = installDom()
  t.after(dom.restore)
  const client = new FakeClient()
  client.list = async () => {
    throw new SessionApiError(500, 'http_error', 'at /srv/app/server.js:10:3', 'req_5')
  }
  const handle = initSessions({ client: client as unknown as SessionClient, writerId: 'phone' })
  await settle()
  const section = dom.document.main.children[0]!
  assert.match(section.textContent, /HTTP 500, http_error/)
  assert.match(section.textContent, /req_5/)
  assert.doesNotMatch(section.textContent, /server\.js/)
  handle.dispose()
})
