# Optional web evidence (0.5)

Continuous mode can search through the custom gateway. Enable **web commands** in Conversation setup while paused, then say `vyhledej …` or `search …`. Only the text following that command goes to Brave Search. Ordinary utterances, audio, preparation notes and conversation history are not sent to the search provider. The selected Beast model still receives the normal conversational context plus retrieved snippets.

A completed web-backed hint is marked `BEAST / WEB`. Expand its phone history item for numbered source links, retrieval time and publication dates when provided. Sources also appear in the conversation JSON export. They are search snippets, not proof of full-page reading or correctness; source citations in generated text remain model output. A failed/empty search fails the turn visibly rather than silently presenting an ordinary model answer as web-backed.

## Gateway setup

Set `BRAVE_SEARCH_API_KEY` on the server alongside the existing Beast credentials and gateway token. Use the official Brave Web Search API: https://api-dashboard.search.brave.com/app/documentation/web-search . No search credential belongs in VITE variables or the package. The gateway needs outbound Internet and connectivity/VPN to Beast. No provider account, paid plan or production deployment is created by this change.

The authenticated `/api/health` response reports `webSearch`. The client sends optional `webQuery` to `/api/chat`; the gateway emits a `sources` NDJSON event before answer deltas. Demo mode rejects web requests. Direct Beast rejects them too. Update both client and gateway; an older gateway without sources cannot produce a successful web hint.

Configure Custom gateway in the phone UI using its HTTPS origin and gateway token. Add its exact origin to the packaged whitelist:

```sh
npm run pack:device -- https://YOUR-BEAST-HOST/v1 https://YOUR-GATEWAY-HOST
```

The supplied device package retains the existing direct Beast host only, because no custom gateway deployment URL has been supplied. Repackage with the actual gateway origin before testing web on G2. A Beast `/v1` base is not our gateway.

## Bounds and trust

One search per explicit command, maximum 600 characters/75 words; 6-second search deadline; 256 KiB response; five snippets of at most 1,200 characters each. Existing gateway auth, origin checks, two-active-request limit, total deadline and disconnect cancellation apply. No linked pages are fetched, and redirects from the fixed search endpoint are refused. Retrieved text is labelled untrusted and cannot call tools; prompts cannot guarantee model immunity to misleading snippets. Source links permit HTTP(S) only. Search queries and snippets are not written to diagnostic logs. Phone source history is memory-only.

Verified with mocked providers and HTTP integration tests; real Brave/Beast and G2 require configured gateway credentials and hardware testing.
