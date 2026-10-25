# Personal gateway deployment checklist (nothing deployed)

Use an existing Node 20.18+ host reachable from the phone, near Beast where possible. The packaged frontend and gateway are separate services. Keep provider keys only in the server environment.

1. On the gateway host, copy `.env.example` to an untracked `.env`. Configure exact HTTPS `BEAST_STT_URL` and `BEAST_CHAT_URL`, keys, a random `GATEWAY_TOKEN` (at least 16 characters), and explicit `ALLOWED_ORIGINS` for the frontend/WebView. Defaults are `whisper-live` and `beast/big`; set `BEAST_CHAT_MODEL=beast/small` to use the smaller model.
2. Run `npm run gateway` under the host's existing supervisor. Default bind is loopback. Place behind an existing HTTPS reverse proxy; forward cancellation and streaming, disable proxy response buffering, and keep proxy timeouts above the gateway timeout. Do not expose demo mode.
3. Keep `UPSTREAM_TIMEOUT_MS` at the default 90000 or lower: the current frontend has a 95-second overall request budget. Longer server budgets do not extend the client budget.
4. Serve `dist/` via an existing HTTPS static host. Enter the gateway origin/token at runtime. Tokens stay in memory, preferences contain only origin and language. Treat the gateway token as a secret; rotate server-side if lost.
5. Replace the example manifest whitelist with the exact real HTTPS gateway origin and run `npm run pack`. Test CORS with the actual Even WebView Origin; no wildcard or assumed Origin. The example whitelist is not a usable deployment target.
6. Test health, known Czech WAV and both chat models, then G2 audio and display. A health response proves gateway reachability, not inference compatibility. Confirm HTTPS and phone Wi-Fi/mobile/VPN access before relying on it.

No deployment, distribution, merge, paid resource or continuous background service is authorized or created by this change. Background/lock-screen reliability must be measured on the user's Android/G2 setup.
