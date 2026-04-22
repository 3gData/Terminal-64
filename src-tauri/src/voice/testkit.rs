//! Voice test harness + telemetry + startup self-test.
//!
//! Three jobs (references Agent 4 §6–§10 in `.wolf/voice-research-shared.md`):
//!
//! 1. **Self-test** (§7): `run_self_test(app)` loads each model adapter and
//!    runs one inference on a 1 s silent f32 buffer, emits a structured
//!    `voice-selftest` event with per-stage ms + ok/err. Spawned off the main
//!    thread at startup so Metal shader compile (~1–2 s on first boot) does
//!    not block UI. Also callable on demand via the `voice_run_selftest`
//!    Tauri command (Agent 3 §4 "run self-test" button).
//!
//! 2. **Telemetry** (§6): `emit_telemetry(app, ...)` writes a single
//!    `voice-telemetry` event with `{ stage, decode_ms?, vad_ms?,
//!    queue_depth? }`. Call sites live inside other agents' code (whisper
//!    partial worker emits `decode_ms`, voice_manager capture loop emits
//!    `vad_ms` + `queue_depth`). This module owns only the sink.
//!
//! 3. **Fixture runner** (§10): `voice_run_fixtures(dir, out_json)` walks a
//!    directory of `.wav` files, pushes each through wake → vad → dictation
//!    adapters, and writes a JSON report. Useful for regression testing
//!    without spinning up the mic / capture loop.
//!
//! Bundled WAV: none on disk — the self-test uses a generated silent buffer
//! to keep the binary small and sidestep the cfg(target_os) path maze. The
//! fixture runner loads user-provided WAVs from a path.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::voice::adapters::{CommandAdapter, DictationAdapter, VadAdapter, WakeAdapter};
use crate::voice_manager::{CommandRunner, DictationRunner, VadDetector as VadTrait, WakeRunner};

// ---- Telemetry (§6) ---------------------------------------------------------

/// Payload for the `voice-telemetry` event. Any field may be `None`: call
/// sites fill in just the metrics they have (e.g. whisper partial worker
/// sets `decode_ms` + `stage:"partial"`, capture loop sets `vad_ms` +
/// `queue_depth`). The frontend merges fields by `stage`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VoiceTelemetry {
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decode_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vad_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_depth: Option<u32>,
}

/// Emit a single telemetry sample. Cheap — Tauri's `emit` is fire-and-forget.
/// Other agents call this directly; no throttling here (caller decides cadence).
#[allow(dead_code)] // Call sites land in parallel agents' PRs (whisper.rs, voice_manager.rs).
pub fn emit_telemetry(
    app: &AppHandle,
    stage: &str,
    decode_ms: Option<f32>,
    vad_ms: Option<f32>,
    queue_depth: Option<u32>,
) {
    let payload = VoiceTelemetry {
        stage: stage.to_string(),
        decode_ms,
        vad_ms,
        queue_depth,
    };
    let _ = app.emit("voice-telemetry", &payload);
}

// ---- Self-test (§7) ---------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SelfTestStage {
    pub name: String,
    pub ms: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SelfTestReport {
    pub ok: bool,
    pub total_ms: u64,
    pub stages: Vec<SelfTestStage>,
}

/// Sample rate for all pipeline stages. Matches `MicManager::TARGET_SAMPLE_RATE`.
const SR: usize = 16_000;

/// Synthesize 1 second of silence (f32 zeros). Keeps the binary small — the
/// task prompt mentioned "bundled 1s silent WAV" but in-memory zeros behave
/// identically for warm-up / smoke-test purposes.
fn silent_1s() -> Vec<f32> {
    vec![0.0; SR]
}

/// Run every stage once on a 1 s silent buffer. Emits `voice-selftest`
/// and also returns the report so the caller (tauri command) can surface it.
///
/// Runs synchronously; callers that can't block should wrap in `std::thread::spawn`.
pub fn run_self_test(app: &AppHandle) -> SelfTestReport {
    let overall = Instant::now();
    let silent = silent_1s();
    let mut stages: Vec<SelfTestStage> = Vec::new();

    // --- Stage 1: wake ---
    stages.push(time_stage("wake", || {
        let mut a = WakeAdapter::try_load("jarvis")?;
        // 80 ms chunks (1280 samples @ 16 kHz) are what the detector expects.
        for chunk in silent.chunks_exact(1280).take(6) {
            let _ = a.feed(chunk);
        }
        Ok(())
    }));

    // --- Stage 2: vad ---
    stages.push(time_stage("vad", || {
        let mut a = VadAdapter::try_load()?;
        for chunk in silent.chunks_exact(1280).take(6) {
            let _ = a.is_speech(chunk);
        }
        Ok(())
    }));

    // --- Stage 3: command (Moonshine) ---
    stages.push(time_stage("command", || {
        let mut a = CommandAdapter::try_load()?;
        a.transcribe(&silent).map(|_| ())
    }));

    // --- Stage 4: dictation (whisper) — also Metal pre-warm (§2) ---
    stages.push(time_stage("dictation", || {
        let mut a = DictationAdapter::try_load(app.clone())?;
        a.start();
        a.push(&silent);
        a.flush().map(|_| ())
    }));

    let ok = stages.iter().all(|s| s.ok);
    let total_ms = overall.elapsed().as_millis() as u64;
    let report = SelfTestReport {
        ok,
        total_ms,
        stages,
    };
    let _ = app.emit("voice-selftest", &report);
    safe_eprintln!(
        "[voice/testkit] self-test: ok={} total={}ms stages={:?}",
        report.ok,
        report.total_ms,
        report
            .stages
            .iter()
            .map(|s| format!("{}={}ms{}", s.name, s.ms, if s.ok { "" } else { " ERR" }))
            .collect::<Vec<_>>()
    );
    report
}

