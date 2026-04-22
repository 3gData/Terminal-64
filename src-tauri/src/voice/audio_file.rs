//! Decode an arbitrary audio file (Discord voice notes are OGG Opus) into
//! 16 kHz mono f32 PCM suitable for whisper.cpp.
//!
//! Strategy:
//!   1. Shell out to `afconvert` (macOS built-in) or `ffmpeg` (if installed)
//!      to transcode to 16 kHz mono PCM WAV in a temp file.
//!   2. Read that WAV back via `symphonia`, collect samples as f32.
//!
//! No pure-Rust Opus decoder ships with symphonia, and pulling in
//! `libopus` via `audiopus` is a build-host headache. afconvert is on every
//! macOS install; ffmpeg is ubiquitous on Linux/Windows dev machines. This
//! keeps the dep surface light for the one feature that needs it.

use std::path::{Path, PathBuf};
use std::process::Command;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub const TARGET_RATE: u32 = 16_000;

/// Transcode `input` to 16 kHz mono PCM WAV. Returns the path to the WAV
/// file in a temp location that the caller is responsible for cleaning up.
fn transcode_to_wav(input: &Path) -> Result<PathBuf, String> {
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("voice");
    let out = std::env::temp_dir().join(format!("t64-voice-{}-{}.wav", stem, std::process::id()));

    // Try afconvert first on macOS: zero install, fast, reliable for Opus.
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/afconvert")
            .arg(input)
            .arg("-f")
            .arg("WAVE")
            .arg("-d")
            .arg("LEI16@16000")
            .arg("-c")
            .arg("1")
            .arg(&out)
            .status();
        if let Ok(s) = status {
            if s.success() {
                return Ok(out);
            }
        }
    }

    // Fallback / non-macOS: ffmpeg. Most dev machines have it; if not, the
    // caller surfaces the error and the user sees a helpful message.
    let ffmpeg_status = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(input)
        .args(["-ac", "1", "-ar", &TARGET_RATE.to_string(), "-f", "wav"])
        .arg(&out)
        .status();
    match ffmpeg_status {
        Ok(s) if s.success() => Ok(out),
        Ok(s) => Err(format!("ffmpeg exited with status {}", s)),
        Err(e) => Err(format!(
            "no audio transcoder available (afconvert/ffmpeg): {e}"
        )),
    }
}

/// Read a 16 kHz mono PCM WAV into a flat f32 vec.
fn read_wav_f32(path: &Path) -> Result<Vec<f32>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open wav: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let hint = Hint::new();
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe: {e}"))?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "no default track".to_string())?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("decoder: {e}"))?;
    let mut samples: Vec<f32> = Vec::new();
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => return Err(format!("next_packet: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                if buf.is_none() {
                    let spec = *decoded.spec();
                    buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
                }
                if let Some(b) = buf.as_mut() {
                    b.copy_interleaved_ref(decoded);
                    samples.extend_from_slice(b.samples());
                }
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(format!("decode: {e}")),
        }
    }
    Ok(samples)
}

/// Decode a Discord voice-note attachment to 16 kHz mono f32 samples.
pub fn load_as_16k_mono(input: &Path) -> Result<Vec<f32>, String> {
    let wav = transcode_to_wav(input)?;
    let samples = read_wav_f32(&wav);
    let _ = std::fs::remove_file(&wav);
    samples
}
