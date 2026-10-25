# Changelog

All notable changes to this repository are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning. Release notes for the client were previously kept at the top of [`beast-g2/README.md`](beast-g2/README.md).

## [Unreleased]

### Added

- Continuous integration for the test suite and the TypeScript/Vite build on Node 20.18 and 22.
- CodeQL analysis for JavaScript and TypeScript on push, pull request and a weekly schedule.
- Repository hygiene job that fails when `.env`, `app.device.json` or an `.ehpk` package is tracked.
- Manifest guard: `npm run pack` and `npm run pack:device` refuse reserved example hosts, non-HTTPS entries and URLs with credentials or query strings.
- `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `THIRD-PARTY-NOTICES.md`, `.editorconfig` and `beast-g2/.nvmrc`.

### Changed

- Root `README.md` rewritten as a project overview. The client keeps its own release notes.

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
