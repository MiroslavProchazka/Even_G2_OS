# Architecture

The gateway is a small Node HTTP server (`server/gateway.mjs`) in front of an optional
SQLite session store. This document describes the seams that let parallel feature phases
add behaviour without editing the same files, plus the ownership rules that keep merges
conflict-free.

## Server layout

| File | Responsibility |
| --- | --- |
| `server/gateway.mjs` | HTTP server, auth, CORS, rate limit, `/api/health`, `/api/chat`, `/api/transcribe`. |
| `server/sessions/http.mjs` | Thin `/api/sessions` dispatcher: prefix check, 405 helper, 404, registry loop. |
| `server/sessions/routes/index.mjs` | Ordered route registry. |
| `server/sessions/routes/sessions.mjs` | Session lifecycle, segments, import, gaps, export, turn corrections. |
| `server/sessions/routes/summaries.mjs` | Summaries and preparations. |
| `server/sessions/routes/respond.mjs` | Shared `methodNotAllowed` and `notFound` responders. |
| `server/sessions/db.mjs` | SQLite open, pragmas and the `migrate()` runner. |
| `server/sessions/migrations/index.mjs` | Ordered migration registry. |
| `server/sessions/migrations/001-initial.mjs`, `002-summaries.mjs` | One migration per file: `version` and `sql`. |
| `server/sessions/service.mjs` | Session domain logic (core session, transcript, coverage). |
| `server/sessions/summary.mjs` | Summary and preparation domain logic. |
| `server/sessions/repository.mjs` | SQL queries; no HTTP knowledge. |
| `server/sessions/worker.mjs` | Transcription and summary job runner. |

## Route module contract

A route module is a `.mjs` file in `server/sessions/routes/` that exports:

```js
export function match(parts) {}   // parts = path segments after the host, e.g. ['api','sessions',':id','export']
export async function handle(ctx) {}
```

`match(parts)` is a pure predicate. It must not read the request body, touch the
database or throw for malformed paths. `parts[0]` is `api`, `parts[1]` is `sessions`,
`parts[2]` is the session id, `parts[3]` is the action and `parts[4]` is the sub-resource
(turn id or summary id).

`handle(ctx)` performs the work and writes the response. `ctx` carries:

| Key | Meaning |
| --- | --- |
| `req`, `res` | Node request and response. |
| `route` | Pathname, for example `/api/sessions/abc/export`. |
| `parts` | Path segments. |
| `sessionId`, `action`, `sub` | `parts[2]`, `parts[3]`, `parts[4]`. |
| `query` | `URLSearchParams` of the request URL. |
| `service` | `SessionService`, always present. |
| `summary` | `SummaryService`, or `undefined` when summaries are disabled. |
| `requestId` | Request id echoed in every response body. |

Rules:

- The first module whose `match()` returns true handles the request. Order in
  `routes/index.mjs` is therefore significant; append new modules after existing ones
  unless a specific path must win.
- A module that matches owns the response completely: status code, headers, body shape and
  body limits. Do not fall through after writing.
- `handle()` may throw `ApiError`; the gateway maps it to the status and code. Do not catch
  it inside the route module.
- Keep the existing response shapes and status codes. The route registry is a refactor seam,
  not an API change.

## Migration contract

A migration module is a `.mjs` file in `server/sessions/migrations/` that exports:

```js
export const version = 3 // positive integer, unique, ascending in the registry
export const sql = `...` // one or more SQLite statements, applied in one transaction
```

`migrations/index.mjs` lists migrations in ascending version order. `migrate(db)` in `db.mjs`
reads `schema_migrations`, skips applied versions, executes each pending `sql` inside a
transaction and records the version. `migrate(db, registry)` accepts an explicit registry for
tests. Never edit an applied migration: its SQL is already in user databases. Add a new file
and a new version instead.

## File ownership for parallel phases

| Path | Owner |
| --- | --- |
| `server/gateway.mjs`, `server/sessions/http.mjs`, `server/sessions/db.mjs`, `server/sessions/index.mjs` | I4.0 only. Frozen after the seams land. |
| `server/sessions/routes/<domain>.mjs` | The phase that owns the domain. |
| `server/sessions/migrations/<version>-<name>.mjs` | The phase that owns the domain. |
| `server/sessions/service.mjs`, `repository.mjs`, `summary.mjs` | Existing session core; extend only for core changes. |
| `src/session-api.ts`, `src/sessions.ts` | I4.0 barrel; new domains add files under `src/session-api/` and `src/sessions/panels/`. |

Two phases may edit the same file only when the table gives them the same owner. Otherwise
the later phase adds a new file and registers it.

## What a new feature must not edit

- `server/sessions/http.mjs` — add `routes/<domain>.mjs` and append it to `routes/index.mjs`.
- `server/sessions/db.mjs` — add `migrations/<version>-<name>.mjs` and append it to
  `migrations/index.mjs`.
- Existing route modules and existing migrations, including their response shapes, SQL text and
  version numbers.
- `src/session-api.ts` and `src/sessions.ts` as growing files; they stay barrels.
- `server/sessions/service.mjs` for a new domain; create a domain module and call it from the
  new route module.

## Tests

`tests/http-routing.test.mjs` proves that a route module appended to the registry is
dispatched by `createRouter()` without editing `http.mjs`. `tests/migration-registry.test.mjs`
proves the registry order and that a migration appended to the array is applied by `migrate()`.
Tests must not bind fixed ports; pass `0` to `listen()` when a server is required.
