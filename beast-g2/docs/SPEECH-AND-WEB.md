# Speech quality and Internet access

## What 0.3.1 changes

- Double tap requests the native Even exit dialog after cancelling inference and stopping capture. The root screen uses `shutDownPageContainer(1)`; cancellation leaves capture paused.
- Three native text containers provide a left status header, right battery header and content body. Header writes are skipped when unchanged.
- Glasses battery is read from `getDeviceInfo()` and matching `onDeviceStatusChanged` events; ring events are ignored. Phone battery uses optional `navigator.getBattery()`. `--` means unknown/unavailable, including unsupported WebViews.
- `+ API`: recent successful calls without failures in the last five outcomes; `~ API`: mixed outcomes; `! API`: latest call failed; `? NET`: no result in the last 60 seconds; `x OFF`: browser reports offline. This is request reliability, not RF signal strength. `~nM` is the browser's estimated Mbps (NetworkInformation), not measured throughput; `--M` means unavailable. `G!` indicates a reported glasses disconnect. RUN means active listening/inference, not proof that the provider has Internet access.

## Why recognition may differ from stock Even AI

We do not know the stock provider or its internal DSP and cannot attribute the difference to a particular model. `whisper-live` is an endpoint model ID; it does not prove which checkpoint/precision/decoder is deployed. The app already sends 16 kHz mono PCM16 and defaults to Czech; verify the selected language on the device. This matches the official ASR template's audio format.

Recommended next steps, in order:

1. Benchmark the same 20–30 Czech phrases (names, numbers, technical terms, quiet speech and noise). With explicit recording consent, retain short WAV samples for A/B comparison and delete after evaluation. Ordinary diagnostics remain metadata-only. Measure word error rate and final latency, rather than judging different utterances by impression.
2. Check PCM RMS/peak for low level or clipping and the actual deployed checkpoint behind `whisper-live`. Test a multilingual large-v3 final pass against the current model; turbo is a latency candidate, not an assumed accuracy improvement. Keep explicit `language=cs` for Czech sessions.
3. Compare decoder settings on the backend (e.g. beam size 5) and a short vocabulary prompt for Beast/company/person names, if the endpoint supports it. Prompt text should guide spelling, not supply an invented transcript.
4. Replace fixed RMS onset with a tuned speech VAD if low-volume words are clipped; preserve pre-roll and the requested two-second final silence. Do not blindly amplify or denoise: amplification also raises noise and aggressive denoising removes consonants. A/B test preprocessing on identical recordings.
5. Replace cumulative HTTP preview requests with a genuine streaming STT connection through our gateway, using stable final/interim segments and full utterance context for the final pass. This improves responsiveness and avoids repeatedly retranscribing the growing audio, but accuracy still needs measurement.

No recognition improvement against stock Even is claimed without comparative recordings. Server configuration has not been changed by this client release.

## Internet-enabled Beast

Current direct chat sends ordinary messages to `/chat/completions`; the client does not execute tool calls. A prompt saying “search the Internet” cannot create that capability.

Recommended path: G2 client → authenticated Beast gateway → search/context provider → Beast → streamed hint + source metadata. Preserve the current direct mode as a fallback. Start with an explicit web-search toggle or “vyhledej” command; only the selected question goes to the search provider, never the full continuous microphone stream. A gateway can retrieve context before chat even if the model does not support tool calls. Later add a bounded tool loop if the deployed model supports it.

A concrete provider option is Brave LLM Context (pre-extracted text and source URLs). Keep its credential on the gateway. Limit search requests, time and context size; treat retrieved text as untrusted evidence, not instructions. Return source URLs and dates to the phone UI, with a short source marker on the glasses. On search failure show that web evidence is unavailable rather than implying that the answer is current. Need a provider choice/key and a deployed gateway route to enable this; none was provisioned in 0.3.1.

Sources:
- https://github.com/even-realities/evenhub-templates/blob/main/asr/README.md
- https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getBattery
- https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation
- https://github.com/SYSTRAN/faster-whisper/blob/master/README.md
- https://huggingface.co/openai/whisper-large-v3-turbo/blob/main/README.md
- https://api-dashboard.search.brave.com/documentation
