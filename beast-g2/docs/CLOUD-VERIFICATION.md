# Cloud review · 25 October 2026

Base: `a3732211f0ff3c809532cc93a99f64a00bcd6658`, branch `feat/beast-g2`.

## Verified here

- Clean `npm ci`, original 12 tests and Vite/TypeScript build passed in cloud.
- Expanded regression suite: microphone start/cancel/stop ordering, duplicate finish, stale errors, SDK subscription cleanup and glasses-only PCM filtering.
- Real loopback HTTP integration connects AssistantController → GatewayClient → demo gateway → streamed deltas → controller's UI state, for text and synthetic PCM/WAV. It does **not** exercise rendered browser DOM or actual microphone hardware.
- Fake upstream exercises byte-fragmented Czech UTF-8 SSE, stop without socket close, truncated stream, authentication failure, aggregate multiline frame limit and timeout/capacity recovery.
- Client terminal NDJSON stops reading and cancels its body, including when transport stays open. SDK dispose queues microphone stop behind any pending start.
- `npm run pack` builds and stamps `out.ehpk` with SDK 0.0.16 / minimum Even App 2.2.10. Packaging success does not validate a production gateway whitelist.

## Browser limitation

Vite starts with `npx vite --host 127.0.0.1`. The default all-interface launch failed because this runtime denies network-interface enumeration. The cloud browser is on another network: opening `http://127.0.0.1:5173` returned `ERR_CONNECTION_REFUSED`. No Mac, tunnel, deployment or paid service was used to bypass this.

Rendered browser → gateway → UI and mobile screenshot verification are **pending**. The phone layout has a narrow-screen stacked text form, wrapping header, 44px paging buttons and accessible paging labels, but these were reviewed in source only. To verify on a shared browser/server host:

1. `npm run gateway:demo` and `npx vite --host 127.0.0.1`.
2. Open `http://127.0.0.1:5173`, choose **Use local demo**, **Test gateway**. Expect DEMO and simulated answers.
3. Ask a text question. Expect transcript, streamed answer and `ANSWER` HUD, with controls re-enabled.
4. Try a wrong token, unavailable gateway and Start question without G2. Expect visible errors and successful text retry after correction.
5. At 390px and 320px viewport widths, verify no horizontal overflow, form accessibility, paging and long Czech answer wrapping.
6. Background while recording/inferencing, return and start a new question. There is no promise of background operation.

## External gates

Actual Beast REST/multipart/STT/chat models and provider cancellation; G2 capture and timing; Czech font; BLE reconnect; battery; locked-phone behavior. No live Beast credentials or private Hermes configuration were accessed. A native SDK call which never settles still requires device/runtime investigation; queuing deliberately prevents overlapping microphone commands.

The manifest still contains `https://gateway.example.com`, an explicitly nonproduction example. This build is not ready for production installation without replacing it and checking the real origin, CORS and phone reachability.

## Continuous-mode extension

Added opt-in G2 listening, bounded VAD/pre-roll, serial segment transcription/chat, Czech/English question heuristic with addressed-only option, duplicate/overlap suppression, pause/interruption and explicit resume, missing-PCM watchdog, and stable completed-answer presentation. `npm run demo:continuous` runs synthetic PCM through the same implementation with no device/network. New continuous HTTP integration also uses the actual demo gateway. See CONTINUOUS.md for precise policies and limitations. Rendered browser/mobile and all hardware/provider gates above remain pending.

Continuous extension validation: **38 tests passed**, synthetic CLI demo passed, TypeScript/Vite build passed and `.ehpk` was stamped (46,665 bytes). The last pack reported an unavailable npm registry version-floor lookup; CLI retained the explicit stricter `min_app_version: 2.2.10` from app.json. This warning does not establish current vendor compatibility.
