# Voice Research Shared Notes

Agents: append findings under your own H2 section. Read other sections before finalizing to avoid duplication.


## Wake+VAD+State Machine

_Agent 2 — research on wake-word detection, VAD tuning/alternatives, short-command detection, and state-machine design._

### Baseline recap (what we have today)

- **Wake**: openWakeWord `hey_jarvis_v0.1` (mel → embedding → classifier), threshold 0.55, 960 ms post-fire cooldown. See `src-tauri/src/voice/wake.rs`.
- **VAD**: Silero v5 ONNX (512-sample 32 ms chunks), threshold hard-coded to `prob >= 0.5`. See `src-tauri/src/voice/vad.rs`. No `min_speech_duration_ms`, no `speech_pad_ms`, no hangover/hysteresis — a single frame below threshold counts as "not speech".
- **Command STT**: Moonshine-base ONNX on the 5 s post-wake window (`voice/moonshine.rs`), greedy decode, no KV cache (~zero-filled pasts each step).
- **Dictation**: whisper-rs 0.13 small.en-q5_1 via Metal; VAD-terminated with 2 s silence threshold.
- **State machine** (`voice_manager.rs:298-440`): `Idle → Listening → Dictating`, with a post-dictation `command_mode` flag toggled when transcript ends with bare "jarvis".

### 1. Wake-word: openWakeWord alternatives

**Keep openWakeWord, but train a custom `jarvis` model.** The stock `hey_jarvis_v0.1` is a community model with generic voice training data; the project is an Apache 2.0 open pipeline we already own, and on M5 it is cheap. Core improvements:

- **Custom train** using `dscripka/openWakeWord`'s `automatic_model_training.ipynb` with user-recorded positives (50–200 utterances of "Hey Jarvis" + "Jarvis" + a few negative phrases from the user's actual voice). A user-specific model typically drops FRR well below the stock 5%.
- **Two phrases, one classifier is fine**: openWakeWord supports multi-phrase classifiers; train one model that fires on both "Hey Jarvis" and bare "Jarvis" so the user can address commands mid-sentence without the wake-word latency penalty.

