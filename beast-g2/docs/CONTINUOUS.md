# Changes in 0.3.2

On real G2, the ten-second hint timer starts only after LatestDisplay receives a successful SDK write for the matching reply ID. Repeated/stale acknowledgements cannot reset or start another hint's timer. An unresolved write times out without starting another native write or acknowledging late resolution. Transient rejections retry at most twice; Retry display requeues the current frame, while a timed-out native session requires reopening. SDK success is an acknowledgement, not physical proof that the wearer read the text.

Hints now use one static three-line view (overflow is marked with an ellipsis), with full text available on the phone during the hint lifetime. An error from a newer request does not obscure an already delivered hint. No automatic page movement.

Speech sensitivity offers Quiet speech / Normal / Noisy room thresholds and can change only while capture is paused. The optional direct-mode vocabulary field sends at most 300 characters as the transcription `prompt`; provider support must be checked, so leave it empty if the server rejects it. This is configuration support, not a measured accuracy improvement. Actual streaming STT remains pending a documented backend protocol; cumulative HTTP previews continue.

The host phone must be on the network/VPN required by the configured private endpoint. General Internet availability does not establish provider reachability. Model aliases may change; choose based on measured latency, not the words big/small.

Validation: 60 tests plus TypeScript/Vite build; physical G2 and STT quality still require device evaluation.

---

# Continuous G2 0.3

The glasses microphone streams PCM16 mono at 16 kHz. VAD uses an RMS speech threshold (600), not literal zero amplitude. Speech ending is 2,000 ms of below-threshold audio. A short pause does not split the utterance. Missing PCM remains a connection failure, not synthetic silence.

While speech continues, cumulative WAV snapshots are offered to Whisper every second, with one in-flight preview and one replaceable pending snapshot. This is incremental HTTP transcription, not a native streaming Whisper protocol: first words arrive after about one second plus provider latency. Preview results never trigger chat. Finalization cancels previews and runs an authoritative final transcription. Utterance and session guards discard late preview responses.

Every nonempty final transcript goes to Beast, including statements and repeated questions. The old question heuristic and deduplication no longer suppress speech. The lens has separate transcript and hint areas. Chat deltas show immediately when no older hint occupies the hint area. Completed hints get ten seconds from publication to the UI, then expire and automatically reveal the next. Long hints advance their three-line viewport every 2.5 seconds; the full answer remains visible on the phone during its hint lifetime. Prompts request two short sentences, ideally under 200 characters. Extremely long provider answers may not fit all pages in ten seconds.

The current hint and up to three waiting hints are retained. Completed answers are never silently replaced: a full inbox pauses the final inference pipeline until a display slot becomes available. Audio backpressure is still bounded to two waiting utterances; oldest or >30-second-old audio is dropped with a counter/notice. This avoids unlimited latency/memory under sustained speech. An utterance longer than 30 seconds is rejected visibly and capture resumes after two seconds of silence; no incomplete utterance is automatically sent at the size limit.

Preview timeout: 8 seconds. Final STT: 20 seconds. Chat: 30 seconds total. Abort and generation checks prevent late results from reappearing. Timeouts and provider errors are visible and do not permanently block later speech. Pause cancels requests, clears hints and preview text, and stops the microphone. A failed native stop retains unknown microphone state.

Diagnostic events `answer.ready`, `answer.shown`, and `answer.expired` distinguish inference completion from UI publication/expiry. These are UI events, not hardware acknowledgements; SDK display write spans separately record success/failure. Actual lens delivery, Whisper latency and noisy-room VAD sensitivity still need G2 testing.

## Device test

1. Upload `beast-g2-0.3.0.ehpk` to the existing private project.
2. Apply direct Beast connection, enter the key at runtime, and test a text question first.
3. Select Continuous G2, resume, and speak for 3–5 seconds. Verify draft words appear before you stop.
4. Pause for less than two seconds and continue: there should be one final utterance. Then pause for two seconds and verify final transcription/chat.
5. Ask a second question while the first hint is visible. It should appear automatically after the first ten-second interval. No swipe is required.
6. Disconnect the network during inference. Verify a visible error, then reconnect and try a fresh utterance. Export diagnostics after a failure.

The host still pauses capture when the WebView is hidden. Keep the phone/plugin foreground during this initial test. Physical G2, live Beast and background behavior are not covered by the automated tests.
