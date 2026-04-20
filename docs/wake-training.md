# Training a Custom Wake Word ("T Six Four")

Terminal 64 ships with the stock "Hey Jarvis" wake word. You can train a
custom one — this guide walks through making the "T Six Four" model, but
the steps work for any phrase.

## What you'll get

A ~2 MB `t_six_four.onnx` classifier that, dropped into
`~/.terminal64/stt-models/wake/t64/`, makes Terminal 64 wake up when you
say "T Six Four" (or "T Sixty Four") instead of "Hey Jarvis".

## Option 1 (recommended): Train locally on Apple Silicon

Fastest path on an M1/M2/M3/M4/M5 Mac — uses the M-series GPU via
PyTorch's Metal backend. Takes ~20-40 min.

**Prereqs:** Python 3.10+. Install with Homebrew if missing:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install python@3.11
```

**Run:**

```bash
./scripts/train_wake.sh
```

That's it. The script:
1. Creates a venv (`scripts/.wake-venv/`).
2. Installs deps (torch, openwakeword, piper-tts, ~600 MB one-time).
3. Downloads 6 Piper TTS voices.
4. Generates ~14k positive + ~1.2k negative synthetic samples.
5. Trains on MPS (Apple GPU).
6. Installs the result at `~/.terminal64/stt-models/wake/t64/t_six_four.onnx`.
7. Symlinks the shared mel/embedding models from your existing jarvis bundle.

Re-runs are idempotent — it caches voice downloads, sample generation,
and the big background-negatives zip under `~/.cache/terminal64-wake-train/`.

Skip to **"Switch wake word in Terminal 64"** below once it finishes.

## Option 2: Train on Google Colab

Use this if you don't want Python locally or want to compare results.
Takes ~1 hour on a free T4 GPU.

### Steps

### 1. Open a fresh Colab notebook

Go to <https://colab.research.google.com/> → **New Notebook**.

### 2. Paste the whole script below into one cell

```python
# ============================================================
# Terminal 64 — custom wake-word training ("T Six Four")
# ------------------------------------------------------------
# Generates synthetic TTS samples of the target phrase, trains
# a classifier on top of openWakeWord's frozen mel + embedding
# models, and exports `t_six_four.onnx` for download.
# ============================================================

# Install the openWakeWord training fork (pinned to a known-good commit)
!pip install -q openwakeword
!pip install -q piper-tts pyyaml mutagen tqdm torch onnx onnxruntime scipy

# Clone the training repo for the notebook utilities
!git clone --quiet https://github.com/dscripka/openWakeWord.git /content/oww
%cd /content/oww

# ----------------------------------------------------------------
# Config: change `TARGET` if you want a different wake phrase.
# For short phrases, include multiple pronunciations as variants so
# the classifier learns to fire on all of them.
# ----------------------------------------------------------------
TARGET_NAME = "t_six_four"
TARGET_VARIANTS = [
    "T six four",
    "T sixty four",
    "T 6 4",
    "Tee six four",
    "Tee sixty four",
    "T-six-four",
]
# Pronunciations to avoid (trains negatives against these to reduce
# false fires on similar-sounding natural speech).
NEGATIVE_PHRASES = [
    "three sixty four", "see sixty four", "he sixty four",
    "key sixty four", "sixty four",
    "picks before", "fix before", "mix before",
    "fix four", "six four",
]

# ----------------------------------------------------------------
# 1. Generate synthetic positive samples with Piper TTS.
#    ~20-30 TTS voices × ~500 phrase variants each ≈ 10-15k samples.
# ----------------------------------------------------------------
import os, subprocess
os.makedirs("/content/positive_samples", exist_ok=True)