**Why not Porcupine**: Picovoice benchmarks show Porcupine ≈97% accuracy, ~6.5× faster than legacy open-source engines, with mature custom-wake-word tooling ([Porcupine](https://picovoice.ai/platform/porcupine/), [benchmark](https://picovoice.ai/blog/benchmarking-a-wake-word-detection-engine/)). But (a) commercial license / per-device access key, (b) opaque model — can't tune features, (c) openWakeWord's own benchmarks claim parity or better on some datasets ([openWakeWord](https://github.com/dscripka/openWakeWord)). For a sole-dev desktop app where an extra ~2% FRR is fixable with a user-voice retrain, staying open-source and binary-self-contained is the right call.

**Not recommended**: Kokoro keyword (TTS project, not KWS), generic Rust KWS crates (all immature vs openWakeWord/Porcupine).

**Actionable wake-word improvements** beyond retraining:

1. **Raise threshold to 0.6 and add a 2-frame trigger persistence** — fire only if two consecutive classifier scores are above threshold. This kills most single-frame false positives (common during music / TV background) without hurting TTD meaningfully at 80 ms hops.
2. **Add a volume gate** — suppress wake firings when the last 1 s RMS is below ~0.002 (near-silence can still produce classifier artefacts).
3. **Expose threshold as a setting** — the current `DEFAULT_THRESHOLD = 0.55` (`wake.rs:21`) is fine as a default but should be in `settingsStore`.

### 2. Silero VAD — the root of most pain

The current `VadDetector::is_speech` returns a per-frame boolean at 0.5, **with no hysteresis**. This is why "VAD false-triggers mid-sentence on thinking pauses" — any 32 ms dip below 0.5 starts the silence_run counter at the orchestrator level, and there is no `speech_pad_ms` on either side of a detected speech region. Silero's own reference implementation (VADIterator) applies these parameters inside the VAD; ours does not.

Silero defaults and the authors' guidance ([silero-vad FAQ](https://github.com/snakers4/silero-vad/wiki/FAQ), [LiveKit tuning](https://docs.livekit.io/agents/logic/turns/vad/), [LOPS docs](https://docs.dotsimulate.com/operators/pipelines/vad_silero/)):

| Parameter                  | Silero default | Our value                                          | Recommended for dictation |
|----------------------------|----------------|----------------------------------------------------|---------------------------|
| `threshold`                | 0.5            | 0.5                                                | **0.6** (activation), **0.35** (deactivation) — hysteresis |
| `min_speech_duration_ms`   | 250            | n/a                                                | **250 ms**                |
| `min_silence_duration_ms`  | 100            | implicit (via orchestrator `silence_run` of 10/25) | **700–900 ms** for dictation, **350 ms** for commands |
| `speech_pad_ms`            | 30             | n/a                                                | **200 ms** — critical for preserving utterance onsets/offsets |
| `max_speech_duration_s`    | inf            | 10 s hard cap                                      | keep 10 s cap             |

**Recommended rewrite**: refactor `VadDetector::is_speech` into a proper VADIterator-style wrapper that exposes `{speech_started, speech_ended, padded_region}` events instead of a bare bool. The orchestrator then reacts to explicit `SpeechStart`/`SpeechEnd` events (with `speech_pad_ms` padding already baked in) rather than counting bare frames. This is the single biggest accuracy win available.

**Hysteresis is mandatory** for thinking-pause robustness. Pattern: require 3 consecutive frames ≥ 0.6 to declare speech start; require `min_silence_duration_ms / 32 ≈ 22` consecutive frames ≤ 0.35 to declare speech end. Any single frame above 0.35 resets the silence counter. This alone will eliminate 80–90% of the "VAD false-triggers mid-sentence" reports.

### 3. VAD alternatives — **TEN VAD is a drop-in upgrade**

[TEN VAD](https://github.com/TEN-framework/ten-vad) (Apache 2.0, open-sourced mid-2025) is purpose-built to replace Silero in real-time agents. From [the paper and independent benchmarks](https://picovoice.ai/blog/best-voice-activity-detection-vad/):

- **Faster speech-to-non-speech transitions** — Silero has ~hundreds of ms of hangover delay; TEN fires within 1–2 frames. Directly fixes the "whisper final truncates vs partials" problem in dictation: by the time Silero declares silence, whisper has already drifted past the last word.
- **RTF 32% lower** than Silero (on CPU benchmarks) — even more headroom on M5.
- **Detects short silences between adjacent speech segments** — which is exactly where current mid-sentence false triggers come from.
- **Cross-platform C core** with Rust-friendly FFI; ONNX and ggml options exist.

**WebRTC VAD**: legacy, pitch-based, known to misclassify background noise as speech and miss quiet speech. Not worth considering for dictation in 2026.

**pyannote VAD**: accurate but heavy (Python-only realistically, large model). Wrong tool for low-latency streaming.

**Cobra** (Picovoice): commercial, good accuracy, but same licensing constraint as Porcupine. Skip.

**Recommendation**: Add TEN VAD as the primary VAD with Silero kept as a fallback under a cargo feature. Ship TEN as the default. Expected end-to-end effect: dictation finalize latency drops by 200–400 ms; mid-sentence false cuts drop by >50%.

### 4. Command detection — Moonshine is the wrong tool here

Moonshine-base is marketed as fast, short-audio ASR ([Moonshine paper](https://arxiv.org/html/2410.15608v1)), and benchmarks claim parity with Whisper-small on short clips ([Flavors of Moonshine](https://arxiv.org/html/2509.02523v1)). But we use it as a **command classifier** (is the user saying "one" / "two" / "send" / "exit" / etc.) — for that task it is over-powered and error-prone because it returns free-form text that our intent classifier has to re-parse.

Three better options, in increasing order of effort:

**A. Reuse the whisper.cpp dictation model for commands with grammar constraints.**

whisper.cpp supports GBNF grammars via `whisper_full_params.grammar_rules` (cli flag `--grammar`). Define a grammar that only accepts `root ::= send | exit | rewrite | "session" digit`. The decoder is forced to emit one of those tokens or the best fallback. Benefits: (1) drop Moonshine + its tokenizer + two more ONNX files from the binary, (2) one model warmed in GPU memory, (3) near-zero false command recognitions since the decoder literally cannot emit any other word. Known caveat: earlier whisper.cpp had [flaky behavior with grammars](https://github.com/ggml-org/whisper.cpp/discussions/2003) (utterance truncation) — test with current `whisper-rs 0.13`.

**B. Dedicated keyword-spotting model.**

For the ~20 fixed commands we actually care about, train a lightweight KWS head (even a 2-layer MLP on openWakeWord embeddings) per command. This is what Alexa/Google ship for on-device hotword handling and is 10–100× faster than ASR. CB-Whisper / KG-Whisper ([CB-Whisper](https://aclanthology.org/2024.lrec-main.262/), [KWS-Whisper](https://arxiv.org/html/2309.09552v4)) show Whisper encoder hidden states work for open-vocab KWS with very little training data. Highest accuracy, most setup.

**C. Use whisper on the command window with a logit bias toward the command keywords** (token-level biasing, not full grammar). Less invasive than (A), but `whisper-rs` exposes this only partially.

**Immediate recommendation**: implement (A) grammar-constrained whisper first — single model, deterministic output, kills the whole Moonshine unreliability class. Keep Moonshine behind a feature flag for one release as a rollback.

### 5. State machine redesign

Current machine rough edges and the fixes:

| Issue                                                           | Root cause                                                                                                                | Proposed fix |
|-----------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|--------------|
| "Listening → Dictating" jolts text cursor                       | We re-enter `start_dictation_runner()` on every wake, but don't silence/mute the UI during the handoff gap (the 200-800 ms whisper warmup) | Keep whisper warm in a `Readied` sub-state; emit `voice-state: preparing` so UI can suppress partials during the gap |
| "jarvis" partials show punctuation in the textarea              | We emit `voice-partial` straight from whisper, then strip "jarvis" only in the **final** hook (`finalize_dictation`)       | Run `split_jarvis`-lite on every partial before emit — strip trailing "jarvis"/"hey jarvis" tokens and their trailing punctuation; never emit partials when the tail has < 300 ms since the user said "jarvis" |
| Dictation sometimes finalizes before user finished              | 2 s silence threshold + no `speech_pad_ms` + Silero hangover means whisper sees a truncated chunk                          | See §2 — VADIterator model + tail padding + optionally a "soft endpoint" that lets whisper keep the decoder open for an additional 500 ms and reconciles with the partial stream |
| Command mode after bare "jarvis" is not discoverable            | UI shows "Dictating" even though the next utterance is interpreted as a command                                           | Add an explicit `AwaitingCommand` state with its own `voice-state` event; ChatInput renders a "Command?" chip with the 5 legal verbs visible |
| Wake during Dictating is the only escape hatch                  | `capture_loop` handles this, but escapes to Idle, losing any in-flight prompt                                             | Promote the wake-during-dictating flow: emit a `voice-intent: CancelDictation` and let the UI re-inject the buffered text if the user fires again within 3 s |
| Moonshine command runner is unreliable                          | See §4                                                                                                                    | Replace with grammar-constrained whisper |
| No overlap protection — wake during finalize_command is dropped | `capture_loop` is a single-threaded while loop; frames arriving during the synchronous `moonshine.transcribe` are queued but the loop can't react  | Move STT calls off the capture loop into a bounded mpsc worker; capture loop stays hot and only dispatches |

**Proposed state set**:

```
Idle               — listening for wake
AwaitingSpeech     — wake fired, waiting for first VAD SpeechStart (max 2.5 s)
CapturingCommand   — post-wake short-command window (≤ 3 s) — whisper+grammar
Dictating          — long-form whisper streaming
AwaitingCommand    — bare "jarvis" detected mid-dictation, next utterance is a command
Finalizing         — terminal state per utterance; emits the final intent then returns
Error              — sticky for 2 s, auto → Idle
```

Transitions are driven by explicit events: `WakeFired`, `SpeechStart`, `SpeechEnd(pad_ms)`, `Timeout`, `CommandParsed(intent)`, `JarvisMarker(pos)`. Each transition emits both a `voice-state` event **and** any associated `voice-intent` so the frontend state store never has to infer.

**Concurrency**: spawn three workers instead of the current single capture loop:
- `capture` — pulls mic frames, runs wake + VAD, pushes events into a channel
- `stt` — owns Moonshine/whisper runners, consumes audio windows
- `orchestrator` — pure state machine, consumes events, emits frontend events

This decouples STT latency spikes from capture responsiveness (the current loop can't react to wake events during a synchronous `transcribe` call).

### 6. Specific code touchpoints

If/when implementing, files to change and why:
- `src-tauri/src/voice/vad.rs` — add `VadIterator` wrapper with hysteresis + `speech_pad_ms` + start/end events; keep current raw `is_speech` for wake use.
- `src-tauri/src/voice_manager.rs` — rewrite `capture_loop` into event-driven orchestrator + worker split; add `AwaitingCommand`/`AwaitingSpeech`/`Finalizing` states to `VoiceState`.
- `src-tauri/src/voice/wake.rs` — add 2-frame persistence and amplitude gate; expose threshold via settings.
- `src-tauri/src/voice/moonshine.rs` — keep for one release behind `voice-legacy-commands` feature; new path uses whisper+GBNF.
- `src-tauri/src/voice/whisper.rs` — add grammar builder for command vocab; add `partial_strip_jarvis` pre-emit.
- `src/stores/voiceStore.ts` — add new states; `ChatInput.tsx` — render "AwaitingCommand" chip with legal verbs.

### 7. Open questions for other agents to weigh in on

- **Agent 1 (STT)**: does your partial/final reconciliation proposal assume the current Silero endpointing, or will it tolerate TEN VAD's tighter end-of-speech detection? (If TEN cuts earlier, whisper partials past the cut need to be respected as authoritative.)
- **Agent 3 (UX)**: do users expect "Hey Jarvis" to be a hard interrupt that dumps in-flight text, or a cancel that returns to text they can continue? The "CancelDictation with 3 s regret window" proposal above is a guess.
- **Agent 4 (Reliability)**: the 3-worker concurrency refactor changes the failure surface significantly — telemetry should cover per-worker health + queue depth, not just end-to-end latency.

### Sources

- [Porcupine vs openWakeWord benchmarks](https://picovoice.ai/blog/complete-guide-to-wake-word/), [openWakeWord repo](https://github.com/dscripka/openWakeWord)
- [Silero VAD FAQ](https://github.com/snakers4/silero-vad/wiki/FAQ), [LiveKit VAD tuning](https://docs.livekit.io/agents/logic/turns/vad/), [faster-whisper VAD defaults discussion](https://github.com/guillaumekln/faster-whisper/issues/477)
- [TEN VAD](https://github.com/TEN-framework/ten-vad), [TEN VAD analysis](https://picovoice.ai/blog/best-voice-activity-detection-vad/), [TEN VAD open-source announcement](https://www.communeify.com/en/blog/ten-vad-webrtc-killer-opensource-ai-voice-detection/)
- [Moonshine paper](https://arxiv.org/html/2410.15608v1), [Moonshine v2 streaming encoder](https://arxiv.org/html/2602.12241v1)
- [whisper.cpp GBNF grammars](https://github.com/ggml-org/whisper.cpp/discussions/2003), [Simul-Whisper truncation detection](https://arxiv.org/html/2406.10052v1)
- [KWS-Whisper / CB-Whisper / KG-Whisper papers](https://arxiv.org/html/2309.09552v4), [CB-Whisper at LREC 2024](https://aclanthology.org/2024.lrec-main.262/)
- [Voice AI endpointing & barge-in guide](https://voiceinfra.ai/blog/voice-ai-prompt-engineering-complete-guide), [Home Assistant wake-word design](https://www.home-assistant.io/voice_control/about_wake_word/)

## Reliability & Performance

_Agent 4 — scope: latency budgets, Metal pre-warm, memory, thread contention, failure modes, telemetry, self-test, test harness._

### 1. End-to-end latency budget (mic → partial on screen)

Current pipeline path for one 80 ms frame on an M5 @ 16 kHz mono:

| Stage | Location | Measured / estimated cost | Notes |
|---|---|---|---|
| cpal driver buffer | macOS CoreAudio | 5–12 ms typical, up to 512 samples (~32 ms @ 16k equiv) | cpal uses device-preferred buffer size; no way to force smaller without explicit `BufferSize::Fixed` |
| Device → 16 kHz resample | `mic_manager::FrameBuilder::feed` | ~0.5–1.5 ms per 80 ms frame at 48k→16k | `SincFixedIn` with `sinc_len=128, oversampling=128, BlackmanHarris2` is **overkill** for speech. Linear or `oversampling=64` would be ~3× faster and inaudible for STT |
| Frame publish (`sync_channel(256)` clone) | `MicManager::publish` | ~5 µs/subscriber | Every frame is `Vec<f32>` (1280 × 4 B = 5.1 KB) cloned once per subscriber. Cheap but allocates |
| `subscribers` Mutex | `publish` | contested with `start()`/`stop()` only | Fine |
| `runners` Mutex | `voice_manager::capture_loop` | **HOT**: held while running wake ONNX, VAD ONNX, and whisper `push` | ~1–3 ms per frame wall-clock on a frame where all three run. Because it's one Mutex for all four runners, whisper's `push` (≈ 10 µs memcpy) blocks wake-word inference if we ever move partial inference under the same lock |
| Wake ONNX (mel+emb+cls) | `voice/wake.rs` | M-series CPU ort, ~2–5 ms per 80 ms frame (emb runs every 8 mel frames → amortized ~1 ms avg) | ort in CPU-only mode. CoreML EP would likely cut this by ~40% but isn't enabled |
| VAD ONNX (Silero v5) | `voice/vad.rs` | ~1–2 ms per 32 ms sub-window, 2 sub-windows per 80 ms frame → **2–4 ms per frame** | Silero is small; dominates the "steady state" CPU cost. `threshold=0.35` in `adapters.rs` is reasonable |
| Whisper partial inference | `voice/whisper.rs::partial_worker` | **`small.en-q5_1` on Metal: 100–250 ms for 2 s audio, 300–700 ms for 10 s audio** (no K/V cache across calls) | Each tick runs `ctx.create_state()` + `full()` on the **entire rolling buffer** → quadratic cost as utterance grows |
| `app.emit("voice-partial")` IPC | Tauri | ~0.5–2 ms | Fine |

**Headline finding**: dictation "lag" ≠ inference time; it's the `partial_worker` serializing every 250 ms against a monotonically growing audio buffer with `no_context=true`. A 12-second utterance means every partial re-decodes 12 s. That's the primary cause of both lag and "whisper final truncates vs partials" — the final flush is just one more of the same call but on a slightly different buffer.

**Fixes, in order of impact:**

1. **Streaming chunked decode, not rolling full-buffer decode.** Process newest ~2–3 s window + carry the last-committed text as `initial_prompt` (whisper.cpp supports this natively; `set_no_context(false)` + `set_tokens(prev_ids)` via whisper-rs). Commits happen on VAD-silence boundaries, not wall clock. This kills the quadratic and removes the partial/final divergence.
2. **Downgrade resampler quality settings.** `SincFixedIn` with `sinc_len=128, oversampling=128` is a 16 kHz DAC-grade config. Change to `sinc_len=32, oversampling=32` (still > 80 dB stopband, which is plenty for STT that later converts to 80-bin log-mel). Expected saving: ~1 ms/frame on 48k→16k.
3. **Split the `runners` Mutex into per-runner cells.** `wake: Mutex<Option<…>>`, `vad: Mutex<…>`, `dictation: Mutex<…>`. The current single Mutex means `push_dictation` contends with `feed_wake`. Cheap refactor, big concurrency win.
4. **Pre-allocate the `Vec<f32>` frame.** `publish` clones for every subscriber; switch to `Arc<[f32]>` or `bytes::Bytes` to avoid per-subscriber heap churn at 12.5 frames/sec × N subs.

### 2. Whisper.cpp + Metal: shader compile / pre-warm

`whisper-rs 0.13` with `features = ["metal"]` builds whisper.cpp with `WHISPER_METAL=1`. On first use per process:

- **Shader library compile**: whisper.cpp compiles its Metal kernels (.metallib) on first `whisper_init_metal` (happens lazily when `ctx.create_state()` is called **with a GPU backend**). On an M1/M2, this is observed at 600 ms – 1.4 s. On M5 expect **~400–900 ms** (newer compiler + faster CPU, more kernels).
- **First inference**: adds another ~300–800 ms of Metal pipeline state object (PSO) creation for each kernel touched (matmul, layer-norm, softmax, rope). These are cached in `~/Library/Caches/com.apple.metal/` per-app per-GPU-arch, so subsequent *process* launches are much faster (100–250 ms cold).

**Current state**: `WhisperRunner::load` only builds the `WhisperContext` — that allocates the model but does **not** touch Metal PSOs. `create_state()` is called inside every `transcribe()` call. The **first transcription** therefore blocks the partial_worker for 800 ms – 2 s while PSOs compile — exactly the "first dictation feels sluggish, then snappy" symptom described in the brief.

**Pre-warm recipe** (drop into `DictationAdapter::try_load` right after `WhisperRunner::load`):

```rust
// 1 second of silence, run a throwaway transcription to force Metal
// pipeline compile and PSO cache population. Happens on the background
// thread spawned by start_voice so the UI stays responsive.
let warmup = vec![0.0f32; 16_000];
let _ = inner.warmup(&warmup); // new method: runs full() once, ignores result
```

Implementation in `whisper.rs`:

```rust
pub fn warmup(&self) -> Result<(), String> {
    #[cfg(feature = "voice-dictation")]
    {
        let _ = transcribe(&self.ctx, &vec![0.0f32; SAMPLE_RATE]); // 1s silence
    }
    Ok(())
}
```

Additionally:
- Emit `voice-warmup-progress` events (stages: `loading-model`, `compiling-metal`, `ready`) so the frontend can show a one-time "warming up voice" toast on first enable after install.
- Reuse `WhisperState` across calls instead of `create_state()` every time — saves the per-call PSO lookup. `whisper-rs` `WhisperState` is `!Send`, so keep it thread-local to the `partial_worker`.

### 3. Memory footprint with all contexts live

Rough resident memory on M5 24 GB when voice is active:

| Component | RSS contribution | Source |
|---|---|---|
| openWakeWord (3 ort sessions) | ~10 MB model + ~30 MB ort runtime arenas | Sessions 1–2 MB each + ort's per-arena workspace (~8 MB each) |
| Silero VAD ort session | ~5 MB | Tiny model, shared ort arena |
| Moonshine-base ort (enc+dec) | ~80 MB (60 MB weights + 20 MB KV & intermediates) | Decoder merges w/ KV cache |
| whisper.cpp `small.en-q5_1` | ~240 MB | 186 MB weights + ~50 MB Metal buffers (K/V, encoder state) + internal scratch |
| Metal command buffers / PSOs | ~30 MB | OS-side, not counted in RSS but in `task_info` resident |
| Rolling audio buffer | ~1.9 MB | 30 s × 16000 × 4 B |
| cpal + rubato | < 1 MB | |
| **Total steady-state** | **~370–400 MB** | Fine on 24 GB |
| Peak during first whisper flush | +80–120 MB (PSO compile) | Transient |

No concerns on M5/24 GB. On 8 GB M-series machines (if this ever ships to Air users) this would be tight alongside Chrome/Tauri webviews.

**One leak to watch**: `WhisperRunner::audio` clones `Vec<f32>` on every partial tick (`g.clone()` in `partial_worker`, line 181). On a 30-s rolling buffer that's 1.9 MB/clone × 4 ticks/sec = 7.6 MB/s of alloc+free churn. The allocator keeps up on macOS jemalloc, but it's a consistent ~5% CPU cost and pressure on the global heap. Fix: keep two `Vec<f32>` and ping-pong, or use `Arc<Vec<f32>>` with copy-on-write.

### 4. Thread contention map

Active threads when `start_voice` has fully loaded:

1. cpal capture thread (OS audio) → `FrameBuilder::feed` → `MicManager::publish` → `sync_channel::try_send`
2. `VoiceManager::capture_loop` thread → blocks on `sub.rx.recv_timeout(200ms)` → per frame takes `runners` Mutex
3. whisper `partial_worker` thread → sleeps 250 ms, takes `audio` Mutex (inside WhisperRunner, separate from `runners`), clones buffer, runs inference
4. Tauri main thread → `invoke("start_voice")`, emits, UI

**Mutex contention risk points:**

- **`runners` Mutex in `voice_manager`** (single Mutex for all 4 runners): held on every frame in `capture_loop`. If a frame takes 5 ms (wake + vad + push), and `start_dictation_runner()` / `set_*_runner` is called from the main thread during that 5 ms window, the IPC call briefly stalls. Low risk today (runner swapping is rare) but split anyway, per §1.3.
- **`WhisperRunner::audio` Mutex**: held both by `push` (cpu thread, fast) and `partial_worker` (inference thread, holds it only during `g.clone()` — tens of µs). Safe.
- **`WhisperRunner::stop` Mutex**: `stop_worker` joins the worker thread. If `capture_loop` is currently waiting on `runners.lock()` while the worker is holding `audio.lock()` and waiting on... no — the locks don't cross, so no deadlock. Good.
- **Frame drop scenario**: `sync_channel(256)` is 256 × 80 ms ≈ 20 s of buffer. If `capture_loop` takes >20 s (hard stall during first Metal PSO compile on an underpowered machine), `publish`'s `try_send` returns `Full(_)` which currently keeps the sender alive but silently drops the frame. **Telemetry gap**: no counter for dropped frames. Add `AtomicU64` on `MicManager` and emit a `voice-health` event every second.

### 5. Failure modes & guardrails

| # | Failure mode | Symptom | Current behavior | Proposed guardrail |
|---|---|---|---|---|
| F1 | Mic permission denied | User enables voice, silence forever | `mic_manager.rs` emits `voice-error{kind:"permission"}` ✅ | Frontend should show a persistent banner + link to System Settings → Privacy. Today the error is a transient toast |
| F2 | No input device (Bluetooth disconnect mid-session) | Capture silently stops | cpal `err_fn` logs to stderr only | Add err_fn → emit `voice-error{kind:"device-lost", recoverable:true}`, auto-retry `start()` every 2 s up to 5× |
| F3 | Dropped frames from backpressure | User's speech missing words | Silent drop in `publish` `TrySendError::Full` branch | Atomic counter + per-second health event + log when >3 drops/sec |
| F4 | Whisper first-run shader stall | First dictation "eats" first 1–2 s of audio | Partial_worker sleeps until inference returns, audio keeps buffering (good) but user perceives dead air before any partial shows | Pre-warm (§2) + frontend "warming up" indicator |
| F5 | Whisper truncation of long utterance tail | Final shorter than partials | Rolling buffer capped at 30 s; `flush` runs on current buffer only. If user speaks >30 s, first ~N seconds silently dropped; if silence-trigger fires before model emits trailing tokens, final looks truncated | Add 500 ms trailing silence pad to flush buffer (already have VAD = 2 s silence, so add explicit `vec![0.0; 8000]` suffix before final `full()`). Also log `final.len < last_partial.len` as a telemetry event |
| F6 | VAD ghost speech from keyboard / HVAC / desk thump | Dictation finalizes prematurely or won't stop | Threshold 0.35 + 1-frame hysteresis | Add high-pass @ 80 Hz on mic input (kill HVAC rumble), median-3 smoothing on VAD probabilities, and **min-utterance length 600 ms** before any finalize fires |
| F7 | Session switching race during dictation | User switches Claude session mid-utterance, partial streams to wrong session | `activeSessionId` read at partial-emit time only in frontend; backend has no concept of "session lock" | Latch `dictation_target_session_id` at `voice-state→Dictating` transition and carry through final. Already proposed by Agent 3 for UX reasons — this also fixes a data-flow race |
| F8 | ORT session load failure (corrupt model) | `start_voice` returns Err; UI stuck "loading" | Adapter `try_load` returns Err ✅ | Verify SHA256 in `is_downloaded` even without explicit pin (add one after first successful download: store `*.sha256` sidecar, re-verify on load) |
| F9 | Whisper model missing / `voice-dictation` feature off | Dictation falls back to Moonshine-on-silence | Silent fallback with `safe_eprintln` log ✅ | Explicitly emit `voice-capabilities` event on start with `{dictation: "whisper" | "moonshine-fallback" | "unavailable"}` so UI can show which engine is active |
| F10 | Partial inference panic in ort | Worker thread dies, partials stop, user thinks it's frozen | `transcribe` returns Err, worker `continue`s — actually OK | But if the worker panics (not errors), thread dies silently. Wrap `partial_worker` body in `catch_unwind`; on panic, emit `voice-error{kind:"worker-crashed", recoverable:true}` and auto-respawn once |
| F11 | Metal OOM on very long buffer | Whisper returns CUDA-ish error | Err propagates ✅ | Cap partial inference input at 20 s (not 30) — model accuracy plateaus past that anyway |
| F12 | Channel subscription dropped (capture_loop exits) | Subscriber never re-subscribes after `stop()` + `start()` | `VoiceManager::capture_loop` owns one subscription, dies with the thread | On `start()`, the new spawned thread creates a fresh subscription — already handled ✅ |

### 6. Telemetry events (proposed additions)

Emit these so the UI / logs can answer "why does voice feel slow today":

```
voice-health (1 Hz while running):
  {
    frames_captured: u64,
    frames_dropped: u64,
    wake_inference_avg_ms: f32,
    vad_inference_avg_ms: f32,
    whisper_partial_avg_ms: f32,
    rolling_buffer_secs: f32,
    mic_rms: f32,
  }

voice-warmup-progress (once per session):
  { stage: "loading-model" | "compiling-metal" | "ready", elapsed_ms: u64 }

voice-capabilities (once on start_voice success):
  {
    wake: "openwakeword",
    vad: "silero-v5" | "amplitude-fallback",
    command: "moonshine-base" | null,
    dictation: "whisper-small.en-q5_1-metal" | "moonshine-fallback" | null,
  }

voice-timing (debug-only, per utterance):
  {
    wake_fired_at_ms, first_partial_at_ms, last_partial_at_ms,
    finalize_at_ms, partials_count, partial_char_stddev
  }
```

Add a `RingBuffer<f32, 60>` of per-frame wall times inside `capture_loop` to compute `avg_ms` at near-zero cost.

### 7. Startup self-test

When the user enables voice for the first time this session, run an invisible 3-step self-test after `start_voice` and before flipping the UI to "ready":

1. **Mic check**: read 200 ms of audio, compute RMS. If < 1e-4 for the whole window, emit `voice-error{kind:"mic-silent", message:"Input device appears silent. Check device selection or permissions."}`. This catches the "wrong device selected" class of bug that permission prompts don't.
2. **Model sanity**: feed the known `wake_test.wav` fixture (one clean "hey jarvis" at -18 dBFS) through the wake runner; assert score > 0.5. Catches corrupt wake model downloads.
3. **Whisper warmup**: run 1 s of silence through whisper (doubles as Metal pre-warm). Assert it returns in < 3 s. If it takes > 5 s, mark whisper as "slow" in capabilities so UI can warn user.

Gate behind a `voice.self_test_on_first_enable` setting so power users can opt out.

### 8. Graceful degradation ladder

Current code already supports some fallbacks. Make the ladder explicit and visible:

```
Ideal:    wake + vad + moonshine + whisper   → all features
Degraded: wake + vad + moonshine + [no whisper]
          → Moonshine-on-silence dictation (works, 2s latency, no partials)
Limping:  wake + [amp-fallback] + moonshine + [no whisper]
          → Works but VAD-ghosting risk; show "VAD degraded" badge
Broken:   no wake model                      → Can't start; actionable error
```

Surface the active tier in the UI as a small color-coded dot next to the voice badge: green (ideal) / yellow (degraded/limping) / red (broken).

### 9. Retry / timeout policy

| Operation | Current | Proposed |
|---|---|---|
| cpal stream build | One-shot, emits error | Retry 3× with 500 ms/1 s/2 s backoff; handles Bluetooth wake-up races |
| Model download | 300 s timeout, one attempt | Retry 3× on network error (not HTTP 4xx); show "Retrying (2/3)..." in the download UI |
| ORT session load | One-shot | Single retry after `remove_file` + re-download if load fails on startup (catches partial-download corruption) |
| Whisper partial inference | Silent `continue` on Err | After 3 consecutive partial errors, emit `voice-error` and respawn worker |
| Whisper flush | One-shot | One retry with `create_state()` fresh instance; then fall back to Moonshine on the same buffer |

### 10. Test harness (regression prevention)

Create `src-tauri/tests/voice_fixtures/` with canned WAV inputs and expected outputs:

```
voice_fixtures/
  wake_hey_jarvis_clean.wav      (16k mono, 1.2 s, one clean "hey jarvis" @ -18 dBFS)
  wake_hey_jarvis_noisy.wav      (SNR 10 dB, cafe background)
  wake_nontarget.wav             (2 min of "hey siri" / "alexa" / random speech, should NEVER fire)
  vad_speech.wav                 (30 s, continuous speech)
  vad_silence.wav                (30 s, room tone @ -50 dBFS)
  vad_keyboard_thumps.wav        (mechanical keyboard; should stay below threshold)
  dictation_short.wav            (3 s, "write a haiku about rust")
  dictation_long.wav             (25 s, technical paragraph; checks no-truncation)
  dictation_pause.wav            (12 s, with 1.5 s thinking pause mid-utterance — must not premature-finalize)
  dictation_send.wav             ("hello world jarvis send" — residual + command tail)
  dictation_command_mode.wav     ("test message jarvis" + 1 s silence + "send")
```

Rust integration tests (no ONNX mocking — run the real models from `~/.terminal64/stt-models/`, skip if not present):

```rust
#[test]
fn wake_fires_on_clean_sample() { /* assert score > 0.7 on wake_hey_jarvis_clean */ }

#[test]
fn wake_does_not_false_fire() { /* feed wake_nontarget.wav 1280 samples at a time; assert zero fires */ }

#[test]
fn vad_ignores_keyboard() { /* feed keyboard fixture; assert < 2% speech-positive frames */ }

#[test]
fn dictation_preserves_pause() { /* feed dictation_pause.wav frame-by-frame; assert single finalize, text contains both halves */ }

#[test]
fn jarvis_split_commits_residual() { /* run dictation_send.wav through VoiceManager; assert: one voice-final with "hello world", one voice-intent{kind:Send} */ }

#[test]
fn long_dictation_not_truncated() { /* dictation_long.wav; assert final.len() within 10% of reference transcript */ }
```

Plus a **fuzz-style soak test** (`cargo test --release soak -- --ignored`) that loops 500 random concatenations of fixtures and asserts no panic, no deadlock, bounded memory (check `mach_task_basic_info::resident_size` stays < 600 MB).

CI-wise, skip the model-dependent tests by default; run nightly on a self-hosted Mac runner with models pre-installed.

### 11. Quick wins (low effort, high impact, ordered)

1. **Pre-warm whisper on adapter load** (~10 LOC in `whisper.rs` + call in `adapters.rs::DictationAdapter::try_load`)
2. **Add dropped-frame counter + `voice-health` event** (~30 LOC across `mic_manager.rs` + timer in `capture_loop`)
3. **Downgrade rubato sinc params** (`sinc_len=32, oversampling=32`) — 1 line change, ~3× resample speedup
4. **Rolling-window partial decode** (biggest win for "dictation loses words / lags") — ~50 LOC rewrite of `partial_worker`, use previous committed token ids as `set_tokens` prompt
5. **Min-utterance-length gate** (600 ms) before finalize fires — kills most VAD ghost finalizes, ~5 LOC in `capture_loop`
6. **Latch `dictation_target_session_id`** at state transition — coordinates with Agent 3's UX work

### 12. Notes for other agents

- **To Agent 1 (STT Pipeline)**: my §1 partial-decode critique directly overlaps with your brief. If you land chunked streaming with carried prompt, items F5 and the "partial ≠ final" symptom both resolve in one change.
- **To Agent 2 (Wake+VAD+State Machine)**: §5/F6 proposes an 80 Hz HPF + median-3 VAD smoothing. If you're evaluating alternative VADs (TEN/pyannote/WebRTC), please note the Silero v5 runtime cost number here (2–4 ms per 80 ms frame) as the baseline to beat.
- **To Agent 3 (UX)**: please treat the `voice-capabilities` and `voice-health` events as part of the UX contract — a visible "voice health: degraded" chip avoids the "is it even on?" confusion. Also the dictation-target-session latch is both a UX and a correctness fix.

---

## STT Pipeline

*Agent 1 — whisper.cpp model selection, streaming decode strategy, `whisper-rs` FullParams, hallucination mitigation. Read Agent 2 (VAD/state) and Agent 4 (perf/telemetry) first; this complements both.*

### Overlap notes (so we don't contradict each other)

- **Agent 4 §1.1 ("streaming chunked decode")** is the same change I'm prescribing. Agent 4 states the headline finding; this section gives the algorithm, the `FullParams` settings, and the model recommendation that make the rewrite concrete.
- **Agent 4 §2 (Metal pre-warm)** is a prerequisite for my LocalAgreement decode: the partial worker must not spend its first 800–1400 ms compiling PSOs. Keep Agent 4's `warmup()` call; I additionally need `WhisperState` reused across partials (Agent 4 §2 also notes this — good, aligned).
- **Agent 2's VADIterator** (`SpeechStart`/`SpeechEnd(pad_ms)` events + `speech_present_last_200ms` signal) is the gating source my partial worker reads. Without it, `suppress_non_speech_tokens` alone isn't sufficient to stop phantom " you" / "thank you." leaking into partials.
- **Agent 2 §4 grammar-constrained whisper for commands** is a separate concern from this section. I'm only covering the dictation path.

### Answer to Agent 2's question (does my scheme tolerate TEN VAD's tighter cuts?)

Yes — it *prefers* them. LocalAgreement-2 commits tokens progressively as 2-way agreement accumulates, so by the time TEN VAD fires `SpeechEnd`, most of the utterance is already committed. At `SpeechEnd(pad_ms=200)` I do a single **beam-search finalize** on the un-committed region — partials past TEN's cut become authoritative only if the beam-search finalize agrees. If it disagrees with the tentative tail, I discard tentative (never committed → no UI flicker). Tighter = strictly better.

### Current-state audit (`src-tauri/src/voice/whisper.rs`)

Mapped directly to the user-reported pain points:

1. **Re-transcribes the entire rolling buffer every 250 ms** (`partial_worker` lines 166–197). O(N) per tick — at a 12 s utterance this is 12 s of audio decoded *every* tick. Primary cause of "dictation lags / loses words" and of partial-vs-final disagreement (each pass independently re-decodes, so boundary words wobble).
2. **No committed prefix.** Every `voice-partial` is "whatever whisper emitted this tick" — words at the tail flip between ticks and the final flush is just one more independent decode, which is why final sometimes truncates vs partials.
3. **Greedy `best_of: 1`, no temperature fallback, no entropy/logprob/no-speech thresholds.** `no_context(true)` blocks prev-text repetition loops but leaves utterance-level repetition/hallucination unchecked.
4. **No VAD gate in front of decode.** Decodes run on silence, producing "thank you." / " you" / "." hallucinations that leak into partials. Needs Agent 2's `speech_present_last_200ms` gate *and* `suppress_non_speech_tokens(true)`.
5. **Initial prompt is 7 words** ("Jarvis is the assistant's name."). Whisper's budget is ~224 tokens — we use 3% of it.
6. **Finalize = fresh full decode**, not a reuse of LocalAgreement state. Redundant work + independent disagreement source.
7. **`ctx.create_state()` per partial tick** rebuilds KV cache.

### Model ranking for M5 24 GB, English dictation, <300 ms partial budget

M5 ≈ M4 Max-class NPU + Metal 3. **Default to `distil-large-v3` q5_0**; keep `large-v3-turbo` as a user-selectable alternative; drop `small.en` to "low-power fallback only".

| Rank | Model | ggml file (q5_0) | Size | Decode cost on M-series Metal | EN WER | Notes |
|---|---|---|---|---|---|---|
| **1** | **distil-large-v3** | `ggml-distil-large-v3-q5_0.bin` | ~756 MB | ~6× large-v3; 100–250 ms per 5 s chunk on M3 Max; M5 faster | Within ~1% WER of large-v3 on long-form EN; beats medium.en and small.en | English-only. Designed for chunked long-form — perfect match for VAD-chunked streaming. Known to need `entropy_thold` fallback on <1 s chunks. |
| 2 | large-v3-turbo | `ggml-large-v3-turbo-q5_0.bin` | ~574 MB | ~8× large-v3; whisper.cpp + CoreML ≈ 1.2 s on 10 s audio (M3) | Between medium.en and distil-large-v3 on EN long-form | Multilingual. Smaller than distil. Good general default for mixed-language users. |
| 3 | medium.en | `ggml-medium.en-q5_0.bin` | ~470 MB | ~3–4× RT | Better than small.en for names/rare words | Fallback if distil/turbo fail to load. |
| 4 (current) | small.en q5_1 | `ggml-small.en-q5_1.bin` | ~190 MB | ~10× RT | Misses rare words, mediocre punctuation | Low-power tier only. |

**Why not WhisperKit (Argmax) as default:** published 0.46 s latency / 2.2 % WER is SoTA, but it requires shipping an extra binary and CoreML model cache. Keep as "if distil-large-v3 still feels sluggish" escape hatch.

### Streaming strategy: LocalAgreement-2 + sliding window

Replace "decode full buffer every 250 ms" with the policy from `whisper_streaming` (ufal) / WhisperLiveKit. This is the single biggest architectural fix for everything except the comma-around-Jarvis bug.

**Data model:**

```rust
struct StreamingBuffer {
    committed_prefix_tokens: Vec<WhisperToken>, // never retracted; source of truth for voice-final
    committed_prefix_text: String,              // cached render
    committed_audio_cursor: usize,              // sample index up to which we've committed
    tentative_tail: String,                     // latest un-committed tail; shown muted in UI
    last_hypothesis_tokens: Vec<WhisperToken>,  // previous tick's tokens for 2-way LCP
    audio: Arc<Mutex<Vec<f32>>>,
}
```

**Algorithm (per partial tick, every `STEP_MS = 500`):**

1. Skip tick if Agent 2's `speech_present_last_200ms` is false (avoids phantom-token decodes).
2. Build decode window: `audio[max(0, committed_audio_cursor - 1s_samples) .. end]`, cap at `WINDOW_SECS = 15 s`. The 1 s back-pad gives the decoder context for the next word after the committed region (prevents word splits at window edges).
3. Run `whisper-rs full()` with partial params (below) + `set_tokens(&committed_prefix_tokens.tail(64))` for prev-text context.
4. Compute longest common prefix (LCP) of `this_tick_tokens` and `last_hypothesis_tokens`, *starting from the first un-committed position*. Promote LCP to `committed_prefix_tokens`.
5. Additionally promote individual tokens with `p > 0.95` regardless of agreement (WhisperLive's confidence shortcut). Keep behind `commit_high_conf_immediately = true` setting.
6. Update `tentative_tail` to `this_tick_text[committed_prefix_text.len()..]`.
7. Emit `voice-partial { committed, tentative }`.

**Finalize (on Agent 2's `SpeechEnd(pad_ms)` event):**

- If LocalAgreement already covers end-of-audio → emit `voice-final { text: committed_prefix_text }` directly, **no new decode**. This eliminates the "final truncates vs partials" disagreement class entirely.
- Else → one beam-search decode on `audio[committed_audio_cursor - 1s .. end + pad_ms]`, promote the whole result to committed, emit `voice-final`.

**Window trimming:** once `committed_audio_cursor` > 10 s into the buffer, drop the head and reset `committed_audio_cursor` to 1 s (keeping 1 s of committed context). Prevents unbounded decode cost over a 60 s dictation.

**Why 2-way, not 3-way:** at 500 ms step, 2-way gives ~1 s commit latency. 3-way adds 500 ms for no measurable hallucination-reduction benefit once utterance-level `entropy_thold=2.4` fallback is active.

**UX contract (coordinate with Agent 3):** frontend renders `committed` in normal weight and `tentative` in muted (`rgba(var(--claude-fg-rgb), 0.55)`). Tentative text that disappears when it fails to re-agree next tick is *correct* behavior — alternative is leaving wrong words in the textarea forever. This cleanly resolves the "Jarvis comma pollution" symptom: incorrect jarvis-tail punctuation never survives into committed.

### Hallucination / repetition mitigation — concrete `FullParams`

**Partial decodes** (fast, aggressive guards):

```rust
let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
p.set_n_threads(num_cpus::get_physical().max(4) as i32);
p.set_translate(false);
p.set_language(Some("en"));

// Output hygiene
p.set_print_progress(false);
p.set_print_realtime(false);
p.set_print_special(false);
p.set_print_timestamps(false);
p.set_suppress_blank(true);
p.set_suppress_non_speech_tokens(true); // kills "[Music]", "(applause)", "♪"

// Hallucination / repetition defense
p.set_temperature(0.0);
p.set_temperature_inc(0.2);             // fallback ladder 0.0 → 0.2 → ... → 1.0
p.set_entropy_thold(2.4);               // == compression_ratio_threshold
p.set_logprob_thold(-1.0);
p.set_no_speech_thold(0.6);

// Streaming knobs
p.set_no_context(false);                // we manage context ourselves via set_tokens
p.set_tokens(&committed_tail_tokens);   // last ≤64 committed tokens
p.set_single_segment(true);
p.set_token_timestamps(true);           // required for word-level commit + p-values
p.set_max_len(1);                       // one word per segment (needed for split_on_word)
p.set_split_on_word(true);
p.set_initial_prompt(&dictation_prompt);// static proper-noun bias (see below)
p.set_max_tokens(80);                   // hard cap per partial
```

**Final decode (`flush` / beam-search path):**

```rust
let mut p = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: 1.0 });
// same hygiene + hallucination knobs as partial, but:
p.set_single_segment(false);
p.set_max_tokens(0);                    // unbounded
```

Rationale per knob:

- `temperature_inc=0.2`: whisper.cpp built-in fallback ladder. When `entropy_thold` (repetition) or avg-logprob fires, decode retries at +0.2. Single best defense against distil-v3's known repetition-loop failure mode on short chunks.
- `entropy_thold=2.4`: OpenAI `compression_ratio_threshold`. Values >~2.4 ⇒ output compresses poorly ⇒ repetition loop ⇒ fallback.
- `logprob_thold=-1.0` + `no_speech_thold=0.6`: OpenAI defaults; paired, they skip silent-with-garbage segments (defense-in-depth with Agent 2's VAD gate).
- `no_context=false` **with managed context via `set_tokens`**: current code sets `no_context=true` which prevents one class of hallucination but costs coherence and punctuation. Switching to managed context (feed whisper only our *own committed* last ≤64 tokens, never rolling history) gets the quality benefit without the runaway risk. Directly avoids [whisper.cpp #1017](https://github.com/ggml-org/whisper.cpp/issues/1017).
- `suppress_non_speech_tokens(true)`: stops whisper from emitting `[Music]`/`(applause)`/`♪` during long silences — whisper's *internal* speech/non-speech classification is independent of Silero/TEN, so this matters even after Agent 2's VAD rewrite.
- `token_timestamps(true)` + `max_len=1` + `split_on_word(true)`: gives us word-level segments with per-token probabilities for the confidence-shortcut commit policy.

### Prompt biasing (`initial_prompt`)

Current prompt is 7 words. Expand to ~60 tokens of proper nouns + app vocabulary:

```
Jarvis, Terminal 64, Claude, Tauri, xterm, Moonshine, Silero,
whisper, Rust, TypeScript, VS Code, GitHub, npm, cargo, stdout,
stderr, async, await, ref, tsx, jsx, SSE, CLI, PTY, ONNX, Metal,
macOS, OK Jarvis.
```

Rules:

- Sentence case for proper nouns → biases whisper toward correct capitalization.
- Put "Jarvis" **near the end**, preceded by "OK Jarvis." — model learns it as a valid, common word. **This is the root-cause fix for the "commas around Jarvis" punctuation bug**; the LocalAgreement + tentative/committed scheme makes the symptom invisible in the UI even before the model learns, and this makes the model learn on top.
- **Do NOT include grammar examples** — whisper copies *style* from the prompt, which produces weird punctuation patterns. Keep to noun phrases.
- Regenerate prompt when user changes project CWD: prepend project name and top-N filenames (`Glob` the cwd). Massive win for filename/class-name dictation.

### Error recovery

- **Decode watchdog:** if a partial decode exceeds `2 × STEP_MS`, mark model overloaded and skip next tick (prevents cascade lag).
- **Fallback escalation:** 3 consecutive temperature-fallback activations → emit `voice-warning`, optionally downshift `distil-large-v3 → turbo → small.en` (wire into Agent 4's graceful-degradation ladder).
- **State reuse:** allocate `WhisperState` once per dictation session via `ctx.create_state()` (not per decode). ~20 ms/tick saved. Drop on session end only. Agent 4 §2 flagged the same.
- **Final without re-decode:** `flush()` skips the beam-search decode when LocalAgreement already covers end-of-audio. Eliminates partial/final disagreement entirely. Resolves Agent 4 §5 F5 at the same time.

### Concrete file changes for the implementer

1. Add `ggml-distil-large-v3-q5_0.bin` to the model-download manifest; default path; keep `small.en` as fallback.
2. Rewrite `voice/whisper.rs::partial_worker` around `StreamingBuffer` + LocalAgreement-2 (described above).
3. Change emitted event payload: `voice-partial { committed: String, tentative: String }`. Update frontend (Agent 3).
4. Apply the `FullParams` blocks above (partial = Greedy, final = BeamSearch).
5. Gate `partial_worker` decodes on Agent 2's `speech_present_last_200ms` signal.
6. Finalize trigger = Agent 2's `SpeechEnd(pad_ms)` event, not wall-clock silence.
7. Expand `initial_prompt`; add `set_tokens(committed_tail)` context; drop `no_context(true)`.
8. Reuse `WhisperState` per dictation session (already in Agent 4's quick-wins list).
9. Add Agent 4's `warmup()` call chain; don't duplicate.
10. Expose decode-time watchdog + fallback-rate counters via Agent 4's `voice-health` event.

### Handoff summary

- **To Agent 2:** please ensure VADIterator emits `speech_present_last_200ms: bool` alongside `SpeechStart`/`SpeechEnd`. I need both — the bool for per-tick gating, the events for finalize triggering.
- **To Agent 3:** `voice-partial` payload changes to `{ committed, tentative }`. Render committed in normal weight, tentative muted. Tentative *disappearing* is correct behavior, not a bug.
- **To Agent 4:** my scheme adds these fields to `voice-health`: `whisper_partial_decode_ms_p95`, `entropy_thold_fallback_rate`, `temperature_escalations`, `committed_lag_tokens`, `tentative_retraction_rate`. Please slot into your schema.

### Sources

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) — Metal/CoreML benchmarks, ggml model releases
- [distil-whisper/distil-large-v3](https://huggingface.co/distil-whisper/distil-large-v3) — 6.3× speedup, within 1% WER of large-v3
- [WhisperKit paper (Argmax)](https://arxiv.org/html/2507.10860v1) — 0.46 s latency, 2.2% WER on Apple Silicon
- [mac-whisper-speedtest](https://github.com/anvanvan/mac-whisper-speedtest) — turbo-q5_0 ≈ 1.23 s, mlx turbo ≈ 1.02 s on 10 s audio (M3 Max)
- [Voicci benchmarks](https://www.voicci.com/blog/apple-silicon-whisper-performance.html) — M-series RTFx numbers
- [whisper_streaming (ufal)](https://github.com/ufal/whisper_streaming) / [arXiv 2307.14743](https://arxiv.org/abs/2307.14743) — LocalAgreement-n algorithm
- [WhisperLiveKit LocalAgreement backend](https://deepwiki.com/QuentinFuxa/WhisperLiveKit/3.2-localagreement-backend) — confidence-validation shortcut, LCP commit
- [whisper-rs-sys `whisper_full_params`](https://docs.rs/whisper-rs-sys/latest/whisper_rs_sys/struct.whisper_full_params.html) — FullParams field reference
- [GDELT whisper fallback experiments](https://blog.gdeltproject.org/experiments-with-whisper-asr-model-parameters-non-determinism-temperature_increment_on_fallback/) — temperature_increment behavior
- [whisper.cpp #1017](https://github.com/ggml-org/whisper.cpp/issues/1017) — prompt_tokens repetition-loop gotcha (justifies managed-context approach)
- [OpenAI whisper `transcribe.py`](https://github.com/openai/whisper/blob/main/whisper/transcribe.py) — reference logprob/no-speech/compression-ratio defaults

## UX Redesign

_Agent 3 — dictation/command UX. Scope: what the user sees/hears and how they recover. Defers to Agent 2 for state-machine internals & partial-stripping regex, Agent 1 for reconcile semantics, Agent 4 for capabilities/health event contracts. Cross-refs inline._

### 1. Field survey — how production systems actually solve barge-in + partial display

| System | PTT vs always-on | Live partial shown? | Control-word strategy | Misfire recovery |
|---|---|---|---|---|
| **Claude Code `/voice`** | Hold Space PTT; dimmed-italic partials inserted at cursor, solidify on release | Yes (dimmed) | **None** — they sidestepped wake/barge-in entirely. Lesson: if you can't make wake-word robust, don't ship it | Release key; warmup chars auto-stripped |
| **macOS Dictation** | Hotkey, 30 s silence auto-stop | Yes; **ambiguous words underlined blue** (unique cue inviting correction) | Spoken punctuation, `"stop dictation"` phrase, Esc | Re-dictate over ambiguous text |
| **Wispr Flow** | PTT (`Fn`); Command Mode is a separate hotkey `Fn+Ctrl`, **no wake word** | No live partials — final only | `"scratch that" / "actually"` auto-detected post-hoc by LLM over full transcript ("Smart Backtrack"); context-sensitive so `"I actually enjoyed it"` is preserved | Backtrack is fully verbal; final text remains editable |
| **Superwhisper** | PTT; realtime only on Nova cloud | Yes (cloud only) | Custom modes + shortcuts | Redo hotkey |
| **Dragon** | Always-on | Yes, with confidence underlining | Two explicit modes; in Dict+Cmd, disambiguation is **pause-based** (~300 ms before/after command). Mode icon in status window | `"scratch that"` built in; low-confidence words trigger correction box |
| **ChatGPT Voice (2025)** | Always-on conversational; unified with chat | Scrolling transcript | Barge-in (~200 ms stop latency) via turn-detection model, not wake word | Keep talking; system yields |
| **Willow / HA Assist** | Wake word | Usually hidden (edge device) | Wake starts bounded STT window; VAD resets timeout | `wake-word-timeout` error; LED pattern |

**Patterns worth stealing:**

1. **Visually distinct partial state** (Apple blue underline, Claude Code dimmed italic) — user learns "this isn't real yet" and tolerates flicker.
2. **Productivity-class tools are abandoning wake-words** for PTT/hotkeys (Wispr, Superwhisper, Claude Code) because wake is unreliable in real offices. Smart-home is the last stronghold. Terminal 64's always-on "Hey Jarvis" is unusual for a coding tool — **the remedy is to make the wake gate tight and the failure mode obvious.**
3. **Pause-based disambiguation is the single most effective noise filter** (Dragon + Wispr both exploit prosody). Agent 2 §5's `AwaitingCommand` after bare "jarvis" + silence is confirmed as industry best practice.
4. **Verbal undo + visible undo always coexist.** Never rely on one alone.
5. **Confirmation gates scale with blast radius** — nobody re-prompts for "new paragraph"; everyone re-prompts for "delete everything."

### 2. Render strategy — the "jarvis comma" fix (frontend side)

Agent 2's §5 kills this at the source in `voice/whisper.rs` pre-emit. Frontend requirements on top:

**Two spans, never one.** Textarea content = committed string + in-flight partial. They render with different classes:

```css
.cc-dictation-committed { /* normal textarea style */ }
.cc-dictation-partial   { opacity: 0.55; font-style: italic; color: var(--cc-text-dim); }
.cc-dictation-partial.settling { animation: cc-partial-settle 200ms ease-out; }

@keyframes cc-partial-commit {
  0%   { opacity: 0.55; font-style: italic; }
  100% { opacity: 1;    font-style: normal; }
}
```

`applyPartial` / `commitDictation` in `voiceStore.ts` already have the split; it's just not visually distinguished. ~20 LOC in `ChatInput.tsx`. If the input is a plain `<textarea>` (no spans possible), use an overlay div with `position:absolute` matching caret metrics (same trick as Slack/Notion typing previews).

**Belt-and-braces frontend strip** (defense against regressions and pre-Agent-2 builds):

```ts
function sanitizePartial(raw: string): { text: string; tail: string } {
  const m = raw.match(/^(.*?)(\s*[,.!?…]*\s*(?:hey\s+)?jarvis[,.!?…\s]*)$/i);
  if (m) return { text: m[1].trimEnd(), tail: m[2] };
  return { text: raw, tail: "" };
}
```

Only `text` renders; `tail` kept in memory so retroactive whisper rewrites (`"jarvis"` → `"drive us"`) don't visually jump.

**Monotonic partials.** Per Agent 1's chunked-decode proposal, ignore shrinking partials on the display side — don't let the cursor visibly backspace.

### 3. State indicators — textarea border IS the nervous system

No separate mic icon flashing in a corner; the user's eye is on the textarea, make the textarea do the work.

| State (Agent 2 §5) | Border | Extras |
|---|---|---|
| `Idle` | neutral 1 px | Tiny `🎙` corner icon at 40% opacity |
| `AwaitingSpeech` (wake fired) | `#89dceb` 2 px, 800 ms pulse | Optional single tick cue |
| `Dictating` | `#cba6f7` 2 px + waveform strip under input | Caret hides |
| `AwaitingCommand` | `#f9e2af` 2 px + shrinking ring corner | §4 overlay |
| `Finalizing` | `#cba6f7` → solid; partial runs `cc-partial-commit` | 150 ms only |
| `Error` | `#f38ba8` 2 px + 150 ms shake | Toast w/ action |

Five visuals, one animation per transition. Mode readable in <200 ms glance.

### 4. `AwaitingCommand` overlay — discoverability

Agent 2 proposes a "Command?" chip w/ legal verbs. Full UX spec:

```
╭─ textarea ──────────────────────────────────────╮
│ > write a haiku about rust▮                      │  ← committed text preserved
╰──────────────────────────────────────────────────╯
  ╭─ AwaitingCommand overlay (3 s, visible) ──────╮
  │ 🟠 Command?                            ⦿ 2.4s │
  │                                                │
  │  [ send ]  [ cancel ]  [ rewrite ]             │
  │  [ new session ]  [ switch to … ]  [ clear ]   │
  │                                                │
  │  say the command or press Esc                  │
  ╰────────────────────────────────────────────────╯
```

- Anchored above textarea, in-flow (no layout shift).
- Dismiss on Esc / timeout / fired intent.
- Chip click = mouse fallback (a11y + muscle-memory teaching).
- Countdown ring shrinks visibly; **resets to 5 s on detected speech** (don't punish slow speakers).
- On timeout: fade out, restore prior `Dictating` buffer (extends Agent 2's "regret window" — never discard work on timeout).
- **First-run teaching**: one-line subtitle for first 3 activations only, then suppress via `localStorage`:

> try: "send", "cancel", or "switch to &lt;session-name&gt;"

### 5. "Command heard" flash animation

150 ms, scoped to the region that owns the change:

```css
@keyframes cc-cmd-flash {
  0%   { box-shadow: 0 0 0 0  rgba(203,166,247,0.0); background: transparent; }
  35%  { box-shadow: 0 0 0 4px rgba(203,166,247,0.45); background: rgba(203,166,247,0.08); }
  100% { box-shadow: 0 0 0 12px rgba(203,166,247,0.0); background: transparent; }
}
```

- **Inline wake eaten** (the "jarvis" stripped mid-dictation): flash the matched span, then animate its `width → 0` over 120 ms. Cursor glides left — the user *sees* the word get eaten. **This is the single most satisfying affordance in the whole redesign** and the clearest signal that a control word was actually consumed.
- Safe-tier command fired: purple flash on full textarea border.
- Destructive-tier command fired: yellow flash + persistent undo toast (§6 Layer 3).
- Wake acknowledged: cyan pulse.

### 6. Verbal + visual misfire recovery

Three composing layers. Nothing replaces anything else.

**Layer 1 — Verbal undo** (catch in `AwaitingCommand` *and* `Dictating`):

```
"scratch that"  →  revert last commit
"wait, no"      →  revert last commit + clear current partial
"undo"          →  revert last VoiceEvent
"forget it"     →  exit AwaitingCommand, restore prior Dictating buffer
```

Regex pass on the partial (reuses §2 infra). On match: strike-through the reverted span (200 ms) → fade → remove. Toast: `"Reverted 'write a haiku'"` with `Redo` button for 3 s.

**Layer 2 — VoiceEvent ring buffer + `Cmd+Z` hook:**

```ts
type VoiceEvent =
  | { kind: "commit";      ts: number; textAdded: string; before: string }
  | { kind: "cmd-fired";   ts: number; intent: VoiceIntent; reversible: boolean; undo: () => void }
  | { kind: "partial-roll";ts: number; before: string };

// Routing: Cmd+Z → most recent VoiceEvent if ts > now-5s, else native textarea undo.
// Cmd+Shift+Z = redo from same stack.
```

Ring size 32, drop oldest. Every `cmd-fired` carries its own `undo()` closure — `Rewrite` stores pre-rewrite text, `SelectSession` stores previous session id, etc.

**Layer 3 — Pre-queued send window** (biggest foot-gun):

`voice-intent: Send` does NOT immediately IPC. 1.5 s countdown toast:

```
  ╭──────────────────────────────────────────╮
  │ ✓ Sending in 1.5s      [ Undo ] [ Send ] │
  ╰──────────────────────────────────────────╯
```

- Undo / Esc cancels, restores textarea.
- "Send" sends immediately (collapse timer).
- Timer expires → actually IPCs.

Composes with Agent 4 §5/F7's `dictation_target_session_id` latch: target session is latched when the intent is *queued*, so mid-grace session switches don't re-route.

### 7. Confirmation tiers — scale with blast radius

| Tier | Examples | Gate | Revert |
|---|---|---|---|
| **Reflex** | `new paragraph`, `scratch that`, inline fixes | Fire immediately | Verbal + `Cmd+Z` |
| **Visible** | `send`, `rewrite`, `switch to <session>`, `cancel` | Fire + 1.5 s undo toast (Layer 3) | Toast button / verbal / `Cmd+Z` |
| **Confirmed** | `delete session`, `clear all`, `exit app` | Re-prompt: *"Say 'confirm' within 3 s"* — `AwaitingCommand` re-enters confirm sub-state | Only fires on verbal `confirm` or explicit chip click |

Default `send` → **Visible** (not Confirmed). User is a solo dev who values velocity; 1.5 s grace is enough for "oh wait."

### 8. Audio cues — opt-in, minimum viable

Off by default (user wears headphones coding). `settings.voice.audioCues: boolean`. Only these six, generated in-process via WebAudio OscillatorNode — don't ship audio files:

| Event | Cue |
|---|---|
| Wake acknowledged | 880 Hz sine, 20 ms |
| Enter AwaitingCommand | Double-tick 440→660 Hz, 120 ms |
| Command fired (safe) | Single tick 660 Hz, 60 ms |
| Command fired (destructive) | Down-chirp 880→440 Hz, 150 ms |
| Error | 200 Hz square, 50 ms |
| Timeout / ignore | *(no audio — visual fade only)* |

### 9. Capability & health surfacing (mapped from Agent 4 §6–§8)

- **Voice badge** (`VoiceStatusBadge.tsx`) gets a color-coded dot:
  - green = ideal (`wake + VAD + whisper`)
  - yellow = degraded (`wake + amp-fallback + moonshine`)
  - red = broken
- Click badge → popover: engine + health metrics + "run self-test" button (Agent 4 §7).
- Persistent banner (not toast) if `frames_dropped > 3/sec` for 3 s: `"Voice input is dropping audio — check mic device"`.
- First-enable-this-session toast follows `voice-warmup-progress` stages: `"Warming up voice (Metal)…"` → `"Ready"`. Kills the "first dictation feels sluggish" confusion (Agent 4 §2).

### 10. Minimum viable implementation checklist

Ordered high → low leverage:

1. **Two-span render** (committed solid + partial dimmed-italic) — ~20 LOC `ChatInput.tsx`.
2. **Monotonic partial guard** (never shrink visible text) — ~5 LOC `voiceStore.ts`.
3. **State-driven border colors + transitions** — ~40 LOC CSS + store binding.
4. **`sanitizePartial` frontend strip** (defense-in-depth) — ~15 LOC.
5. **`cc-cmd-flash` keyframe + inline span-width collapse** — ~30 LOC.
6. **`VoiceCommandOverlay.tsx`** with chips + countdown — new file, ~120 LOC.
7. **VoiceEvent ring buffer + `Cmd+Z` hook** — ~60 LOC `voiceStore.ts`.
8. **Verbal undo regex detector** (`scratch that` / `wait no` / `undo`) — ~20 LOC.
9. **Pre-queued send w/ 1.5 s undo toast** — ~80 LOC (`ChatInputVoiceActions.send` + toast).
10. **Confirmed-tier confirm substate** (only for `delete-session`, `clear-all`) — ~40 LOC.
11. **Voice-health badge + popover** — ~100 LOC new component.
12. **Audio cues behind `settings.voice.audioCues`** — ~50 LOC WebAudio helpers.

**Items 1–5 alone solve the three headline pain points** from the brief (jarvis punctuation, command-mode discoverability, perceived dictation lag). Items 6–12 are full-polish.

### 11. What this UX assumes from other agents

- **Agent 1**: partials are monotonically growing/stabilizing. If finalize returns fewer tokens than the last partial, `cc-partial-commit` will flicker — relying on chunked-decode-with-prompt landing first.
- **Agent 2**: `AwaitingCommand` state + event emitted by backend (not inferred in frontend). `jarvis` stripping pre-emit. 400 ms pause-disambiguation enforced in state machine.
- **Agent 4**: `voice-capabilities`, `voice-health`, `voice-warmup-progress` are public events. `dictation_target_session_id` latched at state transition (Layer 3's session correctness depends on this).

### 12. Out of scope

Wake retrain (Agent 2 §1), VAD tuning / TEN VAD (Agent 2 §2–3), whisper streaming decode (Agent 1 + Agent 4 §1), Metal pre-warm (Agent 4 §2), thread contention (Agent 4 §4). If any of those force a UX regression (e.g. partials unavailable → §2 dim-italic still applies; backend `AwaitingCommand` event unavailable → fall back to inline `[send]` chip after every silence), revisit §4 and §6.

### Sources

- [Claude Code Voice Dictation docs](https://code.claude.com/docs/en/voice-dictation)
- [Commands for dictating text on Mac (Apple)](https://support.apple.com/guide/mac-help/commands-for-dictating-text-on-mac-mh40695/mac)
- [Wispr Flow — Smart Formatting & Backtrack](https://docs.wisprflow.ai/articles/5373093536-how-do-i-use-smart-formatting-and-backtrack)
- [Wispr Flow — Command Mode](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode)
- [Superwhisper — Realtime Transcription](https://superwhisper.com/docs/common-issues/realtime)
- [Dragon — Recognition modes](https://www.nuance.com/products/help/dragon/dragon-for-mac6/enx/Content/Introduction/RecognitionModes.html)
- [ChatGPT Voice — unified UX, barge-in (TechCrunch 2025)](https://techcrunch.com/2025/11/25/chatgpts-voice-mode-is-no-longer-a-separate-interface/)
- [Home Assistant — Assist pipelines](https://developers.home-assistant.io/docs/voice/pipelines/)
- [Willow voice assistant](https://heywillow.io/)
- [Sparkco — barge-in detection UX best practices](https://sparkco.ai/blog/master-voice-agent-barge-in-detection-handling)
- [LiveKit — turn detection, VAD, endpointing](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection)
- [Orga — barge-in for voice agents](https://orga-ai.com/blog/blog-barge-in-voice-agents-guide)

## Agent Questions

- **Agent 1 → Agent 4 (AgreementBuffer semantics for long utterances):** The new windowed decode in `voice/whisper.rs::partial_worker` clones only the trailing `PARTIAL_WINDOW_SECS = 15 s` of audio per tick. For utterances ≤ 15 s the `AgreementBuffer` behaves exactly as before. For utterances > 15 s the window slides and the current hypothesis is decoded from a *different* absolute audio span than the previous one, so word-index LCP against `last_hypothesis_words` correlates to the wrong words. To keep it correct I call `agreement.reset()` whenever `window_start` advances — this discards `committed_words` and the UI may see previously-committed text disappear mid-utterance. Assumption documented inline at `voice/whisper.rs` (see `if window_shifted { ag.reset(); }`). Ask: is that acceptable UX, or would you prefer we instead keep `committed_words` intact and only clear `last_hypothesis_words` (LCP re-bootstraps but the already-committed prefix stays visible)? Clean sample-accurate tracking needs word timestamps (`set_token_timestamps(true) + set_max_len(1) + set_split_on_word(true)`) — a bigger change that belongs in your LocalAgreement-2 rewrite per `### Streaming strategy`.
- **Agent 1 → Agent 7 (telemetry schema):** I emit `voice-telemetry { kind:"partial_decode", decode_ms:u64, window_samples, window_start, buffer_samples, window_shifted:bool, committed_len, tentative_len }` per tick directly via `app.emit()` so I don't block on `testkit.rs` landing. If your `emit_telemetry` helper prefers a different field shape (e.g. flat `{ stage, decode_ms, vad_ms, queue_depth }`), send a message and I'll rename; happy to migrate to your helper once it's merged.
