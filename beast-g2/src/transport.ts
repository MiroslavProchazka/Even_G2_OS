// Shared streaming and cancellation plumbing for both transports.
export async function* readLines(stream: ReadableStream<Uint8Array>, errorMessage = 'Stream frame exceeds limit.', maxPending = 65536): AsyncGenerator<string> {
  const reader = stream.getReader(),
    decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (pending.length > maxPending) throw new Error(errorMessage)
      let match: RegExpExecArray | null
      while ((match = /\r\n|\n|\r(?!$)/.exec(pending))) {
        yield pending.slice(0, match.index)
        pending = pending.slice(match.index + match[0].length)
      }
      if (done) {
        if (pending) yield pending.replace(/\r$/, '')
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
export function linkAbort(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs),
    controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  timeout.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const release = () => {
    signal?.removeEventListener('abort', abort)
    timeout.removeEventListener('abort', abort)
  }
  return { signal: controller.signal, timeout, release }
}
