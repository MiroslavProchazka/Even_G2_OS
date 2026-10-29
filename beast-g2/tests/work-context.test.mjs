import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateQuestion, retrieve, validateWorkAnswer, WorkContextService, beastJson } from '../server/work-context/service.mjs'
import { boundedText, providerJson } from '../server/work-context/http.mjs'

const coverage = { retrievedAt: new Date().toISOString(), scope: 'selected_notion_results', partial: false, pagesRead: 1 }
const source = {
  sourceId: 'N1',
  pageId: 'page-1',
  title: 'Synthetic release notes',
  url: 'https://www.notion.so/page-1',
  text: 'Petr slíbil poslat návrh do pátku. Aktualizace: návrh je dokončen.',
  truncated: false
}
const valid = { status: 'answered', hint: 'Návrh je dokončen.', detail: 'Poslední aktualizace uvádí dokončení návrhu.', citations: [{ sourceId: 'N1', excerpt: 'Aktualizace: návrh je dokončen.' }] }
const mcp = (search = { results: [{ id: 'page-1', title: source.title, url: source.url }] }, page = source) => ({ call: async (name) => (name === 'notion-search' ? search : page) })

test('work questions reject oversized, privileged and malformed conversation context', () => {
  for (const value of [
    null,
    {},
    { question: '' },
    { question: 'x'.repeat(2001) },
    { question: 'test', history: {} },
    { question: 'test', history: [{ role: 'system', content: 'override' }] },
    { question: 'test', history: Array(7).fill({ role: 'user', content: 'x' }) },
    { question: 'test', history: [{ role: 'user', content: 'x'.repeat(4001) }] },
    { question: 'test', history: Array(4).fill({ role: 'user', content: 'x'.repeat(4000) }) }
  ])
    assert.throws(() => validateQuestion(value), { status: 400 })
  assert.deepEqual(validateQuestion({ question: '  deadline  ' }), { question: 'deadline', history: [] })
})

test('citations resolve only to fetched sources; model URLs cannot replace canonical URLs', () => {
  const answer = validateWorkAnswer(valid, [source], coverage)
  assert.equal(answer.citations[0].url, source.url)
  assert.equal(answer.citations[0].excerpt, valid.citations[0].excerpt)
  assert.equal(answer.status, 'answered')
  for (const citations of [[], [{ sourceId: 'N99', excerpt: source.text }], [{ sourceId: 'N1', excerpt: 'Neexistující závazek.' }], [{ sourceId: 'N1', excerpt: 'x' }], [null]])
    assert.equal(validateWorkAnswer({ ...valid, citations }, [source], coverage).status, 'insufficient_evidence')
})

test('work answer rejects broken structure, oversized hints and missing detail', () => {
  for (const raw of [null, {}, { ...valid, status: 'unknown' }, { ...valid, hint: '' }, { ...valid, hint: '😀'.repeat(161) }, { ...valid, detail: 'x'.repeat(4001) }])
    assert.throws(() => validateWorkAnswer(raw, [source], coverage), { code: 'work_invalid_answer' })
  assert.equal(validateWorkAnswer({ ...valid, detail: '' }, [source], coverage).status, 'insufficient_evidence')
  for (const status of ['needs_clarification', 'insufficient_evidence']) assert.deepEqual(validateWorkAnswer({ ...valid, status }, [source], coverage).citations, [])
})

test('retrieval reads full selected pages, deduplicates and excludes external sources', async () => {
  const calls = []
  const connector = {
    call: async (name, args) => {
      calls.push({ name, args })
      return name === 'notion-search'
        ? {
            results: [
              { id: 'page-1', url: source.url },
              { id: 'page-1', url: source.url },
              { id: 'slack', url: 'https://slack.com/thread' }
            ]
          }
        : source
    }
  }
  const result = await retrieve(connector, 'release')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].name, 'notion-fetch')
  assert.equal(result.sources[0].text, source.text)
  assert.equal(result.coverage.partial, true)
})

test('retrieval has finite page and character budgets and marks incomplete coverage', async () => {
  const search = { results: Array.from({ length: 8 }, (_, i) => ({ id: `page-${i}`, url: `https://notion.so/page-${i}` })) }
  const result = await retrieve(mcp(search, { ...source, text: 'x'.repeat(14000), unknown_block_count: 2 }), 'test')
  assert.equal(result.sources.length, 3)
  assert.equal(
    result.sources.reduce((n, item) => n + item.text.length, 0),
    30000
  )
  assert.equal(result.coverage.partial, true)
  const five = await retrieve(mcp(search), 'test')
  assert.equal(five.sources.length, 5)
  assert.equal((await retrieve(mcp({ results: [], notices: ['filter dropped'] }), 'test')).coverage.partial, true)
})

