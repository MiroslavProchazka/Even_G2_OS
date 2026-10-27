# Stored sessions

The gateway can keep conversation sessions, their audio segments, final transcripts,
coverage gaps, traceable summaries and next-conversation preparation in a local
SQLite database. The feature is opt-in: without a session store the gateway keeps
the original in-memory behaviour and `/api/sessions*` returns
`404 sessions_disabled`.

The store is meant for the phone and for importing WAV recordings. It is not a hosted
service, there is no multi-user isolation and the gateway token still protects the whole
instance.

## What is stored

| Table | Contents |
| --- | --- |
| `workspace` | One workspace row with the provider profile and default retention. |
| `sessions` | Identity, name, language, goal, preparation, status, capture state, writer lease, coverage and expiry. |
| `segments` | Accepted audio segments, sequence, source time range, state and the audio path. |
| `transcript_turns` | Final transcript text with source segment, time range and revision. |
| `transcript_revisions` | Every manual correction with its previous and new text. |
| `coverage_gaps` | Known missing intervals and their reason. |
| `jobs` | Transcription jobs with attempts, retry time and the last error; the schema also reserves a summary job type. |
| `summaries` | Structured summary bound to one transcript revision, generator, coverage snapshot, review state and staleness. |
| `summary_citations` | Exact turn IDs, revisions, time ranges and quoted text used by a summary. |
| `action_candidates` | Proposed actions with explicit owner/deadline or null, original relative wording and source citations. |
| `preparations` | Snapshot of a selected past summary for a target session, including source session, date and citations. |

Audio is written under `SESSION_DATA_DIR/audio/<session-id>/`. The database defaults
to `SESSION_DATA_DIR/sessions.sqlite`. Files are created with mode `0600` and the
directory with mode `0700`.

## Lifecycle

```
draft -> active <-> paused -> ended -> deleted
```

Capture state is tracked separately: `off`, `starting`, `on` or `unknown`. `start`
sets capture to `starting`; the first accepted segment sets it to `on`. `pause` and `end`
set it to `off`. Reloading the client never starts listening; the client must call
`start` or `resume` explicitly.

`end` accepts an optional `lastSequence`. The service marks missing sequence numbers
as `missing_segment` gaps and keeps already accepted work running. A session can be ended
while its transcription jobs are still pending; the UI should show "ended, transcript
still finishing".

## API

All routes require `Authorization: Bearer <gateway-token>`.

| Method and path | Purpose |
| --- | --- |
| `GET /api/sessions?limit=50` | List sessions, newest first. |
| `GET /api/sessions/search?q=&limit=50` | Full-text search over the final transcript. |
| `POST /api/sessions` | Create a session. Body: `name`, optional `language` (`cs`, `en`, `auto`), `source` (`import`, `g2`), `goal`, `prep`, `timezone`, `retentionDays`. |
| `GET /api/sessions/:id` | Session detail with segments, turns, gaps, jobs, summaries and the latest preparation. |
| `DELETE /api/sessions/:id` | Delete the session, its indexes, revisions and stored audio. Idempotent. |
| `POST /api/sessions/:id/start` | Start listening. Body: `writerId`. |
| `POST /api/sessions/:id/pause` | Pause listening; accepted work continues. |
| `POST /api/sessions/:id/resume` | Resume a paused session with `writerId`. |
| `POST /api/sessions/:id/end` | Stop accepting audio. Optional `lastSequence` marks missing numbers. |
| `POST /api/sessions/:id/segments` | Upload one WAV segment with headers `X-Writer-Id`, `X-Segment-Id`, `X-Sequence`, `X-Start-Ms`, `X-End-Ms`. |
| `POST /api/sessions/:id/import` | Import one WAV file as `audio/wav` and split it into 30 s segments. Optional `X-Writer-Id`. |
| `POST /api/sessions/:id/gaps` | Record a gap. Body: `startMs`, `endMs`, `reason`. |
| `PATCH /api/sessions/:id/turns/:turnId` | Correct a transcript turn. Body: `text`; creates a revision and marks derived summaries stale. |
| `POST /api/sessions/:id/summary` | Request a summary. Body: optional `allowPartial`, `force`. Returns `202` while pending, `200` for an existing ready summary. |
| `GET /api/sessions/:id/summary` | Latest summary with structured content, citations, action candidates, coverage and status. |
| `GET /api/sessions/:id/summaries` | All summary versions for the session. |
| `PATCH /api/sessions/:id/summaries/:summaryId` | Manual summary correction. Body: `content`; preserves citations and marks related preparation stale. |
| `POST /api/sessions/:id/preparation` | Select a past summary as preparation. Body: `sourceSummaryId`, optional `focus`. |
| `GET /api/sessions/:id/preparation` | Latest preparation for the target session, with source date and citations. |
| `GET /api/sessions/:id/preparations` | Preparation history for the target session. |
| `GET /api/sessions/:id/export?format=json` | Full export with `formatVersion`, IDs, revisions, gaps, completeness, summaries and preparations. |
| `GET /api/sessions/:id/export?format=markdown` | Human-readable export with source links and completeness. |

