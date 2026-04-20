//! Trait adapters bridging concrete ONNX runners to the voice_manager traits.
//!
//! The orchestrator in `voice_manager.rs` accepts `Box<dyn Trait>` runners so
//! it stays agnostic of ONNX internals. This module builds the adapters from
//! model files already downloaded to `~/.terminal64/stt-models/`.

use std::path::PathBuf;

use crate::voice::command_stt::CommandSttRunner;
use crate::voice::models::{find, is_downloaded, model_dir, ModelKind};
use crate::voice::vad::{VadDetector as RealVad, CHUNK_SIZE_16K};
use crate::voice::wake::WakeDetector;
use crate::voice::whisper::WhisperRunner;
use crate::voice_manager::{CommandRunner, DictationRunner, VadDetector as VadTrait, WakeRunner};

// ---- Wake ----

pub struct WakeAdapter {
    inner: WakeDetector,
}

/// Per-bundle wake-word config: the bundle name (matches `voice::models`
/// registry) plus the classifier filename inside the bundle dir. The mel
/// and embedding ONNX files are always the shared openWakeWord ones.
struct WakeBundle {
    bundle: &'static str,
    classifier: &'static str,
}
const WAKE_JARVIS: WakeBundle = WakeBundle {
    bundle: "jarvis",
    classifier: "jarvis.onnx",
};
const WAKE_T64: WakeBundle = WakeBundle {
    bundle: "t64",
    classifier: "t_six_four.onnx",
};

impl WakeAdapter {
    /// Load the currently-configured wake bundle. `name` matches the voice
    /// store's `wakeWord` setting ("jarvis" | "t64"). If the requested bundle
    /// isn't fully downloaded (common for the user-trained t64 before they
    /// drop in their onnx), falls back to jarvis so voice stays functional.
    pub fn try_load(name: &str) -> Result<Self, String> {
        let primary = match name {
            "t64" => &WAKE_T64,
            _ => &WAKE_JARVIS,
        };
        match Self::load_bundle(primary) {
            Ok(adapter) => Ok(adapter),
            Err(e) if primary.bundle != "jarvis" => {
                safe_eprintln!(
                    "[voice/wake] {} bundle not ready ({}); falling back to jarvis",
                    primary.bundle,
                    e
                );
                Self::load_bundle(&WAKE_JARVIS)
            }
            Err(e) => Err(e),
        }
    }

    fn load_bundle(b: &WakeBundle) -> Result<Self, String> {
        let info = find(ModelKind::Wake, b.bundle)
            .ok_or_else(|| format!("wake bundle {} not in registry", b.bundle))?;
        if !is_downloaded(info) {
            return Err(format!("wake bundle {} not fully present", b.bundle));
        }
        let dir = model_dir(ModelKind::Wake, b.bundle)?;
        let mel = dir.join("melspectrogram.onnx");
        let emb = dir.join("embedding_model.onnx");
        let cls = dir.join(b.classifier);
        for p in [&mel, &emb, &cls] {
            if !p.exists() {
                return Err(format!("wake file missing: {}", p.display()));
            }
        }
        safe_eprintln!(
            "[voice/wake] loading bundle '{}' (classifier: {})",
            b.bundle,
            b.classifier
        );
        let inner = WakeDetector::load(&mel, &emb, &cls)?;
        Ok(Self { inner })
    }
}

impl WakeRunner for WakeAdapter {
    fn feed(&mut self, frame: &[f32]) -> bool {
        self.inner.detect(frame).is_some()
    }
    fn reset(&mut self) {
        self.inner.reset();
    }
    fn set_threshold(&mut self, t: f32) {
        self.inner.set_threshold(t);
    }
}

// ---- Command (grammar-constrained whisper) ----
//
// Replaces the legacy Moonshine adapter. Uses whisper.cpp via `CommandSttRunner`
// with an initial-prompt bias toward the command vocabulary plus a
// Levenshtein ≤ 1 snap-to-canonical post-process. Shares the same small.en-q5_1
// model file as dictation — one model on disk, one warm in Metal memory, and
// zero ONNX dependencies for the command path. See
// `.wolf/voice-research-shared.md` §4 for the full design rationale.

