//! Voice model registry + lazy download.
//!
//! Models live under `~/.terminal64/stt-models/{kind}/{name}/`. Downloads are
//! idempotent: existing files with matching SHA-256 are reused. Progress is
//! streamed to the frontend via the `voice-model-progress` event, matching
//! the contract published in team chat.
//!
//! Path safety: every file path under `base/{kind}/{name}/` is built by
//! iterating `components()` and rejecting `ParentDir`/`RootDir`/`Prefix`
//! (see cerebrum.md 2026-04-16 entry on `starts_with` being lexical).

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelKind {
    Wake,
    Vad,
    Moonshine,
    Whisper,
}

impl ModelKind {
    pub fn dir_name(self) -> &'static str {
        match self {
            ModelKind::Wake => "wake",
            ModelKind::Vad => "vad",
            ModelKind::Moonshine => "moonshine",
            ModelKind::Whisper => "whisper",
        }
    }

    #[allow(dead_code)]
    pub fn all() -> &'static [ModelKind] {
        &[
            ModelKind::Wake,
            ModelKind::Vad,
            ModelKind::Moonshine,
            ModelKind::Whisper,
        ]
    }
}

/// Individual file within a model bundle.
#[derive(Debug, Clone)]
pub struct ModelFile {
    /// Relative file name (no slashes, no `..`).
    pub name: &'static str,
    pub url: &'static str,
    /// Expected sha256 hex. Empty string disables the check (useful pre-release).
    pub sha256: &'static str,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub kind: ModelKind,
    pub name: &'static str,
    pub files: &'static [ModelFile],
    #[allow(dead_code)]
    pub total_bytes: u64,
}

/// Public snapshot handed to the frontend (via orchestrator command).
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStatus {
    pub kind: ModelKind,
    pub name: String,
    pub total_bytes: u64,
    pub downloaded: bool,
    pub path: Option<String>,
}

/// Static registry. URLs are hosted on HuggingFace CDNs — caller is expected
/// to route through the allow-listed `proxy_fetch` path or plain reqwest.
/// SHA256 hashes are `""` placeholders; fill in when models are pinned.
pub fn registry() -> &'static [ModelInfo] {
    static REG: &[ModelInfo] = &[
        ModelInfo {
            kind: ModelKind::Wake,
            name: "jarvis",
            files: &[
                ModelFile {
                    name: "jarvis.onnx",
                    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/hey_jarvis_v0.1.onnx",
                    sha256: "",
                    bytes: 2_100_000,
                },
                ModelFile {
                    name: "melspectrogram.onnx",
                    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx",
                    sha256: "",
                    bytes: 700_000,
                },
                ModelFile {
                    name: "embedding_model.onnx",
                    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
                    sha256: "",
                    bytes: 2_500_000,
                },
            ],
            total_bytes: 5_300_000,
        },
        // Custom "T Six Four" wake model. Classifier head is user-trained via
        // Colab (see docs/wake-training.md); the mel + embedding models are
        // shared with the stock "jarvis" bundle since openWakeWord freezes
        // those. The t_six_four.onnx file has no auto-download URL — users
        // drop it into ~/.terminal64/stt-models/wake/t64/ themselves.
        ModelInfo {
            kind: ModelKind::Wake,
            name: "t64",
            files: &[
                ModelFile {
                    name: "t_six_four.onnx",
                    url: "",
                    sha256: "",
                    bytes: 2_100_000,
                },
                ModelFile {
                    name: "melspectrogram.onnx",
                    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx",
                    sha256: "",
                    bytes: 700_000,
                },
                ModelFile {
                    name: "embedding_model.onnx",
                    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
                    sha256: "",
                    bytes: 2_500_000,
                },
            ],
            total_bytes: 5_300_000,
        },
        ModelInfo {
            kind: ModelKind::Vad,
            name: "silero",
            files: &[ModelFile {
                name: "silero_vad.onnx",
                url: "https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx",
                sha256: "",
                bytes: 1_800_000,
            }],
            total_bytes: 1_800_000,
        },
        ModelInfo {
            kind: ModelKind::Moonshine,
            name: "base",
            files: &[
                ModelFile {
                    name: "encoder.onnx",
                    url: "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/encoder_model.onnx",
                    sha256: "",
                    bytes: 30_000_000,
                },
                ModelFile {
                    name: "decoder.onnx",
                    url: "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/decoder_model_merged.onnx",
                    sha256: "",
                    bytes: 30_000_000,
                },
                ModelFile {
                    name: "tokenizer.json",
                    url: "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/tokenizer.json",
                    sha256: "",
                    bytes: 1_200_000,
                },
            ],
            total_bytes: 61_200_000,
        },
        ModelInfo {
            kind: ModelKind::Whisper,
            name: "small.en-q5_1",
            files: &[ModelFile {
                name: "ggml-small.en-q5_1.bin",
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin",
                sha256: "",
                bytes: 186_000_000,
            }],
            total_bytes: 186_000_000,
        },
    ];
    REG
}

