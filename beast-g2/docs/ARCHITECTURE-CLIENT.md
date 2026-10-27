# Client architecture: the contract and panel seams

The web client splits two hot spots so a feature can add a contract domain or a sessions panel without editing the
files another feature owns. Neither seam changes runtime behaviour.

## Session contract (`src/session-api/`)

`src/session-api.ts` is the only public entry point. It re-exports the contract by name; no other module should
import a domain file directly.

| File | Owns |
| --- | --- |
| `src/session-api.ts` | the public barrel: one export block per domain, no logic |
| `src/session-api/client.ts` | HTTP plumbing (`SessionClientBase`), `RequestOptions` and `SessionApiError` |
| `src/session-api/session.ts` | session types, `SessionClient` with the session routes, the `SessionApiError` re-export |
| `src/session-api/summary.ts` | summary and preparation types, `SummaryEndpoints` with their routes |
| `src/session-api/search.ts` | transcript search types and `SearchEndpoints` |
| `src/session-api/qa.ts` | question, citation and evidence types, `QaEndpoints` |
| `src/session-api/memory.ts` | memory item, status and evidence types, `MemoryEndpoints`; per-session and kept-memory reads |

Domains compose by inheritance: `SessionClient extends MemoryEndpoints extends QaEndpoints extends SearchEndpoints extends
SummaryEndpoints extends SessionClientBase`. Every domain class takes the settings provider from the base and calls `this.json`,
`this.post` or `this.request`, so the bearer token, timeouts, tracing and error mapping stay in one place.

To add a domain:

1. Create `src/session-api/<domain>.ts` with its types and `class <Domain>Endpoints extends <CurrentTail>`, where
   `<CurrentTail>` is the last class in the chain.
2. Point the next domain's `extends` (or `SessionClient` in `session.ts`) at the new class.
3. Add one export block to `src/session-api.ts`.
4. Add a request-shape test to `tests/session-api.test.ts` that imports the barrel.

Rules:

- A domain module never imports another domain's runtime values; types only.
- `SessionApiError` is the only error the client throws. It is defined in `client.ts` because the transport throws
  it, and re-exported from `session.ts` so the barrel keeps one error type.
- A method keeps its route, verb, headers, body and timeout in the module that owns it. Moving a method must not
  change any of them.
- Tests import `../src/session-api`, never a domain file, so a missing barrel export fails the suite.

## Sessions panels (`src/sessions/panels/`)

`initSessions` builds the section shell (status line, error line, list and detail columns) and then calls
`mountSessionPanels(container, deps)`. Each panel owns one block of the section.

| File | Owns |
| --- | --- |
| `src/sessions/panels/index.ts` | `SessionPanel`, `registerSessionPanel`, `mountSessionPanels`, built-in registrations |
| `src/sessions/panels/new-session.ts` | the "new session" form and its validation |
| `src/sessions/panels/search.ts` | full-text search input, debounced query, results and selection through the host |
| `src/sessions/panels/captions.ts` | Captions start/stop controls; it never creates a session |
| `src/sessions/panels/qa.ts` | question form, evidence badge and citation chips |
| `src/sessions/panels/memory.ts` | memory proposals, approval, rejection, replacement, source opening and the read-only kept list; explicit retrieval only |
| `src/sessions/panels/hints.ts` | opt-in hint toggle, spacing, pause and local feedback counters |
| `src/sessions/panels/dom.ts` | the `el` and `button` helpers shared by the section and its panels |

A panel is `{ id, mount(section, deps) }`. `mount` receives the element it may fill and the same `SessionsDeps` that
`initSessions` received, including `deps.host`, the host handle:

- `host.gate(element, enabled)` registers a control so the host disables it while a session action runs.
- `host.error(text)` writes the section alert line.
- `host.create(values)` creates or starts a session, refreshes the list, selects it and resolves true when it exists.
- `host.select(id)` opens an existing session by id, so a search hit can reuse the host's list and detail.
- `host.onSessions(listener)` subscribes a panel to a completed list load; the listener runs at once with the current list and returns an unsubscribe function.

Panels keep no per-session module state. The host owns busy state, the status line, the list and the selection, so two panels never
read each other. Registering the same `id` twice replaces the earlier panel, so a reload cannot mount duplicates.

To add a panel:

1. Create `src/sessions/panels/<name>.ts` and export `{ id, mount }`.
2. Register it at the bottom of `panels/index.ts` with `registerSessionPanel(...)`.
3. Add a test to `tests/<panel>-panel.test.ts` that mounts it with a fake host and asserts what it renders.

`list`, `detail`, `summary` and `preparation` stay in `sessions.ts` until a later phase moves them. Do not grow
`sessions.ts` with a new panel.