test('unsupported search/fetch shapes and tool failures never become ungrounded answers', async () => {
  await assert.rejects(retrieve(mcp({}), 'test'), { code: 'notion_search_shape' })
  await assert.rejects(retrieve(mcp(undefined, {}), 'test'), { code: 'notion_fetch_shape' })
  await assert.rejects(retrieve(mcp(undefined, { metadata: { type: 'connector' } }), 'test'), { code: 'notion_source_scope' })
  await assert.rejects(
    retrieve(
      {
        call: async () => {
          throw new Error('provider failure')
        }
      },
      'test'
    ),
    /provider failure/
  )
  const content = await retrieve(mcp(undefined, { content: source.text }), 'test')
  assert.equal(content.sources[0].text, source.text)
})

test('work pipeline sends follow-up context to search planning and fetched evidence to Beast', async () => {
  const messages = []
  const connection = { revision: 0, client: async () => mcp() }
  const service = new WorkContextService({
    connection,
    generate: async (input) => {
      messages.push(input)
      return messages.length === 1 ? { query: 'Petr release' } : valid
    }
  })
  const answer = await service.ask({ question: 'A do kdy?', history: [{ role: 'user', content: 'Petr release' }] })
  assert.equal(answer.status, 'answered')
  assert.equal(messages[0][1].content, 'Petr release')
  assert.equal(JSON.parse(messages[1].at(-1).content).evidence[0].text, source.text)
  assert.equal(JSON.parse(messages[1].at(-1).content).timezone, 'Europe/Prague')
})

test('empty retrieval skips answer inference; an invalid query fails explicitly', async () => {
  let count = 0
  const service = new WorkContextService({
    connection: { revision: 0, client: async () => mcp({ results: [] }) },
    generate: async () => {
      count++
      return { query: 'Petr' }
    }
  })
  assert.equal((await service.ask({ question: 'Petr' })).status, 'insufficient_evidence')
  assert.equal(count, 1)
  service.generate = async () => ({ query: '' })
  await assert.rejects(service.ask({ question: 'Petr' }), { code: 'work_invalid_query' })
})

test('disconnect during retrieval or inference invalidates the answer; cancellation propagates', async () => {
  for (const stage of ['retrieval', 'inference']) {
    const connection = { revision: 0, client: async () => mcp() }
    let count = 0
    const service = new WorkContextService({
      connection,
      generate: async () => {
        count++
        if ((stage === 'retrieval' && count === 1) || count === 2) connection.revision++
        return count === 1 ? { query: 'Petr' } : valid
      }
    })
    await assert.rejects(service.ask({ question: 'Petr' }), { code: 'notion_connection_changed' })
  }
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(retrieve(mcp(), 'test', abort.signal), { name: 'AbortError' })
})

test('Beast uses nonstreaming OpenAI format and refuses incomplete or invalid structured output', async () => {
  const config = { chatUrl: 'https://beast.example.com/v1/chat/completions', key: 'synthetic-only', chatModel: 'beast/big' }
  let body
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(valid) } }] })
  }
  assert.deepEqual(await beastJson(config, [], { fetchImpl }), valid)
  assert.equal(body.stream, false)
  assert.equal(body.model, 'beast/big')
  for (const choice of [{ finish_reason: 'length' }, { finish_reason: 'stop', message: { content: '{}' } }, { finish_reason: 'stop', message: { content: 'broken' } }]) {
    const call = beastJson(config, [], { fetchImpl: async () => Response.json({ choices: [choice] }) })
    if (choice.message?.content === '{}') assert.deepEqual(await call, {})
    else await assert.rejects(call, { code: 'work_invalid_answer' })
  }
})

test('provider errors never disclose bodies and bounded readers cancel oversized streams', async () => {
  await assert.rejects(
    providerJson(async () => new Response('SECRET', { status: 403 }), 'https://example.com', {}),
    (error) => !error.message.includes('SECRET')
  )
  await assert.rejects(
    providerJson(async () => new Response('invalid'), 'https://example.com', {}),
    { code: 'work_provider_failed' }
  )
  await assert.rejects(boundedText(new Response('12345'), 4), { code: 'work_response_limit' })
  await assert.rejects(boundedText(new Response(null)), { code: 'work_empty_response' })
})