Segment upload is idempotent. The same `X-Segment-Id` with the same audio returns
`200` and `duplicate: true`; the same ID with different audio returns `409
segment_conflict`. Sequence numbers are unique per session. `end` with
`lastSequence` marks missing sequence numbers as `missing_segment` gaps.

`PATCH` on a turn from another session returns `404`. A correction increments the
session transcript revision and stores the previous and new text in `transcript_revisions`.

## Search

`GET /api/sessions/search?q=&limit=50` searches the final transcript, not the audio and
not the summaries. The FTS5 table `transcript_search` is kept in sync by triggers on
`transcript_turns`, so a correction reindexes the turn and a deleted session or turn
disappears from the results. The index uses `unicode61 remove_diacritics 2`, so `zrusit`
and `zrušit` find the same passage.

The query is split on everything that is not a letter or a digit. At most eight tokens of
forty characters are kept, each token is quoted and joined with `AND`, so FTS5 operators
(`OR`, `NOT`, `NEAR`, `*`, quotes) in user input are read as text instead of changing the
query. A query without letters or digits returns `400 query_required`. `limit` defaults to 50
and is clamped to 1..50.

Each hit carries `sessionId`, `sessionName`, `turnId`, `revision`, `startMs`, `endMs`, a
short `snippet` with `[` `]` around the matched tokens, and the session timestamps the UI
needs for a date. Hits are ordered by `bm25` ascending (best first) and then by the position
in the session. Sessions with `status = 'deleted'` are excluded.

This is lexical search only: no embeddings, no semantic ranking, no search in summaries and no
answer generation. The Conversations panel debounces typing by 250 ms, aborts the previous
request and opens the selected session when a hit is clicked.

## Summaries and preparation

A summary is generated from the final transcript, never from the audio. It is bound to
one `transcriptRevision` and one coverage snapshot, so a later correction of a cited turn,
a new segment or turn, a newly recorded coverage gap, an expired segment, a failed
transcription, or an end with missing segments marks it `stale` instead of silently
keeping an outdated result. The default request requires an ended session;
`allowPartial: true` is an explicit override for a session that is still running or has
known coverage gaps.

`POST /summary` is asynchronous. The first request creates a `pending` row and returns
`202`; the summary worker writes the result. A repeated request returns the existing
pending or ready summary. `force: true` creates a new version and marks the previous one
stale. A manually edited summary is not replaced without `force` (`409 summary_edited`).

The structured content contains:

- `overview`: short text with citations.
- `decisions`: agreed decision text with citations.
- `actionCandidates`: proposed action, owner or `null`, deadline or `null`, original
  relative wording, `conditional` flag and citations.
- `openQuestions`: text with citations.

Every citation stores `turnId`, `turnRevision`, `startMs`, `endMs` and the source turn text.
The gateway validates that every cited turn belongs to the summarized transcript revision. It does
not invent an owner or a deadline: when the transcript only says "next week", the
deadline stays `null` and `dueText` keeps the original phrase.

A manual `PATCH` validates the same schema, preserves the original coverage snapshot,
marks the summary `edited` and marks related preparations stale. A preparation is a
content snapshot of a selected ready summary: it copies the summary content, source
session name, source date, source summary ID, focus and citations. Its status can become
`stale`, but its content is never regenerated in place; selecting another summary creates
another preparation. Deleting the source session removes its preparations, including those stored
in another target session; deleting the target session removes its preparations.

