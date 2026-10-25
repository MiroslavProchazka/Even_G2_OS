# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.5.x | yes |
| earlier | no |

## Reporting a vulnerability

Do not open a public issue with details. Use GitHub private vulnerability reporting on this repository: **Security → Report a vulnerability**. If that channel is unavailable, open an issue that asks for a private contact and contains no technical detail. This is a personal project without a bug bounty; reports are handled on a best-effort basis and there is no guaranteed response time.

Never put a provider key, gateway token, password or URL containing credentials into an issue, pull request, log or diagnostic export. Replace the value with `REDACTED` and describe where it appeared.

## Scope

In scope:

- gateway token handling, authentication and timing-safe comparison
- CORS origin allow-list, preflight handling and origin denial
- request size, body limits, concurrency and timeout enforcement
- WAV and multipart validation, NDJSON and SSE framing
- server-side request forgery or credential disclosure through configured provider URLs
- diagnostics, logs or exports leaking tokens, transcripts, audio or URLs
- secrets leaking into a packaged `.ehpk`

Out of scope:

- the Even Realities app, SDK and firmware
- the Beast provider, its models and the network path to it
- physical device behaviour, Bluetooth, battery and lock-screen reliability
- anything that requires an unlocked phone or a stolen device
- denial of service against your own local gateway

## Handling of secrets

This repository contains no credentials. Provider keys stay in the gateway environment, gateway tokens are entered at runtime on the phone and kept in memory, and the packaged manifest carries only non-secret HTTPS origins. The gateway compares tokens with `crypto.timingSafeEqual` and rejects unlisted origins before routing. Rotate a leaked gateway token on the server; the client does not store it.

## Known limitations

This is a prototype, not a hosted service. There is no multi-user isolation, no persistence and no audit trail. Continuous background listening, lock-screen survival and hardware timing are unverified; see [docs/REVIEW.md](beast-g2/docs/REVIEW.md) for the open findings.

## Automated analysis

CodeQL runs for JavaScript and TypeScript on every push to `main`, on pull requests and on a weekly schedule. Fix or justify new alerts before a release; an alert that is not reachable in this prototype still needs a short note in the pull request.
