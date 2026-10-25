import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchWeb } from '../server/web.mjs'
const signal = new AbortController().signal
test('search uses fixed host, bounded snippets and rejects unsafe source links', async () => {
  const evidence = await searchWeb('počasí Praha', 'server-secret', signal, async (url, options) => {
    assert.equal(url.origin, 'https://api.search.brave.com')
    assert.equal(url.searchParams.get('q'), 'počasí Praha')
    assert.equal(options.headers['X-Subscription-Token'], 'server-secret')
    assert.equal(options.redirect, 'error')
    return Response.json({
      web: {
        results: [
          { title: 'Bad', url: 'javascript:alert(1)', description: 'bad' },
          { title: 'Weather', url: 'https://example.com/weather', description: 'x'.repeat(3000), page_age: '2026-10-25' }
        ]
      }
    })
  })
  assert.equal(evidence.sources.length, 1)
  assert.equal(evidence.sources[0].id, 1)
  assert.equal(evidence.sources[0].snippet.length, 1200)
})
test('missing key, oversized queries, empty and oversized results fail closed', async () => {
  await assert.rejects(searchWeb('query', '', signal), /not configured/)
  await assert.rejects(searchWeb('x'.repeat(601), 'key', signal), /600/)
  await assert.rejects(
    searchWeb('q', 'key', signal, async () => Response.json({ web: { results: [] } })),
    /No usable/
  )
  await assert.rejects(
    searchWeb('q', 'key', signal, async () => new Response('x'.repeat(262145))),
    /exceeds/
  )
})
