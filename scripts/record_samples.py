#!/usr/bin/env python3
"""Record real-voice wake-phrase samples with proper silence trimming.

Outputs (placed under ~/.cache/terminal64-wake-train/):
  positive/realvoice_NNNN.wav   — phrase recordings, trimmed
  ambient/ambient_NNNN.wav      — 2s chunks of room noise / non-target speech

The phrase clips are trimmed to just the speech + 150ms on each side so the
feature extractor doesn't learn "trailing silence = positive". Clips that
are too quiet (rms < 300) or too short (<300ms of speech) are rejected and
the user is asked to redo them.

Env vars:
  N_SAMPLES          — number of phrase samples to record (default 30)
  N_AMBIENT_CHUNKS   — 2s ambient chunks to record (default 30, ~60s total)
  PHRASE             — what to prompt for (default "T sixty four")
"""

from __future__ import annotations
import os, sys, time, wave
from pathlib import Path

import numpy as np
import sounddevice as sd

N_SAMPLES = int(os.environ.get("N_SAMPLES", "30"))
N_AMBIENT_CHUNKS = int(os.environ.get("N_AMBIENT_CHUNKS", "30"))
PHRASE = os.environ.get("PHRASE", "T sixty four")
ROOT = Path.home() / ".cache/terminal64-wake-train"
POS_DIR = ROOT / "positive"
AMB_DIR = ROOT / "ambient"
SAMPLE_RATE = 16000
RECORD_SECONDS = 2.5  # give extra room; we trim back to the phrase
PREFIX_PHRASE = "realvoice"
PREFIX_AMBIENT = "ambient"

POS_DIR.mkdir(parents=True, exist_ok=True)
AMB_DIR.mkdir(parents=True, exist_ok=True)


def log(msg, color=36):
    print(f"\033[1;{color}m[record]\033[0m {msg}", flush=True)


def save_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(samples.astype(np.int16).tobytes())


