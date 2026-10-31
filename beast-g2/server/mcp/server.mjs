import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadMcpConfig } from './config.mjs'

const config = loadMcpConfig()

/**
 * Calls one read-only public API route and turns both success and failure into a
 * tool result. The URL and the token never appear in the returned text.
 */
async function requestJson(pathname) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(new URL(pathname, config.baseUrl), {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      signal: controller.signal
    })
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!response.ok) {
      return {
        ok: false,
        text: JSON.stringify(
          {
            error: body?.error ?? 'http_error',
            message: body?.message ?? `Public API returned HTTP ${response.status}.`,
            status: response.status
          },
          null,
          2
        )
      }
    }
    if (body === null) {
      return { ok: false, text: JSON.stringify({ error: 'invalid_response', message: 'Public API returned a non-JSON body.' }, null, 2) }
    }
    return { ok: true, text: JSON.stringify(body, null, 2) }
  } catch (error) {
    const timeout = error?.name === 'AbortError'
    return {
      ok: false,
      text: JSON.stringify({ error: timeout ? 'timeout' : 'unreachable', message: timeout ? 'Public API request timed out.' : 'Public API is unreachable.' }, null, 2)
    }
  } finally {
    clearTimeout(timer)
  }
}

function toolResult(result) {
  const content = [{ type: 'text', text: result.text }]
  return result.ok ? { content } : { content, isError: true }
}

const server = new McpServer({ name: 'beast-g2', version: '0.1.0' })
const readOnly = { readOnlyHint: true, openWorldHint: false }

server.registerTool(
  'list_sessions',
  {
    title: 'List stored sessions',
    description: 'List stored sessions in the workspace of this token, newest first. Returns ids, names, status, language and counts. It never returns transcript text.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('Number of sessions, 1-100. Defaults to 50.')
    },
    annotations: readOnly
  },
  async ({ limit }) => toolResult(await requestJson(`/api/public/sessions${limit === undefined ? '' : `?limit=${limit}`}`))
)

server.registerTool(
  'get_session',
  {
    title: 'Get one stored session',
    description: 'Read one stored session with its turns, segments and open coverage gaps. Every summary claim carries citations to turn ids. Unknown or foreign session ids return an error.',
    inputSchema: {
      sessionId: z.string().min(1).max(64).describe('Session id from list_sessions, for example ses_...')
    },
    annotations: readOnly
  },
  async ({ sessionId }) => toolResult(await requestJson(`/api/public/sessions/${encodeURIComponent(sessionId)}`))
)

server.registerTool(
  'get_session_summary',
  {
    title: 'Get one session summary',
    description: 'Read the latest summary of one stored session, including its citation ids and review status. A session without a summary returns an error, not an empty summary.',
    inputSchema: {
      sessionId: z.string().min(1).max(64).describe('Session id from list_sessions, for example ses_...')
    },
    annotations: readOnly
  },
  async ({ sessionId }) => toolResult(await requestJson(`/api/public/sessions/${encodeURIComponent(sessionId)}/summary`))
)

server.registerTool(
  'list_memory',
  {
    title: 'List approved memory',
    description: 'List approved memory items of the workspace of this token, newest first. Items keep their source session and evidence state, including lost evidence after a session deletion.',
    inputSchema: {},
    annotations: readOnly
  },
  async () => toolResult(await requestJson('/api/public/memory'))
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`Beast G2 MCP server: ${config.baseUrl.origin} (read-only, token from PUBLIC_API_TOKEN)`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close()
    process.exit(0)
  })
}
