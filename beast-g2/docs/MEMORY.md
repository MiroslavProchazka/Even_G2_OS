# Memory items

A memory item is one claim taken from one concrete transcript turn and its revision.
It has a kind, a source quote and a status. The model may only propose an item; the user
approves or rejects it in the phone panel. A proposal is never returned by default
retrieval and is never injected into chat or hints automatically.

The store lives in the same SQLite database as sessions. Migration 5 creates
`memory_items`:

| Column | Meaning |
| --- | --- |
| `id` | `mem_` plus 32 lowercase hex characters. |
| `workspace_id`, `session_id`, `turn_id` | The workspace, session and concrete turn the claim came from. |
| `turn_revision` | The turn revision the quote was taken from. |
| `kind` | `decision`, `commitment`, `fact`, `preference` or `open_question`. |
| `text` | The claim, trimmed, 1-500 characters. |
| `source_quote` | The exact turn text at that revision. |
| `status` | `proposed`, `approved`, `rejected` or `superseded`. |
| `supersedes_id` | The item this one replaces, or `null`. |
| `source_deleted` | `1` when the source session was deleted but the item was kept. |
| `evidence_state` | `present`, or `lost` when the source turn is gone. |
| `created_at`, `updated_at`, `approved_at`, `rejected_at`, `superseded_at` | Epoch milliseconds. |

There is no foreign key to `sessions` or `transcript_turns`: an item the user keeps must
outlive its source. The table has check constraints for `kind`, `status`,
`evidence_state` and `source_deleted`, and indexes on `(session_id, status, created_at)`
and `(workspace_id, status, created_at)`.

## API

All routes require `Authorization: Bearer <gateway token>` and accept only ids of the
session in the path.

| Method and path | Purpose |
| --- | --- |
| `GET /api/sessions/:id/memory?status=&query=` | Items of one session. `status` defaults to `approved`; `proposed`, `rejected`, `superseded` and `all` are for the panel. |
| `POST /api/sessions/:id/memory` | Propose one item. Body: `turnId`, `revision`, `kind`, `text`. Returns `201`. |
| `GET /api/sessions/:id/memory/:memoryId` | One approved item. `404` for proposed, rejected or superseded items. |
| `PATCH /api/sessions/:id/memory/:memoryId` | Review one item. Body: `status`: `approved` or `rejected`. |
| `POST /api/sessions/:id/memory/:memoryId/supersede` | Replace one item. Body: `text`, optional `kind`. Returns `201`. |

Every response carries `requestId`. A list response is `{ items, requestId }`; a single item
is `{ item, requestId }`; a replacement is `{ item, superseded, requestId }`.

## Proposal

`POST /api/sessions/:id/memory` accepts one claim:

```json
{ "turnId": "turn_…", "revision": 1, "kind": "decision", "text": "Rozpočet je 120 tisíc korun." }
```

The gateway checks that the session exists, that the turn exists, that the turn belongs to
that session, that `revision` equals the current turn revision, that `kind` is one of the five
kinds, and that `text` is 1-500 characters after trimming. `sourceQuote` is copied from the
turn text, so a claim can always be checked against what was actually said. A turn from another
session, an unknown turn or an unknown session returns `404 not_found`; a stale revision returns
`409 stale_revision`; a malformed turn id returns `400 invalid_turn`; a non-integer revision
returns `400 invalid_revision`; a bad kind returns `400 invalid_kind`; bad text returns
`400 invalid_text`. A proposal starts as `proposed`, with `sourceDeleted: false` and
`evidenceState: "present"`.

The model has no write path of its own. A caller proposes through this route, and the item stays
invisible until the user approves it.

## Review

`PATCH` moves a `proposed` item to `approved` or `rejected` and sets `approved_at` or
`rejected_at` plus `updated_at`. Repeating the same status is idempotent (`200`, the original
timestamp is kept). Every other transition, including approving a rejected item or rejecting an
approved one, returns `409 invalid_transition`. A status other than `approved` or `rejected`
returns `400 invalid_status`; an item of another session returns `404`.

## Retrieval

`GET /api/sessions/:id/memory` returns `approved` items by default. `status=proposed`,
`rejected`, `superseded` or `all` is for the review panel; `all` returns every status. An
unknown status returns `400 invalid_status`.

`query` is optional and may contain at most 200 characters (`400 invalid_query` otherwise). It is
folded to lower case with Czech diacritics removed in JavaScript, then matched as a substring of
the item text: `zrusit schuzku` finds `Zrušit schůzku`. Retrieval is always scoped to the session
in the path; another session's items are never returned.

Approved items are used only on an explicit request from the panel or this retrieval route. They are
never injected into chat, hints or a summary automatically.

## Replacement

`POST /api/sessions/:id/memory/:memoryId/supersede` creates a new `proposed` item from the same
turn, revision and source quote, with `supersedesId` pointing at the old row, and marks the old row
`superseded` with `superseded_at` in the same transaction. Both rows stay in the database, so the
history of a claim remains readable. Only a `proposed` or `approved` item can be replaced; a rejected
or superseded one returns `409 invalid_transition`. The new item inherits the old kind when `kind` is
omitted.

## Source deletion

`DELETE /api/sessions/:id` deletes the memory items derived from the session by default.
`DELETE /api/sessions/:id?keepMemory=1` keeps them: each surviving row gets
`sourceDeleted: true`, `evidenceState: "lost"` and a new `updatedAt`, while its text and status
stay. The item no longer has a turn to point at, and the panel must show that its evidence is gone.
The same rule runs in the transaction that removes the session, so a failure rolls both back.

A trigger on `sessions` applies the default rule to every other deletion path, including the
retention sweep and a restore that replays the deletion journal: memory items whose
`source_deleted` is `0` are removed with their session. A kept item has `source_deleted = 1`
before its session row disappears, so the trigger leaves it alone.

## Limits

- No embeddings, no semantic ranking and no retrieval across sessions: `query` is a folded
  substring match over the items of one session.
- No automatic injection: an approved item reaches a model only when the caller asks for it.
- No confidence score, no owner and no due date on an item; a decision, a commitment, a fact, a
  preference and an open question share one shape.
- No encryption at rest beyond the SQLite file and its filesystem permissions, and no forensic
  erasure: deleted rows can remain in free pages, the WAL, snapshots and older backups.
- A kept item is not re-attached when a session with the same id is restored.
