use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;
use spectrum_analyzer::scaling::divide_by_N_sqrt;
use spectrum_analyzer::{samples_fft_to_spectrum, FrequencyLimit};
use tauri::{AppHandle, Emitter};

use crate::types::SpectrumData;

const FFT_SIZE: usize = 2048;
const NUM_BANDS: usize = 64;
const TARGET_FPS: u64 = 30;
const FRAME_DURATION: Duration = Duration::from_millis(1000 / TARGET_FPS);

pub struct AudioManager {
    active: Arc<AtomicBool>,
}

impl AudioManager {
    pub fn new() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start(&self, app_handle: &AppHandle) -> Result<(), String> {
        if self.active.load(Ordering::Relaxed) {
            return Ok(());
        }

        self.active.store(true, Ordering::Relaxed);

        let active = self.active.clone();
        let app = app_handle.clone();

        std::thread::spawn(move || {
            if let Err(e) = run_capture(active.clone(), app) {
                safe_eprintln!("[audio] Capture failed: {}", e);
                active.store(false, Ordering::Relaxed);
            }
        });

        safe_eprintln!("[audio] Party mode started");
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.active.store(false, Ordering::Relaxed);
        safe_eprintln!("[audio] Party mode stopped");
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }
}

#[cfg(target_os = "macos")]
fn run_capture(active: Arc<AtomicBool>, app: AppHandle) -> Result<(), String> {
    use screencapturekit::prelude::*;

    safe_eprintln!("[audio] Using ScreenCaptureKit for system audio capture");

    let content = SCShareableContent::get().map_err(|e| {
        format!(
            "Failed to get shareable content (Screen Recording permission needed): {:?}",
            e
        )
    })?;

    let display = content
        .displays()
        .into_iter()
        .next()
        .ok_or_else(|| "No display found for ScreenCaptureKit".to_string())?;

    // Configure for audio capture with minimal video (can't fully disable video)
    let config = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_sample_rate(48000)
        .with_channel_count(2);

    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();

    // Lock-free ring buffer shared between SCKit callback and processing thread
    let rb = HeapRb::<f32>::new(FFT_SIZE * 8);
    let (producer, mut consumer) = rb.split();
    let producer = Arc::new(std::sync::Mutex::new(producer));
    let producer_clone = producer.clone();

    let logged = Arc::new(AtomicBool::new(false));
    let logged_clone = logged.clone();

    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(
        move |sample: CMSampleBuffer, of_type: SCStreamOutputType| {
            if of_type != SCStreamOutputType::Audio {
                return;
            }

            if let Some(audio_buffers) = sample.audio_buffer_list() {
                for buffer in &audio_buffers {
                    let raw_bytes = buffer.data();
                    // SAFETY: SCKit delivers audio as 32-bit float PCM; the buffer lives for the
                    // duration of this closure, and we only read from it.
                    #[allow(unsafe_code)]
                    let samples: &[f32] = unsafe {
                        std::slice::from_raw_parts(
                            raw_bytes.as_ptr() as *const f32,
                            raw_bytes.len() / std::mem::size_of::<f32>(),
                        )
                    };

                    // Log once to confirm audio is flowing
                    if !logged_clone.swap(true, Ordering::Relaxed) {
                        let max_raw = samples.iter().cloned().fold(0.0f32, |a, b| a.max(b.abs()));
                        safe_eprintln!(
                            "[audio] First SCKit audio callback: {} samples, max={:.6}",
                            samples.len(),
                            max_raw
                        );
                    }

                    if let Ok(mut prod) = producer_clone.lock() {
                        // Mix stereo to mono
                        for chunk in samples.chunks(2) {
                            let mono = chunk.iter().sum::<f32>() / chunk.len() as f32;
                            let _ = prod.try_push(mono);
                        }
                    }
                }
            }
        },
        SCStreamOutputType::Audio,
    );

    stream
        .start_capture()
        .map_err(|e| format!("Failed to start capture: {:?}", e))?;

    safe_eprintln!("[audio] ScreenCaptureKit stream started — entering processing loop");

    // Processing loop: read from ring buffer, FFT, emit
    let mut samples_buf = vec![0.0f32; FFT_SIZE];
    let mut accumulated = 0usize;
    let mut debug_counter = 0u64;

    while active.load(Ordering::Relaxed) {
        let frame_start = Instant::now();

        while accumulated < FFT_SIZE {
            match consumer.try_pop() {
                Some(sample) => {
                    samples_buf[accumulated] = sample;
                    accumulated += 1;
                }
                None => break,
            }
        }

        debug_counter += 1;
        if debug_counter % 60 == 0 {
            let max_sample = samples_buf
                .iter()
                .cloned()
                .fold(0.0f32, |a, b| a.max(b.abs()));
            safe_eprintln!(
                "[audio] Debug: accumulated={}/{}, max_sample={:.6}",
                accumulated,
                FFT_SIZE,
                max_sample
            );
        }

        if accumulated >= FFT_SIZE {
            // Compute RMS volume of the raw samples (before windowing)
            let rms = (samples_buf.iter().map(|s| s * s).sum::<f32>() / FFT_SIZE as f32).sqrt();
            // Map RMS to a 0-1 volume scale (RMS of ~0.3 = full volume)
            let volume = (rms / 0.3).min(1.0);

            let windowed: Vec<f32> = samples_buf
                .iter()
                .enumerate()
                .map(|(i, &s)| {
                    let w = 0.5
                        * (1.0
                            - (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE as f32 - 1.0))
                                .cos());
                    s * w
                })
                .collect();

            if let Ok(spectrum) = samples_fft_to_spectrum(
                &windowed,
                48000,
                FrequencyLimit::Range(20.0, 20000.0),
                Some(&divide_by_N_sqrt),
            ) {
                // Mix 70% frequency shape + 30% volume scaling
                let vol_scale = 0.7 + 0.3 * volume;
                let bands: Vec<f32> = map_to_log_bands(spectrum.data(), NUM_BANDS)
                    .into_iter()
                    .map(|b| b * vol_scale)
                    .collect();
                let peak = bands.iter().cloned().fold(0.0f32, f32::max);

                let bass = if bands.len() >= 8 {
                    bands[..8].iter().sum::<f32>() / 8.0
                } else {
                    0.0
                };
                let mid = if bands.len() >= 32 {
                    bands[8..32].iter().sum::<f32>() / 24.0
                } else {
                    0.0
                };
                let treble = if bands.len() >= NUM_BANDS {
                    bands[32..].iter().sum::<f32>() / 32.0
                } else {
                    0.0
                };

                let data = SpectrumData {
                    bands,
                    peak,
                    bass,
                    mid,
                    treble,
                };

                let _ = app.emit("party-mode-spectrum", &data);
            }

            accumulated = 0;
        }

        let elapsed = frame_start.elapsed();
        if elapsed < FRAME_DURATION {
            std::thread::sleep(FRAME_DURATION - elapsed);
        }
    }

    stream
        .stop_capture()
        .map_err(|e| format!("Failed to stop capture: {:?}", e))?;
    safe_eprintln!("[audio] ScreenCaptureKit stream stopped");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn run_capture(active: Arc<AtomicBool>, _app: AppHandle) -> Result<(), String> {
    safe_eprintln!("[audio] System audio capture not yet implemented for this platform");
    active.store(false, Ordering::Relaxed);
    Err("System audio capture is only supported on macOS currently".into())
}

