//! 16 kHz mono mic capture, producing a shared broadcast of f32 frames.
//!
//! Public API (pub/sub) was stubbed by the orchestrator agent and is kept
//! intact here — `MicManager::new()`, `subscribe()`, `publish()`,
//! `start()`, `stop()`, `is_running()`. The concrete backend (cpal input
//! stream → optional rubato resample → 80 ms mono frames) lives inside
//! `start()`. Each frame is `FRAME_SIZE_SAMPLES` f32 samples at
//! `TARGET_SAMPLE_RATE` (80 ms @ 16 kHz = openWakeWord default hop).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use tauri::{AppHandle, Emitter};

/// Target sample rate for the voice pipeline. openWakeWord and Moonshine
/// both expect 16 kHz mono f32 audio.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Size of the frame chunks the capture thread pushes onto subscribers.
pub const FRAME_SIZE_SAMPLES: usize = 1280; // 80ms @ 16kHz — openWakeWord default hop.

/// Handle to a subscriber's receiver half. When dropped, the subscription
/// is implicitly released (sender `send` will skip closed channels).
pub struct MicSubscription {
    pub rx: Receiver<Vec<f32>>,
}

pub struct MicManager {
    running: Arc<AtomicBool>,
    subscribers: Arc<Mutex<Vec<SyncSender<Vec<f32>>>>>,
    // cpal Stream is !Send on some platforms; keep it behind a Mutex and drop
    // it on stop() to release the device.
    stream: Arc<Mutex<Option<Stream>>>,
}

// The cpal Stream is held inside the Mutex and never moved across threads
// beyond the one-shot spawn in start(); AppHandle is Send.
unsafe impl Send for MicManager {}
unsafe impl Sync for MicManager {}

impl MicManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            running: Arc::new(AtomicBool::new(false)),
            subscribers: Arc::new(Mutex::new(Vec::new())),
            stream: Arc::new(Mutex::new(None)),
        })
    }

    /// Start the default input device, downmix to mono, optionally resample
    /// to 16 kHz, and publish 80 ms frames to all subscribers. No-op if
    /// already running. On device/permission failure, emits `voice-error`
    /// and clears the running flag.
    pub fn start(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let this = self.clone();
        let app = app.clone();

        // cpal device open can briefly block, so do it off the caller thread.
        std::thread::spawn(move || match build_input_stream(this.clone()) {
            Ok(stream) => {
                if let Err(e) = stream.play() {
                    let msg = format!("mic stream play() failed: {e}");
                    safe_eprintln!("[mic] {msg}");
                    let _ = app.emit(
                        "voice-error",
                        serde_json::json!({
                            "kind": "runtime",
                            "message": msg,
                            "recoverable": true,
                        }),
                    );
                    this.running.store(false, Ordering::SeqCst);
                    return;
                }
                safe_eprintln!(
                    "[mic] capture started @ {} Hz mono, {}-sample frames",
                    TARGET_SAMPLE_RATE,
                    FRAME_SIZE_SAMPLES
                );
                if let Ok(mut slot) = this.stream.lock() {
                    *slot = Some(stream);
                }
            }
            Err(e) => {
                safe_eprintln!("[mic] build_input_stream failed: {e}");
                let _ = app.emit(
                    "voice-error",
                    serde_json::json!({
                        "kind": kind_for_error(&e),
                        "message": e,
                        "recoverable": true,
                    }),
                );
                this.running.store(false, Ordering::SeqCst);
            }
        });

        Ok(())
    }

    pub fn stop(&self) {
        if !self.running.swap(false, Ordering::SeqCst) {
            return;
        }
        // Drop the cpal Stream to release the input device immediately.
        if let Ok(mut slot) = self.stream.lock() {
            let _ = slot.take();
        }
        // Drop all subscribers so their receivers disconnect.
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.clear();
        }
        safe_eprintln!("[mic] stopped");
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Subscribe to the mic stream. The returned receiver gets every frame
    /// produced by the capture thread while it lives; dropping it releases
    /// the subscription. Bounded capacity backpressures slow consumers by
    /// dropping the oldest frames.
    pub fn subscribe(&self) -> MicSubscription {
        // 256 frames × 80ms = ~20s of audio buffer. Large enough to absorb
        // a slow whisper call (Metal shader compile on first run can stall
        // for 1-2s) without dropping frames of the user's next sentence.
        let (tx, rx) = sync_channel::<Vec<f32>>(256);
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.push(tx);
        }
        MicSubscription { rx }
    }

    /// Called by the capture backend to distribute a frame to all live
    /// subscribers. Stale/closed senders are pruned lazily.
    pub fn publish(&self, frame: Vec<f32>) {
        let Ok(mut subs) = self.subscribers.lock() else {
            return;
        };
        subs.retain(|tx| match tx.try_send(frame.clone()) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => true,
            Err(TrySendError::Disconnected(_)) => false,
        });
    }
}

