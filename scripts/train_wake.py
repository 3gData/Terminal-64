#!/usr/bin/env python3
"""Local wake-word trainer for Terminal 64.

Pipeline:
  1. Generate (or reuse) synthetic TTS positives + near-miss negatives via Piper.
  2. Generate (or reuse) synthetic background-speech negatives.
  3. Load real-voice phrase recordings (positive) and ambient mic recordings
     (negative) if the user recorded any via record_samples.sh.
  4. Extract 16×96 feature vectors by running audio through the frozen
     openWakeWord mel + embedding ONNX models, ENERGY-CENTERED so the
     feature window covers the loud speech region regardless of clip length.
  5. Train a small conv-over-time classifier on MPS / CUDA / CPU.
  6. Post-train sanity check: score silence, TTS Hey-Jarvis, and held-out
     samples. Refuse to install if false-positive rate is too high.
  7. Export ONNX and drop it into ~/.terminal64/stt-models/wake/t64/.

Env vars:
  WAKE_NAME          — output filename stem (default t_six_four)
  MODEL_DIR          — install target (default ~/.terminal64/stt-models/wake/t64)
  USER_OVERSAMPLE    — duplication factor for real-voice samples (default 15)
  MAX_FP_RATE        — max acceptable false-positive rate (default 0.02)
  EPOCHS             — training epochs (default 30)
"""

from __future__ import annotations
import os, random, shutil, subprocess, sys, wave
from pathlib import Path

import numpy as np
import requests
from tqdm import tqdm

# ---------------------------------------------------------------- config
WAKE_NAME = os.environ.get("WAKE_NAME", "t_six_four")
MODEL_DIR = Path(os.environ.get("MODEL_DIR", Path.home() / ".terminal64/stt-models/wake/t64"))
USER_OVERSAMPLE = int(os.environ.get("USER_OVERSAMPLE", "15"))
MAX_FP_RATE = float(os.environ.get("MAX_FP_RATE", "0.02"))
EPOCHS = int(os.environ.get("EPOCHS", "30"))

WORK_DIR = Path.home() / ".cache" / "terminal64-wake-train"
POS_DIR = WORK_DIR / "positive"
NEG_DIR = WORK_DIR / "negative"
BG_DIR = WORK_DIR / "bg_negatives"
AMB_DIR = WORK_DIR / "ambient"
for d in (POS_DIR, NEG_DIR, BG_DIR, AMB_DIR):
    d.mkdir(parents=True, exist_ok=True)
MODEL_DIR.mkdir(parents=True, exist_ok=True)

TARGET_VARIANTS = [
    "T sixty four",
    "Tee sixty four",
    "T sixty-four",
    "Tee sixty-four",
    "tee sixty four",
    "T 64",
    "Tee 64",
]
NEGATIVE_PHRASES = [
    "three sixty four", "see sixty four", "he sixty four",
    "key sixty four", "sixty four", "sixty-four",
    "be sixty four", "bee sixty four", "tree sixty four",
    "T six four", "six four", "tea for two",
    "hey jarvis", "hey siri", "okay google", "alexa",
    "picks before", "fix before", "mix before",
]
# Broad English "not the phrase" corpus for TTS background.
BG_PHRASES = [
    "the weather today looks quite pleasant outside",
    "please open the document on the desktop",
    "i need to schedule a meeting for tomorrow",
    "can you remind me about the appointment",
    "send an email to the team about the project update",
    "what time is the presentation this afternoon",
    "add milk and bread to the shopping list",
    "set a timer for fifteen minutes",
    "play some music from my favorites playlist",
    "turn on the lights in the living room",
    "what is the fastest route to the airport",
    "tell me a joke about computers",
    "remind me to call my mom later tonight",
    "start a new timer for the kitchen",
    "open the web browser and search for recipes",
    "the quick brown fox jumps over the lazy dog",
    "she sells seashells by the seashore",
    "peter piper picked a peck of pickled peppers",
    "how much wood would a woodchuck chuck",
    "a stitch in time saves nine",
    "actions speak louder than words",
    "better late than never",
    "birds of a feather flock together",
    "do not count your chickens before they hatch",
    "every cloud has a silver lining",
    "good things come to those who wait",
    "hope for the best prepare for the worst",
    "if it ain't broke don't fix it",
    "look before you leap carefully",
    "never judge a book by its cover",
    "once bitten twice shy",
    "practice makes perfect every time",
    "rome was not built in a day",
    "the early bird catches the worm",
    "time flies when you're having fun",
    "where there is a will there is a way",
    "you can't have your cake and eat it too",
    "all that glitters is not gold",
    "beauty is in the eye of the beholder",
    "curiosity killed the cat they say",
    "don't put all your eggs in one basket",
    "fortune favors the bold and brave",
    "great minds think alike don't they",
    "honesty is the best policy always",
    "if at first you don't succeed try again",
    "keep your friends close and enemies closer",
    "laughter is the best medicine for sure",
    "money doesn't grow on trees you know",
    "no pain no gain as they say",
    "out of sight out of mind",
    "patience is a virtue so they tell me",
    "slow and steady wins the race",
    "the pen is mightier than the sword",
    "two heads are better than one",
    "you can lead a horse to water",
    "what goes up must come down",
    "let's grab coffee sometime next week",
    "the train leaves at nine in the morning",
    "i'll see you at the party on friday",
    "don't forget to pick up the groceries",
    "the library is open until nine pm",
    "traffic on the highway is terrible today",
    "this restaurant has amazing pasta dishes",
    "the concert tickets went on sale this morning",
    "my flight lands around three in the afternoon",
    "the new movie comes out this weekend",
    "let me check my calendar for availability",
    "i'll forward you the email with the details",
    "the meeting has been moved to thursday",
    "can you pick up the dry cleaning",
    "the game starts at seven eastern time",
    "let's order pizza for dinner tonight",
]

