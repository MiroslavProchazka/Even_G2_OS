# Even_G2_OS

[![CI](https://github.com/MiroslavProchazka/Even_G2_OS/actions/workflows/ci.yml/badge.svg)](https://github.com/MiroslavProchazka/Even_G2_OS/actions/workflows/ci.yml)
[![CodeQL](https://github.com/MiroslavProchazka/Even_G2_OS/actions/workflows/codeql.yml/badge.svg)](https://github.com/MiroslavProchazka/Even_G2_OS/actions/workflows/codeql.yml)

Personal playground for building on [Even Realities G2](https://www.evenrealities.com/) smart glasses. Each subproject is self-contained, runs locally, and documents what is verified versus what still needs testing on real hardware.

## Projects

| Project | What it does | Version |
| --- | --- | --- |
| [`beast-g2/`](beast-g2/) | Voice client for a self-hosted Beast service: glasses microphone → Whisper → chat model → glasses display | 0.5.0 |

## beast-g2

An early Even Realities G2 client for a self-hosted Beast service. TypeScript/Vite frontend, a small dependency-free Node gateway, and a clearly marked local demo. Nothing is hosted for you: the gateway runs on your own machine and proxies to your own OpenAI-compatible endpoint.

**Status:** cloud-reviewed development build. Stored sessions, summaries, preparation snapshots, transcript search, questions with citations, opt-in hints, Captions mode and the phone Conversations panel are implemented and covered by tests; G2 capture is verified in the official EvenHub simulator. Request logging is content-free with a bounded in-memory ring, and retention has a text-free deletion journal with a restore import. Live Beast API compatibility, real glasses capture, lock-screen survival and deployment are not yet verified. See [verification](beast-g2/docs/CLOUD-VERIFICATION.md), [design](beast-g2/docs/ANALYSIS.md), [handoff](beast-g2/docs/HANDOFF.md) and the [roadmap](ROADMAP.md) for the staged plan.

### Run locally

Node 20.18+ and npm:

```sh
cd beast-g2
npm ci
npm test
npm run build
npm run gateway:demo
# in a second terminal
npm run dev
```

Open http://localhost:5173, select **Use local demo**, **Test gateway**, then ask a text question. The demo token is `local-demo-token-only`; demo mode binds to loopback and makes no provider calls. No microphone from the computer or phone is used, so the text path works without glasses.

### Live gateway

Copy `.env.example` to `.env` and fill in the provider endpoints, provider key and a random gateway token of at least 16 characters. Set `ALLOWED_ORIGINS` to the actual client origins, then run `npm run gateway`.

Never put credentials in source files, frontend `VITE_*` variables, the manifest or the `.ehpk`. The phone receives only a gateway token entered at runtime; the frontend keeps it in memory and saves only non-secret settings (gateway origin, language, model names and optional vocabulary) as preferences. The gateway keeps conversations in memory by default. The opt-in session store adds SQLite-backed sessions, WAV import, transcripts, coverage gaps, traceable summaries, preparation snapshots and export; audio is deleted after transcription or after 24 hours, and ended sessions expire after 30 days. Deleting a session also removes preparations for which it is the source or target. See [beast-g2/docs/SESSIONS.md](beast-g2/docs/SESSIONS.md). Use HTTPS for deployment.

### Build for the glasses

```sh
cd beast-g2
npm run pack:device -- https://your-beast.example.com/v1
```

This generates the ignored `app.device.json` and an `.ehpk`. Only the non-secret base URL enters the bundle. For a packaged build, replace the placeholder `https://gateway.example.com` whitelist entry in `app.json` with your real gateway origin first.

SDK 0.0.16 requires Even App 2.2.10+. Start the local server, run `npm run qr -- http://<Mac-LAN-IP>:5173`, and scan through Even developer preview.

### Controls

Tap starts recording, tap again sends (30 second limit), double tap cancels, swipes page the answer. Continuous listening is an opt-in mode: it shows incremental transcription on the lens, finalizes after two seconds of silence, and advances completed hints after ten seconds without a swipe. See [continuous behavior](beast-g2/docs/CONTINUOUS.md).

## Layout

```text
Even_G2_OS/
└── beast-g2/
    ├── src/        capture, VAD, continuous pipeline, controller, SDK bridge, API client, display
    ├── server/     Node gateway: auth, CORS, WAV validation, Whisper multipart, chat SSE
    ├── tests/      audio, cancellation, display and gateway contract tests
    ├── scripts/    device QR and device packaging helpers
    └── docs/       analysis, backlog, review, deployment and verification notes
```

## Requirements

- macOS or Linux with Node 20.18+
- Even Realities G2 and Even App 2.2.10+ for on-device testing
- A reachable OpenAI-compatible endpoint for chat and speech-to-text

## Security

This repository contains no credentials. Provider keys stay in the gateway environment, gateway tokens are entered at runtime on the phone, and diagnostics stay local and in memory. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not through public issues.

## Development

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, checks and pull request expectations
- [CHANGELOG.md](CHANGELOG.md): release notes and unreleased changes
- CI runs tests and build on Node 20.18 and 22, then lint, formatting, `npm audit --omit=dev` and coverage thresholds on Node 22; it fails when secrets or build artifacts are tracked
- `npm run pack` and `npm run pack:device` refuse a manifest that still points at a reserved example host

## Attribution

`beast-g2/` keeps the MIT notice of an Even Realities sample application in [beast-g2/LICENSE](beast-g2/LICENSE). See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for that notice and the dependency licenses.

## License

MIT, see [LICENSE](LICENSE).