def trim_silence(
    samples: np.ndarray, pad_ms: int = 150, frame_ms: int = 20
) -> np.ndarray:
    """Trim leading + trailing silence down to ±pad_ms around the speech
    region. 'Speech' = windows with rms > 15% of the peak rms across the
    whole clip. Returns empty if no above-threshold region exists."""
    frame = int(SAMPLE_RATE * frame_ms / 1000)
    if len(samples) < frame * 3:
        return samples
    # RMS per frame.
    n_frames = len(samples) // frame
    trimmed_len = n_frames * frame
    framed = samples[:trimmed_len].reshape(n_frames, frame).astype(np.float32)
    rms_per_frame = np.sqrt((framed ** 2).mean(axis=1) + 1e-9)
    peak = rms_per_frame.max()
    if peak < 100:
        return np.array([], dtype=samples.dtype)
    thresh = max(200.0, peak * 0.15)
    active = rms_per_frame > thresh
    if not active.any():
        return np.array([], dtype=samples.dtype)
    first = np.argmax(active)
    last = len(active) - 1 - np.argmax(active[::-1])
    pad_frames = max(1, pad_ms // frame_ms)
    start = max(0, first - pad_frames) * frame
    end = min(n_frames, last + 1 + pad_frames) * frame
    return samples[start:end]


def record_phrase_clip() -> np.ndarray:
    audio = sd.rec(
        int(RECORD_SECONDS * SAMPLE_RATE),
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="int16",
    )
    sd.wait()
    return audio.flatten()


def record_phrase_samples() -> int:
    existing = sorted(POS_DIR.glob(f"{PREFIX_PHRASE}_*.wav"))
    start_idx = len(existing)
    print()
    log(f"Recording {N_SAMPLES} samples of: \033[1;33m\"{PHRASE}\"\033[0m", color=36)
    log("Tips: say it naturally — vary tone (fast/slow, energetic/flat).")
    log("      Clips with <300ms speech or <300 rms will be rejected.")
    print()
    saved = 0
    attempts = 0
    max_attempts = N_SAMPLES * 3
    while saved < N_SAMPLES and attempts < max_attempts:
        attempts += 1
        idx = start_idx + saved
        path = POS_DIR / f"{PREFIX_PHRASE}_{idx:04d}.wav"
        input(
            f"\033[1;32m[{saved+1}/{N_SAMPLES}]\033[0m "
            f"Press ENTER, then say \"{PHRASE}\"... "
        )
        print(f"   🔴 recording {RECORD_SECONDS:.1f} s...", end="", flush=True)
        raw = record_phrase_clip()
        trimmed = trim_silence(raw, pad_ms=150)
        dur_ms = int(len(trimmed) * 1000 / SAMPLE_RATE)
        rms = int(
            np.sqrt((trimmed.astype(np.float32) ** 2).mean())
            if len(trimmed) > 0
            else 0
        )
        # Quality gate: need at least 300ms of actual audio and a
        # reasonable loudness — otherwise the classifier learns garbage.
        if dur_ms < 300 or rms < 300 or len(trimmed) == 0:
            print(
                f" \033[1;31m✗ rejected\033[0m (dur={dur_ms}ms rms={rms}) — "
                f"speak louder / closer and try again"
            )
            continue
        if dur_ms > 1800:
            print(
                f" \033[1;33m⚠ very long ({dur_ms}ms)\033[0m — saving anyway"
            )
        save_wav(path, trimmed)
        saved += 1
        print(f" \033[1;32m✓ saved\033[0m ({dur_ms}ms, rms={rms})")
    if saved < N_SAMPLES:
        log(
            f"Only got {saved}/{N_SAMPLES} valid samples after {attempts} "
            f"attempts. Proceeding anyway.",
            color=33,
        )
    return saved


def record_ambient_samples() -> int:
    """Record a continuous 60s stream and chunk into 2s segments. User
    should talk normally, cough, clear throat, hit keyboard — anything
    that is NOT the wake phrase. This teaches the classifier what real
    mic captures of 'not the phrase' look like, which no amount of TTS
    background speech can replace."""
    existing = sorted(AMB_DIR.glob(f"{PREFIX_AMBIENT}_*.wav"))
    start_idx = len(existing)
    chunk_samples = 2 * SAMPLE_RATE
    total_s = int(N_AMBIENT_CHUNKS * 2)
    print()
    log(
        f"Now recording \033[1;33m{total_s}s of ambient noise\033[0m — "
        f"NOT the wake phrase.",
        color=36,
    )
    log("Good things to do during this:")
    log("  - talk normally (random words, count, read a sentence aloud)")
    log("  - type on the keyboard")
    log("  - clear throat, cough, say 'hey jarvis'")
    log("  - just sit quietly")
    log("Anything EXCEPT saying \"" + PHRASE + "\".")
    input("Press ENTER to start the " + str(total_s) + "s recording... ")
    print(f"   🔴 recording {total_s} s...", end="", flush=True)
    audio = sd.rec(total_s * SAMPLE_RATE, samplerate=SAMPLE_RATE, channels=1, dtype="int16")
    sd.wait()
    print(" done.")
    samples = audio.flatten()
    saved = 0
    for i in range(N_AMBIENT_CHUNKS):
        chunk = samples[i * chunk_samples : (i + 1) * chunk_samples]
        if len(chunk) < chunk_samples // 2:
            break
        path = AMB_DIR / f"{PREFIX_AMBIENT}_{start_idx + saved:04d}.wav"
        save_wav(path, chunk)
        saved += 1
    log(f"Saved {saved} ambient chunks.", color=32)
    return saved


def main() -> int:
    try:
        sd.default.samplerate = SAMPLE_RATE
        sd.default.channels = 1
        # Probe mic once so permission prompt lands before recording.
        sd.rec(160, samplerate=SAMPLE_RATE, channels=1, dtype="int16")
        sd.wait()
    except Exception as e:
        print(f"[record] mic probe failed: {e}", file=sys.stderr)
        return 1

    n_phrase = record_phrase_samples()
    n_amb = record_ambient_samples()
    print()
    log(
        f"✅ Done. {n_phrase} phrase samples + {n_amb} ambient chunks saved.",
        color=32,
    )
    log("Now run ./scripts/train_wake.sh to retrain.", color=36)
    return 0


if __name__ == "__main__":
    sys.exit(main())