pub struct CommandAdapter {
    inner: CommandSttRunner,
}

impl CommandAdapter {
    pub fn try_load() -> Result<Self, String> {
        let info = find(ModelKind::Whisper, "small.en-q5_1")
            .ok_or_else(|| "whisper model not in registry".to_string())?;
        if !is_downloaded(info) {
            return Err("whisper model not downloaded (command STT shares it)".to_string());
        }
        let dir = model_dir(ModelKind::Whisper, "small.en-q5_1")?;
        let bin = dir.join("ggml-small.en-q5_1.bin");
        if !bin.exists() {
            return Err(format!("whisper file missing: {}", bin.display()));
        }
        let inner = CommandSttRunner::load(&bin)?;
        Ok(Self { inner })
    }
}

impl CommandRunner for CommandAdapter {
    fn transcribe(&mut self, audio: &[f32]) -> Result<String, String> {
        self.inner.transcribe(audio)
    }
}

// ---- VAD ----
//
// Silero VADIterator-style hysteresis wrapper. The previous "any sub-window
// above threshold" bool was the root cause of dictation losing trailing
// words: a single 32 ms dip below 0.5 (a breath between words, a soft
// consonant tail) was enough to start the orchestrator's silence counter
// and finalize whisper on a truncated buffer.
//
// This wrapper runs a proper two-threshold state machine at the 32 ms
// sub-window tick and only exposes smoothed speech/silence transitions
// through the existing `VadTrait::is_speech` bool:
//
//   * Mic frames are 1280 samples (80 ms); Silero takes 512 samples
//     (32 ms). We buffer across calls and step the state machine on each
//     full sub-window, then return the current state to the orchestrator.
//   * `speech_threshold = 0.5` activates, `silence_threshold = 0.35`
//     deactivates; probabilities in the 0.35–0.5 band leave counters
//     untouched (classic hysteresis — uncertain frames don't flip state).
//   * `min_speech_duration_ms = 250` → ~8 consecutive sub-windows above
//     0.5 required before declaring speech. Rejects single-frame false
//     positives from keyboard thunks / HVAC.
//   * `min_silence_duration_ms = 500` → ~16 consecutive sub-windows below
//     0.35 required before declaring silence. Any frame ≥ 0.5 resets the
//     counter, so mid-sentence thinking pauses under 500 ms no longer
//     end the utterance. Reference: Silero VADIterator (same algorithm,
//     same neg-threshold = 0.35 derivation).
//   * `speech_pad_ms = 300` → after the state machine declares silence,
//     keep emitting speech=true for ~10 more sub-windows. This prevents
//     the orchestrator's own silence_run from starting mid-consonant and
//     preserves trailing audio context for whisper.
//
// Net effect from last high-prob sub-window to this wrapper returning
// false: min_silence_duration_ms + speech_pad_ms ≈ 800 ms. The
// orchestrator's SILENCE_FRAMES_TO_FINALIZE is tuned down accordingly in
// voice_manager.rs.

const VAD_SUB_WINDOW_MS: u32 = 32; // 512 samples @ 16 kHz
const VAD_SPEECH_THRESHOLD: f32 = 0.5;
const VAD_SILENCE_THRESHOLD: f32 = 0.35;
// Ceiling conversions (ms → sub-windows). 250/32 = 7.8125 → 8, etc.
const VAD_MIN_SPEECH_FRAMES: u32 = 250_u32.div_ceil(VAD_SUB_WINDOW_MS);
const VAD_MIN_SILENCE_FRAMES: u32 = 500_u32.div_ceil(VAD_SUB_WINDOW_MS);
const VAD_SPEECH_PAD_FRAMES: u32 = 300_u32.div_ceil(VAD_SUB_WINDOW_MS);

pub struct VadAdapter {
    inner: RealVad,
    buf: Vec<f32>,
    triggered: bool,
    pre_speech_run: u32,
    silence_run: u32,
    pad_frames_left: u32,
}

