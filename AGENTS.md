# Even G2 OS agent guide

Even G2 OS: a WebView app for Even Realities G2 glasses plus the gateway that feeds it. `beast-g2/` is the app (vanilla TypeScript client + Node gateway); the root files are product spec, roadmap and project policy.

## Read before changing code

- `Product_spec.md` is the product source of truth.
- `ROADMAP.md` splits execution into phases meant for parallel agents.
- `beast-g2/docs/HANDOFF.md` records what was verified and what still needs hardware. Do not restate it as fresh work.
- `beast-g2/docs/BACKLOG.md` holds concrete open items; `beast-g2/docs/SESSIONS.md` the session log.
- `beast-g2/docs/ARCHITECTURE.md` and `ARCHITECTURE-CLIENT.md` describe the gateway and client split.

## Commands (run inside `beast-g2/`)

- `npm test`, `npm run typecheck`, `npm run lint`, `npx prettier --check .`, `npm run build`
- Node 20.18 from `.nvmrc`. If `better-sqlite3` fails with `NODE_MODULE_VERSION`, put the matching Node first on `PATH` (`PATH=/usr/local/bin:$PATH`). Never rebuild the shared checkout's native module as a shortcut.
- `npm run dev` (Vite), `npm run gateway` (real), `npm run gateway:demo` (demo data)
- `npm run simulate` starts the official EvenHub simulator with its automation API on `http://127.0.0.1:9899`
- `npm run pack:device -- https://<beast-host>/v1` packages for the phone; it requires an HTTPS origin and bakes it in as the default

## Verification

- A plain browser has no SDK bridge, so glasses rendering, gestures and microphone never fire there. Verify in the EvenHub simulator, not just in a browser.
- The lens and the phone UI fail independently: check `/api/screenshot/glasses` and `/api/screenshot/webview` separately.
- State what the simulator proved and what it did not (microphone quality, locked phone, BLE recovery, battery). Never call a simulator run hardware-verified.

## Security

- Never put provider keys in `VITE_*` variables or in the `.ehpk`. Only the non-secret base URL belongs in the bundle; keys are entered at runtime.
- Never log `Authorization`, tokens, transcript text, prompts, query strings or provider bodies. Log the pathname and an allowlist of fields instead.
- `.env` stays uncommitted. Internal hosts such as `llm.corp.*` need the phone on the corporate VPN.

## Parallel work

- Worktrees live in `~/Documents/DEVELOPMENT/even-g2-worktrees/`. One agent per worktree, each with a disjoint file list.
- Land the seam first: registries, migrations and the panel host are edited by every phase, so merge those before dispatching parallel agents.

## House rules

- Do not commit, push or open a PR without asking.
- Keep UI copy in English. Czech is a speech-language value, not a UI locale.
- Bump `app.json` and `package.json` versions together before a build meant for installation.
