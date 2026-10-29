import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkClient, validateWorkResponse, type WorkAnswer } from '../src/work-api'
import { WorkConversation } from '../src/work-conversation'
import type { Settings, Turn } from '../src/api'
import { AssistantController } from '../src/controller'

const settings = (): Settings => ({ transport: 'gateway', gateway: 'https://gateway.example.com', token: 'synthetic-gateway-token', language: 'cs' })
const answer = (): WorkAnswer => ({
  status: 'answered',
  hint: 'Návrh je hotový.',
  detail: 'Petr dokončil návrh.',
  citations: [{ sourceId: 'N1', pageId: 'synthetic', url: 'https://notion.so/synthetic', title: 'Synthetic notes', excerpt: 'Petr dokončil návrh.', truncated: false }],
  coverage: { retrievedAt: new Date().toISOString(), scope: 'selected_notion_results', partial: false, pagesRead: 1 }
})

test('work client sends only gateway auth and bounded conversation data', async (t) => {
  const previous = globalThis.fetch
  t.after(() => {
    globalThis.fetch = previous
  })
  const requests: { url: string; init: RequestInit }[] = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    return Response.json({ answer: answer(), connected: true, authorizationUrl: 'https://mcp.notion.com/authorize' })
  }
  const client = new WorkClient(settings)
  const signal = new AbortController().signal
  assert.equal((await client.ask('Co dlužím Petrovi?', [], signal)).hint, answer().hint)
  assert.deepEqual(JSON.parse(requests[0].init.body as string), { question: 'Co dlužím Petrovi?', history: [] })
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, 'Bearer synthetic-gateway-token')
  await client.status()
  await client.connect()
  await client.disconnect()
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ['/api/work/ask', '/api/notion/status', '/api/notion/connect', '/api/notion/disconnect']
  )
})

test('client rejects malformed answers, missing evidence, invalid coverage and unsafe links', () => {
  for (const patch of [
    { hint: '' },
    { hint: 'x'.repeat(161) },
    { detail: 'x'.repeat(4001) },
    { citations: [] },
    { coverage: { ...answer().coverage, pagesRead: 6 } },
    { coverage: { ...answer().coverage, retrievedAt: 'unknown' } }
  ])
    assert.throws(() => validateWorkResponse({ ...answer(), ...patch }))
  for (const url of ['javascript:alert(1)', 'https://evil.example/page', 'https://user:password@notion.so/page'])
    assert.throws(() => validateWorkResponse({ ...answer(), citations: [{ ...answer().citations[0], url }] }))
  assert.equal(validateWorkResponse({ ...answer(), status: 'insufficient_evidence', citations: [] }).status, 'insufficient_evidence')
})

test('work follow-ups keep separate bounded history, clearing starts a new conversation', async () => {
  const histories: Turn[][] = []
  const conversation = new WorkConversation(settings, {
    ask: async (_question, history) => {
      histories.push(history)
      return answer()
    }
  })
  const signal = new AbortController().signal
  for (let i = 0; i < 5; i++) await conversation.ask(`question ${i}`, signal)
  assert.equal(histories[0].length, 0)
  assert.equal(histories[4].length, 4)
  conversation.reset()
  await conversation.ask('new', signal)
  assert.equal(histories.at(-1)!.length, 0)
})

test('credential changes discard work history and suppress results from an old connection', async () => {
  let current = settings()
  let resolve!: (answer: WorkAnswer) => void
  const histories: Turn[][] = []
  const conversation = new WorkConversation(() => current, {
    ask: async (_question, history) => {
      histories.push(history)
      return new Promise((done) => {
        resolve = done
      })
    }
  })
  const pending = conversation.ask('question', new AbortController().signal)
  current = { ...current, token: 'another-token' }
  resolve(answer())
  await assert.rejects(pending, /connection changed/)
  const next = conversation.ask('new', new AbortController().signal)
  resolve(answer())
  await next
  assert.equal(histories[1].length, 0)
})

test('direct mode, oversized questions and overlapping work requests fail without leaking context', async () => {
  const direct = new WorkConversation(() => ({ ...settings(), transport: 'direct' }), { ask: async () => answer() })
  await assert.rejects(direct.ask('question', new AbortController().signal), /Custom gateway/)
  const conversation = new WorkConversation(settings, { ask: async () => answer() })
  await assert.rejects(conversation.ask('x'.repeat(2001), new AbortController().signal), /1–2000/)
  let resolve!: (answer: WorkAnswer) => void
  const busy = new WorkConversation(settings, {
    ask: async () =>
      new Promise((done) => {
        resolve = done
      })
  })
  const first = busy.ask('first', new AbortController().signal)
  await assert.rejects(busy.ask('second', new AbortController().signal), /already running/)
  resolve(answer())
  await first
})

test('reset and cancellation prevent stale work results from completing', async () => {
  for (const action of ['reset', 'cancel', 'signal'] as const) {
    let resolve!: (answer: WorkAnswer) => void
    const conversation = new WorkConversation(settings, {
      ask: async () =>
        new Promise((done) => {
          resolve = done
        })
    })
    const controller = new AbortController(),
      pending = conversation.ask('question', controller.signal)
    if (action === 'signal') controller.abort()
    else conversation[action]()
    resolve(answer())
    await assert.rejects(pending, { name: 'AbortError' })
  }
})

test('manual work answers do not enter ordinary chat history or receive its context', async () => {
  let work = false
  const histories: Turn[][] = []
  const controller = new AssistantController(
    { async start() {}, async stop() {} },
    {
      managesHistory: () => work,
      transcribe: async () => 'synthetic',
      chat: async (_question, history, _signal, delta) => {
        histories.push([...history])
        delta(work ? 'private work hint' : 'ordinary answer')
      }
    },
    () => {}
  )
  await controller.ask('ordinary question')
  work = true
  await controller.ask('work question')
  assert.deepEqual(histories[1], [])
  work = false
  await controller.ask('ordinary follow-up')
  assert.deepEqual(histories[2], [
    { role: 'user', content: 'ordinary question' },
    { role: 'assistant', content: 'ordinary answer' }
  ])
})
