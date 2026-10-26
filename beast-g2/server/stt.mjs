import { ApiError } from './errors.mjs'

const MAX_PROVIDER_JSON = 1048576

async function readBoundedJson(response, limit) {
  const reader = response.body?.getReader()
  if (!reader) throw new ApiError(502, 'empty_body', 'Provider returned an empty body.')
  let size = 0
  const chunks = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new ApiError(502, 'invalid_transcription', 'Provider response exceeds the size limit.')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

export async function transcribeAudio(config, audio, { language = 'auto', fetchImpl = fetch, signal } = {}) {
  const form = new FormData()
  form.set('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav')
  form.set('model', config.sttModel)
  form.set('response_format', 'json')
  if (language !== 'auto') form.set('language', language)
  const response = await fetchImpl(config.sttUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.sttKey}` },
    body: form,
    signal,
    redirect: 'error'
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new ApiError(502, `stt_upstream_${response.status}`, `stt provider returned HTTP ${response.status}. Check the configured endpoint, key and model on the gateway.`)
  }
  let result
  try {
    result = JSON.parse((await readBoundedJson(response, MAX_PROVIDER_JSON)).toString('utf8'))
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, 'invalid_transcription', 'Provider returned an invalid transcript.')
  }
  if (typeof result.text !== 'string' || result.text.length > 4000) throw new ApiError(502, 'invalid_transcription', 'Provider returned an invalid transcript.')
  return result.text.trim()
}
