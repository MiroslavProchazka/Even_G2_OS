import { ApiError } from './errors.mjs'

export function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

export async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new ApiError(413, 'too_large', 'Request exceeds size limit.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody(req, limit = 120000) {
  let input
  try {
    input = JSON.parse((await readBody(req, limit)).toString('utf8'))
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'invalid_json', 'Malformed JSON.')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'invalid_json', 'Expected a JSON object.')
  return input
}