impl VadAdapter {
    pub fn try_load() -> Result<Self, String> {
        let info = find(ModelKind::Vad, "silero")
            .ok_or_else(|| "vad model not in registry".to_string())?;
        if !is_downloaded(info) {
            return Err("vad model not downloaded".to_string());
        }
        let dir = model_dir(ModelKind::Vad, "silero")?;
        let p: PathBuf = dir.join("silero_vad.onnx");
        if !p.exists() {
            return Err(format!("vad file missing: {}", p.display()));
        }
        let inner = RealVad::load(&p)?;
        Ok(Self {
            inner,
            buf: Vec::with_capacity(CHUNK_SIZE_16K * 4),
            triggered: false,
            pre_speech_run: 0,
            silence_run: 0,
            pad_frames_left: 0,
        })
    }

    /// Advance the state machine by one Silero sub-window probability.
    fn step(&mut self, prob: f32) {
        if self.triggered {
            if prob >= VAD_SPEECH_THRESHOLD {
                self.silence_run = 0;
            } else if prob < VAD_SILENCE_THRESHOLD {
                self.silence_run = self.silence_run.saturating_add(1);
                if self.silence_run >= VAD_MIN_SILENCE_FRAMES {
                    self.triggered = false;
                    self.silence_run = 0;
                    // Arm the post-speech padding window.
                    self.pad_frames_left = VAD_SPEECH_PAD_FRAMES;
                }
            }
            // else: probability sits in the 0.35–0.5 hysteresis band —
            // neither resume nor silence; leave counters intact.
        } else {
            if prob >= VAD_SPEECH_THRESHOLD {
                self.pre_speech_run = self.pre_speech_run.saturating_add(1);
                if self.pre_speech_run >= VAD_MIN_SPEECH_FRAMES {
                    self.triggered = true;
                    self.pre_speech_run = 0;
                    self.silence_run = 0;
                    // Fresh speech cancels any leftover hangover.
                    self.pad_frames_left = 0;
                }
            } else if prob < VAD_SILENCE_THRESHOLD {
                // Definite silence breaks the pre-speech streak.
                self.pre_speech_run = 0;
            }
            // Tick down the post-speech pad only on non-triggered frames;
            // if we re-triggered above, pad was already cleared.
            if !self.triggered && self.pad_frames_left > 0 {
                self.pad_frames_left -= 1;
            }
        }
    }
}

impl VadTrait for VadAdapter {
    fn is_speech(&mut self, frame: &[f32]) -> bool {
        self.buf.extend_from_slice(frame);
        while self.buf.len() >= CHUNK_SIZE_16K {
            let chunk: Vec<f32> = self.buf.drain(..CHUNK_SIZE_16K).collect();
            let (_, prob) = self.inner.is_speech(&chunk, 16_000);
            self.step(prob);
        }
        self.triggered || self.pad_frames_left > 0
    }

    fn reset(&mut self) {
        // Clear the sub-window buffer and all hysteresis counters. Called
        // across state transitions so the pad tail of the previous utterance
        // (e.g. the wake word itself) doesn't bleed into the next capture
        // window as false speech. Silero's internal LSTM state is also reset.
        self.buf.clear();
        self.triggered = false;
        self.pre_speech_run = 0;
        self.silence_run = 0;
        self.pad_frames_left = 0;
        self.inner.reset();
    }
}

// ---- Dictation (whisper.cpp) ----

pub struct DictationAdapter {
    inner: WhisperRunner,
}

impl DictationAdapter {
    pub fn try_load(app: tauri::AppHandle) -> Result<Self, String> {
        let info = find(ModelKind::Whisper, "small.en-q5_1")
            .ok_or_else(|| "whisper model not in registry".to_string())?;
        if !is_downloaded(info) {
            return Err("whisper model not downloaded".to_string());
        }
        let dir = model_dir(ModelKind::Whisper, "small.en-q5_1")?;
        let bin = dir.join("ggml-small.en-q5_1.bin");
        if !bin.exists() {
            return Err(format!("whisper file missing: {}", bin.display()));
        }
        let mut inner = WhisperRunner::load(&bin)?;
        inner.set_app(app);
        Ok(Self { inner })
    }
}

impl DictationRunner for DictationAdapter {
    fn start(&mut self) {
        self.inner.start();
    }
    fn push(&mut self, frame: &[f32]) {
        self.inner.push(frame);
    }
    fn flush(&mut self) -> Result<String, String> {
        self.inner.flush()
    }
}