impl Drop for MicManager {
    fn drop(&mut self) {
        self.stop();
    }
}

fn kind_for_error(msg: &str) -> &'static str {
    let m = msg.to_lowercase();
    if m.contains("permission") || m.contains("denied") || m.contains("not authorized") {
        "permission"
    } else if m.contains("no default input") || m.contains("no device") {
        "permission"
    } else {
        "runtime"
    }
}

/// Heuristic: true if this input device is a Bluetooth/AirPods mic.
/// Using it forces macOS to downgrade the output side from A2DP stereo to
/// HFP mono, which audibly wrecks music playback — so we prefer to avoid it.
fn is_bluetooth_input(name: &str) -> bool {
    let n = name.to_lowercase();
    [
        "airpods", "bluetooth", "beats", "bose", "sony wh", "sony wf",
        "sennheiser momentum", "galaxy buds", "pixel buds", "soundcore",
    ]
    .iter()
    .any(|pat| n.contains(pat))
}

/// Pick an input device, preferring the MacBook's built-in mic when the
/// system default is a Bluetooth/AirPods input. This keeps AirPods in
/// high-quality A2DP for music while Jarvis uses the laptop mic.
fn pick_input_device(host: &cpal::Host) -> Result<cpal::Device, String> {
    let default = host
        .default_input_device()
        .ok_or_else(|| "No default input device available".to_string())?;
    let default_name = default.name().ok().unwrap_or_default();
    if !is_bluetooth_input(&default_name) {
        return Ok(default);
    }
    // Default is Bluetooth — look for a built-in alternative.
    let devices = host
        .input_devices()
        .map_err(|e| format!("enumerate inputs: {e}"))?;
    for d in devices {
        let n = d.name().ok().unwrap_or_default();
        let ln = n.to_lowercase();
        if ln.contains("macbook") || ln.contains("built-in") || ln.contains("builtin") {
            safe_eprintln!(
                "[mic] default '{default_name}' is Bluetooth, using built-in '{n}' instead \
                 (prevents AirPods A2DP → HFP downgrade)"
            );
            return Ok(d);
        }
    }
    safe_eprintln!(
        "[mic] default '{default_name}' is Bluetooth and no built-in mic found — \
         falling back to default (music playback will degrade)"
    );
    Ok(default)
}

