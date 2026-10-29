import { createHash, randomBytes } from 'node:crypto'
import { ApiError } from '../../errors.mjs'
import { providerJson } from '../../work-context/http.mjs'
import { NotionMcp, NOTION_MCP } from './mcp.mjs'

function trustedUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ApiError(502, 'notion_oauth_metadata', 'Invalid Notion authorization metadata.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'notion.com' || url.hostname.endsWith('.notion.com')))
    throw new ApiError(502, 'notion_oauth_metadata', 'Unexpected Notion authorization endpoint.')
  return url.href
}
const canonical = (value) =>
  String(value || '')
    .replaceAll('-', '')
    .toLowerCase()

// Cancellation stops waiting, while shared rotation preserves any newly issued token.
async function waitForRefresh(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  let abort
  const interrupted = new Promise((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([promise, interrupted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export class NotionConnection {
  constructor({ store, redirectUri, workspaceId, fetchImpl = fetch, makeMcp = (token, options) => new NotionMcp(token, options), now = Date.now }) {
    const redirect = new URL(redirectUri)
    const local = redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname)
    if ((!local && redirect.protocol !== 'https:') || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/api/notion/callback')
      throw new Error('NOTION_REDIRECT_URI must be an HTTPS callback URL (HTTP loopback allowed for development).')
    if (!/^[a-f0-9]{32}$/.test(canonical(workspaceId))) throw new Error('Set NOTION_WORKSPACE_ID to the intended work workspace ID.')
    Object.assign(this, { store, redirectUri, fetch: fetchImpl, makeMcp, now, workspaceId: canonical(workspaceId) })
    this.pending = null
    this.revision = 0
    this.refreshing = null
  }
  status() {
    const record = this.store.read()
    const connected = Boolean(record && record.workspaceId === this.workspaceId)
    return { configured: true, connected, ...(connected ? { workspaceId: record.workspaceId } : {}) }
  }
  async begin(signal) {
    const revision = this.revision
    const resource = await providerJson(this.fetch, 'https://mcp.notion.com/.well-known/oauth-protected-resource', { signal })
    const issuer = trustedUrl(resource.authorization_servers?.[0])
    const metadata = await providerJson(this.fetch, new URL('/.well-known/oauth-authorization-server', issuer), { signal })
    const authorization = trustedUrl(metadata.authorization_endpoint)
    const tokenEndpoint = trustedUrl(metadata.token_endpoint)
    const registration = trustedUrl(metadata.registration_endpoint)
    const client = await providerJson(this.fetch, registration, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        client_name: 'Beast G2 Work Context',
        redirect_uris: [this.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    })
    if (typeof client.client_id !== 'string') throw new ApiError(502, 'notion_registration', 'Could not register the Notion connection.')
    if (revision !== this.revision) throw new ApiError(409, 'notion_connection_changed', 'Notion connection changed. Start again.')
    const state = randomBytes(32).toString('hex'),
      verifier = randomBytes(32).toString('base64url')
    this.pending = { state, verifier, clientId: client.client_id, tokenEndpoint, expires: this.now() + 600000, revision }
    const url = new URL(authorization)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: this.redirectUri,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: NOTION_MCP
    }).toString()
    return { authorizationUrl: url.href }
  }
  async callback(query, signal) {
    const pending = this.pending
    if (!pending || pending.expires < this.now() || query.get('state') !== pending.state) throw new ApiError(400, 'notion_oauth_state', 'The Notion login expired or has invalid state. Start again.')
    this.pending = null
    if (query.get('error') || !query.get('code')) throw new ApiError(400, 'notion_oauth_denied', 'Notion authorization was not completed.')
    const tokens = await this.exchange(
      pending.tokenEndpoint,
      { grant_type: 'authorization_code', code: query.get('code'), client_id: pending.clientId, redirect_uri: this.redirectUri, code_verifier: pending.verifier, resource: NOTION_MCP },
      signal
    )
    const identity = await this.identity(tokens.access_token, signal)
    if (pending.revision !== this.revision) throw new ApiError(409, 'notion_connection_changed', 'Notion connection changed. Start again.')
    this.store.write({ clientId: pending.clientId, tokenEndpoint: pending.tokenEndpoint, tokens, expires: this.expiry(tokens), workspaceId: identity.workspaceId })
    this.revision++
    return { connected: true }
  }
  expiry(tokens) {
    return this.now() + (Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? tokens.expires_in : 3600) * 1000
  }
  async exchange(endpoint, params, signal) {
    const tokens = await providerJson(
      this.fetch,
      endpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal },
      'notion_reconnect'
    )
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new ApiError(502, 'notion_reconnect', 'Reconnect Notion to continue.')
    return tokens
  }
  async identity(token, signal) {
    const mcp = await this.makeMcp(token, { fetchImpl: this.fetch, signal }).initialize()
    const data = await mcp.call('notion-get-self')
    if (canonical(data.workspace?.id) !== this.workspaceId) throw new ApiError(403, 'notion_workspace_mismatch', 'Connect the configured work Notion workspace.')
    return { workspaceId: this.workspaceId, mcp }
  }
  async client(signal) {
    let record = this.store.read()
    if (!record || record.workspaceId !== this.workspaceId) throw new ApiError(401, 'notion_reconnect', 'Connect the configured work Notion workspace first.')
    const revision = this.revision
    if (record.expires <= this.now() + 60000) {
      if (!record.tokens.refresh_token) throw new ApiError(401, 'notion_reconnect', 'Reconnect Notion to continue.')
      // A shared refresh prevents concurrent use of a rotating refresh token.
      this.refreshing ||= (async () => {
        const tokens = await this.exchange(
          record.tokenEndpoint,
          { grant_type: 'refresh_token', refresh_token: record.tokens.refresh_token, client_id: record.clientId, resource: NOTION_MCP },
          AbortSignal.timeout(30000)
        )
        if (revision !== this.revision) throw new ApiError(409, 'notion_connection_changed', 'Notion connection changed.')
        this.store.write({ ...record, tokens: { ...record.tokens, ...tokens }, expires: this.expiry(tokens) })
      })().finally(() => {
        this.refreshing = null
      })
      await waitForRefresh(this.refreshing, signal)
      record = this.store.read()
    }
    signal?.throwIfAborted()
    if (!record || revision !== this.revision) throw new ApiError(409, 'notion_connection_changed', 'Notion connection changed.')
    const identity = await this.identity(record.tokens.access_token, signal)
    if (revision !== this.revision) throw new ApiError(409, 'notion_connection_changed', 'Notion connection changed.')
    return identity.mcp
  }
  disconnect() {
    this.revision++
    this.pending = null
    this.store.clear()
    return { connected: false }
  }
}
