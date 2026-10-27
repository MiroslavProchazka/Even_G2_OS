import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSummaryMessages, generateSummary } from '../server/summary-provider.mjs'

const config = {
  chatUrl: 'https://fake.invalid/chat',
  key: 'fake-key',
  chatModel: 'beast/big'
}

const session = { name: 'Pilot', language: 'cs', goal: 'Rozhodnout', prep: '' }
const turns = [
  { id: `turn_${'a'.repeat(32)}`, revision: 1, startMs: 0, endMs: 1000, text: 'První věta.' },
  { id: `turn_${'b'.repeat(32)}`, revision: 1, startMs: 1000, endMs: 2000, text: 'Druhá věta.' }
]

test('summary provider asks for strict JSON and parses a fenced answer', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url, options }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '```json\n{"overview":{"text":"Shrnutí.","citations":["' + turns[0].id + '"]},"decisions":[],"actionCandidates":[],"openQuestions":[]}\n```'
            }
          }
        ]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  const result = await generateSummary(config, { session, turns, fetchImpl })
  assert.equal(request.url, config.chatUrl)
  const body = JSON.parse(request.options.body)
  assert.equal(body.model, 'beast/big')
  assert.equal(body.stream, false)
  assert.match(body.messages[0].content, /Never invent an owner or deadline/)
  assert.match(body.messages[1].content, new RegExp(turns[0].id))
  assert.deepEqual(result.overview.citations, [turns[0].id])
})

test('summary provider rejects malformed JSON and upstream failures', async () => {
  const malformed = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  await assert.rejects(() => generateSummary(config, { session, turns, fetchImpl: malformed }), /JSON/i)
  const unavailable = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
  await assert.rejects(() => generateSummary(config, { session, turns, fetchImpl: unavailable }), /HTTP 503/)
})

test('summary messages identify every turn and state the no-invention rules', () => {
  const messages = buildSummaryMessages({ session, turns, chunk: { index: 1, count: 3 } })
  assert.match(messages[0].content, /part 2 of 3/)
  assert.match(messages[0].content, /owner to null/)
  assert.match(messages[0].content, /conditional=true/)
  assert.match(messages[1].content, new RegExp(turns[1].id))
  assert.match(messages[1].content, /untrusted data/)
})
