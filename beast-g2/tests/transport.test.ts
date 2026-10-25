import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkAbort, readLines } from '../src/transport'

test('readLines handles CRLF, split UTF-8 and a final unterminated line', async () => {
  const bytes = new TextEncoder().encode('jeden\r\ndva\nposlední')
  const stream = new ReadableStream({
    start(c) {
      for (const byte of bytes) c.enqueue(new Uint8Array([byte]))
      c.close()
    }
  })
  const lines: string[] = []
  for await (const line of readLines(stream)) lines.push(line)
  assert.deepEqual(lines, ['jeden', 'dva', 'poslední'])
})
test('readLines cancels the reader when the consumer stops early', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('a\nb\n'))
    },
    cancel() {
      cancelled = true
    }
  })
  for await (const line of readLines(stream)) {
    assert.equal(line, 'a')
    break
  }
  assert.equal(cancelled, true)
})
test('readLines enforces the pending buffer limit', async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('x'.repeat(20)))
      c.close()
    }
  })
  await assert.rejects(async () => {
    for await (const _line of readLines(stream, 'too large', 10)) {
      /* drain */
    }
  }, /too large/)
})
test('linkAbort forwards consumer abort and releases listeners', () => {
  const source = new AbortController(),
    link = linkAbort(source.signal, 60000)
  assert.equal(link.signal.aborted, false)
  source.abort()
  assert.equal(link.signal.aborted, true)
  link.release()
})
