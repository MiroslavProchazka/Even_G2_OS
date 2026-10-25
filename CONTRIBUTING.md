# Contributing

This is a personal prototype. Issues and pull requests are welcome, but there is no support commitment and no response-time guarantee. Hardware behaviour of the glasses is documented as unverified until it is measured on a device.

## Setup

```sh
cd beast-g2
nvm use          # reads beast-g2/.nvmrc, Node 20.18.0
npm ci
```

`npm ci` is the only supported install path: it uses the committed `package-lock.json` and the pinned Even Realities CLI and simulator versions. Do not upgrade the SDK, CLI or simulator in an unrelated pull request.

## Checks

Run the same checks as CI before opening a pull request:

```sh
cd beast-g2
npm test          # node:test suite
npm run build     # tsc --noEmit && vite build
```

`npm run pack` and `npm run pack:device` additionally refuse a manifest whose network whitelist still points at a reserved example host, is not HTTPS, or carries credentials. To test packaging, pass a real origin:

```sh
npm run pack:device -- https://your-beast-host/v1
```

## Pull requests

- Keep one topic per pull request and use an imperative subject line.
- State what you verified and what stays unverified. A green build, a passing test or an `.ehpk` is not evidence of glasses or provider behaviour.
- Add a regression test for every behavioural fix, in the existing `node:test` suites.
- Update `CHANGELOG.md` under `Unreleased`.
- Do not commit `.env`, `app.device.json`, `dist/`, `node_modules/` or an `.ehpk`. CI fails if a secret or build artifact is tracked.

## Code conventions

- TypeScript is strict; keep it that way and avoid `any`.
- `server/` stays dependency-free: Node built-ins and local modules only.
- Client code must not read provider keys. Only non-secret origins and the language are persisted; tokens stay in memory.
- Diagnostics must never contain tokens, transcripts, audio, URLs or headers.
- Code comments and English documentation are in English. `docs/` analysis notes are in Czech.

## Reporting bugs

Open an issue with the diagnostics JSON exported from the phone, with tokens, URLs and conversation content removed. Describe whether the failure happened in demo mode, gateway mode or direct Beast mode, and whether it involved real glasses.
