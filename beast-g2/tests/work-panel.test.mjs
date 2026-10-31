import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { mountWorkContext } from '../src/work-context.ts'
import { createGateway, loadConfig } from '../server/gateway.mjs'
import { WorkContextService } from '../server/work-context/service.mjs'

async function setup(t) {
  const dom = new JSDOM('<main></main>', { url: 'https://phone.example.com' })
  const previous = globalThis.document
  globalThis.document = dom.window.document
  const plans = []
  const page = { title: '<script>synthetic-title</script>', text: 'Petr potvrdil dokončení návrhu.', url: 'https://notion.so/synthetic' }
  const connection = {
    revision: 0,
    status: () => ({ connected: true }),
    begin: async () => ({ authorizationUrl: 'https://mcp.notion.com/authorize' }),
    disconnect() {
      this.revision++
      return { connected: false }
    },
    client: async () => ({ call: async (name) => (name === 'notion-search' ? { results: [{ id: 'synthetic', ...page }] } : page) })
  }
  const work = new WorkContextService({
    connection,
    generate: async (messages) => {
      if (messages[0].content.startsWith('Rewrite')) {
        plans.push(messages)
        return { query: 'Petr' }
      }
      return { status: 'answered', hint: 'Návrh je hotový.', detail: 'Petr potvrdil dokončení návrhu.', citations: [{ sourceId: 'N1', excerpt: page.text }] }
    }
  })
  const server = createGateway({ ...loadConfig({ DEMO_MODE: '1', RATE_LIMIT: '1000' }), work })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const settings = { transport: 'gateway', gateway: `http://127.0.0.1:${server.address().port}`, token: 'local-demo-token-only', language: 'cs' }
  const panel = mountWorkContext(dom.window.document.querySelector('main'), () => settings)
  t.after(() => {
    server.closeAllConnections()
    server.close()
    globalThis.document = previous
    dom.window.close()
  })
  return { dom, panel, plans, connection, settings, work, node: (selector) => dom.window.document.querySelector(selector) }
}
async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('DOM did not reach the expected state')
}

test('work form reaches HTTP retrieval and renders fetched citations as text, without HTML injection', async (t) => {
  const f = await setup(t)
  assert.equal(f.plans.length, 0)
  f.node('[name="question"]').value = 'Co dlužím Petrovi?'
  f.node('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await until(() => f.node('[data-status]').textContent === 'Answer with sources.')
  assert.equal(f.node('[data-hint]').textContent, 'Návrh je hotový.')
  assert.equal(f.node('[data-detail]').textContent, 'Petr potvrdil dokončení návrhu.')
  assert.equal(f.node('[data-sources] a').href, 'https://notion.so/synthetic')
  assert.equal(f.node('[data-sources] script'), null)
  assert.match(f.node('[data-sources] a').textContent, /<script>/)
  assert.match(f.node('[data-coverage]').textContent, /not the entire workspace/)
  let hint
  f.node('[data-voice]').checked = true
  assert.equal(f.panel.enabled(), true)
  await f.panel.answer('A do kdy?', new AbortController().signal, (value) => {
    hint = value
  })
  assert.equal(hint, 'Návrh je hotový.')
  assert.equal(f.plans[1][1].content, 'Co dlužím Petrovi?')
  f.node('[data-action="clear"]').click()
  assert.equal(f.node('[data-detail]').textContent, '')
  await f.panel.answer('Nová otázka', new AbortController().signal, () => {})
  assert.equal(f.plans[2].length, 2)
})

test('panel has explicit login/status/disconnect and direct mode reports a visible error', async (t) => {
  const f = await setup(t)
  f.node('[data-action="connect"]').click()
  await until(() => !f.node('[data-login]').hidden)
  assert.equal(f.node('[data-login]').href, 'https://mcp.notion.com/authorize')
  assert.equal(f.node('[data-login]').rel, 'noopener noreferrer')
  f.node('[data-action="status"]').click()
  await until(() => f.node('[data-status]').textContent.startsWith('Work Notion connected'))
  f.node('[data-action="disconnect"]').click()
  await until(() => f.connection.revision === 1)
  assert.equal(f.node('[data-login]').hidden, true)
  f.settings.transport = 'direct'
  await assert.rejects(
    f.panel.answer('Question', new AbortController().signal, () => {}),
    /Custom gateway/
  )
  assert.match(f.node('[data-error]').textContent, /Custom gateway/)
})

test('panel cancellation and reset discard a late answer and erase evidence', async (t) => {
  const f = await setup(t)
  let release
  f.work.ask = async (_input, signal) =>
    new Promise((resolve, reject) => {
      release = () => reject(new Error('late answer'))
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  const pending = f.panel.answer('question', new AbortController().signal, () => assert.fail('stale hint'))
  await until(() => release)
  f.node('[data-action="cancel"]').click()
  await assert.rejects(pending)
  assert.equal(f.node('[data-detail]').textContent, '')
  f.panel.reset()
  assert.equal(f.node('[data-error]').textContent, '')
})