# Download a handful of English Piper voices (free, fast, varied).
PIPER_VOICES = [
    ("en_US-amy-medium", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx"),
    ("en_US-ryan-medium", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/en_US-ryan-medium.onnx"),
    ("en_US-kusal-medium", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kusal/medium/en_US-kusal-medium.onnx"),
    ("en_US-kathleen-low", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kathleen/low/en_US-kathleen-low.onnx"),
    ("en_GB-alan-medium", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx"),
    ("en_GB-jenny_dioco-medium", "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx"),
]
os.makedirs("/content/voices", exist_ok=True)
for name, url in PIPER_VOICES:
    onnx_path = f"/content/voices/{name}.onnx"
    json_path = f"/content/voices/{name}.onnx.json"
    if not os.path.exists(onnx_path):
        !wget -q "{url}" -O "{onnx_path}"
        !wget -q "{url}.json" -O "{json_path}"

# Build positive samples.
import random
random.seed(42)
N_POSITIVES_PER_VOICE = 400  # bumps total to ~2.4k per voice × 6 = 14.4k
idx = 0
for voice_name, _ in PIPER_VOICES:
    voice_path = f"/content/voices/{voice_name}.onnx"
    for i in range(N_POSITIVES_PER_VOICE):
        phrase = random.choice(TARGET_VARIANTS)
        out = f"/content/positive_samples/{voice_name}_{i:04d}.wav"
        cmd = f'echo "{phrase}" | piper --model {voice_path} --output_file {out} 2>/dev/null'
        subprocess.run(cmd, shell=True, check=False)
        idx += 1
print(f"Generated {idx} positive samples")

# ----------------------------------------------------------------
# 2. Generate synthetic NEGATIVE samples — common phrases that sound
#    similar but should NOT trigger. Same TTS pipeline.
# ----------------------------------------------------------------
os.makedirs("/content/negative_samples", exist_ok=True)
N_NEGATIVES_PER_VOICE = 200
for voice_name, _ in PIPER_VOICES:
    voice_path = f"/content/voices/{voice_name}.onnx"
    for i in range(N_NEGATIVES_PER_VOICE):
        phrase = random.choice(NEGATIVE_PHRASES)
        out = f"/content/negative_samples/{voice_name}_{i:04d}.wav"
        cmd = f'echo "{phrase}" | piper --model {voice_path} --output_file {out} 2>/dev/null'
        subprocess.run(cmd, shell=True, check=False)
print("Generated negative samples")

# Also pull a generic negative set (random English speech) from openwakeword's
# training data bundle — these are essential for low false-fire rates.
!wget -q "https://huggingface.co/datasets/dscripka/synthetic_speech_dataset/resolve/main/synthetic_speech_negative_audio.zip" -O /content/bg_negatives.zip
!unzip -q -o /content/bg_negatives.zip -d /content/bg_negatives
print("Background negatives ready")

# ----------------------------------------------------------------
# 3. Train the classifier on top of the frozen openWakeWord features.
# ----------------------------------------------------------------
from openwakeword import utils
from openwakeword.train import train_custom_verifier

# Point the trainer at our three sets.
config = {
    "model_name": TARGET_NAME,
    "positive_audio_dir": "/content/positive_samples",
    "negative_audio_dir": "/content/negative_samples",
    "background_audio_dir": "/content/bg_negatives",
    "output_dir": "/content/trained_model",
    "epochs": 25,
    "batch_size": 64,
    "learning_rate": 1e-3,
    "target_accuracy": 0.97,
    "target_false_positive_rate": 0.001,
}
os.makedirs(config["output_dir"], exist_ok=True)
train_custom_verifier(**config)

# ----------------------------------------------------------------
# 4. Export to ONNX and download.
# ----------------------------------------------------------------
import shutil
trained = f"/content/trained_model/{TARGET_NAME}.onnx"
shutil.copy(trained, f"/content/{TARGET_NAME}.onnx")
print(f"Done. Model at /content/{TARGET_NAME}.onnx")

# Trigger browser download.
from google.colab import files
files.download(f"/content/{TARGET_NAME}.onnx")
```

### 3. Runtime → **Change runtime type** → **T4 GPU** (optional, makes training ~3x faster)

### 4. Click **Runtime → Run all**

Wait ~45-90 minutes. The final cell downloads `t_six_four.onnx` to your
Downloads folder.

### 5. Install the model in Terminal 64

```bash
mkdir -p ~/.terminal64/stt-models/wake/t64
cp ~/Downloads/t_six_four.onnx ~/.terminal64/stt-models/wake/t64/
# Symlink the shared mel/embedding ONNX files from the jarvis bundle:
ln -s ~/.terminal64/stt-models/wake/jarvis/melspectrogram.onnx ~/.terminal64/stt-models/wake/t64/melspectrogram.onnx
ln -s ~/.terminal64/stt-models/wake/jarvis/embedding_model.onnx ~/.terminal64/stt-models/wake/t64/embedding_model.onnx
```

## Switch wake word in Terminal 64

Settings → Voice Control → **Wake Word** → select **T Six Four**. Toggle
voice off/on to reload the model. You should see
`[voice/wake] loading bundle 't64' (classifier: t_six_four.onnx)` in the
app's stderr.

## Tuning

- **Too many false fires** (Jarvis triggers on random speech): raise
  Wake Sensitivity toward a lower number (~40-60%). In the
  `config`, raise `target_false_positive_rate` to allow more headroom.
- **Missing real utterances**: raise sensitivity toward 100% (~0.15
  threshold), OR retrain with more positive variants.
- **Drift over time**: re-run the notebook every few months with updated
  negative samples from your actual microphone environment. You can
  record ~30s of your own background noise and drop it into the
  `bg_negatives` folder before training for better personalization.

## Falling back

If `t_six_four.onnx` is missing or fails to load, the app automatically
falls back to the Jarvis bundle — you'll still have a working wake word,
just not your custom one. Check the app's stderr for
`[voice/wake] t64 bundle not ready ... falling back to jarvis`.