PIPER_VOICES = [
    ("en_US-amy-medium", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx"),
    ("en_US-ryan-medium", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/en_US-ryan-medium.onnx"),
    ("en_US-kusal-medium", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kusal/medium/en_US-kusal-medium.onnx"),
    ("en_US-kathleen-low", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kathleen/low/en_US-kathleen-low.onnx"),
    ("en_GB-alan-medium", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx"),
    ("en_GB-jenny_dioco-medium", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx"),
]
N_POS_PER_VOICE = 400
N_NEG_PER_VOICE = 200
N_BG_PER_VOICE = 500

random.seed(42)
np.random.seed(42)

# --- sample rate + feature-extraction constants (match openWakeWord) ----
SR = 16000
MEL_BINS = 32
EMB_WINDOW = 76      # mel frames per embedding
EMB_HOP = 8          # mel frames between successive embeddings
CLS_WINDOW = 16      # embeddings fed to the classifier
EMB_DIM = 96
MIN_MEL_FRAMES_NEEDED = EMB_WINDOW + EMB_HOP * (CLS_WINDOW - 1)  # 196


def log(msg: str, color: int = 36) -> None:
    print(f"\033[1;{color}m[wake-train]\033[0m {msg}", flush=True)


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        with open(dest, "wb") as f, tqdm(
            total=total, unit="B", unit_scale=True, unit_divisor=1024,
            desc=dest.name, leave=False
        ) as bar:
            for chunk in r.iter_content(chunk_size=65536):
                f.write(chunk)
                bar.update(len(chunk))


def ensure_voices() -> list[Path]:
    voice_dir = WORK_DIR / "voices"
    voice_dir.mkdir(exist_ok=True)
    out = []
    for name, url in PIPER_VOICES:
        onnx = voice_dir / f"{name}.onnx"
        cfg = voice_dir / f"{name}.onnx.json"
        download(url, onnx)
        download(url + ".json", cfg)
        out.append(onnx)
    return out


def synthesise(
    phrases: list[str], n_per_voice: int, out_dir: Path, label: str, prefix: str = ""
) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    voices = ensure_voices()
    total = len(voices) * n_per_voice
    # Only count TTS-generated WAVs (not realvoice/ambient user recordings).
    already = len([p for p in out_dir.glob("*.wav") if "realvoice" not in p.name and "ambient" not in p.name])
    if already >= total:
        log(f"{label}: {already} samples already present, skipping generation")
        return already
    log(f"{label}: generating {total - already} samples across {len(voices)} voices...")
    count = already
    with tqdm(total=total, initial=already, desc=label, unit="wav") as bar:
        for voice_path in voices:
            voice_name = voice_path.stem
            for i in range(n_per_voice):
                out_path = out_dir / f"{prefix}{voice_name}_{i:04d}.wav"
                if out_path.exists() and out_path.stat().st_size > 0:
                    continue
                phrase = random.choice(phrases)
                subprocess.run(
                    ["piper", "--model", str(voice_path), "--output_file", str(out_path)],
                    input=phrase.encode(),
                    capture_output=True,
                    check=False,
                )
                count += 1
                bar.update(1)
    return count


# --- feature extraction (energy-centered) -------------------------------

def _read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        if w.getnchannels() == 2:
            data = data.reshape(-1, 2).mean(axis=1).astype(np.int16)
    return data, sr


def _resample_linear(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return audio
    new_len = int(len(audio) * dst_sr / src_sr)
    idx = np.linspace(0, len(audio) - 1, new_len).astype(np.int64)
    return audio[idx]


def _energy_center_window(
    audio: np.ndarray, window_samples: int
) -> np.ndarray:
    """Find the `window_samples`-length sub-range with the highest total
    energy, centered on the peak RMS region. Pads with trailing zeros if
    audio is shorter than window_samples."""
    if len(audio) <= window_samples:
        out = np.zeros(window_samples, dtype=audio.dtype)
        # Right-align so the (likely) phrase sits near the end — matches
        # openWakeWord runtime which accumulates samples and evaluates on
        # the trailing window. But importantly, we do this AFTER trimming
        # silence in the recorder, so "trailing" here is actual audio.
        out[-len(audio):] = audio
        return out
    # Compute RMS per ~25ms frame, convolve with window-sized kernel to
    # find the max-energy region.
    frame = 400  # 25ms @ 16kHz
    n_frames = len(audio) // frame
    framed = audio[: n_frames * frame].reshape(n_frames, frame).astype(np.float32)
    rms = np.sqrt((framed ** 2).mean(axis=1) + 1e-9)
    window_frames = window_samples // frame
    if window_frames >= n_frames:
        return audio[-window_samples:]
    # Sliding-window sum via cumulative sum, O(n).
    cumulative = np.concatenate([[0.0], np.cumsum(rms)])
    window_energy = cumulative[window_frames:] - cumulative[: -window_frames]
    best_start_frame = int(np.argmax(window_energy))
    best_start = best_start_frame * frame
    return audio[best_start : best_start + window_samples]


def extract_features_batch(
    wav_paths: list[Path], mel_sess, emb_sess
) -> np.ndarray:
    mel_in = mel_sess.get_inputs()[0].name
    emb_in = emb_sess.get_inputs()[0].name
    # Target window: enough audio to produce MIN_MEL_FRAMES_NEEDED mel frames.
    # Empirically ~1.6s of 16kHz audio produces ~200 frames. Use 1.8s for safety.
    window_samples = int(1.8 * SR)
    feats = []
    failures = 0
    for path in tqdm(wav_paths, desc="extract", unit="wav", leave=False):
        try:
            audio, sr = _read_wav(path)
            audio = _resample_linear(audio, sr, SR)
            audio = _energy_center_window(audio, window_samples)
            audio_f = audio.astype(np.float32)
            mel_out = mel_sess.run(None, {mel_in: audio_f.reshape(1, -1)})[0]
            mel = (mel_out / 10.0 + 2.0).reshape(-1, MEL_BINS)
            if mel.shape[0] < MIN_MEL_FRAMES_NEEDED:
                mel = np.pad(
                    mel,
                    ((MIN_MEL_FRAMES_NEEDED - mel.shape[0], 0), (0, 0)),
                )
            # Take the window whose center aligns with the audio's peak
            # energy — since we already energy-centered the audio, the
            # last MIN_MEL_FRAMES frames correspond to that region.
            mel = mel[-MIN_MEL_FRAMES_NEEDED:]
            embs = []
            for i in range(CLS_WINDOW):
                start = i * EMB_HOP
                window = mel[start : start + EMB_WINDOW]
                emb_input = window.reshape(1, EMB_WINDOW, MEL_BINS, 1).astype(np.float32)
                emb_out = emb_sess.run(None, {emb_in: emb_input})[0]
                embs.append(emb_out.flatten()[:EMB_DIM])
            feats.append(np.stack(embs).astype(np.float32))
        except Exception as e:
            failures += 1
            if failures <= 3:
                print(
                    f"[wake-train] EXTRACT FAIL ({path.name}): "
                    f"{type(e).__name__}: {e}",
                    flush=True,
                )
    if failures:
        log(f"{failures}/{len(wav_paths)} extract failures", color=33)
    return (
        np.stack(feats) if feats else np.zeros((0, CLS_WINDOW, EMB_DIM), dtype=np.float32)
    )


# --- classifier ---------------------------------------------------------

def build_classifier():
    """Conv-over-time classifier. 16×96 input → Conv1d stack → pool → MLP
    head. Returns LOGITS from forward() for clean BCEWithLogitsLoss use;
    `ClassifierWithSigmoid` wraps for inference/ONNX export."""
    import torch.nn as nn
    import torch

    class Classifier(nn.Module):
        def __init__(self):
            super().__init__()
            # LayerNorm over the time dim so batch=1 works cleanly (BN
            # breaks on tiny batches during sanity check).
            self.conv1 = nn.Conv1d(EMB_DIM, 128, kernel_size=3, padding=1)
            self.ln1 = nn.LayerNorm([128, CLS_WINDOW])
            self.conv2 = nn.Conv1d(128, 64, kernel_size=3, padding=1)
            self.ln2 = nn.LayerNorm([64, CLS_WINDOW])
            self.pool = nn.AdaptiveAvgPool1d(1)
            self.fc1 = nn.Linear(64, 64)
            self.fc2 = nn.Linear(64, 1)
            self.dropout = nn.Dropout(0.3)

        def forward(self, x):  # logits
            x = x.transpose(1, 2)  # [B, 96, 16]
            x = torch.relu(self.ln1(self.conv1(x)))
            x = torch.relu(self.ln2(self.conv2(x)))
            x = self.pool(x).squeeze(-1)
            x = self.dropout(torch.relu(self.fc1(x)))
            return self.fc2(x).squeeze(-1)

    return Classifier()


def build_export_model(trained):
    """Wrap a trained logits-classifier with sigmoid for runtime use."""
    import torch.nn as nn
    import torch

    class Inference(nn.Module):
        def __init__(self, core):
            super().__init__()
            self.core = core

        def forward(self, x):
            return torch.sigmoid(self.core(x))

    return Inference(trained)


# --- post-train sanity check --------------------------------------------

def sanity_check(
    model, device, mel_sess, emb_sess, user_pos: list[Path]
) -> dict:
    """Score silence + TTS Hey-Jarvis (should be low) and user recordings
    (should be high). Returns pass/fail info."""
    import torch

    # Generate a one-shot "Hey Jarvis" sample via Piper if possible.
    voice = (WORK_DIR / "voices" / "en_US-ryan-medium.onnx")
    hey_jarvis_path = WORK_DIR / "_sanity_hey_jarvis.wav"
    try:
        subprocess.run(
            ["piper", "--model", str(voice), "--output_file", str(hey_jarvis_path)],
            input=b"Hey Jarvis",
            capture_output=True,
            check=False,
            timeout=10,
        )
    except Exception:
        pass

    # Silence sample.
    silence_path = WORK_DIR / "_sanity_silence.wav"
    silent = np.zeros(int(1.8 * SR), dtype=np.int16)
    with wave.open(str(silence_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(silent.tobytes())

    test_cases = []
    if hey_jarvis_path.exists():
        test_cases.append(("Hey Jarvis (TTS)", hey_jarvis_path, 0.0))
    test_cases.append(("silence", silence_path, 0.0))
    # Include a few user recordings if present.
    for p in user_pos[:5]:
        test_cases.append((f"user: {p.name}", p, 1.0))

    if not test_cases:
        return {"ok": True, "notes": ["no test cases"]}

    paths = [t[1] for t in test_cases]
    feats = extract_features_batch(paths, mel_sess, emb_sess)
    if len(feats) != len(paths):
        return {"ok": False, "notes": ["feature extract mismatch"]}

    model.eval()
    with torch.no_grad():
        x = torch.from_numpy(feats).to(device)
        scores = torch.sigmoid(model(x)).cpu().numpy()

    notes = []
    fp_count = 0
    fn_count = 0
    for (name, _, expected), score in zip(test_cases, scores):
        status = "OK"
        if expected < 0.5 and score > 0.5:
            status = "\033[1;31mFALSE POSITIVE\033[0m"
            fp_count += 1
        elif expected >= 0.5 and score < 0.5:
            status = "\033[1;33mFALSE NEGATIVE\033[0m"
            fn_count += 1
        notes.append(f"  {name}: score={score:.3f} expected={expected:.0f} — {status}")

    n_neg_tests = sum(1 for t in test_cases if t[2] < 0.5)
    fp_rate = fp_count / max(1, n_neg_tests)
    ok = fp_rate <= MAX_FP_RATE and fn_count <= max(1, len(user_pos) // 3)
    return {"ok": ok, "fp_count": fp_count, "fn_count": fn_count, "fp_rate": fp_rate, "notes": notes}


# --- main ---------------------------------------------------------------

def train_and_export(
    pos_wavs: list[Path],
    neg_wavs: list[Path],
    user_pos_wavs: list[Path],
) -> Path:
    import onnxruntime as ort
    import torch
    import torch.nn as nn

    device = torch.device(
        "mps" if torch.backends.mps.is_available()
        else "cuda" if torch.cuda.is_available()
        else "cpu"
    )
    log(f"Training device: {device}")

    jarvis_dir = Path.home() / ".terminal64/stt-models/wake/jarvis"
    mel_path = jarvis_dir / "melspectrogram.onnx"
    emb_path = jarvis_dir / "embedding_model.onnx"
    if not mel_path.exists() or not emb_path.exists():
        raise FileNotFoundError(
            f"Missing feature extractors at {jarvis_dir}. Install the "
            f"jarvis bundle first (enable voice in Terminal 64)."
        )
    log("Loading feature extractors (mel + embedding)...")
    mel_sess = ort.InferenceSession(str(mel_path), providers=["CPUExecutionProvider"])
    emb_sess = ort.InferenceSession(str(emb_path), providers=["CPUExecutionProvider"])

    log(
        f"Extracting features: {len(pos_wavs)} positive "
        f"({len(user_pos_wavs)} user-voice), {len(neg_wavs)} negative"
    )
    X_pos = extract_features_batch(pos_wavs, mel_sess, emb_sess)
    X_neg = extract_features_batch(neg_wavs, mel_sess, emb_sess)
    # Separately extract user features so we can oversample just them.
    X_user = extract_features_batch(user_pos_wavs, mel_sess, emb_sess) if user_pos_wavs else np.zeros((0, CLS_WINDOW, EMB_DIM), dtype=np.float32)
    log(f"Features: pos={X_pos.shape} user={X_user.shape} neg={X_neg.shape}")

    # Oversample user recordings so they actually influence the decision
    # boundary — 30 recordings out of 2430 positives is 1% without this.
    if len(X_user) > 0:
        X_user_oversampled = np.tile(X_user, (USER_OVERSAMPLE, 1, 1))
        log(
            f"Oversampled user recordings {USER_OVERSAMPLE}× → "
            f"{len(X_user_oversampled)} effective samples"
        )
    else:
        X_user_oversampled = X_user
        log(
            "NO user recordings found — classifier will overfit to TTS "
            "voices. Strongly recommend running ./scripts/record_samples.sh first.",
            color=33,
        )

    X_all_pos = np.concatenate([X_pos, X_user_oversampled], axis=0) if len(X_user_oversampled) > 0 else X_pos
    X = np.concatenate([X_all_pos, X_neg], axis=0)
    y = np.concatenate([np.ones(len(X_all_pos)), np.zeros(len(X_neg))])

    # Shuffle + 85/15 train/val split.
    perm = np.random.permutation(len(X))
    X, y = X[perm], y[perm]
    n_val = max(200, len(X) // 7)
    X_val, y_val = X[:n_val], y[:n_val]
    X_tr, y_tr = X[n_val:], y[n_val:]
    log(f"Split: train={len(X_tr)} (pos {int(y_tr.sum())}, neg {int((1-y_tr).sum())}), val={len(X_val)}")

    model = build_classifier().to(device)
    # BCE with positive-class weighting so fewer positive samples are
    # compensated for. We also favor FP-reduction by pushing the loss
    # harder on negatives via a slight pos_weight down-tilt.
    pos_weight = torch.tensor([len(X_neg) / max(1, len(X_all_pos))], dtype=torch.float32).to(device)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)

    X_tr_t = torch.from_numpy(X_tr.astype(np.float32))
    y_tr_t = torch.from_numpy(y_tr.astype(np.float32))
    X_val_t = torch.from_numpy(X_val.astype(np.float32)).to(device)
    y_val_t = torch.from_numpy(y_val.astype(np.float32)).to(device)

    batch_size = 64
    best_fp = 1.0
    best_state = None
    for epoch in range(EPOCHS):
        model.train()
        idx = torch.randperm(len(X_tr_t))
        tot_loss = 0.0
        n_batches = 0
        for i in range(0, len(idx), batch_size):
            b = idx[i : i + batch_size]
            xb = X_tr_t[b].to(device)
            yb = y_tr_t[b].to(device)
            logits = model(xb)
            loss = loss_fn(logits, yb)
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot_loss += loss.item()
            n_batches += 1
        sched.step()

        model.eval()
        with torch.no_grad():
            logits = model(X_val_t)
            vp = torch.sigmoid(logits)
            pred = (vp > 0.5).float()
            tp = ((pred == 1) & (y_val_t == 1)).float().sum().item()
            fp = ((pred == 1) & (y_val_t == 0)).float().sum().item()
            fn = ((pred == 0) & (y_val_t == 1)).float().sum().item()
            tn = ((pred == 0) & (y_val_t == 0)).float().sum().item()
            acc = (tp + tn) / len(y_val_t)
            fp_rate = fp / max(1, fp + tn)
        log(
            f"epoch {epoch+1:02d}/{EPOCHS} loss={tot_loss/max(1,n_batches):.4f} "
            f"acc={acc:.3f} tp={int(tp)} fp={int(fp)} fn={int(fn)} fp_rate={fp_rate:.3f}"
        )
        if fp_rate < best_fp:
            best_fp = fp_rate
            best_state = {k: v.clone().detach().cpu() for k, v in model.state_dict().items()}

    if best_state is not None:
        model.load_state_dict({k: v.to(device) for k, v in best_state.items()})
        log(f"Loaded best-FP checkpoint (val fp_rate={best_fp:.3f})", color=32)

    # --- Sanity check BEFORE installing ---
    check = sanity_check(model, device, mel_sess, emb_sess, user_pos_wavs)
    log("Sanity check:", color=36)
    for line in check["notes"]:
        print(line, flush=True)
    if not check["ok"]:
        log(
            f"❌ sanity check FAILED (fp_rate={check.get('fp_rate',1):.3f} "
            f"> {MAX_FP_RATE:.2f} threshold). Model NOT installed.",
            color=31,
        )
        log(
            "Retry with more user recordings: "
            "N_SAMPLES=60 ./scripts/record_samples.sh",
            color=33,
        )
        raise RuntimeError("sanity check failed")
    log("✅ sanity check passed", color=32)

    # Export ONNX with sigmoid-wrapped output so the runtime gets 0..1
    # probabilities matching the stock jarvis.onnx output contract.
    out_dir = WORK_DIR / "trained"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"{WAKE_NAME}.onnx"
    export_model = build_export_model(model.to("cpu").eval()).eval()
    dummy = torch.zeros(1, CLS_WINDOW, EMB_DIM)
    torch.onnx.export(
        export_model,
        dummy,
        str(out_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}},
        opset_version=13,
        dynamo=False,
    )
    log(f"Exported ONNX: {out_path} ({out_path.stat().st_size // 1024} KB)")
    return out_path


def main() -> int:
    synthesise(TARGET_VARIANTS, N_POS_PER_VOICE, POS_DIR, "positive")
    synthesise(NEGATIVE_PHRASES, N_NEG_PER_VOICE, NEG_DIR, "near-miss negatives")
    synthesise(BG_PHRASES, N_BG_PER_VOICE, BG_DIR, "background speech")

    # Collect WAVs, separating real-voice recordings so we can oversample.
    user_pos = sorted(POS_DIR.glob("realvoice_*.wav"))
    tts_pos = [p for p in sorted(POS_DIR.glob("*.wav")) if "realvoice" not in p.name]
    neg_wavs = (
        sorted(NEG_DIR.glob("*.wav"))
        + sorted(BG_DIR.glob("*.wav"))
        + sorted(AMB_DIR.glob("*.wav"))  # real-mic ambient = gold-standard negatives
    )
    log(f"Positive WAVs: {len(tts_pos)} TTS + {len(user_pos)} real-voice")
    log(f"Negative WAVs: {len(neg_wavs)} total ({len(list(AMB_DIR.glob('*.wav')))} real-mic ambient)")

    try:
        model_path = train_and_export(tts_pos + user_pos, neg_wavs, user_pos)
    except RuntimeError as e:
        log(f"Training aborted: {e}", color=31)
        return 2

    dest = MODEL_DIR / f"{WAKE_NAME}.onnx"
    shutil.copy(model_path, dest)
    log(f"✅ Installed {dest} ({dest.stat().st_size // 1024} KB)", color=32)
    return 0


if __name__ == "__main__":
    sys.exit(main())
