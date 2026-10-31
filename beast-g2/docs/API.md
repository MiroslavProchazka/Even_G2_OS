# Public API

The public API exposes approved memory, summaries and stored sessions to another
client over HTTP. It is read-only: every route is a `GET`, no route creates,
updates or deletes anything, and a token can only read the workspace it was issued
for. It is not the MCP server (I6.2) and it is not a hosting or tunnelling
feature.

The API lives under `/api/public/` in the same gateway process as the phone and
glasses routes. It reads the same SQLite store as `/api/sessions` and
`/api/memory`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_API_ENABLED` | `0` | `1` turns the public API on. Any other value leaves it off. |
| `PUBLIC_API_TOKENS` | `[]` | JSON array of token objects. Read only when the API is enabled. |

```dotenv
PUBLIC_API_ENABLED=1
PUBLIC_API_TOKENS=[{"name":"laptop","token":"replace-with-a-random-token-of-at-least-32-characters","scopes":["sessions:read","summaries:read","memory:read"],"workspaceId":"default"}]
```

`PUBLIC_API_TOKENS` must be valid JSON on one line. Each entry has:

| Field | Rule |
| --- | --- |
| `name` | 1-40 characters of `a-z`, `0-9` or `-`, unique. |
| `token` | 32-200 characters without whitespace, unique. |
| `scopes` | Non-empty array of unique values from the scope table. |
| `workspaceId` | 1-64 characters of letters, digits, `.`, `_`, `:`, `-`. |

Validation runs at startup. A configuration error is a plain `Error` that names
the offending field and entry but never the token value, so a bad token cannot
reach the console. `PUBLIC_API_ENABLED=1` with an empty or invalid token array
refuses to start. When the API is disabled, `PUBLIC_API_TOKENS` is ignored
completely, including malformed JSON.

The API also needs the stored session store. Without it the API reports itself as
disabled and every public path returns `404 public_api_disabled`.

`GET /api/health` reports `publicApi: true` only when at least one valid token is
configured and the stored session service is present.

## Scopes

| Scope | Grants |
| --- | --- |
| `sessions:read` | `GET /api/public/sessions` and `GET /api/public/sessions/:id`. |
| `summaries:read` | `GET /api/public/sessions/:id/summary`. |
| `memory:read` | `GET /api/public/memory`. |

`GET /api/public/me` needs no scope: it only describes the token itself.

A missing scope is checked before any session, summary or memory lookup and before
a response body is assembled. It returns `403 insufficient_scope`; the response never
contains a partial list. A token without `summaries:read` therefore cannot learn
whether a session id exists by asking for its summary.

## Authentication

Every request carries the token in the `Authorization` header:

```http
Authorization: Bearer <public-token>
```

A missing, malformed or unknown token returns `401 unauthorized`. The scheme is
case-insensitive; the token itself is compared by SHA-256 digest in constant time.

A public token is not the gateway token:

- A public token never opens `/api/sessions`, `/api/memory`, `/api/health`,
  `/api/chat` or `/api/transcribe`; those routes return `401 unauthorized`.
- `GATEWAY_TOKEN` never opens `/api/public/*`; it returns `401 unauthorized`.
- The two checks are separate. A public request is mounted before the gateway token
  check, so it never has to match `GATEWAY_TOKEN`.

## Endpoints

Every response carries `requestId`, the same id as the `X-Request-Id` response
header. Bodies below omit nothing that the route returns.

### `GET /api/public/me`

Returns the token name, scopes and workspace. The token value is never returned.

```bash
curl -H "Authorization: Bearer $PUBLIC_TOKEN" https://gateway.example/api/public/me
```

```json
{
  "token": {
    "name": "laptop",
    "scopes": ["sessions:read", "summaries:read", "memory:read"],
    "workspaceId": "default"
  },
  "requestId": "6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b"
}
```

### `GET /api/public/sessions?limit=`

Returns the newest sessions of the token workspace. `limit` is an integer from 1
to 100 and defaults to 50. A non-integer or out-of-range value returns
`400 invalid_limit`.

The list never contains transcript text, audio paths, jobs, summaries or provider
configuration.

```bash
curl -H "Authorization: Bearer $PUBLIC_TOKEN" "https://gateway.example/api/public/sessions?limit=20"
```

```json
{
  "sessions": [
    {
      "id": "ses_0123456789abcdef0123456789abcdef",
      "name": "Planning call",
      "status": "ended",
      "source": "g2",
      "language": "cs",
      "createdAt": 1767225600000,
      "startedAt": 1767225601000,
      "endedAt": 1767225900000,
      "transcriptRevision": 3,
      "coverageDeclared": "complete"
    }
  ],
  "requestId": "6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b"
}
```

A session from another workspace is never listed, even when it is newer than
every session of the token workspace.

### `GET /api/public/sessions/:id`

Returns one session, its final transcript turns, its coverage gaps and a coverage
summary. The session must belong to the token workspace.

```bash
curl -H "Authorization: Bearer $PUBLIC_TOKEN" \
  https://gateway.example/api/public/sessions/ses_0123456789abcdef0123456789abcdef
```

```json
{
  "session": {
    "id": "ses_0123456789abcdef0123456789abcdef",
    "name": "Planning call",
    "status": "ended",
    "source": "g2",
    "language": "cs",
    "createdAt": 1767225600000,
    "startedAt": 1767225601000,
    "endedAt": 1767225900000,
    "transcriptRevision": 3,
    "coverageDeclared": "partial"
  },
  "turns": [
    {
      "id": "turn_0123456789abcdef0123456789abcdef",
      "text": "The budget is 120 thousand crowns.",
      "revision": 1,
      "startMs": 0,
      "endMs": 30000,
      "createdAt": 1767225630000
    }
  ],
  "gaps": [{ "startMs": 30000, "endMs": 60000, "reason": "network" }],
  "coverage": { "declared": "partial", "pendingTranscriptions": 0 },
  "requestId": "6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b"
}
```

An unknown id, a malformed id, a deleted session and a session from another
workspace all return the same `404 not_found`. The response does not distinguish
them.

### `GET /api/public/sessions/:id/summary`

Returns the latest summary of an own session, including its citations and action
candidates. A session without a summary returns `404 not_found`.

```bash
curl -H "Authorization: Bearer $PUBLIC_TOKEN" \
  https://gateway.example/api/public/sessions/ses_0123456789abcdef0123456789abcdef/summary
```

```json
{
  "summary": {
    "id": "sum_0123456789abcdef0123456789abcdef",
    "status": "ready",
    "reviewStatus": "unreviewed",
    "transcriptRevision": 3,
    "createdAt": 1767225901000,
    "readyAt": 1767225905000,
    "editedAt": null,
    "content": {
      "overview": { "text": "The team agreed on the budget.", "citations": ["turn_0123456789abcdef0123456789abcdef"] },
      "decisions": [{ "text": "The budget is 120 thousand crowns.", "citations": ["turn_0123456789abcdef0123456789abcdef"] }],
      "actionCandidates": [],
      "openQuestions": [],
      "coverage": { "declared": "partial", "turns": 1, "pendingTranscriptions": 0, "gaps": [] }
    },
    "citations": [
      {
        "turnId": "turn_0123456789abcdef0123456789abcdef",
        "turnRevision": 1,
        "startMs": 0,
        "endMs": 30000,
        "quote": "The budget is 120 thousand crowns.",
        "createdAt": 1767225905000
      }
    ],
    "actionCandidates": [],
    "coverage": { "declared": "partial", "turns": 1, "pendingTranscriptions": 0, "gaps": [] }
  },
  "requestId": "6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b"
}
```

A citation carries the quoted turn text because a citation without its quote
cannot be checked. This is the only place where the public API returns a quote from
the transcript.

### `GET /api/public/memory`

Returns approved memory items of the token workspace, newest first. It includes
items whose source session was deleted; such an item keeps `sessionId`, `turnId` and
`turnRevision` and reports `evidenceState: "lost"`.

```bash
curl -H "Authorization: Bearer $PUBLIC_TOKEN" https://gateway.example/api/public/memory
```

```json
{
  "items": [
    {
      "id": "mem_0123456789abcdef0123456789abcdef",
      "kind": "decision",
      "text": "The budget is 120 thousand crowns.",
      "sessionId": "ses_0123456789abcdef0123456789abcdef",
      "turnId": "turn_0123456789abcdef0123456789abcdef",
      "turnRevision": 1,
      "status": "approved",
      "evidenceState": "present",
      "createdAt": 1767225700000,
      "updatedAt": 1767225710000,
      "approvedAt": 1767225710000
    }
  ],
  "requestId": "6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b"
}
```

Only `approved` items are returned. Proposed, rejected and superseded items
never appear. `sourceQuote` is never returned because it is the exact transcript
text. The route accepts no `status` or `query` parameter; both are ignored and the
result stays the approved list of the token workspace.

## Errors

Errors use the same body shape as the rest of the gateway:

```json
{ "error": "insufficient_scope", "message": "This token does not carry the summaries:read scope.", "requestId": "6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b" }
```

| Status | Code | When |
| --- | --- | --- |
| `400` | `invalid_limit` | `limit` is not an integer from 1 to 100. |
| `401` | `unauthorized` | The token is missing, malformed or unknown. |
| `403` | `insufficient_scope` | The token lacks the scope of the route. |
| `404` | `public_api_disabled` | The public API is disabled. Every public path returns this code. |
| `404` | `not_found` | The path is unknown, the session is unknown, malformed, deleted or foreign, or the session has no summary. |
| `405` | `method_not_allowed` | The path is known and the method is not `GET`. The response carries `Allow: GET`. |
| `429` | `rate_limited` | The shared gateway rate limit is exhausted. The response carries `Retry-After`. |
| `500` | `internal_error` | An unexpected failure. The body carries no internal detail. |

Order of checks: authentication (`401`), then route match (`404`), then method
(`405`), then scope (`403`), then the read and the workspace check (`400`/`404`).
A token without a scope never learns whether a session id exists.

## Workspace isolation

The workspace comes from the token, never from a query parameter or a request
body. The API has no route that accepts a workspace id.

- `GET /api/public/sessions` filters the stored list to the token workspace
  before applying `limit`.
- `GET /api/public/sessions/:id` returns `404 not_found` for a session in another
  workspace. It never returns the row and never returns `403`.
- `GET /api/public/sessions/:id/summary` applies the same session check before it
  reads a summary.
- `GET /api/public/memory` filters `memory_items` by `workspace_id`.

A malformed session id and a foreign session id look identical: both are
`404 not_found`.

## Read-only guarantee

Every public route is a `GET`. `POST`, `PATCH`, `PUT` and `DELETE` on a known
public path return `405 method_not_allowed` with `Allow: GET`. `OPTIONS` stays the
gateway-wide CORS preflight and returns `204` without touching a read. No public
route calls a write method on the repository, the session service or the summary
service. The API has no route for creating a session, correcting a turn, reviewing
memory or requesting a summary; those actions stay on the gateway API and the phone
panel.

## Token rotation

Tokens are read at startup. To rotate one:

1. Add a new entry with a new `name` and a new `token` to `PUBLIC_API_TOKENS`.
2. Restart the gateway. Both the old and the new token work after the restart
   only if both entries are present.
3. Move the client to the new token.
4. Remove the old entry and restart the gateway. The old token stops working.

A token cannot be changed at runtime and there is no revocation endpoint. Use a
separate entry per client so one client can be removed without touching another.
Never commit a real token to the repository, a test fixture or a document.

## Logging and privacy

The request log records the request id, method, pathname, status, duration, error
code and stage. A query string is stripped before the entry is built, so a token in a
query string never reaches the log. The log entry shape has no field for a bearer
token or a token name, so neither the token value nor the token name is logged; the
pathname is the only request metadata this API adds to the log.

Transcript text, prompts, provider bodies, audio paths and memory source quotes are
never written to the request log.

## What the API does not expose

- Audio and audio paths. The session detail has no segments and no `audioPath`.
- Transcription jobs, job errors, retry state and worker state.
- Prompts, provider configuration and provider profiles.
- Memory `sourceQuote` and any other copy of the transcript text outside the
  session turns and summary citations.
- Summaries in the session list and in the session detail; summaries have their own
  route.
- Session goal, preparation notes, retention settings, writer leases and expiry
  timestamps.
- Writes of any kind: no create, update, delete, review, correction, import,
  summary request or memory proposal.
- Other workspaces. A token sees only its own workspace.

## Health

`GET /api/health` is a gateway route and still requires `GATEWAY_TOKEN`. It reports
`publicApi: true` when the public API has at least one valid token and the stored
session service is present.

```json
{
  "ok": true,
  "mode": "live",
  "models": { "chat": "beast/big", "stt": "whisper-live" },
  "webSearch": false,
  "sessions": true,
  "summaries": true,
  "workContext": false,
  "briefing": true,
  "publicApi": true,
  "requestId": "6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b"
}
```