pub fn find(kind: ModelKind, name: &str) -> Option<&'static ModelInfo> {
    registry().iter().find(|m| m.kind == kind && m.name == name)
}

/// Base dir: `~/.terminal64/stt-models/`.
pub fn base_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "No home directory".to_string())?;
    Ok(home.join(".terminal64").join("stt-models"))
}

/// Directory for one model: `<base>/{kind}/{name}/`, with components() validation.
pub fn model_dir(kind: ModelKind, name: &str) -> Result<PathBuf, String> {
    let base = base_dir()?;
    let joined = base.join(kind.dir_name()).join(name);
    validate_under(&base, &joined)?;
    Ok(joined)
}

/// Reject `..`, root, drive-prefix, and UNC segments; ensure `child` stays under `base`.
fn validate_under(base: &Path, child: &Path) -> Result<(), String> {
    for comp in child.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir => {
                // Absolute components are OK only if they match `base`'s own prefix.
            }
            Component::ParentDir => {
                return Err("Path contains parent-directory segment".into());
            }
        }
    }
    // Resolve logically: base's own components are a strict prefix of child's.
    let base_comps: Vec<_> = base.components().collect();
    let child_comps: Vec<_> = child.components().collect();
    if child_comps.len() < base_comps.len()
        || base_comps
            .iter()
            .zip(child_comps.iter())
            .any(|(a, b)| a != b)
    {
        return Err(format!(
            "Path escapes base directory: {} not under {}",
            child.display(),
            base.display()
        ));
    }
    Ok(())
}

/// True if every file in the model bundle exists at a non-zero size.
pub fn is_downloaded(info: &ModelInfo) -> bool {
    let Ok(dir) = model_dir(info.kind, info.name) else {
        return false;
    };
    info.files.iter().all(|f| {
        let Ok(leaf) = safe_leaf(f.name) else {
            return false;
        };
        let p = dir.join(leaf);
        p.exists() && fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false)
    })
}

/// Build `dir/name` rejecting traversal in `name`.
fn safe_leaf(name: &str) -> Result<String, String> {
    let p = Path::new(name);
    for c in p.components() {
        match c {
            Component::Normal(_) => {}
            _ => return Err(format!("Unsafe file name: {name}")),
        }
    }
    Ok(name.to_string())
}

