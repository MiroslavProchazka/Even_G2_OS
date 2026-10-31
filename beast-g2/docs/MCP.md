# MCP server

The MCP server exposes the read-only public API to an MCP client such as Claude
Desktop or another agent host. It is a thin stdio adapter: every tool calls a `GET`
route under `/api/public/`, and the gateway enforces the token, its scopes and its
workspace. The server does not read SQLite, does not build prompts and has no write
tool.

This is I6.2. It is not the HTTP public API itself (I6.1) and it is not a hosted
service. The client starts the server as a child process over stdio; there is no port to
open and no OAuth flow.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_API_TOKEN` | required | Public API token with the scopes the tools need. |
| `PUBLIC_API_URL` | `http://127.0.0.1:8787` | Public API base URL. HTTPS outside loopback. |
| `MCP_REQUEST_TIMEOUT_MS` | `15000` | Timeout of one public API request, 1000-120000 ms. |

`PUBLIC_API_URL` must not contain credentials, a query string or a fragment. A plain
HTTP URL is accepted only for `127.0.0.1`, `localhost` or `::1`. The token must be
32-200 characters without whitespace. A bad configuration stops the server with a
message that names the variable, never the token value.

Run it directly with:

```sh
PUBLIC_API_URL=https://gateway.example.com PUBLIC_API_TOKEN=... npm run mcp
```

## Client configuration

```json
{
  "mcpServers": {
    "beast-g2": {
      "command": "node",
      "args": ["/absolute/path/to/beast-g2/server/mcp/server.mjs"],
      "env": {
        "PUBLIC_API_URL": "https://gateway.example.com",
        "PUBLIC_API_TOKEN": "replace-with-the-public-api-token"
      }
    }
  }
}
```

Keep the real token in the MCP client configuration or its secret store, not in a
tracked file. The server reads the token from the environment and never prints it.

## Tools

| Tool | Input | Public API route | Scope |
| --- | --- | --- | --- |
| `list_sessions` | `limit` 1-100, optional | `GET /api/public/sessions?limit=` | `sessions:read` |
| `get_session` | `sessionId` | `GET /api/public/sessions/:id` | `sessions:read` |
| `get_session_summary` | `sessionId` | `GET /api/public/sessions/:id/summary` | `summaries:read` |
| `list_memory` | none | `GET /api/public/memory` | `memory:read` |

`list_sessions` returns ids, names, status, language and counts. It never returns
transcript text. `get_session` returns the session, its turns, segments and open gaps.
`get_session_summary` returns the latest summary with its citations, review status and
stale state. `list_memory` returns approved memory items of the token workspace,
including items whose source session was deleted and which carry
`evidenceState: "lost"`.

Every tool result is a JSON text block. Citations are the same citation ids the public
API returns; the MCP server does not rewrite or drop them. A token without the required
scope gets an error result with `insufficient_scope`, and a session from another
workspace gets `not_found`, never partial data.

## Read-only guarantee

The server registers four tools and every one is annotated `readOnlyHint: true`. No tool
creates, updates or deletes a session, summary or memory item, and no tool sends audio,
starts a job or builds a prompt. `OPTIONS` and write methods are irrelevant here: the
server speaks MCP over stdio, not HTTP.

## Errors

| Situation | Result |
| --- | --- |
| Public API returns 4xx or 5xx | Tool result with `isError: true` and `{error, message, status}`. |
| Token lacks a scope | `isError: true`, `error: "insufficient_scope"`, HTTP 403. |
| Unknown or foreign session | `isError: true`, `error: "not_found"`, HTTP 404. |
| Public API is unreachable | `isError: true`, `error: "unreachable"`. |
| Public API times out | `isError: true`, `error: "timeout"`. |
| Unknown tool name | JSON-RPC error from the MCP server, not an empty result. |

The error text never contains the token, the token name or the public API URL. The
server writes one startup line to stderr with the origin and no secret; it does not log
tool arguments, session text or summaries.

## Verification

`tests/mcp.test.mjs` starts a real gateway with a temporary SQLite store, starts this
server as a child process and talks to it with the official
`@modelcontextprotocol/sdk` client over stdio. It covers the tool list and read-only
annotations, own and foreign workspace listings, session detail, summary citations, a
missing scope, approved memory, an unknown tool and configuration validation. The suite
also checks that transcript text and the token never appear in a tool result.

A green suite is not evidence about a real MCP host, a phone, a tunnel or the glasses.
The server was not run through Claude Desktop, a hosted MCP gateway or a VPN.
