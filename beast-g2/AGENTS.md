# beast-g2 agent guide

The app half of Even G2 OS: a vanilla TypeScript client running in the Even App WebView, plus a Node gateway. Product and roadmap live one level up in the repo root.

## Commands

- `npm test`, `npm run typecheck`, `npm run lint`, `npx prettier --check .`, `npm run build`
- `npm run dev` (Vite), `npm run gateway` (real), `npm run gateway:demo` (demo data)
- `npm run simulate` starts the official EvenHub simulator; automation API on `http://127.0.0.1:9899` (`/api/ping`, `/api/console`, `/api/screenshot/glasses`, `/api/screenshot/webview`, `POST /api/input {"action":"click"}`)
- `npm run pack:device -- https://<beast-host>/v1` to package; HTTPS origin only, no credentials or query strings
- Node 20.18 from `.nvmrc`. On `NODE_MODULE_VERSION` failures from `better-sqlite3`, put the matching Node first on `PATH` (`PATH=/usr/local/bin:$PATH`); do not rebuild the native module in the shared checkout.

## Verification

- A plain browser has no SDK bridge: glasses rendering, gestures and mic never fire there. Use the simulator.
- Check both surfaces, `/api/screenshot/glasses` and `/api/screenshot/webview`; they fail independently.
- Say what the simulator proved and what it did not (microphone quality, locked phone, BLE recovery, battery).
- Record a phase as done in `docs/HANDOFF.md` only after its gates pass, with the merge commit.

## Security

- Never put provider keys in `VITE_*` variables or in the `.ehpk`; only the non-secret base URL enters the bundle.
- Never log `Authorization`, tokens, transcript text, prompts, query strings or provider bodies.
- Keep UI copy in English; Czech is a speech-language value, not a UI locale.
- `supported_languages` is an enum (`en, de, fr, es, it, zh, ja, ko`). A `cs` entry makes the packer fail after the build.

## House rules

- Do not commit, push or open a PR without asking.
- Worktrees live in `~/Documents/DEVELOPMENT/even-g2-worktrees/`; one agent per worktree with a disjoint file list.