/// Build a cpal input stream that downmixes to mono, resamples to 16 kHz,
/// slices into 80 ms chunks, and calls `mic.publish(frame)` for each chunk.
fn build_input_stream(mic: Arc<MicManager>) -> Result<Stream, String> {
    let host = cpal::default_host();
    let device = pick_input_device(&host)?;

    let supported = device
        .default_input_config()
        .map_err(|e| format!("default_input_config failed: {e}"))?;

    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.clone().into();
    let in_rate = config.sample_rate.0;
    let in_channels = config.channels as usize;

    safe_eprintln!(
        "[mic] device={:?} rate={} ch={} fmt={:?}",
        device.name().ok(),
        in_rate,
        in_channels,
        sample_format
    );

    let frame_builder = Arc::new(Mutex::new(FrameBuilder::new(in_rate, TARGET_SAMPLE_RATE)?));
    let err_fn = |err| safe_eprintln!("[mic] stream error: {err}");

    match sample_format {
        SampleFormat::F32 => {
            let fb = frame_builder.clone();
            let m = mic.clone();
            device
                .build_input_stream(
                    &config,
                    move |data: &[f32], _| {
                        let mono = downmix_f32(data, in_channels);
                        if let Ok(mut b) = fb.lock() {
                            b.feed(&mono, &m);
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("build_input_stream(f32): {e}"))
        }
        SampleFormat::I16 => {
            let fb = frame_builder.clone();
            let m = mic.clone();
            device
                .build_input_stream(
                    &config,
                    move |data: &[i16], _| {
                        let mono = downmix_i16(data, in_channels);
                        if let Ok(mut b) = fb.lock() {
                            b.feed(&mono, &m);
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("build_input_stream(i16): {e}"))
        }
        SampleFormat::U16 => {
            let fb = frame_builder.clone();
            let m = mic.clone();
            device
                .build_input_stream(
                    &config,
                    move |data: &[u16], _| {
                        let mono = downmix_u16(data, in_channels);
                        if let Ok(mut b) = fb.lock() {
                            b.feed(&mono, &m);
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("build_input_stream(u16): {e}"))
        }
        other => Err(format!("Unsupported sample format: {other:?}")),
    }
}

/// Accumulates mono samples at the device rate, resamples to 16 kHz if
/// needed, then emits fixed-size 1280-sample frames via `MicManager::publish`.
struct FrameBuilder {
    resampler: Option<SincFixedIn<f32>>,
    resample_chunk: usize,
    in_accum: Vec<f32>,  // device-rate samples awaiting resample
    out_accum: Vec<f32>, // 16 kHz samples awaiting frame emission
}

impl FrameBuilder {
    fn new(in_rate: u32, out_rate: u32) -> Result<Self, String> {
        let (resampler, chunk) = if in_rate == out_rate {
            (None, 0)
        } else {
            let params = SincInterpolationParameters {
                sinc_len: 128,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 128,
                window: WindowFunction::BlackmanHarris2,
            };
            let rs = SincFixedIn::<f32>::new(
                out_rate as f64 / in_rate as f64,
                2.0,
                params,
                1024,
                1,
            )
            .map_err(|e| format!("rubato init failed: {e}"))?;
            let chunk = rs.input_frames_next();
            (Some(rs), chunk)
        };
        Ok(Self {
            resampler,
            resample_chunk: chunk,
            in_accum: Vec::with_capacity(8192),
            out_accum: Vec::with_capacity(FRAME_SIZE_SAMPLES * 4),
        })
    }

    fn feed(&mut self, mono: &[f32], mic: &MicManager) {
        match self.resampler.as_mut() {
            None => {
                self.out_accum.extend_from_slice(mono);
            }
            Some(rs) => {
                self.in_accum.extend_from_slice(mono);
                while self.in_accum.len() >= self.resample_chunk {
                    let input =
                        vec![self.in_accum.drain(..self.resample_chunk).collect::<Vec<f32>>()];
                    match rs.process(&input, None) {
                        Ok(out) => self.out_accum.extend_from_slice(&out[0]),
                        Err(e) => {
                            safe_eprintln!("[mic] resample failed: {e}");
                            return;
                        }
                    }
                }
            }
        }
        // Emit all complete 80 ms frames accumulated so far.
        while self.out_accum.len() >= FRAME_SIZE_SAMPLES {
            let frame: Vec<f32> = self.out_accum.drain(..FRAME_SIZE_SAMPLES).collect();
            mic.publish(frame);
        }
    }
}

fn downmix_f32(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|c| c.iter().copied().sum::<f32>() / c.len() as f32)
        .collect()
}

fn downmix_i16(data: &[i16], channels: usize) -> Vec<f32> {
    const SCALE: f32 = 1.0 / 32768.0;
    if channels <= 1 {
        return data.iter().map(|&s| s as f32 * SCALE).collect();
    }
    data.chunks(channels)
        .map(|c| {
            let sum: f32 = c.iter().map(|&s| s as f32 * SCALE).sum();
            sum / c.len() as f32
        })
        .collect()
}

fn downmix_u16(data: &[u16], channels: usize) -> Vec<f32> {
    const SCALE: f32 = 1.0 / 32768.0;
    if channels <= 1 {
        return data
            .iter()
            .map(|&s| (s as i32 - 32768) as f32 * SCALE)
            .collect();
    }
    data.chunks(channels)
        .map(|c| {
            let sum: f32 = c
                .iter()
                .map(|&s| (s as i32 - 32768) as f32 * SCALE)
                .sum();
            sum / c.len() as f32
        })
        .collect()
}
