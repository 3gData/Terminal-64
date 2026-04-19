//! openWakeWord runner (melspec → embedding → classifier).
//!
//! Pipeline:
//!   1. melspectrogram.onnx: [1, N samples] → [frames, 1, 1, 32] log-mel features.
//!      openWakeWord scales mel features as `mel / 10 + 2` before downstream use.
//!   2. embedding_model.onnx: [1, 76, 32, 1] → [1, 1, 1, 96] dense embedding.
//!   3. jarvis.onnx classifier: [1, 16, 96] → [1, 1] scalar score in 0..1.
//!
//! Public API:
//!   - `WakeDetector::load(mel, embedding, classifier) -> Result<Self>`
//!   - `detect(&mut self, chunk: &[f32; 1280]) -> Option<f32>`
//!   - `set_threshold(&mut self, f32)`
//!   - `reset(&mut self)`

use std::path::{Path, PathBuf};

use ndarray::{Array2, Array3, Array4};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

/// Default primary-network score threshold. openWakeWord's upstream default
/// is 0.5; we set it lower because the `hey_jarvis` model scores conservatively
/// (a clean hit often sits 0.35–0.6). 0.30 catches most natural tempo/pitch
/// variations without flooding false positives when combined with the
/// 3-frame consensus smoother below.
pub const DEFAULT_THRESHOLD: f32 = 0.30;
/// Rolling window (80 ms frames) over which we keep recent classifier
/// scores. A wake word takes ~0.8 s to say, so 3 frames = 240 ms catches
/// the peak region without letting single-frame noise spikes trigger.
pub const SCORE_WINDOW: usize = 3;

/// openWakeWord hop length in 16 kHz samples (80 ms).
pub const AUDIO_HOP: usize = 1280;

pub const EMBEDDING_WINDOW: usize = 76;
pub const CLASSIFIER_WINDOW: usize = 16;

pub struct WakeDetector {
    mel: Session,
    embedding: Session,
    classifier: Session,
    #[allow(dead_code)]
    paths: [PathBuf; 3],

    mel_in: String,
    mel_out: String,
    emb_in: String,
    emb_out: String,
    cls_in: String,
    cls_out: String,

    mel_buffer: Vec<Vec<f32>>,
    embedding_buffer: Vec<Vec<f32>>,
    frames_since_last_embedding: usize,
    threshold: f32,
    cooldown: u32,
    /// Ring of the last `SCORE_WINDOW` classifier scores. Detection fires
    /// when either (a) the latest score crosses `threshold` (catches a
    /// clean hit) OR (b) the window mean crosses `threshold * 0.85`
    /// (catches slower/softer "heyyy jarvissss" deliveries whose per-frame
    /// peaks are borderline but whose sustained score is still strong).
    recent_scores: [f32; SCORE_WINDOW],
    score_idx: usize,
}

impl WakeDetector {
    pub fn load(
        melspec_path: &Path,
        embedding_path: &Path,
        classifier_path: &Path,
    ) -> Result<Self, String> {
        let mel = build_session(melspec_path)?;
        let embedding = build_session(embedding_path)?;
        let classifier = build_session(classifier_path)?;

        let mel_in = first_input(&mel);
        let mel_out = first_output(&mel);
        let emb_in = first_input(&embedding);
        let emb_out = first_output(&embedding);
        let cls_in = first_input(&classifier);
        let cls_out = first_output(&classifier);

        safe_eprintln!(
            "[voice/wake] loaded {} / {} / {} | mel {}→{} emb {}→{} cls {}→{}",
            melspec_path.display(),
            embedding_path.display(),
            classifier_path.display(),
            mel_in,
            mel_out,
            emb_in,
            emb_out,
            cls_in,
            cls_out
        );

        Ok(Self {
            mel,
            embedding,
            classifier,
            paths: [
                melspec_path.to_path_buf(),
                embedding_path.to_path_buf(),
                classifier_path.to_path_buf(),
            ],
            mel_in,
            mel_out,
            emb_in,
            emb_out,
            cls_in,
            cls_out,
            mel_buffer: Vec::with_capacity(EMBEDDING_WINDOW * 2),
            embedding_buffer: Vec::with_capacity(CLASSIFIER_WINDOW * 2),
            frames_since_last_embedding: 0,
            threshold: DEFAULT_THRESHOLD,
            cooldown: 0,
            recent_scores: [0.0; SCORE_WINDOW],
            score_idx: 0,
        })
    }

