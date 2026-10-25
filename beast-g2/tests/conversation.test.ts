import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conversationPrompt, parseCue, ReplyHistory } from '../src/conversation'
import { ContinuousController } from '../src/continuous'
import { simulateUtterance } from '../src/continuous-demo'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
test('direct mode preserves the original utterance and notes do not silently truncate speech', () => {
  assert.equal(conversationPrompt('Original', { mode: 'direct', notes: '' }), 'Original')
  assert.match(conversationPrompt('Otázka', { mode: 'direct', notes: 'Meeting goal' }), /Meeting goal/)
  assert.throws(() => conversationPrompt('a'.repeat(4000), { mode: 'context', notes: 'notes' }), /exceed/)
})
test('context cue validates visible hints and rejects malformed responses', () => {
  assert.equal(parseCue('{"show":false}').show, false)
  assert.deepEqual(parseCue('{"show":true,"hint":"Hint","detail":"Full answer"}'), { show: true, hint: 'Hint', detail: 'Full answer' })
  for (const value of ['not json', 'null', '{"show":"false"}', JSON.stringify({ show:true, hint:'x'.repeat(121), detail:'answer' })]) assert.throws(() => parseCue(value))
})
test('phone history is bounded, copied, exportable and independently deletable', () => {
  const history = new ReplyHistory()
  for (let i = 0; i < 25; i++) history.add({ transcript: `Turn ${i}`, answer: `Full ${i}`, mode: 'direct' })
  assert.equal(history.snapshot().length, 20); assert.equal(history.snapshot()[0].transcript, 'Turn 5')
  history.snapshot()[0].answer = 'mutated'; assert.equal(history.snapshot()[0].answer, 'Full 5')
  assert.equal(JSON.parse(history.export()).replies.length, 20)
  history.clear(); assert.equal(history.snapshot().length, 0)
})
test('context mode remembers quiet turns, hides raw JSON and archives full answers after hint expiry', async t => {
  let calls = 0, clock = 1000, prior: unknown
  const c = new ContinuousController({ async start() {}, async stop() {} }, {
    async transcribe() { return 'Latest speech' },
    async chat(prompt, history, _signal, delta) {
      assert.match(prompt, /Preparation notes/); assert.match(prompt, /Project context/)
      prior = history
      delta(++calls === 1 ? '{"show":false}' : '{"show":true,"hint":"Short hint","detail":"Full useful explanation"}')
      assert.equal(c.state.streaming, '')
    }
  }, () => {}, { now: () => clock })
  t.after(() => c.pause())
  assert.equal(c.configureConversation({ mode: 'context', notes: 'Project context' }), true)
  await c.start(); assert.equal(c.configureConversation({ mode:'direct',notes:'' }), false)
  simulateUtterance(c); await tick(); assert.equal(c.state.reply, undefined)
  simulateUtterance(c); await tick(); assert.deepEqual(prior, [{role:'user',content:'Latest speech'}])
  assert.equal(c.state.reply?.hint, 'Short hint'); assert.equal(c.archive.snapshot()[0].answer, 'Full useful explanation')
  clock += 10000; c.tickHint(); assert.equal(c.state.reply, undefined); assert.equal(c.archive.snapshot().length, 1)
  await c.pause(); assert.equal(c.archive.snapshot().length, 1)
})
test('gateway cue mode has a JSON contract while direct mode remains plain text', async () => {
  const { validateChat } = await import('../server/gateway.mjs')
  assert.match(validateChat({ text:'Question', format:'cue' })[0].content, /JSON object/)
  assert.match(validateChat({ text:'Question' })[0].content, /plain text/)
  assert.throws(() => validateChat({ text:'Question', format:'unsupported' }))
})

test('web commands share only explicit query and preserve sources through pause/export', async t => {
  const { webQuery } = await import('../src/conversation')
  assert.equal(webQuery('vyhledej počasí', true), 'počasí')
  assert.equal(webQuery('search the web weather', true), 'weather')
  assert.equal(webQuery('vyhledej počasí', false), undefined)
  assert.equal(webQuery('Ordinary speech', true), undefined)
  const evidence = { sources: [{id:1,title:'Source',url:'https://example.com'}], retrievedAt:'2026-10-25T12:00:00Z' }
  const c = new ContinuousController({async start(){},async stop(){}}, {
    async transcribe(){return 'vyhledej počasí'},
    async chat(_text,_history,_signal,delta,options){ assert.equal(options?.webQuery,'počasí'); options?.onSources?.(evidence); delta('Weather [1]') }
  },()=>{})
  t.after(()=>c.pause()); c.configureConversation({mode:'direct',notes:'private prep',web:true}); await c.start(); simulateUtterance(c); await tick();
  assert.deepEqual(c.state.reply?.evidence,evidence); await c.pause(); assert.deepEqual(JSON.parse(c.archive.export()).replies[0].evidence,evidence)
})