## Retention and limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `SESSION_DATA_DIR` | `~/.local/share/beast-g2` | Database and audio root. |
| `SESSION_DB_PATH` | `SESSION_DATA_DIR/sessions.sqlite` | SQLite file. |
| `SESSION_RETENTION_DAYS` | `30` | Ended sessions are pruned after this period. |
| `AUDIO_RETENTION_HOURS` | `24` | Audio is deleted after transcription or expiry. |
| `AUDIO_QUOTA_BYTES` | `536870912` | Retained audio quota (512 MiB). |
| `MAX_SESSION_MS` | `3600000` | Maximum session duration (60 min). |
| `MAX_TRANSCRIPT_CHARS` | `100000` | Maximum final transcript characters. |
| `MAX_IMPORT_BYTES` | `134217728` | Maximum import size (128 MiB). |
| `SEGMENT_MS` | `30000` | Import segment length. |
| `WORKER_POLL_MS` | `500` | Transcription worker poll interval. |
| `WORKER_MAX_ATTEMPTS` | `3` | Maximum STT attempts per segment. |
| `WORKER_BACKOFF_MS` | `1000` | Retry backoff base. |
| `WORKER_TIMEOUT_MS` | `90000` | STT request timeout. |
| `WRITER_LEASE_MS` | `60000` | Writer lease before another client can take over. |
| `DISK_RESERVE_BYTES` | `67108864` | Free-space reserve before accepting audio. |
| `SUMMARY_MAX_CHARS` | `100000` | Maximum characters of the transcript sent to the summary model. |
| `SUMMARY_CHUNK_CHARS` | `12000` | Target size of one summary chunk. |
| `SUMMARY_MAX_CHUNKS` | `12` | Maximum number of chunks per summary. |
| `SUMMARY_MAX_ITEMS` | `100` | Maximum decisions plus action candidates plus open questions. |

Audio is kept only until its segment is transcribed, and in any case for at most
24 hours (`AUDIO_RETENTION_HOURS`, default 24). The retention sweep deletes the
file and clears `segments.audio_path` and `segments.audio_bytes`; the segment row,
its time range, the transcript turn, revisions, summaries and coverage gaps stay. A
segment that was never transcribed becomes `expired`, its pending transcription jobs
fail with `Audio expired before transcription.`, and one `audio_expired` gap records
the hole. The transcription worker also deletes audio as soon as a segment is
transcribed or permanently fails, so 24 hours is an upper bound, not a promise to
keep audio that long.

An ended session is hard-deleted when its retention deadline passes: 30 days after
the end with the default `SESSION_RETENTION_DAYS=30` (the value is copied to the
session at creation and may be 1-365). A draft that never started expires 30 days
after creation. An `active` or `paused` session is never expired by the sweep,
even after its deadline; only an id in the journal overrides the state check,
because that deletion already happened after the backup. Deleting a session removes
its segments, turns, revisions, coverage gaps, jobs, summaries, citations, action
candidates, preparations and search rows, and its stored audio.

### Deleted ids and restore

