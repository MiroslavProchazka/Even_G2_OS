# Cloud continuation — 2026-10-25

User request: build a custom Even G2 app for Beast, use G2 microphone and Whisper on Beast. The user is on a flight and wants to turn off their Mac. Continue entirely in cloud; do not depend on their local machine. Work in `MiroslavProchazka/sandbox`, branch `feat/beast-g2`, directory `beast-g2/`. GitHub main was an otherwise empty sandbox. Do not overwrite other projects or merge automatically.

Implementation snapshot: bounded PCM→WAV, Even SDK mic/gestures, cancellation-aware controller, coalesced text updates and pagination, phone settings/text fallback, Node HTTP gateway with token auth/CORS/body limits, multipart STT and chat SSE→NDJSON, explicit demo mode and tests. Read README and ANALYSIS first. The analysis uses example hostnames. No live credentials are in this repo. Do not fetch the user's private Hermes env; cloud does not need it for implementation.

Next work:

1. Run `npm ci`, `npm test`, `npm run build` in `beast-g2/`. Inspect and fix correctness issues; add meaningful regressions, particularly microphone start/stop/cancel races, SDK lifecycle, controller recovery, fragmented streaming and shutdown.
2. Run the loopback demo gateway plus Vite. Verify text question from real browser UI through API and streaming reply. Add reproducible smoke test if practical. Verify error states and mobile layout. Keep demo clearly labeled. Do not claim G2 hardware tests or real Beast inference.
3. Review robustness: finite input/output/time budgets, proper stream cleanup, upstream SSE terminators, server disconnects, key/token non-disclosure, CORS, duplicate events, microphone watchdog and safe restart after suspend. Avoid making unsupported background guarantees; official lifecycle docs and FAQ conflict.
4. Resolve exact packaged app manifest restrictions and test packaging with installed CLI. Network whitelist still points to an example gateway and must not be described as production-ready. The supported manifest locale list lacks cs; spoken language selection still supports cs.
5. Prepare configurable production deployment instructions without actually deploying or creating paid resources. User has authorized development and pushing to sandbox, not a production deployment or distribution to others.
6. Commit improvements and push the existing branch. Create a draft PR if useful, with accurate validation and remaining hardware/provider gates. Keep communicating in Czech.

Unverified external contracts: actual Beast transcription URL and protocol; actual chat URL, models and streaming; provider CORS and phone network/VPN reachability; hardware PCM timing; Czech font glyphs; battery/reconnect/locked phone. Config defaults from user's stated setup: chat beast/big, optional beast/small, speech whisper-live. Do not infer realtime transcription from its name. Do not add keys to source, bundle or PR.

The locally installed package-lock uses SDK 0.0.16 / simulator 0.9.5 / CLI 0.1.14. SDK's declared Even App floor is 2.2.10. Frontend build has passed once before this handoff. See current test output rather than assuming all checks pass.

## Stored sessions — I1

Implemented on 2026-10-26: opt-in SQLite session store, WAV segment upload and import, final transcript turns, manual revisions, coverage gaps, transcription worker with retries and restart recovery, JSON/Markdown export, deletion, retention and the `npm run session:import` CLI. See `docs/SESSIONS.md`.

Verified locally: 121 tests pass, lint and TypeScript/Vite build pass, coverage thresholds pass on Node 22.20, a 90-second WAV imports as three transcribed segments, audio files are removed after transcription, and a job left `running` is retried to `done` after a gateway restart.

Still open for I1/MVP: client session list/detail and Resume/End UI, G2 capture writing into the same store, and real Beast STT/chat verification.

## Summaries and preparation — I2

Implemented on 2026-10-26: structured summaries bound to a transcript revision, exact turn citations, decisions and action candidates with explicit owner/deadline or `null`, open questions, manual summary edits, staleness after transcript changes, asynchronous summary generation, and immutable preparation snapshots for a target session. New routes are documented in `docs/SESSIONS.md`; export format is now version 2.

Verified locally on Node 20.18: 144 tests pass, lint and TypeScript/Vite build pass. Summary provider parsing and error handling are covered, migration v2 preserves v1 transcription jobs, the HTTP flow requests a summary after `end`, waits for `ready`, reads the latest summary and creates a preparation, and a new gap or a missing segment marks a ready summary stale. The coverage gate was not re-run locally because `better-sqlite3` in this checkout is built for Node 20 while the coverage threshold flags need a newer Node; CI still runs it. Still open: live Beast summary quality evaluation, client summary/preparation UI, task promotion into an external task system, and G2 capture integration.

`Product_spec.md` is now tracked in the repository and remains the product source.