/// Ensure the model is on disk. If any file is missing, download all files
/// for the bundle and verify SHA-256 where provided. Emits `voice-model-progress`.
/// Safe to call many times; returns the model's directory on success.
pub async fn ensure(app: &AppHandle, kind: ModelKind, name: &str) -> Result<PathBuf, String> {
    let info = find(kind, name).ok_or_else(|| format!("Unknown model {:?}/{}", kind, name))?;
    let dir = model_dir(kind, name)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all({}): {e}", dir.display()))?;

    for f in info.files {
        let leaf = safe_leaf(f.name)?;
        let dest = dir.join(&leaf);
        validate_under(&dir, &dest)?;

        if dest.exists() {
            // If sha256 is specified, verify; otherwise accept existing files with
            // non-zero size.
            let ok = if f.sha256.is_empty() {
                fs::metadata(&dest).map(|m| m.len() > 0).unwrap_or(false)
            } else {
                verify_sha256(&dest, f.sha256).unwrap_or(false)
            };
            if ok {
                continue;
            }
            // Corrupt / wrong hash — re-download.
            let _ = fs::remove_file(&dest);
        }

        emit_progress(app, kind, name, 0, f.bytes, "downloading");
        match download_file(app, f, &dest, kind, name).await {
            Ok(()) => {
                emit_progress(app, kind, name, f.bytes, f.bytes, "done");
            }
            Err(e) => {
                let _ = fs::remove_file(&dest);
                emit_progress(app, kind, name, 0, f.bytes, "error");
                return Err(format!("download {}: {e}", f.name));
            }
        }
    }

    Ok(dir)
}

/// Map the internal 4-kind registry onto the 3-kind frontend surface
/// (`wake` | `command` | `dictation`). VAD is folded under `command` since
/// it's an implementation detail of the command-listening phase.
fn frontend_kind(kind: ModelKind) -> &'static str {
    match kind {
        ModelKind::Wake => "wake",
        ModelKind::Vad | ModelKind::Moonshine => "command",
        ModelKind::Whisper => "dictation",
    }
}

fn emit_progress(
    app: &AppHandle,
    kind: ModelKind,
    _name: &str,
    bytes: u64,
    total: u64,
    status: &str,
) {
    let progress = if total == 0 {
        0.0f32
    } else {
        (bytes as f32 / total as f32).clamp(0.0, 1.0)
    };
    // Frontend contract (Agent 3): voice-download-progress = { kind, progress }.
    let _ = app.emit(
        "voice-download-progress",
        serde_json::json!({
            "kind": frontend_kind(kind),
            "progress": progress,
        }),
    );
    // Emit a richer internal event for the orchestrator / logs.
    let _ = app.emit(
        "voice-download-progress-detail",
        serde_json::json!({
            "kind": frontend_kind(kind),
            "bytes": bytes,
            "total": total,
            "status": status,
        }),
    );
}

/// Streaming download with periodic progress events. Verifies SHA-256 after.
async fn download_file(
    app: &AppHandle,
    file: &ModelFile,
    dest: &Path,
    kind: ModelKind,
    name: &str,
) -> Result<(), String> {
    safe_eprintln!("[voice/models] fetching {} -> {}", file.url, dest.display());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(file.url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(file.bytes);

    let tmp = dest.with_extension("part");
    let mut out = fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit = 0u64;
    let mut stream = resp.bytes_stream();

    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        out.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
        if !file.sha256.is_empty() {
            hasher.update(&chunk);
        }
        downloaded += chunk.len() as u64;
        if downloaded - last_emit > 256 * 1024 {
            emit_progress(app, kind, name, downloaded, total, "downloading");
            last_emit = downloaded;
        }
    }
    out.flush().map_err(|e| format!("flush: {e}"))?;
    drop(out);

    if !file.sha256.is_empty() {
        let got = hex::encode(hasher.finalize());
        if got != file.sha256 {
            return Err(format!(
                "sha256 mismatch: expected {} got {}",
                file.sha256, got
            ));
        }
    }

    fs::rename(&tmp, dest).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

fn verify_sha256(path: &Path, expected_hex: &str) -> Result<bool, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let got = hex::encode(hasher.finalize());
    Ok(got == expected_hex)
}

/// Convenience used by orchestrator's `voice_status` / `voice_list_models`.
#[allow(dead_code)]
pub fn status_all() -> Vec<ModelStatus> {
    registry()
        .iter()
        .map(|m| {
            let path = model_dir(m.kind, m.name).ok();
            let downloaded = is_downloaded(m);
            ModelStatus {
                kind: m.kind,
                name: m.name.to_string(),
                total_bytes: m.total_bytes,
                downloaded,
                path: path.map(|p| p.display().to_string()),
            }
        })
        .collect()
}
