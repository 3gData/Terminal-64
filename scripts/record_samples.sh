#!/usr/bin/env bash
# Record real-voice samples of the wake phrase so the next training run
# isn't overfit to Piper TTS. Run BEFORE ./scripts/train_wake.sh.
#
# Usage:
#   ./scripts/record_samples.sh                # 30 samples of "T sixty four"
#   N_SAMPLES=50 ./scripts/record_samples.sh   # more samples
#   PHRASE="Hey Terminal" ./scripts/record_samples.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$REPO_ROOT/scripts/.wake-venv"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "[record] No venv found — run ./scripts/train_wake.sh first to bootstrap it."
  exit 1
fi

# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"

# Install sounddevice into the existing venv if not already present.
if ! python -c "import sounddevice" 2>/dev/null; then
  echo "[record] Installing sounddevice (one-time)..."
  pip install --quiet sounddevice
fi

python "$REPO_ROOT/scripts/record_samples.py"

echo ""
echo "[record] Kicking off retraining with the new samples..."
"$REPO_ROOT/scripts/train_wake.sh"
