#!/usr/bin/env bash
# Train a custom wake word locally on your Mac (M1/M2/M3/M4/M5).
# Uses PyTorch's MPS backend so the M-series GPU does the work.
#
# Usage:
#   ./scripts/train_wake.sh              # train T Six Four (default)
#   WAKE_NAME=my_phrase ./scripts/train_wake.sh  # override
#
# Outputs:
#   ~/.terminal64/stt-models/wake/t64/t_six_four.onnx
#   (also symlinks the shared melspectrogram + embedding_model ONNX files
#    from the jarvis bundle you already have)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$REPO_ROOT/scripts/.wake-venv"
WAKE_NAME="${WAKE_NAME:-t_six_four}"
TARGET_BUNDLE="${TARGET_BUNDLE:-t64}"
MODEL_DIR="$HOME/.terminal64/stt-models/wake/$TARGET_BUNDLE"

say() { printf '\033[1;36m[wake-train]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[wake-train] %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. Find a Python 3.10+ interpreter ----------------------------
find_python() {
  # Include uv's managed Python installs in PATH for discovery.
  if command -v uv >/dev/null 2>&1; then
    local uv_py
    uv_py=$(uv python find 3.11 2>/dev/null || uv python find 3.12 2>/dev/null || uv python find 3.10 2>/dev/null || true)
    if [[ -n "$uv_py" && -x "$uv_py" ]]; then
      echo "$uv_py"
      return 0
    fi
  fi
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      local ver
      ver=$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")
      local major="${ver%%.*}"
      local minor="${ver##*.}"
      if [[ "$major" -eq 3 && "$minor" -ge 10 ]]; then
        echo "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

PY=$(find_python) || {
  cat <<EOF >&2
[wake-train] No Python 3.10+ found.

Install one with:
  brew install python@3.11

Then re-run this script.

(If you don't have Homebrew: /bin/bash -c "\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)")
EOF
  exit 1
}
say "Using $PY ($($PY --version))"

# --- 2. Create / reuse venv ----------------------------------------
if [[ ! -d "$VENV_DIR" ]]; then
  say "Creating venv at $VENV_DIR"
  "$PY" -m venv "$VENV_DIR"
fi
# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip wheel

# --- 3. Install deps -----------------------------------------------
say "Installing dependencies (first run takes ~2 min, subsequent runs instant)"
pip install --quiet \
  'torch>=2.1' \
  'openwakeword>=0.6' \
  piper-tts \
  onnx \
  onnxruntime \
  scipy \
  tqdm \
  requests

# --- 4. Run the training script -----------------------------------
say "Starting training pipeline (generate samples → train → export)"
WAKE_NAME="$WAKE_NAME" MODEL_DIR="$MODEL_DIR" \
  "$VENV_DIR/bin/python" "$REPO_ROOT/scripts/train_wake.py"

# --- 5. Symlink the shared mel + embedding files ------------------
JARVIS_DIR="$HOME/.terminal64/stt-models/wake/jarvis"
if [[ -d "$JARVIS_DIR" ]]; then
  for f in melspectrogram.onnx embedding_model.onnx; do
    if [[ ! -e "$MODEL_DIR/$f" ]]; then
      ln -sf "$JARVIS_DIR/$f" "$MODEL_DIR/$f"
      say "Linked $f from jarvis bundle"
    fi
  done
else
  say "WARNING: jarvis bundle not found at $JARVIS_DIR"
  say "         You'll need to download melspectrogram.onnx + embedding_model.onnx manually"
  say "         from https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1"
fi

say "✅ Done. Model installed at $MODEL_DIR/$WAKE_NAME.onnx"
say "   Open Terminal 64 → Settings → Voice Control → Wake Word → T Six Four"
say "   Toggle voice off/on to reload."
