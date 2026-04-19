//! Moonshine-base ASR for the post-wake command window.
//!
//! **Deprecated (2026-04-18).** Superseded by
//! [`crate::voice::command_stt::CommandSttRunner`], which runs the existing
//! whisper.cpp context under a GBNF grammar / snap-to-canonical pipeline.
//! The ONNX-based Moonshine path shipped through several false-positive and
//! command-leakage incidents (see research §4); we keep the module in-tree
//! for one release as a rollback option but it is no longer wired into
//! `adapters.rs`.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use ndarray::{Array1, Array2, Array3, Array4};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use tokenizers::tokenizer::Tokenizer;

pub const MAX_COMMAND_SAMPLES: usize = 16_000 * 3;
const BOS_ID: i64 = 1;
const EOS_ID: i64 = 2;
const MAX_DECODE_STEPS: usize = 96;
const HIDDEN_DIM: usize = 416;
const NUM_LAYERS: usize = 8;
const NUM_HEADS: usize = 8;
const HEAD_DIM: usize = 52;

pub struct MoonshineRunner {
    encoder: Session,
    decoder: Session,
    #[allow(dead_code)]
    tokenizer_path: PathBuf,
    tokenizer: Tokenizer,

    enc_in: String,
    enc_out: String,
    dec_input_ids: String,
    dec_enc_hidden: String,
    dec_use_cache: String,
    dec_logits_out: String,
    // Captured layer-wise past_key_values input names (encoder + decoder KV).
    dec_past_names: Vec<String>,
}

impl MoonshineRunner {
    pub fn load(
        encoder_path: &Path,
        decoder_path: &Path,
        tokenizer_json_path: &Path,
    ) -> Result<Self, String> {
        let encoder = build_session(encoder_path)?;
        let decoder = build_session(decoder_path)?;
        let tokenizer = Tokenizer::from_file(tokenizer_json_path)
            .map_err(|e| format!("tokenizer load {}: {e}", tokenizer_json_path.display()))?;

        let enc_in = encoder
            .inputs()
            .iter()
            .find(|i| i.name() == "input_values")
            .map(|o| o.name().to_string())
            .unwrap_or_else(|| {
                encoder
                    .inputs()
                    .first()
                    .map(|o| o.name().to_string())
                    .unwrap_or_default()
            });
        let enc_out = encoder
            .outputs()
            .iter()
            .find(|o| o.name() == "last_hidden_state")
            .map(|o| o.name().to_string())
            .unwrap_or_else(|| {
                encoder
                    .outputs()
                    .first()
                    .map(|o| o.name().to_string())
                    .unwrap_or_default()
            });

        let dec_input_ids = "input_ids".to_string();
        let dec_enc_hidden = "encoder_hidden_states".to_string();
        let dec_use_cache = "use_cache_branch".to_string();
        let dec_logits_out = "logits".to_string();

        let dec_past_names: Vec<String> = decoder
            .inputs()
            .iter()
            .map(|i| i.name().to_string())
            .filter(|n| n.starts_with("past_key_values."))
            .collect();

        safe_eprintln!(
            "[voice/moonshine] loaded enc={} dec={} tok={} | enc_in={} enc_out={} past={}",
            encoder_path.display(),
            decoder_path.display(),
            tokenizer_json_path.display(),
            enc_in,
            enc_out,
            dec_past_names.len()
        );

        Ok(Self {
            encoder,
            decoder,
            tokenizer_path: tokenizer_json_path.to_path_buf(),
            tokenizer,
            enc_in,
            enc_out,
            dec_input_ids,
            dec_enc_hidden,
            dec_use_cache,
            dec_logits_out,
            dec_past_names,
        })
    }

    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String, String> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        let n = samples.len().min(MAX_COMMAND_SAMPLES);
        let clipped = &samples[..n];

