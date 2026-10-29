# Notion work context

This is an opt-in read-only extension to the existing Beast G2 gateway. Notion remains the
source of truth; no pages, tasks or transcripts are imported into the session database.
The phone keeps a separate bounded work conversation in memory. Closing the application,
clearing the conversation or applying connection settings clears it.

## Data flow

G2 manual Ask or phone question → authenticated gateway → Notion MCP search/fetch →
Beast synthesis → validated short lens hint and phone detail with source excerpts.

The gateway, not the model, controls the three allowed Notion tools. Native model tool
calling and a Dot API are not required. Existing ordinary chat, captions and stored capture
remain separate. Work retrieval has its own concurrency budget; it does not occupy the
ordinary chat/STT slots. It is not connected to automatic continuous hints.

## Configure

Use live gateway mode and the existing server-only settings in `.env.example`:

```dotenv
BEAST_CHAT_URL=https://beast.example.com/v1/chat/completions
BEAST_CHAT_MODEL=beast/big
BEAST_API_KEY=<server-side key>
BEAST_STT_URL=https://beast.example.com/v1/audio/transcriptions
BEAST_STT_MODEL=whisper-live
WORK_CONTEXT_ENABLED=1
NOTION_WORKSPACE_ID=<work workspace UUID>
NOTION_REDIRECT_URI=https://gateway.example.com/api/notion/callback
NOTION_TOKEN_ENCRYPTION_KEY=<64 hexadecimal characters>
```

The URLs above are placeholders. Configure the actual full provider URLs; verify the STT
endpoint/model separately. Generate the encryption key with `openssl rand -hex 32` and keep it
outside source control. The gateway continues to require its own `GATEWAY_TOKEN`, HTTPS and
an exact `ALLOWED_ORIGINS` list. The device manifest whitelist must include the real gateway
origin before packaging. Provider and Notion credentials never enter the frontend or package.

Host the gateway where it can reach both Beast and `https://mcp.notion.com/mcp`. The mobile
VPN must route to the gateway and resolve its DNS name. A phone VPN does not provide the
server with network access to Beast. Exposing the gateway publicly is not required.

## Connect and use

1. In phone settings select **Custom gateway**, enter its origin and gateway token, and apply.
2. In **Work context · Notion**, click **Connect Notion**, then the generated sign-in link.
3. Authorize the intended workspace. The callback rejects any workspace other than
   `NOTION_WORKSPACE_ID`. Return to the application and click **Check Notion**.
4. Ask a work question in that panel. Follow-up questions use the separate work history.
5. To use the G2 microphone or the existing text Ask, enable **Use work context for manual
   Ask from glasses** and select Manual listening mode. Only the short validated hint goes
   to the lens; full detail and source links appear in the work panel.
6. **Cancel question** cancels work retrieval. **Clear work conversation** clears local context.
   **Disconnect Notion** deletes this gateway's credentials and invalidates in-flight answers.

Disconnect is local removal, not revocation at Notion. Revoke the client in Notion as well if
needed. **Check Notion** reports locally stored connection state; actual tool access and
workspace identity are rechecked on every question.

OAuth uses discovery, dynamic public-client registration, authorization code + PKCE and
single-use state expiring after ten minutes. Restarting the gateway discards unfinished logins.
Access and refresh credentials are stored in `SESSION_DATA_DIR/notion-credentials.enc`,
authenticated with AES-256-GCM and mode 0600, and replaced atomically. The key is separate
from that file. Concurrent refreshes share one operation to respect refresh-token rotation.
Backups of the data directory include encrypted credentials; protect the key separately.

## HTTP contract

All routes require the gateway bearer token except the OAuth callback. That callback accepts
only a matching pending state and authorization code; it never trusts an arbitrary workspace.
All responses have `requestId`, no-store caching and existing gateway error mapping.

| Method and path | Purpose |
| --- | --- |
| `GET /api/notion/status` | Locally configured/connected state, never tokens |
| `POST /api/notion/connect` | Create a login URL |
| `GET /api/notion/callback` | Consume a single-use OAuth login |
| `POST /api/notion/disconnect` | Delete gateway credentials and invalidate requests |
| `POST /api/work/ask` | `{question, history?: [{role, content}]}` |

An answer has `status` (`answered`, `needs_clarification` or `insufficient_evidence`), `hint`,
`detail`, `citations` and `coverage`. Citations contain source ID, canonical URL, title, page ID,
exact excerpt and truncation state. Coverage contains retrieval time, pages read, partial flag
and scope `selected_notion_results`.

## Bounds and evidence

- Question: 2,000 characters. History: six user/assistant turns, 12,000 total characters.
- Query planning: short keywords, followed by one bounded retrieval and one synthesis.
- Retrieval: at most five fetched pages, 12,000 characters per page, 30,000 total characters.
- Provider response: at most 1 MiB. Work HTTP request: at most 24,000 bytes.
- Hint: 160 Unicode code points. Detail: 4,000 characters. Up to ten citations.
- Overall request deadline: `UPSTREAM_TIMEOUT_MS`; disconnect/cancel invalidates the result.

Search results alone are not evidence. Selected pages are fetched before synthesis. Dropped
filters, omitted results and truncated content mark coverage as partial. This version does not
page through an entire workspace or claim exhaustive task coverage. Fetch/identity/search
failures produce an error, never a fallback answer pretending to have workspace evidence.

The server checks that each cited source was loaded and that the quoted excerpt occurs in
that source. This is structural evidence validation, not proof that a model's interpretation
is correct. Evaluate ambiguity, newer task updates, proposed versus agreed decisions and
completion claims on annotated examples before relying on the feature.

## Supported protocol and known limits

The dependency-free MCP client implements the hosted Streamable HTTP transport, JSON or
SSE response bodies, initialization, session headers and the three exact tools
`notion-get-self`, `notion-search`, `notion-fetch`. It does not implement legacy `/sse`,
server-initiated sampling or arbitrary MCP servers. The deployed tool list must include all
three names. Non-ChatGPT Notion result shapes may vary; unsupported shapes fail explicitly.

Reading nested pages, attachment-only meeting transcripts or database task rows may require
additional retrieval adapters. Those are not silently treated as loaded. This MVP uses bounded
keyword search; task-specific data-source queries, project briefs, calendar lookup, proactive
notifications and confirmed writes are subsequent work. There is no claim that every search
result reflects an exhaustive or current task ledger.

## Verification

Synthetic tests cover OAuth state and workspace checks, encrypted persistence, token rotation,
disconnect races, MCP JSON/SSE framing, finite retrieval, source validation, HTTP authentication,
timeouts, capacity isolation and separate client history. No live Notion/Beast calls, work data,
mobile VPN session or real G2 hardware are used by those tests.

Before a live pilot verify: the actual Notion response shapes, readable meeting transcripts,
Beast structured JSON quality, configured workspace, mobile VPN routing, deployed manifest,
Czech speech recognition, G2 display and cancellation after a network drop. Measure search,
planning and synthesis latency separately. No background or locked-phone guarantee is made.

References: [Notion MCP](https://developers.notion.com/guides/mcp/overview),
[custom MCP client](https://developers.notion.com/guides/mcp/build-mcp-client),
[supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools).
