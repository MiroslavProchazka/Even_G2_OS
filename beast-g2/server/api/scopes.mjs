// Scopes, token parsing and bearer authentication for the read-only public API.
//
// A public token is a per-client secret with a fixed scope list and one workspace. It is not the
// gateway token: the gateway mounts `/api/public/` before its own token check, so the two credentials
// never satisfy each other. See docs/API.md.
import { createHash, timingSafeEqual } from 'node:crypto'
import { ApiError } from '../errors.mjs'

export const PUBLIC_SCOPES = ['sessions:read', 'summaries:read', 'memory:read']

const NAME = /^[a-z0-9-]{1,40}$/
const WORKSPACE = /^[A-Za-z0-9._:-]{1,64}$/
const BEARER = /^Bearer ([^\s]+)$/i
const TOKEN_MIN = 32
const TOKEN_MAX = 200

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest()
}

function label(entry, index) {
  return entry && typeof entry.name === 'string' && NAME.test(entry.name) ? `entry "${entry.name}"` : `entry #${index + 1}`
}

/**
 * Parses `PUBLIC_API_TOKENS` when `PUBLIC_API_ENABLED=1`. Every message names the field and the
 * entry, never the token value: a configuration error must not print a secret to the console.
 */
export function parsePublicApiTokens(raw) {
  let entries
  try {
    entries = JSON.parse(raw ?? '')
  } catch {
    throw new Error('PUBLIC_API_TOKENS must be a JSON array of token objects.')
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('PUBLIC_API_TOKENS must contain at least one token when PUBLIC_API_ENABLED=1.')
  }
  const names = new Set()
  const digests = new Set()
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`PUBLIC_API_TOKENS entry #${index + 1} must be an object.`)
    }
    const where = label(entry, index)
    if (typeof entry.name !== 'string' || !NAME.test(entry.name)) {
      throw new Error(`PUBLIC_API_TOKENS ${where}: name must contain 1-40 characters of a-z, 0-9 or hyphen.`)
    }
    if (names.has(entry.name)) {
      throw new Error(`PUBLIC_API_TOKENS ${where}: name is already used by another entry.`)
    }
    names.add(entry.name)
    if (typeof entry.token !== 'string' || entry.token.length < TOKEN_MIN || entry.token.length > TOKEN_MAX || /\s/.test(entry.token)) {
      throw new Error(`PUBLIC_API_TOKENS ${where}: token must contain ${TOKEN_MIN}-${TOKEN_MAX} characters without whitespace.`)
    }
    const tokenDigest = digest(entry.token)
    if (digests.has(tokenDigest.toString('hex'))) {
      throw new Error(`PUBLIC_API_TOKENS ${where}: token is already used by another entry.`)
    }
    digests.add(tokenDigest.toString('hex'))
    if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) {
      throw new Error(`PUBLIC_API_TOKENS ${where}: scopes must be a non-empty array of ${PUBLIC_SCOPES.join(', ')}.`)
    }
    if (new Set(entry.scopes).size !== entry.scopes.length) {
      throw new Error(`PUBLIC_API_TOKENS ${where}: scopes must not repeat.`)
    }
    if (!entry.scopes.every((scope) => PUBLIC_SCOPES.includes(scope))) {
      throw new Error(`PUBLIC_API_TOKENS ${where}: scopes must be a non-empty array of ${PUBLIC_SCOPES.join(', ')}.`)
    }
    if (typeof entry.workspaceId !== 'string' || !WORKSPACE.test(entry.workspaceId)) {
      throw new Error(`PUBLIC_API_TOKENS ${where}: workspaceId must contain 1-64 characters of letters, digits, dot, colon, underscore or hyphen.`)
    }
    return { name: entry.name, token: entry.token, scopes: [...entry.scopes], workspaceId: entry.workspaceId }
  })
}

/**
 * Returns the matching token entry or null. Every entry is compared through a SHA-256 digest with
 * `timingSafeEqual`, and the loop does not stop at the first match, so the response time does not
 * depend on which entry matched.
 */
export function authenticatePublicToken(tokens, authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null
  const match = BEARER.exec(authorizationHeader)
  if (!match) return null
  const presented = digest(match[1])
  let found = null
  for (const entry of tokens ?? []) {
    if (entry && typeof entry.token === 'string' && timingSafeEqual(presented, digest(entry.token))) found ??= entry
  }
  return found
}

/** Throws `403 insufficient_scope` before the caller reads anything. */
export function requireScope(entry, scope) {
  if (!entry || !Array.isArray(entry.scopes) || !entry.scopes.includes(scope)) {
    throw new ApiError(403, 'insufficient_scope', `This token does not carry the ${scope} scope.`)
  }
  return entry
}