/// Map raw FFT frequency bins to logarithmically-spaced bands
fn map_to_log_bands(
    data: &[(
        spectrum_analyzer::Frequency,
        spectrum_analyzer::FrequencyValue,
    )],
    num_bands: usize,
) -> Vec<f32> {
    if data.is_empty() {
        return vec![0.0; num_bands];
    }

    let f_min = 20.0f32;
    let f_max = 20000.0f32;
    let log_min = f_min.ln();
    let log_max = f_max.ln();

    let mut bands = vec![0.0f32; num_bands];
    let mut counts = vec![0usize; num_bands];

    for &(freq, val) in data {
        let f = freq.val();
        if f < f_min || f > f_max {
            continue;
        }
        let log_f = f.ln();
        let band_idx = ((log_f - log_min) / (log_max - log_min) * num_bands as f32) as usize;
        let band_idx = band_idx.min(num_bands - 1);
        bands[band_idx] += val.val();
        counts[band_idx] += 1;
    }

    for i in 0..num_bands {
        if counts[i] > 0 {
            bands[i] /= counts[i] as f32;
        }
    }

    let max_val = bands.iter().cloned().fold(0.0f32, f32::max);
    if max_val > 0.0 {
        for b in &mut bands {
            *b /= max_val;
        }
    }

    bands
}
