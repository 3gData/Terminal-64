//! Silero VAD runner for command endpointing.
//!
//! Silero-VAD ONNX takes 16 kHz mono audio in 512-sample chunks (32 ms).
//! The unified state tensor `[2, 1, 128]` (h and c stacked) is carried across
//! calls for streaming decisions.

use std::path::{Path, PathBuf};

use ndarray::{Array1, Array2, Array3};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

pub const CHUNK_SIZE_16K: usize = 512;
// Silero v5: state is [2, 1, 128] — two LSTM layers, 128 hidden units.
pub const STATE_SHAPE: [usize; 3] = [2, 1, 128];
pub const STATE_LEN: usize = 2 * 128;

pub struct VadDetector {
    session: Session,
    #[allow(dead_code)]
    path: PathBuf,
    state: Vec<f32>,
    last_confidence: f32,
    input_name: String,
    state_name: String,
    sr_name: String,
    prob_out_name: String,
    state_out_name: String,
}

impl VadDetector {
    pub fn load(path: &Path) -> Result<Self, String> {
        let session = Session::builder()
            .map_err(|e| format!("ort builder: {e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("ort opt level: {e}"))?
            .commit_from_file(path)
            .map_err(|e| format!("ort load {}: {e}", path.display()))?;

        // Resolve names defensively — Silero v4 had separate h/c; v5 merged them.
        let inputs: Vec<String> = session
            .inputs()
            .iter()
            .map(|i| i.name().to_string())
            .collect();
        let outputs: Vec<String> = session
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .collect();
        let input_name = inputs
            .iter()
            .find(|n| n.as_str() == "input")
            .cloned()
            .unwrap_or_else(|| inputs.first().cloned().unwrap_or_default());
        let state_name = inputs
            .iter()
            .find(|n| n.as_str() == "state")
            .cloned()
            .unwrap_or_else(|| inputs.get(1).cloned().unwrap_or_default());
        let sr_name = inputs
            .iter()
            .find(|n| n.as_str() == "sr")
            .cloned()
            .unwrap_or_else(|| inputs.get(2).cloned().unwrap_or_default());
        let prob_out_name = outputs
            .iter()
            .find(|n| n.as_str() == "output")
            .cloned()
            .unwrap_or_else(|| outputs.first().cloned().unwrap_or_default());
        let state_out_name = outputs
            .iter()
            .find(|n| n.as_str() == "stateN")
            .cloned()
            .unwrap_or_else(|| outputs.get(1).cloned().unwrap_or_default());

        safe_eprintln!(
            "[voice/vad] loaded {} ; inputs={:?} outputs={:?}",
            path.display(),
            inputs,
            outputs
        );

        Ok(Self {
            session,
            path: path.to_path_buf(),
            state: vec![0.0; STATE_LEN],
            last_confidence: 0.0,
            input_name,
            state_name,
            sr_name,
            prob_out_name,
            state_out_name,
        })
    }

    pub fn reset(&mut self) {
        for v in self.state.iter_mut() {
            *v = 0.0;
        }
        self.last_confidence = 0.0;
    }

    #[allow(dead_code)]
    pub fn last_confidence(&self) -> f32 {
        self.last_confidence
    }

    pub fn is_speech(&mut self, chunk: &[f32], sample_rate: u32) -> (bool, f32) {
        if sample_rate != 16_000 || chunk.len() != CHUNK_SIZE_16K {
            return (false, 0.0);
        }

        let input_arr = Array2::from_shape_vec((1, CHUNK_SIZE_16K), chunk.to_vec());
        let Ok(input_arr) = input_arr else {
            return (false, 0.0);
        };
        let state_arr = Array3::from_shape_vec(STATE_SHAPE, self.state.clone());
        let Ok(state_arr) = state_arr else {
            return (false, 0.0);
        };
        let sr_arr = Array1::from_vec(vec![16_000i64]);

        let input_t = match Tensor::from_array(input_arr) {
            Ok(t) => t,
            Err(_) => return (false, 0.0),
        };
        let state_t = match Tensor::from_array(state_arr) {
            Ok(t) => t,
            Err(_) => return (false, 0.0),
        };
        let sr_t = match Tensor::from_array(sr_arr) {
            Ok(t) => t,
            Err(_) => return (false, 0.0),
        };

        let outputs = self.session.run(ort::inputs![
            self.input_name.as_str() => input_t,
            self.state_name.as_str() => state_t,
            self.sr_name.as_str() => sr_t,
        ]);
        let outputs = match outputs {
            Ok(o) => o,
            Err(e) => {
                safe_eprintln!("[voice/vad] run failed: {}", e);
                return (false, 0.0);
            }
        };

        let prob = match outputs[self.prob_out_name.as_str()].try_extract_tensor::<f32>() {
            Ok((_, data)) => data.first().copied().unwrap_or(0.0),
            Err(e) => {
                safe_eprintln!("[voice/vad] extract prob failed: {}", e);
                return (false, 0.0);
            }
        };

        if let Ok((shape, data)) = outputs[self.state_out_name.as_str()].try_extract_tensor::<f32>()
        {
            let n = shape.iter().map(|d| *d as usize).product::<usize>();
            if n == STATE_LEN && data.len() == STATE_LEN {
                self.state.copy_from_slice(data);
            }
        }

        self.last_confidence = prob;
        (prob >= 0.5, prob)
    }
}
