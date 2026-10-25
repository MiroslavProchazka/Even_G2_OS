import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BeastClient, beastUrl } from '../src/beast'
import type { Settings } from '../src/api'
const settings: Settings = { gateway: 'https://beast.example.com/v1/', token: 'test-only-secret', language: 'cs', transport: 'direct' }
test('direct Beast preserves /v1 and refuses credentials or insecure transport', () => {
  assert.equal(beastUrl(settings.gateway, 'chat/completions'), 'https://beast.example.com/v1/chat/completions')
  assert.throws(() => beastUrl('http://beast.example.com/v1', 'models'))
  assert.throws(() => beastUrl('https://user:secret@beast.example.com', 'models'))
})
test('direct speech sends multipart WAV, exact model and language', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (input, init) => {
    assert.equal(input, 'https://beast.example.com/v1/audio/transcriptions')
    const form = init!.body as FormData
    assert.equal(form.get('model'), 'whisper-live'); assert.equal(form.get('language'), 'cs')
    assert.equal((form.get('file') as Blob).type, 'audio/wav'); assert.equal((init!.headers as Record<string,string>)['Content-Type'], undefined)
    return Response.json({ text: ' Česká otázka? ' })
  }
  assert.equal(await new BeastClient(() => settings).transcribe(new Uint8Array(50), new AbortController().signal), 'Česká otázka?')
})
test('direct chat supports fragmented Czech SSE and ends without waiting for socket close', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original }); let cancelled = false
  globalThis.fetch = async (input, init) => {
    assert.equal(input, 'https://beast.example.com/v1/chat/completions')
    assert.equal(JSON.parse(init!.body as string).model, 'beast/big')
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Příliš žluťoučký"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n')
    return new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])) }, cancel() { cancelled = true } }))
  }
  let answer = ''; await new BeastClient(() => settings).chat('Otázka?', [], new AbortController().signal, text => { answer += text })
  assert.equal(answer, 'Příliš žluťoučký'); assert.equal(cancelled, true)
})
test('direct chat detects truncated stream and cancels it', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
  await assert.rejects(new BeastClient(() => settings).chat('Question?', [], new AbortController().signal, () => {}), /before completion/)
})
test('direct model health rejects an unavailable configured chat model', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => Response.json({ data: [{ id: 'beast/small' }] })
  await assert.rejects(new BeastClient(() => settings).health(), /beast\/big is missing/)
})
test('optional vocabulary is sent only as a bounded transcription prompt', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (_input, init) => {
    const form = init!.body as FormData
    assert.equal((form.get('prompt') as string).length, 300)
    assert.equal(form.get('language'), 'cs')
    return Response.json({ text: 'Beast' })
  }
  await new BeastClient(() => ({ ...settings, sttPrompt: 'a'.repeat(400) })).transcribe(new Uint8Array(50), new AbortController().signal)
})
test('direct Beast cue mode requests structured cues without changing default chat', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (_input, init) => {
    assert.match(JSON.parse(init!.body as string).messages[0].content, /JSON object/)
    return new Response('data: {"choices":[{"delta":{"content":"{\\"show\\":false}"},"finish_reason":"stop"}]}\n\n')
  }
  let output = ''; await new BeastClient(() => settings).chat('Conversation', [], new AbortController().signal, x => { output += x }, { format:'cue' })
  assert.equal(output, '{"show":false}')
})

test('direct Beast refuses web instead of pretending to search', async () => {
  await assert.rejects(new BeastClient(()=>settings).chat('question',[],new AbortController().signal,()=>{}, {webQuery:'question'}), /custom gateway/)
})