Before the sweep removes a session it writes one row to `deleted_sessions`:
`session_id`, `deleted_at`, `reason` (`retention_expired`) and
`retention_deadline` (the session's last known `expires_at`). This is the
soft-delete list: it keeps only the id and metadata after the session row is gone,
and it has no transcript text and no audio path. The sweep never removes it, and
every later backup contains it, so a backup taken after the deletion carries the
tombstone.

A backup taken before the deletion still contains the session. After restoring that
backup, copy the journal from the live database and sweep the restored copy:

```sh
node scripts/retention-check.mjs --db /srv/beast/sessions.sqlite \
  --deleted-from /srv/beast/live.sqlite --apply
```

Every restored session whose id is in the journal is removed, even when its restored
`expires_at` is still in the future. Keep an independent copy of the journal (ids,
times and reasons only) when the live database is gone; without it a restore can
resurrect a session that was deleted after the backup.

### Running the sweep

`node scripts/retention-check.mjs` is a dry run by default. It copies the database
to a temporary file, runs the sweep on the copy, prints counts and ids (never
transcript text), removes the copy and leaves the source unchanged. `--apply` runs the
sweep on the database itself; `--now <iso>` fixes the clock and `--json` prints a
machine-readable report. Run it after `scripts/backup.mjs`, for example daily. The sweep
is idempotent, commits each batch and can be run again after a failure.

The sweep journals its own deletions. A manual `DELETE /api/sessions/:id` writes a
`user_deleted` tombstone in the same transaction as the hard delete, so a restore that
imports the journal cannot bring the session back. To carry the journal into a restored
backup, run `node scripts/retention-check.mjs --db <restored> --deleted-from <live> --apply`
before exposing the instance; the report lists ids, never transcript text.

### Not covered

- No forensic block erasure: deleted rows and files can remain in free SQLite pages,
  the WAL, filesystem blocks, snapshots and older backups until those rotate.
- No provider-side copies: the STT and summary providers, the G2 device, exports and
  any file-sync client keep their own copies outside this database.
- No legal assessment: this is an engineering retention mechanism, not a legal opinion
  on GDPR or any other obligation.

## Import a WAV file

Start the gateway, then run:

```bash
npm run session:import -- recording.wav \
  --gateway http://127.0.0.1:8787 \
  --name "Monday call" \
  --language cs \
  --out monday-call.md
```

With the demo gateway, add `--demo` instead of a token. For a live gateway, set
`GATEWAY_TOKEN` in the environment or pass `--token`. The command creates a session,
starts it, imports the WAV, ends the session, waits for transcription jobs and writes
the export. `--format json` writes the JSON export, `--keep` leaves the session active,
and `--delete` removes the session after exporting.

After the transcript is ready, request and inspect a summary:

```sh
npm run session:summary -- <session-id> --demo --request --prepare \
  --focus "Navázat na rozhodnutí" --out summary.json --prep-out preparation.json
```

Without `--request`, the command reads the latest summary. `--wait` waits for an existing
pending summary, `--allow-partial` explicitly accepts incomplete coverage, `--force`
creates a new version, and `--prepare` creates an immutable preparation snapshot.

The WAV must be RIFF/WAVE PCM, mono, 16 kHz, 16-bit. The import reads the file in
chunks and never holds the whole recording in memory.

## Failure behaviour

- A failed STT attempt is retried with exponential backoff up to `WORKER_MAX_ATTEMPTS`.
- A missing audio file is recorded as a `stt_failed` gap instead of silently dropping the
  segment.
- If the process stops with a job in `running`, the next `worker.start()` moves it back to
  `pending`, so it runs again. The transcript turn has a unique segment constraint and is
  written once.
- If an import is truncated or aborted, the received part is kept and the rest is recorded
  as an `import_truncated`, `import_invalid` or `import_aborted` gap.
- If the session is deleted during transcription, the worker finds no session or segment and
  cancels the job without recreating data.
- When the transcript character limit is reached, the current turn is stored, the session is
  ended and `endReason` explains the limit.
- A summary provider failure is stored as `failed` with `lastError`; the transcript is not
  affected. A summary left `pending` when the gateway restarts is marked `failed` and must be
  requested again. A summary generated from an older revision becomes `stale` and is never shown as
  current without an explicit `force` regeneration.
- A manually edited summary is never overwritten by an automatic regeneration unless
  `force: true` is passed. Related preparations are marked stale, not deleted.

## Client

The phone app has a **Conversations** section built by `src/sessions.ts`. It lists stored
sessions newest first with date, duration, status, coverage and source, and opens a detail with
the transcript, coverage gaps, transcription jobs, the latest summary with citation chips,
summary editing, preparation snapshots and export. `Resume`/`End` act through the recorder when
the glasses are connected and through the API otherwise. A citation chip scrolls to the cited turn
and highlights it. The section is only rendered; nothing is recorded until a session is started.

`src/capture.ts` records a stored session from the G2 microphone. It creates the session with
`source: g2`, starts it, uploads 30-second WAV segments with a stable segment id and sequence,
retries with bounded backoff, records a coverage gap when a segment is finally dropped, flushes a
partial segment on pause and on end, and ends with the last accepted sequence. Continuous listening
and stored capture share one microphone through a reference-counted port in `src/main.ts`, so ending a
question does not stop a recording session. The glasses show one short status line
(`REC 00:12 S3`, `PAUSED S5`, `ERR MIC`) above the normal HUD.

Every upload is idempotent: a repeated segment id returns `duplicate: true` and is not counted twice.
A writer conflict, a reused sequence and a paused session are never treated as duplicates, so audio is
not lost silently.

The client was also exercised against the official `@evenrealities/evenhub-simulator` with its automation
API on port 9899. A click from the glasses reaches the app as a touch `sysEvent` with `eventSource` set and
no `eventType`; the protobuf encoding omits the zero `CLICK_EVENT`, so `gesture()` treats that shape as a
tap. Without the fallback the tap did nothing in the simulator. The simulator proves gesture delivery and
that PCM events flow after a tap; it does not prove microphone quality, locked-phone behaviour or BLE recovery.

## Not in this phase

Task promotion into an external task system is still separate work. Stored sessions, summaries and
preparations are the base it will read from.
