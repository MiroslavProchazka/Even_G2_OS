# Changelog

All notable changes to this repository are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning. Release notes for the client were previously kept at the top of [`beast-g2/README.md`](beast-g2/README.md).

## [Unreleased]

### Added

- Continuous integration for the test suite and the TypeScript/Vite build on Node 20.18 and 22.
- CodeQL analysis for JavaScript and TypeScript on push, pull request and a weekly schedule.
- Repository hygiene job that fails when `.env`, `app.device.json` or an `.ehpk` package is tracked.
- Manifest guard: `npm run pack` and `npm run pack:device` refuse reserved example hosts, non-HTTPS entries and URLs with credentials or query strings.
- `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `THIRD-PARTY-NOTICES.md`, `.editorconfig` and `beast-g2/.nvmrc`.
- Issue and pull request templates for bug reports, feature requests and review.
- ESLint flat config, Prettier and CI jobs for lint, formatting, `npm audit --omit=dev` and coverage thresholds.
- Shared `src/transport.ts` for stream line parsing and abort/timeout wiring, with its own tests.
- Pure view rules in `src/view.ts` for busy state, history visibility, mode switching and connection messages.
- Gateway rate limiting (`RATE_LIMIT`, `RATE_WINDOW_MS`) with `Retry-After`, and a 1 MiB cap on STT provider responses.
- `docs/README.md` as an index of architecture, review, audit, deployment and handoff notes.
- `docs/IRIS-COMPARISON.md` with product direction, P1/P2 proposals, open questions and explicit non-goals, linked from the docs index and backlog.
- Opt-in SQLite session store (`SESSION_DATA_DIR`) with sessions, segments, final transcripts, revisions, coverage gaps and transcription jobs.
- Session API for create/list/detail/start/pause/resume/end, segment upload, WAV import, gap reporting, turn corrections, JSON/Markdown export and deletion.
- Background transcription worker with bounded retries, restart recovery, writer leases, audio quotas, disk reserve and audio deletion after transcription or retention expiry.
- `npm run session:import` CLI for importing a WAV file into a stored session and writing its export.
- `docs/SESSIONS.md` with the session API, limits, retention and failure behaviour.
- Structured session summaries bound to a transcript revision, with exact turn citations, decisions, action candidates, open questions, coverage and manual edits.
- Asynchronous summary generation with chunking, provider JSON validation, single-flight runs, failure recovery and staleness after transcript, coverage or audio-retention changes.
- Immutable preparation snapshots that select a past summary for a target session and keep source date, focus and citations.
- Summary, summary-list, summary-edit, preparation and preparation-list API routes; session detail and export now include them.

### Changed

- Root `README.md` rewritten as a project overview. The client keeps its own release notes.
- `app.json` declares English and Czech (`["en", "cs"]`).
- CI actions are pinned to commit SHAs, and the client build is checked by ESLint and Prettier.
- `SECURITY.md` now states exactly which client data is kept in memory and which settings are saved.
- The gateway now depends on `better-sqlite3` for the opt-in session store; chat and STT request handling is unchanged.
- Session JSON export is now `formatVersion: 2` and includes summaries and preparations; Markdown export adds summary and preparation sections.

### Fixed

- Continuous mode no longer stalls when the glasses accept a hint but never acknowledge it: an acknowledgement deadline drops the hint and advances the queue, and a display failure pauses listening.
- Live STT responses are read through a bounded reader instead of `response.json()`, so an oversized provider body cannot exhaust gateway memory.
- Chat and STT provider requests refuse redirects instead of following them.
- Demo mode always uses the public demo token, even when `GATEWAY_TOKEN` is exported.
- Diagnostics report the version and SDK version from `package.json` instead of a hard-coded `0.4.0` and `0.0.16`.
- Gateway configuration names the missing variable and rejects non-HTTPS, malformed and path-bearing origins before listening.
- The UI disables the ask button outside manual mode, hides hint history in manual mode, and explains why a mode switch is blocked.
- The client warns when a gateway is configured over plain HTTP outside loopback.
- A native SDK timeout now marks the session unresponsive: later microphone, display and exit operations fail fast with a clear error instead of waiting behind an unresolved native call. Late native resolution cannot start a queued stop.

## [0.5.0] - 2026-10-25

### Added

- Optional web commands in continuous mode through the custom gateway, backed by the Brave Web Search API. Completed web-backed hints are marked `BEAST / WEB` and expose numbered sources, retrieval time and publication dates.
- `sources` NDJSON event, `webSearch` status in `/api/health`, bounded query and snippet limits, a six-second search deadline and rejection of non-HTTP(S) source links.
- Optional second gateway origin in `pack:device`, so the packaged whitelist can cover both the Beast API and the gateway.

### Security

- Search queries and snippets are kept out of diagnostic logs, demo mode and direct Beast mode reject web requests, and retrieved text is labelled untrusted.

## [0.4.0] - 2026-10-25

### Added

- Bounded, memory-only phone history of 20 entries after a hint expires or capture pauses, with JSON export, deletion and no automatic upload.
- Prep notes of up to 1,500 characters for the active continuous session, applied while paused, with an explicit reset of the rolling model context.
- Experimental contextual cues: a validated JSON object with a hint of at most 120 characters plus a detail string, or `show:false` to keep the turn in context without a lens hint.

### Changed

- Continuous mode defaults to answering every utterance, and quiet turns stay in the rolling conversation context.

## [0.3.0] - 2026-10-25

### Added

- Continuous mode: incremental Whisper transcription on the lens, finalisation after two seconds of silence, streamed hints and automatic advancement of completed hints after ten seconds without a swipe.

### Changed

- Continuous mode replaces the earlier question filter and manual reveal. Every non-empty utterance is sent to the model.

## [0.3.1] and [0.3.2] - 2026-10-25

### Fixed

- Corrections from the first review iteration: microphone restart after a failed stop, explicit reporting of a silent stop failure on dispose, the in-memory diagnostic panel and gateway stage logging. See [docs/REVIEW.md](beast-g2/docs/REVIEW.md).

The tree does not record which of the two patch releases carried which correction.

## [0.2.0] - 2026-10-25

### Added

- Device test build with a Direct Beast mode that talks to an OpenAI-compatible HTTPS API base, including a `/v1` path when required, with the key held in memory for the session.
- `pack:device` script that generates an ignored `app.device.json` with a network whitelist and default base URL, and packs an `.ehpk`.
- Multipart WAV speech input and streamed chat SSE, with a connection test that validates the chat model through `/models`.

### Security

- Only the non-secret base URL enters the bundle. Provider keys are never passed through the URL or the build environment.

## Earlier prototyping

Versions before 0.2.0 were local experiments without device packaging, release notes or hardware validation. They are not documented separately.