    pub fn set_threshold(&mut self, t: f32) {
        self.threshold = t.clamp(0.0, 1.0);
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    pub fn detect(&mut self, chunk: &[f32]) -> Option<f32> {
        if chunk.len() != AUDIO_HOP {
            safe_eprintln!(
                "[voice/wake] expected {}-sample chunks, got {}",
                AUDIO_HOP,
                chunk.len()
            );
            return None;
        }
        if self.cooldown > 0 {
            self.cooldown -= 1;
            return None;
        }

        // Stage 1: melspec. Input [1, 1280] f32 → output [frames, 1, 1, 32].
        let bins_per_frame = 32usize;
        let mel_frames: Vec<Vec<f32>> = {
            let arr_in = match Array2::from_shape_vec((1, AUDIO_HOP), chunk.to_vec()) {
                Ok(a) => a,
                Err(_) => return None,
            };
            let t_in = match Tensor::from_array(arr_in) {
                Ok(t) => t,
                Err(e) => {
                    safe_eprintln!("[voice/wake] mel tensor: {}", e);
                    return None;
                }
            };
            let mel_outputs = match self.mel.run(ort::inputs![self.mel_in.as_str() => t_in]) {
                Ok(o) => o,
                Err(e) => {
                    safe_eprintln!("[voice/wake] mel run: {}", e);
                    return None;
                }
            };
            let (shape, data) =
                match mel_outputs[self.mel_out.as_str()].try_extract_tensor::<f32>() {
                    Ok(v) => v,
                    Err(e) => {
                        safe_eprintln!("[voice/wake] mel extract: {}", e);
                        return None;
                    }
                };
            let total = data.len();
            if total == 0 || total % bins_per_frame != 0 {
                safe_eprintln!(
                    "[voice/wake] unexpected mel output len {} (shape {:?})",
                    total,
                    shape.iter().collect::<Vec<_>>()
                );
                return None;
            }
            let n_frames = total / bins_per_frame;
            let mut frames = Vec::with_capacity(n_frames);
            for f in 0..n_frames {
                let slice = &data[f * bins_per_frame..(f + 1) * bins_per_frame];
                // openWakeWord feature scaling.
                let scaled: Vec<f32> = slice.iter().map(|v| v / 10.0 + 2.0).collect();
                frames.push(scaled);
            }
            frames
        };
        for frame in mel_frames {
            self.mel_buffer.push(frame);
            self.frames_since_last_embedding += 1;
        }
        // Cap buffer so it doesn't grow unbounded during long idle listening.
        let max_mel_keep = EMBEDDING_WINDOW + 32;
        if self.mel_buffer.len() > max_mel_keep {
            let drop = self.mel_buffer.len() - max_mel_keep;
            self.mel_buffer.drain(0..drop);
        }

        // Stage 2: embedding. openWakeWord hops 8 mel frames per embedding step.
        const EMBED_HOP: usize = 8;
        while self.mel_buffer.len() >= EMBEDDING_WINDOW
            && self.frames_since_last_embedding >= EMBED_HOP
        {
            let vec96: Vec<f32> = {
                let start = self.mel_buffer.len() - EMBEDDING_WINDOW;
                let window = &self.mel_buffer[start..];
                let mut flat: Vec<f32> = Vec::with_capacity(EMBEDDING_WINDOW * bins_per_frame);
                for frame in window {
                    flat.extend_from_slice(frame);
                }
                let emb_in_arr =
                    match Array4::from_shape_vec((1, EMBEDDING_WINDOW, bins_per_frame, 1), flat) {
                        Ok(a) => a,
                        Err(_) => break,
                    };
                let emb_t = match Tensor::from_array(emb_in_arr) {
                    Ok(t) => t,
                    Err(e) => {
                        safe_eprintln!("[voice/wake] emb tensor: {}", e);
                        break;
                    }
                };
                let emb_out = match self
                    .embedding
                    .run(ort::inputs![self.emb_in.as_str() => emb_t])
                {
                    Ok(o) => o,
                    Err(e) => {
                        safe_eprintln!("[voice/wake] emb run: {}", e);
                        break;
                    }
                };
                let (_s, edata) = match emb_out[self.emb_out.as_str()].try_extract_tensor::<f32>()
                {
                    Ok(v) => v,
                    Err(e) => {
                        safe_eprintln!("[voice/wake] emb extract: {}", e);
                        break;
                    }
                };
                if edata.len() < 96 {
                    break;
                }
                edata[..96].to_vec()
            };
            self.embedding_buffer.push(vec96);
            self.frames_since_last_embedding -= EMBED_HOP;
            if self.embedding_buffer.len() > CLASSIFIER_WINDOW * 2 {
                let drop = self.embedding_buffer.len() - CLASSIFIER_WINDOW * 2;
                self.embedding_buffer.drain(0..drop);
            }
        }

        if self.embedding_buffer.len() < CLASSIFIER_WINDOW {
            return None;
        }

        // Stage 3: classifier. Trailing 16 embeddings → [1, 16, 96] f32.
        let score: f32 = {
            let start = self.embedding_buffer.len() - CLASSIFIER_WINDOW;
            let mut flat: Vec<f32> = Vec::with_capacity(CLASSIFIER_WINDOW * 96);
            for e in &self.embedding_buffer[start..] {
                flat.extend_from_slice(e);
            }
            let cls_arr = match Array3::from_shape_vec((1, CLASSIFIER_WINDOW, 96), flat) {
                Ok(a) => a,
                Err(_) => return None,
            };
            let cls_t = match Tensor::from_array(cls_arr) {
                Ok(t) => t,
                Err(e) => {
                    safe_eprintln!("[voice/wake] cls tensor: {}", e);
                    return None;
                }
            };
            let cls_out = match self
                .classifier
                .run(ort::inputs![self.cls_in.as_str() => cls_t])
            {
                Ok(o) => o,
                Err(e) => {
                    safe_eprintln!("[voice/wake] cls run: {}", e);
                    return None;
                }
            };
            match cls_out[self.cls_out.as_str()].try_extract_tensor::<f32>() {
                Ok((_, d)) => d.first().copied().unwrap_or(0.0),
                Err(e) => {
                    safe_eprintln!("[voice/wake] cls extract: {}", e);
                    return None;
                }
            }
        };

        // Push score into the rolling window (FIFO via modular index).
        self.recent_scores[self.score_idx] = score;
        self.score_idx = (self.score_idx + 1) % SCORE_WINDOW;
        let window_mean: f32 =
            self.recent_scores.iter().sum::<f32>() / SCORE_WINDOW as f32;
        // Dual trigger: clean spike OR sustained-but-quiet hit.
        let fire = score > self.threshold || window_mean > self.threshold * 0.85;
        if fire {
            safe_eprintln!(
                "[voice/wake] fire score={:.3} mean={:.3} thr={:.3}",
                score,
                window_mean,
                self.threshold
            );
            self.reset();
            Some(score)
        } else {
            None
        }
    }

    pub fn reset(&mut self) {
        self.mel_buffer.clear();
        self.embedding_buffer.clear();
        self.frames_since_last_embedding = 0;
        self.recent_scores = [0.0; SCORE_WINDOW];
        self.score_idx = 0;
        // 400 ms post-fire suppression (was 960 ms). Long cooldowns mean a
        // user re-saying "Jarvis" right after a mis-fire has to wait — with
        // the consensus smoother we can afford a shorter gap because spurious
        // repeats are already filtered at the score layer.
        self.cooldown = 5;
    }
}

fn build_session(path: &Path) -> Result<Session, String> {
    Session::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| format!("ort opt level: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("ort load {}: {e}", path.display()))
}

fn first_input(s: &Session) -> String {
    s.inputs()
        .first()
        .map(|o| o.name().to_string())
        .unwrap_or_default()
}

fn first_output(s: &Session) -> String {
    s.outputs()
        .first()
        .map(|o| o.name().to_string())
        .unwrap_or_default()
}
