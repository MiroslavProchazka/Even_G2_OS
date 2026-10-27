import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPTION_CHARS, CAPTION_HISTORY, CaptionsController, captionsHud, type CaptionsControl, type CaptionsOptions, type CaptionsState } from '../src/captions'
import { pcmFrame } from '../src/continuous-demo'
import { bindCaptions, captionsPanel } from '../src/sessions/panels/captions'
import type { CreateSessionInput, Session, SessionClient, SessionDetail } from '../src/session-api'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const settle = async () => {
  for (let index = 0; index < 5; index++) await tick()
}

function setup(t: any, options: CaptionsOptions = {}, texts: string[] = ['Dobrý den.']) {
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
  const asked: Uint8Array<ArrayBuffer>[] = []
  let index = 0
  const controller = new CaptionsController(
    audio,
    async (wav) => {
      asked.push(wav)
      return texts[Math.min(index++, texts.length - 1)]
    },
    () => {},
    options
  )
  t.after(() => controller.dispose())
  return { controller, audio, asked }
}

/** One VAD utterance: silence, three seconds of speech, then two seconds of silence. */
function utterance(controller: CaptionsController) {
  for (let index = 0; index < 15; index++) controller.onPcm(pcmFrame(false))
  for (let index = 0; index < 30; index++) controller.onPcm(pcmFrame(true))
  for (let index = 0; index < 105; index++) controller.onPcm(pcmFrame(false))
}

test('a started captions stream shows its final line on the glasses and the phone', async (t) => {
  const { controller, audio, asked } = setup(t)
  assert.equal(await controller.start(), true)
  assert.equal(audio.starts, 1)
  utterance(controller)
  await settle()
  assert.equal(asked.length, 1)
  assert.equal(controller.state.caption, 'Dobrý den.')
  assert.deepEqual(
    controller.state.lines.map((line) => line.text),
    ['Dobrý den.']
  )
  assert.match(captionsHud(controller.state), /CAPTIONS \/ LIVE · NOT STORED/)
  assert.match(captionsHud(controller.state), /Dobrý den\./)
  assert.match(controller.statusLine(), /nothing stored/)
})

test('stopping captions clears the caption and the history', async (t) => {
  const { controller, audio } = setup(t)
  await controller.start()
  utterance(controller)
  await settle()
  assert.equal(controller.state.caption, 'Dobrý den.')
  await controller.stop()
  assert.equal(audio.stops, 1)
  assert.equal(controller.state.caption, '')
  assert.deepEqual(controller.state.lines, [])
  assert.equal(controller.state.phase, 'off')
  assert.doesNotMatch(captionsHud(controller.state), /Dobrý den/)
  assert.match(captionsHud(controller.state), /CAPTIONS \/ OFF · NOT STORED/)
})

test('the in-memory history is bounded and every caption is cut to the limit', async (t) => {
  const texts = Array.from({ length: CAPTION_HISTORY + 5 }, (_, index) => `Line ${index + 1}`)
  const { controller } = setup(t, {}, texts)
  await controller.start()
  for (let index = 0; index < texts.length; index++) {
    utterance(controller)
    await settle()
  }
  assert.equal(controller.state.lines.length, CAPTION_HISTORY)
  assert.equal(controller.state.lines.at(-1)?.text, `Line ${CAPTION_HISTORY + 5}`)
  assert.equal(controller.state.lines[0]?.text, 'Line 6')

  const long = setup(t, {}, ['x'.repeat(400)])
  await long.controller.start()
  utterance(long.controller)
  await settle()
  assert.equal(long.controller.state.caption.length, CAPTION_CHARS)
})

test('a start is refused while another mode holds the microphone', async (t) => {
  const { controller, audio, asked } = setup(t, { microphoneOwner: () => 'continuous listening' })
  assert.equal(await controller.start(), false)
  assert.equal(audio.starts, 0)
  assert.equal(controller.state.microphone, 'off')
  assert.match(controller.state.error, /in use by continuous listening/)
  assert.match(controller.statusLine(), /continuous listening/)
  utterance(controller)
  await settle()
  assert.equal(asked.length, 0)
})

test('dispose stops the microphone and discards the text', async (t) => {
  const { controller, audio } = setup(t)
  await controller.start()
  utterance(controller)
  await settle()
  assert.equal(controller.state.caption, 'Dobrý den.')
  await controller.dispose()
  assert.equal(audio.stops, 1)
  assert.equal(controller.state.caption, '')
  assert.equal(controller.state.lines.length, 0)
  assert.equal(await controller.start(), false)
})

type FakeEvent = { preventDefault: () => void; target: FakeElement }

class FakeElement {
  tagName: string
  className = ''
  children: FakeElement[] = []
  listeners = new Map<string, Array<(event: FakeEvent) => void>>()
  hidden = false
  disabled = false
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

function findButton(root: FakeElement, label: string) {
  return all(root).find((element) => element.tagName === 'BUTTON' && element.textContent === label)
}

class FakeSessionClient {
  calls: Array<{ method: string; args: unknown[] }> = []
  async list(limit = 50) {
    this.calls.push({ method: 'list', args: [limit] })
    return { sessions: [] as Session[] }
  }
  async detail(id: string) {
    this.calls.push({ method: 'detail', args: [id] })
    return {} as SessionDetail
  }
  async create(input: CreateSessionInput) {
    this.calls.push({ method: 'create', args: [input] })
    return { session: {} as Session }
  }
}

test('the captions panel starts and stops the controller without calling the session API', async (t) => {
  const restore = installDom()
  t.after(restore)
  const calls: string[] = []
  let state: CaptionsState = { phase: 'off', microphone: 'off', caption: '', lines: [], queued: 0, dropped: 0, error: '', notice: '' }
  let notify: ((next: CaptionsState) => void) | undefined
  const fake: CaptionsControl = {
    get state() {
      return state
    },
    async start() {
      calls.push('start')
      state = { ...state, phase: 'listening', microphone: 'on' }
      notify?.(state)
      return true
    },
    async pause() {
      calls.push('pause')
    },
    async resume() {
      calls.push('resume')
      return true
    },
    async stop() {
      calls.push('stop')
      state = { ...state, phase: 'off', microphone: 'off', caption: '', lines: [] }
      notify?.(state)
    },
    clear() {
      calls.push('clear')
    },
    statusLine() {
      return state.phase === 'off' ? 'Captions off · nothing stored' : 'Captions listening · nothing stored'
    },
    subscribe(listener) {
      notify = listener
      return () => {
        notify = undefined
      }
    }
  }
  bindCaptions(fake)
  t.after(() => bindCaptions(undefined))
  const client = new FakeSessionClient()
  const section = new FakeElement('div')
  captionsPanel.mount(section as unknown as HTMLElement, { client: client as unknown as SessionClient, writerId: 'phone' })
  assert.match(section.textContent, /Nothing is stored/)
  findButton(section, 'Start captions')!.click()
  await settle()
  assert.deepEqual(calls, ['start'])
  assert.ok(findButton(section, 'Stop captions'))
  assert.match(section.textContent, /Captions listening/)
  findButton(section, 'Stop captions')!.click()
  await settle()
  assert.deepEqual(calls, ['start', 'stop'])
  assert.ok(findButton(section, 'Start captions'))
  assert.match(section.textContent, /Captions off/)
  assert.equal(client.calls.length, 0)
})
