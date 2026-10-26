# Stored sessions

The gateway can keep conversation sessions, their audio segments, final transcripts
and coverage gaps in a local SQLite database. The feature is opt-in: without a session
store the gateway keeps the original in-memory behaviour and `/api/sessions*` returns
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
| `jobs` | Transcription jobs with attempts, retry time and the last error. |

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
| `POST /api/sessions` | Create a session. Body: `name`, optional `language` (`cs`, `en`, `auto`), `source` (`import`, `g2`), `goal`, `prep`, `timezone`, `retentionDays`. |
| `GET /api/sessions/:id` | Session detail with segments, turns, gaps and jobs. |
| `DELETE /api/sessions/:id` | Delete the session, its indexes, revisions and stored audio. Idempotent. |
| `POST /api/sessions/:id/start` | Start listening. Body: `writerId`. |
| `POST /api/sessions/:id/pause` | Pause listening; accepted work continues. |
| `POST /api/sessions/:id/resume` | Resume a paused session with `writerId`. |
| `POST /api/sessions/:id/end` | Stop accepting audio. Optional `lastSequence` marks missing numbers. |
| `POST /api/sessions/:id/segments` | Upload one WAV segment with headers `X-Writer-Id`, `X-Segment-Id`, `X-Sequence`, `X-Start-Ms`, `X-End-Ms`. |
| `POST /api/sessions/:id/import` | Import one WAV file as `audio/wav` and split it into 30 s segments. Optional `X-Writer-Id`. |
| `POST /api/sessions/:id/gaps` | Record a gap. Body: `startMs`, `endMs`, `reason`. |
| `PATCH /api/sessions/:id/turns/:turnId` | Correct a transcript turn. Body: `text`; creates a revision. |
| `GET /api/sessions/:id/export?format=json` | Full export with `formatVersion`, IDs, revisions, gaps and completeness. |
| `GET /api/sessions/:id/export?format=markdown` | Human-readable export with source links and completeness. |

Segment upload is idempotent. The same `X-Segment-Id` with the same audio returns
`200` and `duplicate: true`; the same ID with different audio returns `409
segment_conflict`. Sequence numbers are unique per session. `end` with
`lastSequence` marks missing sequence numbers as `missing_segment` gaps.

`PATCH` on a turn from another session returns `404`. A correction increments the
session transcript revision and stores the previous and new text in `transcript_revisions`.

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

Audio is deleted as soon as its segment is transcribed, or when the audio retention
window expires. A session deletion removes its audio files, rows and indexes. An export is a
separate copy and is not removed by deleting the session.

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

## Not in this phase

Summaries, task extraction, next-conversation preparation and G2 capture integration
are later phases. The stored session is the base they will read from.