fn time_stage<F>(name: &str, f: F) -> SelfTestStage
where
    F: FnOnce() -> Result<(), String>,
{
    let start = Instant::now();
    let res = f();
    let ms = start.elapsed().as_millis() as u64;
    match res {
        Ok(()) => SelfTestStage {
            name: name.to_string(),
            ms,
            ok: true,
            err: None,
        },
        Err(e) => SelfTestStage {
            name: name.to_string(),
            ms,
            ok: false,
            err: Some(e),
        },
    }
}

// ---- Fixture runner (§10) ---------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct FixtureResult {
    pub file: String,
    pub samples: usize,
    pub duration_ms: u64,
    pub wake_fired: bool,
    pub wake_ms: u64,
    pub vad_speech_frames: u32,
    pub vad_total_frames: u32,
    pub vad_ms: u64,
    pub dictation_text: String,
    pub dictation_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FixturesReport {
    pub dir: String,
    pub started_at: String,
    pub total_files: usize,
    pub total_ms: u64,
    pub results: Vec<FixtureResult>,
}

/// Walk `dir` for `*.wav`, run each through wake → vad → dictation adapters,
/// and collect per-file metrics. Writes the JSON report to `out_json` (or
/// `<dir>/voice_fixtures_report.json` if `out_json` is empty). Returns the
/// report to the caller.
pub fn run_fixtures(
    app: &AppHandle,
    dir: &Path,
    out_json: Option<&Path>,
) -> Result<FixturesReport, String> {
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }
    let wavs = list_wavs(dir)?;
    let started = chrono::Utc::now().to_rfc3339();
    let overall = Instant::now();

    // Load each adapter once and reuse across fixtures. Skip stages whose
    // models aren't present — the per-file result records which stage ran.
    let mut wake = WakeAdapter::try_load("jarvis").ok();
    let mut vad = VadAdapter::try_load().ok();
    let mut cmd = CommandAdapter::try_load().ok();
    let mut dict = DictationAdapter::try_load(app.clone()).ok();

    let mut results: Vec<FixtureResult> = Vec::with_capacity(wavs.len());
    for path in &wavs {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        safe_eprintln!("[voice/testkit] fixture: {}", name);

        let samples = match read_wav_16k_mono(path) {
            Ok(s) => s,
            Err(e) => {
                results.push(FixtureResult {
                    file: name,
                    samples: 0,
                    duration_ms: 0,
                    wake_fired: false,
                    wake_ms: 0,
                    vad_speech_frames: 0,
                    vad_total_frames: 0,
                    vad_ms: 0,
                    dictation_text: String::new(),
                    dictation_ms: 0,
                    error: Some(e),
                });
                continue;
            }
        };
        let duration_ms = (samples.len() as u64 * 1000) / SR as u64;

        // --- Wake: feed 80 ms chunks until it fires or the buffer ends. ---
        let (wake_fired, wake_ms) = match wake.as_mut() {
            Some(w) => {
                let t0 = Instant::now();
                let mut fired = false;
                for chunk in samples.chunks_exact(1280) {
                    if w.feed(chunk) {
                        fired = true;
                        break;
                    }
                }
                (fired, t0.elapsed().as_millis() as u64)
            }
            None => (false, 0),
        };

        // --- VAD: count speech/total frames across the full buffer. ---
        let (vad_speech_frames, vad_total_frames, vad_ms) = match vad.as_mut() {
            Some(v) => {
                let t0 = Instant::now();
                let mut speech = 0u32;
                let mut total = 0u32;
                for chunk in samples.chunks_exact(1280) {
                    if v.is_speech(chunk) {
                        speech += 1;
                    }
                    total += 1;
                }
                (speech, total, t0.elapsed().as_millis() as u64)
            }
            None => (0, 0, 0),
        };

        // --- Dictation: prefer whisper, fall back to moonshine command. ---
        let (dictation_text, dictation_ms, dict_err) = if let Some(d) = dict.as_mut() {
            let t0 = Instant::now();
            d.start();
            // Push in 80 ms hops to simulate capture cadence.
            for chunk in samples.chunks(1280) {
                d.push(chunk);
            }
            let res = d.flush();
            let ms = t0.elapsed().as_millis() as u64;
            match res {
                Ok(t) => (t, ms, None),
                Err(e) => (String::new(), ms, Some(e)),
            }
        } else if let Some(c) = cmd.as_mut() {
            let t0 = Instant::now();
            let res = c.transcribe(&samples);
            let ms = t0.elapsed().as_millis() as u64;
            match res {
                Ok(t) => (t, ms, None),
                Err(e) => (String::new(), ms, Some(e)),
            }
        } else {
            (
                String::new(),
                0,
                Some("no dictation/command adapter".into()),
            )
        };

        results.push(FixtureResult {
            file: name,
            samples: samples.len(),
            duration_ms,
            wake_fired,
            wake_ms,
            vad_speech_frames,
            vad_total_frames,
            vad_ms,
            dictation_text,
            dictation_ms,
            error: dict_err,
        });
    }

    let report = FixturesReport {
        dir: dir.display().to_string(),
        started_at: started,
        total_files: wavs.len(),
        total_ms: overall.elapsed().as_millis() as u64,
        results,
    };

    // Write the JSON report. Default location: inside the fixture dir.
    let out_path: PathBuf = match out_json {
        Some(p) => p.to_path_buf(),
        None => dir.join("voice_fixtures_report.json"),
    };
    let json = serde_json::to_vec_pretty(&report).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&out_path, json).map_err(|e| format!("write {}: {e}", out_path.display()))?;
    safe_eprintln!(
        "[voice/testkit] fixtures: {} files in {}ms → {}",
        report.total_files,
        report.total_ms,
        out_path.display()
    );

    Ok(report)
}

