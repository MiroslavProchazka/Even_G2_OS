import { ApiError } from '../../errors.mjs'
import { boundedText } from '../../work-context/http.mjs'

export const NOTION_MCP = 'https://mcp.notion.com/mcp'
const READ_TOOLS = new Set(['notion-get-self', 'notion-search', 'notion-fetch'])

export function toolData(result) {
  if (result?.isError || result?.structuredContent?.error) throw new ApiError(502, 'notion_tool_failed', 'Notion could not read the requested content.')
  if (result?.structuredContent) return result.structuredContent
  const texts = result?.content?.filter((block) => block.type === 'text').map((block) => block.text)
  if (!texts?.length) throw new ApiError(502, 'notion_invalid_response', 'Notion returned no readable content.')
  let data
  try {
    data = JSON.parse(texts.join('\n'))
  } catch {
    return { text: texts.join('\n') }
  }
  if (data.error) throw new ApiError(502, 'notion_tool_failed', 'Notion could not read the requested content.')
  return data
}

// Stop after the matching reply even if the SSE connection remains open.
async function rpcReply(response, id) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return JSON.parse(await boundedText(response))
  const reader = response.body?.getReader()
  if (!reader) throw new ApiError(502, 'notion_invalid_response', 'Notion returned no stream.')
  const decoder = new TextDecoder()
  let pending = '',
    bytes = 0
  const parse = (frame) => {
    const data = frame
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) return null
    const event = JSON.parse(data)
    return event.id === id ? event : null
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      bytes += value?.byteLength || 0
      if (bytes > 1048576) throw new ApiError(502, 'work_response_limit', 'Notion response exceeds the limit.')
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let match
      while ((match = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        const reply = parse(pending.slice(0, match.index))
        pending = pending.slice(match.index + match[0].length)
        if (reply) return reply
      }
      if (done) return parse(pending)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// Narrow read-only Streamable HTTP client. No arbitrary calls, sampling or legacy /sse.
export class NotionMcp {
  constructor(token, { fetchImpl = fetch, signal = AbortSignal.timeout(30000) } = {}) {
    this.token = token
    this.fetch = fetchImpl
    this.signal = signal
    this.sequence = 0
    this.protocol = '2025-03-26'
  }
  async rpc(method, params, notification = false) {
    const id = notification ? undefined : ++this.sequence
    const response = await this.fetch(NOTION_MCP, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(method === 'initialize' ? {} : { 'MCP-Protocol-Version': this.protocol }),
        ...(this.session ? { 'Mcp-Session-Id': this.session } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
      signal: this.signal,
      redirect: 'error'
    })
    if (!response.ok) {
      await response.body?.cancel()
      const unauthorized = response.status === 401
      throw new ApiError(unauthorized ? 401 : 502, unauthorized ? 'notion_reconnect' : 'notion_unavailable', 'Notion is unavailable or requires reconnecting.')
    }
    if (notification) {
      await response.body?.cancel()
      return
    }
    this.session = response.headers.get('mcp-session-id') || this.session
    let reply
    try {
      reply = await rpcReply(response, id)
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'notion_invalid_response', 'Notion returned invalid protocol data.')
    }
    if (!reply || reply.id !== id || reply.error || !reply.result) throw new ApiError(502, 'notion_rpc_failed', 'Notion did not complete the requested operation.')
    return reply.result
  }
  async initialize() {
    const clientInfo = { name: 'beast-g2-work-context', version: '0.1.0' }
    const result = await this.rpc('initialize', { protocolVersion: this.protocol, capabilities: {}, clientInfo })
    if (!['2025-03-26', '2025-06-18', '2025-11-25'].includes(result.protocolVersion)) throw new ApiError(502, 'notion_protocol', 'Unsupported Notion MCP protocol version.')
    this.protocol = result.protocolVersion
    await this.rpc('notifications/initialized', {}, true)
    const tools = await this.rpc('tools/list', {})
    if (!Array.isArray(tools.tools) || ![...READ_TOOLS].every((name) => tools.tools.some((tool) => tool.name === name)))
      throw new ApiError(502, 'notion_tools_missing', 'This Notion connection must expose identity, search and fetch tools.')
    return this
  }
  async call(name, args = {}) {
    if (!READ_TOOLS.has(name)) throw new ApiError(403, 'notion_tool_denied', 'Only approved Notion read tools are available.')
    return toolData(await this.rpc('tools/call', { name, arguments: args }))
  }
}
