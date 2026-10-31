const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const MIN_TOKEN = 32
const MAX_TOKEN = 200

/**
 * Reads the MCP server configuration. The token is the public API token of one
 * workspace; it is never printed and never written to a file by this module.
 */
export function loadMcpConfig(env = process.env) {
  const token = (env.PUBLIC_API_TOKEN ?? '').trim()
  if (token.length < MIN_TOKEN || token.length > MAX_TOKEN || /\s/.test(token)) {
    throw new Error(`Set PUBLIC_API_TOKEN to the public API token (${MIN_TOKEN}-${MAX_TOKEN} characters, no whitespace).`)
  }
  const rawUrl = env.PUBLIC_API_URL ?? 'http://127.0.0.1:8787'
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('PUBLIC_API_URL must be a valid URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PUBLIC_API_URL must use http or https.')
  if (url.username || url.password) throw new Error('PUBLIC_API_URL must not contain credentials.')
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new Error('PUBLIC_API_URL must use https outside loopback.')
  }
  if (url.search || url.hash) throw new Error('PUBLIC_API_URL must not contain a query string or fragment.')
  const timeout = Number(env.MCP_REQUEST_TIMEOUT_MS ?? 15000)
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
    throw new Error('MCP_REQUEST_TIMEOUT_MS must be an integer between 1000 and 120000.')
  }
  return { baseUrl: url, token, timeoutMs: timeout }
}