fn list_wavs(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let rd = std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_file()
            && p.extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("wav"))
                .unwrap_or(false)
        {
            out.push(p);
        }
    }
    out.sort();
    Ok(out)
}

// ---- Minimal WAV reader ------------------------------------------------------
//
// Supports 16-bit PCM (fmt 1) and 32-bit float (fmt 3) at 16 kHz, any channel
// count (downmixed to mono). Rejects anything else with a descriptive error —
// fixtures should be normalized to 16k mono per §10's naming convention.

pub fn read_wav_16k_mono(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("{}: not a RIFF/WAVE file", path.display()));
    }

    let mut i = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None;
    let mut data_range: Option<(usize, usize)> = None;

    while i + 8 <= bytes.len() {
        let tag = &bytes[i..i + 4];
        let size =
            u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        let start = i + 8;
        let end = start.saturating_add(size).min(bytes.len());
        if tag == b"fmt " && size >= 16 {
            let fmt_code = u16::from_le_bytes([bytes[start], bytes[start + 1]]);
            let channels = u16::from_le_bytes([bytes[start + 2], bytes[start + 3]]);
            let sr = u32::from_le_bytes([
                bytes[start + 4],
                bytes[start + 5],
                bytes[start + 6],
                bytes[start + 7],
            ]);
            let bits = u16::from_le_bytes([bytes[start + 14], bytes[start + 15]]);
            fmt = Some((fmt_code, channels, sr, bits));
        } else if tag == b"data" {
            data_range = Some((start, end));
            break;
        }
        // Chunks are padded to even lengths.
        i = end + (size & 1);
    }

    let (fmt_code, channels, sr, bits) =
        fmt.ok_or_else(|| format!("{}: fmt chunk missing", path.display()))?;
    let (data_start, data_end) =
        data_range.ok_or_else(|| format!("{}: data chunk missing", path.display()))?;
    if sr != SR as u32 {
        return Err(format!("{}: sample rate {sr} != 16000", path.display()));
    }
    if channels == 0 {
        return Err(format!("{}: zero channels", path.display()));
    }

    let data = &bytes[data_start..data_end];
    match (fmt_code, bits) {
        (1, 16) => {
            let stride = 2 * channels as usize;
            let mut out = Vec::with_capacity(data.len() / stride);
            for frame in data.chunks_exact(stride) {
                let mut sum = 0.0f32;
                for c in 0..channels as usize {
                    let off = c * 2;
                    let s = i16::from_le_bytes([frame[off], frame[off + 1]]);
                    sum += s as f32 / 32768.0;
                }
                out.push(sum / channels as f32);
            }
            Ok(out)
        }
        (3, 32) => {
            let stride = 4 * channels as usize;
            let mut out = Vec::with_capacity(data.len() / stride);
            for frame in data.chunks_exact(stride) {
                let mut sum = 0.0f32;
                for c in 0..channels as usize {
                    let off = c * 4;
                    let s = f32::from_le_bytes([
                        frame[off],
                        frame[off + 1],
                        frame[off + 2],
                        frame[off + 3],
                    ]);
                    sum += s;
                }
                out.push(sum / channels as f32);
            }
            Ok(out)
        }
        _ => Err(format!(
            "{}: unsupported format fmt={fmt_code} bits={bits} (need PCM16 or Float32)",
            path.display()
        )),
    }
}
