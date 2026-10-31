import { ApiError } from '../errors.mjs'

export async function boundedText(response, limit = 1048576) {
  const reader = response.body?.getReader()
  if (!reader) throw new ApiError(502, 'work_empty_response', 'The provider returned no content.')
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new ApiError(502, 'work_response_limit', 'The provider response exceeds the limit.')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function providerJson(fetchImpl, url, init, code = 'work_provider_failed') {
  const response = await fetchImpl(url, { ...init, redirect: 'error' })
  if (!response.ok) {
    await response.body?.cancel()
    throw new ApiError(502, code, 'The provider request failed. Check connection and authentication.')
  }
  try {
    return JSON.parse(await boundedText(response))
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, code, 'The provider returned an invalid response.')
  }
}
