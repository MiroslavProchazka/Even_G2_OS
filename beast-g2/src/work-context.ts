import type { Settings } from './api'
import { WorkClient } from './work-api'
import { WorkConversation } from './work-conversation'

export function mountWorkContext(parent: HTMLElement, settings: () => Settings) {
  const section = document.createElement('section')
  section.setAttribute('aria-label', 'Work context')
  section.innerHTML = `<h2>Work context · Notion</h2>
<p>Read work notes and commitments through your custom gateway. No Notion writes.</p>
<div class="actions"><button type="button" data-action="status">Check Notion</button><button type="button" data-action="connect">Connect Notion</button><button type="button" data-action="disconnect">Disconnect Notion</button></div>
<p data-status role="status">Notion has not been checked.</p><a data-login hidden target="_blank" rel="noopener noreferrer">Continue to Notion sign-in</a>
<label><input type="checkbox" data-voice> Use work context for manual Ask from glasses</label>
<form><label>Work question<input name="question" maxlength="2000" required placeholder="Co dlužím Petrovi k releasu?"></label><button>Ask Notion</button></form>
<div class="actions"><button type="button" data-action="cancel">Cancel question</button><button type="button" data-action="clear">Clear work conversation</button></div>
<p data-error role="alert"></p><p data-hint></p><p data-detail></p><p data-coverage></p><div data-sources></div>`
  parent.append(section)
  const node = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!
  const client = new WorkClient(settings),
    conversation = new WorkConversation(settings, client)
  let generation = 0
  const clearOutput = () => {
    for (const selector of ['[data-hint]', '[data-detail]', '[data-coverage]', '[data-sources]', '[data-error]']) node(selector).textContent = ''
  }
  const reset = () => {
    generation++
    conversation.reset()
    clearOutput()
    node<HTMLAnchorElement>('[data-login]').hidden = true
    node('[data-status]').textContent = 'Notion has not been checked.'
  }
  const answer = async (question: string, signal: AbortSignal, delta: (text: string) => void) => {
    const current = generation
    clearOutput()
    node('[data-status]').textContent = 'Finding evidence and preparing an answer…'
    try {
      const result = await conversation.ask(question, signal)
      if (current !== generation) return
      node('[data-hint]').textContent = result.hint
      node('[data-detail]').textContent = result.detail
      node('[data-coverage]').textContent =
        `Pages read: ${result.coverage.pagesRead}. Selected search results, not the entire workspace.${result.coverage.partial ? ' Some evidence is incomplete.' : ''}`
      const sources = node('[data-sources]')
      for (const citation of result.citations) {
        const link = document.createElement('a'),
          quote = document.createElement('p')
        link.href = citation.url
        link.textContent = `${citation.sourceId}: ${citation.title}`
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        quote.textContent = citation.excerpt
        sources.append(link, quote)
      }
      node('[data-status]').textContent = result.status === 'answered' ? 'Answer with sources.' : result.status === 'needs_clarification' ? 'Please clarify.' : 'Insufficient evidence.'
      delta(result.hint)
    } catch (error) {
      if (current === generation) {
        node('[data-status]').textContent = 'Work question did not complete.'
        node('[data-error]').textContent = error instanceof Error ? error.message : 'Work question failed.'
      }
      throw error
    }
  }
  const run = async (task: () => Promise<void>) => {
    const current = generation
    try {
      await task()
    } catch (error) {
      if (current === generation) node('[data-error]').textContent = error instanceof Error ? error.message : 'Work request failed.'
    }
  }
  node<HTMLFormElement>('form').addEventListener('submit', (event) => {
    event.preventDefault()
    void run(async () => {
      await answer(node<HTMLInputElement>('[name="question"]').value, new AbortController().signal, () => {})
    })
  })
  for (const action of ['connect', 'status', 'disconnect'])
    node(`[data-action="${action}"]`).addEventListener('click', () => {
      if (action === 'disconnect') reset()
      void run(async () => {
        if (settings().transport !== 'gateway') throw new Error('Select Custom gateway in connection settings first.')
        const current = generation
        if (action === 'connect') {
          const result = await client.connect()
          if (current !== generation) return
          const url = new URL(result.authorizationUrl)
          if (url.protocol !== 'https:' || !(url.hostname === 'notion.com' || url.hostname.endsWith('.notion.com'))) throw new Error('Invalid authorization URL.')
          const link = node<HTMLAnchorElement>('[data-login]')
          link.href = url.href
          link.hidden = false
          node('[data-status]').textContent = 'Open the sign-in link. After sign-in, return and check Notion.'
        } else if (action === 'disconnect') {
          await client.disconnect()
          if (current === generation) node('[data-status]').textContent = 'Notion disconnected from this gateway.'
        } else {
          const result = await client.status()
          if (current === generation) node('[data-status]').textContent = result.connected ? 'Work Notion connected. Access is checked again when asking.' : 'Connect work Notion first.'
        }
      })
    })
  node('[data-action="cancel"]').addEventListener('click', () => conversation.cancel())
  node('[data-action="clear"]').addEventListener('click', reset)
  return { answer, reset, enabled: () => node<HTMLInputElement>('[data-voice]').checked }
}
