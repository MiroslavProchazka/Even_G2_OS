# Briefing from stored sessions

`POST /api/briefing` assembles one read-only briefing from the latest summaries of
one to three selected sessions. It never calls a model, never writes and never reads
an external system. Every item carries its source session, the source date, the
summary it came from and the exact transcript citations behind it.

The route is a workspace route next to `/api/sessions`; it is not part of the session
dispatcher. Without a session store it returns `404 sessions_disabled`, and
`GET /api/health` reports `briefing: false`.

## Request

```json
{ "sessionIds": ["ses_…", "ses_…"] }
```

- The body is limited to 16 000 bytes and must be a JSON object.
- `sessionIds` is an array of 1-3 session ids. Duplicates are removed in
  first-seen order before the limit is applied.
- A missing or non-array `sessionIds`, a non-string id and a blank id return
  `400 invalid_selection`. An empty array returns `400 empty_selection`; more than
  three unique ids return `400 too_many_sessions`.
- An unknown or deleted session returns `404 not_found`. The whole request fails;
  a partial briefing is never returned.
- Only `POST` is accepted. Another method returns `405 method_not_allowed` with
  `Allow: POST`. `/api/briefing/<anything>` returns `404 not_found`.

## Response

```json
{
  "briefing": {
    "generatedAt": "2026-10-27T15:58:39.888Z",
    "maxSessions": 3,
    "sources": [
      {
        "sessionId": "ses_…",
        "sessionName": "Monday call",
        "sessionDate": "2026-10-27T15:58:39.886Z",
        "summaryId": "sum_…",
        "summaryCreatedAt": "2026-10-27T15:58:39.887Z",
        "summaryStatus": "ready",
        "reviewStatus": "unreviewed",
        "transcriptRevision": 1,
        "summaryTranscriptRevision": 1,
        "verification": "verified",
        "reason": null,
        "coverage": { "declared": "complete", "turns": 2, "pendingTranscriptions": 0, "gaps": [] }
      }
    ],
    "items": [
      {
        "id": "sum_…:overview",
        "kind": "overview",
        "text": "The budget was approved.",
        "owner": null,
        "due": null,
        "dueText": null,
        "conditional": false,
        "verification": "verified",
        "source": {
          "sessionId": "ses_…",
          "sessionName": "Monday call",
          "sessionDate": "2026-10-27T15:58:39.886Z",
          "summaryId": "sum_…",
          "summaryCreatedAt": "2026-10-27T15:58:39.887Z",
          "verification": "verified"
        },
        "citations": [{ "turnId": "turn_…", "turnRevision": 1, "startMs": 0, "endMs": 1000, "quote": "We approve 120 thousand." }]
      }
    ]
  },
  "requestId": "…"
}
```

`sources` keeps the request selection order. `sessionDate` is
`session.endedAt ?? session.startedAt ?? session.createdAt`; `summaryCreatedAt` is
`summary.readyAt ?? summary.createdAt`. `summaryId`, `summaryStatus`,
`reviewStatus`, `summaryCreatedAt`, `summaryTranscriptRevision` and `coverage` are
`null` when the session has no summary.

`items` contains only verified sources. One `overview` item comes from the summary
overview, one `decision` per decision, one `commitment` per stored action candidate
and one `open_question` per open question. A commitment keeps its owner, due date and
relative due text; every other kind has `owner`, `due` and `dueText` set to `null`
and `conditional` set to `false`. Items are ordered by kind (`overview`,
`decision`, `commitment`, `open_question`), then by the source selection order, then
by the original order inside the summary.

Ids are stable and derived only from stored data:

| Kind | Id |
| --- | --- |
| `overview` | `<summaryId>:overview` |
| `decision` | `<summaryId>:decision:<index>` |
| `commitment` | `<summaryId>:commitment:<actionCandidateId>` |
| `open_question` | `<summaryId>:open_question:<index>` |

## Verification

The briefing is built deterministically from stored rows. It never calls a summary
model, so the same stored state always produces the same briefing apart from
`generatedAt`.

A source is `verified` only when all of the following hold:

1. A summary exists and `summary.status` is `ready`.
2. `summary.transcriptRevision` equals the current `session.transcriptRevision`.
3. `summary.content.overview` has non-empty text and at least one citation.
4. Every citation id used by the overview, the decisions, the content action
   candidates and the open questions exists in `summary.citations` and names a turn in
   the current transcript.
5. Every used citation revision equals the current turn revision.
6. `summary.citations` is not empty.

The review status does not affect verification: an `unreviewed` summary verifies when
its content and citations are current.

An unverified source contributes no items. Its `verification` is `unverified` and
`reason` is one of:

| Reason | Meaning |
| --- | --- |
| `no_summary` | The session has no summary. |
| `summary_pending` | The latest summary is still being generated. |
| `summary_failed` | The latest summary failed. |
| `summary_stale` | The latest summary was marked stale, for example after a turn correction. |
| `transcript_changed` | The summary is ready but bound to an older transcript revision. |
| `summary_invalid` | The stored content is malformed, the overview or its citations are empty, or the citation list is empty. |
| `citation_missing` | A claim cites a turn that is absent from the summary citations or from the current transcript. |
| `citation_stale` | A cited turn revision differs from the current turn revision. |

The quote comes from the matching summary citation. The current turn text is only a
fallback when that citation exists and is current.

## Guarantees and limits

- Read-only: the route creates no session, summary, preparation, memory item or job.
- No model call and no external source; existing documents and trackers remain the
  source of truth for work context.
- One request covers at most three sessions and one latest summary per session.
- A missing or stale source is shown as `unverified`; it is never reported as
  "nothing new" and never as `done`.
- Coverage is the summary coverage snapshot. It is `null` when there is no summary.
- An empty transcript or a summary without citations is not a valid source.