        // Encoder forward.
        let enc_arr = Array2::from_shape_vec((1, n), clipped.to_vec())
            .map_err(|e| format!("enc reshape: {e}"))?;
        let enc_t = Tensor::from_array(enc_arr).map_err(|e| format!("enc tensor: {e}"))?;
        let enc_out_name = self.enc_out.clone();
        let (enc_shape_vec, encoder_hidden): (Vec<i64>, Vec<f32>) = {
            let enc_out = self
                .encoder
                .run(ort::inputs![self.enc_in.as_str() => enc_t])
                .map_err(|e| format!("enc run: {e}"))?;
            let (shape, data) = enc_out[enc_out_name.as_str()]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("enc extract: {e}"))?;
            (shape.iter().copied().collect(), data.to_vec())
        };
        if enc_shape_vec.len() < 3 {
            return Err(format!(
                "encoder output rank {} unexpected",
                enc_shape_vec.len()
            ));
        }
        let enc_seq = enc_shape_vec[1] as usize;
        let enc_hidden_dim = enc_shape_vec[2] as usize;
        if enc_hidden_dim != HIDDEN_DIM {
            safe_eprintln!(
                "[voice/moonshine] warning: encoder hidden dim {} != expected {}",
                enc_hidden_dim,
                HIDDEN_DIM
            );
        }

        // Greedy decode: non-cached path — we feed `use_cache_branch=false`
        // plus zero past_key_values each step. This re-decodes from BOS every
        // iteration; OK for ≤3s audio per the plan's trade-off guidance.
        let mut tokens: Vec<i64> = vec![BOS_ID];
        for _ in 0..MAX_DECODE_STEPS {
            let ids_arr = Array2::from_shape_vec((1, tokens.len()), tokens.clone())
                .map_err(|e| format!("ids reshape: {e}"))?;
            let ids_t = Tensor::from_array(ids_arr).map_err(|e| format!("ids tensor: {e}"))?;

            let hidden_arr =
                Array3::from_shape_vec((1, enc_seq, enc_hidden_dim), encoder_hidden.clone())
                    .map_err(|e| format!("hidden reshape: {e}"))?;
            let hidden_t =
                Tensor::from_array(hidden_arr).map_err(|e| format!("hidden tensor: {e}"))?;

            let use_cache_arr = Array1::from_vec(vec![false]);
            let use_cache_t =
                Tensor::from_array(use_cache_arr).map_err(|e| format!("use_cache tensor: {e}"))?;

            let mut inputs: Vec<(
                std::borrow::Cow<'_, str>,
                ort::session::SessionInputValue<'_>,
            )> = Vec::new();
            inputs.push((
                std::borrow::Cow::from(self.dec_input_ids.as_str()),
                ort::session::SessionInputValue::from(ids_t),
            ));
            inputs.push((
                std::borrow::Cow::from(self.dec_enc_hidden.as_str()),
                ort::session::SessionInputValue::from(hidden_t),
            ));
            inputs.push((
                std::borrow::Cow::from(self.dec_use_cache.as_str()),
                ort::session::SessionInputValue::from(use_cache_t),
            ));

            // Fill every past_key_values.* with a zero tensor. Encoder-KV
            // entries live on the encoder seq axis; decoder-KV entries start
            // at sequence length zero.
            for name in self.dec_past_names.clone().iter() {
                let is_encoder = name.contains(".encoder.");
                let seq_len = if is_encoder { enc_seq } else { 0 };
                let shape = (1usize, NUM_HEADS, seq_len, HEAD_DIM);
                let zeros = vec![0.0f32; shape.0 * shape.1 * shape.2 * shape.3];
                let arr = Array4::from_shape_vec(shape, zeros)
                    .map_err(|e| format!("past reshape {name}: {e}"))?;
                let t = Tensor::from_array(arr).map_err(|e| format!("past tensor {name}: {e}"))?;
                inputs.push((
                    std::borrow::Cow::from(name.clone()),
                    ort::session::SessionInputValue::from(t),
                ));
            }

            let outs = self
                .decoder
                .run(inputs)
                .map_err(|e| format!("dec run: {e}"))?;
            let (logits_shape, logits_data) = outs[self.dec_logits_out.as_str()]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("logits extract: {e}"))?;
            if logits_shape.len() != 3 {
                return Err(format!("logits rank {} unexpected", logits_shape.len()));
            }
            let seq = logits_shape[1] as usize;
            let vocab = logits_shape[2] as usize;
            if seq == 0 || vocab == 0 {
                break;
            }
            let last_offset = (seq - 1) * vocab;
            let last = &logits_data[last_offset..last_offset + vocab];
            let mut best_id: usize = 0;
            let mut best_val: f32 = f32::NEG_INFINITY;
            for (i, v) in last.iter().enumerate() {
                if *v > best_val {
                    best_val = *v;
                    best_id = i;
                }
            }
            let next = best_id as i64;
            if next == EOS_ID {
                break;
            }
            tokens.push(next);
        }

        // Strip BOS, stop before EOS (already not appended).
        let ids_u32: Vec<u32> = tokens
            .iter()
            .skip(1)
            .filter(|t| **t != EOS_ID && **t >= 0)
            .map(|t| *t as u32)
            .collect();
        let text = self
            .tokenizer
            .decode(&ids_u32, true)
            .map_err(|e| format!("tokenizer decode: {e}"))?;
        Ok(text.trim().to_string())
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
