#!/bin/bash
#
# One-time setup for the Whisper + pyannote fallback pipeline.
# Run this once to install all dependencies.
#

set -e

echo "=== Meeting Transcriber Fallback Setup ==="
echo ""

# 1. BlackHole virtual audio driver
echo "1. Installing BlackHole 2ch (virtual audio driver)..."
if brew list blackhole-2ch &>/dev/null; then
  echo "   Already installed."
else
  brew install blackhole-2ch
fi

echo ""
echo "   IMPORTANT: After install, open Audio MIDI Setup and:"
echo "   - Click '+' > Create Multi-Output Device"
echo "   - Check both 'BlackHole 2ch' and your speakers/headphones"
echo "   - Set this Multi-Output Device as system output"
echo ""

# 2. sox for audio recording
echo "2. Installing sox (audio recording)..."
if command -v sox &>/dev/null; then
  echo "   Already installed."
else
  brew install sox
fi

# 3. whisper.cpp
echo "3. Installing whisper.cpp..."
if command -v whisper-cpp &>/dev/null || [ -f /opt/homebrew/bin/whisper-cpp ]; then
  echo "   Already installed."
else
  brew install whisper-cpp
fi

# 4. Download whisper model
echo "4. Downloading whisper model (base.en - 142MB)..."
MODEL_DIR="/opt/homebrew/share/whisper-cpp/models"
if [ -f "${MODEL_DIR}/ggml-base.en.bin" ]; then
  echo "   Model already exists."
else
  whisper-cpp-download-ggml-model base.en 2>/dev/null || {
    echo "   Auto-download failed. Downloading manually..."
    mkdir -p "$MODEL_DIR"
    curl -L "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" \
      -o "${MODEL_DIR}/ggml-base.en.bin"
  }
fi

# 5. Python dependencies
echo "5. Installing Python dependencies..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
pip3 install -r "${SCRIPT_DIR}/requirements.txt"

# 6. HuggingFace token check
echo ""
echo "6. Checking HuggingFace token..."
if [ -n "$HF_TOKEN" ]; then
  echo "   HF_TOKEN is set."
else
  echo "   HF_TOKEN is NOT set."
  echo ""
  echo "   To use speaker diarization, you need a free HuggingFace token:"
  echo "   1. Create account at https://huggingface.co"
  echo "   2. Accept terms at https://huggingface.co/pyannote/speaker-diarization-3.1"
  echo "   3. Create token at https://huggingface.co/settings/tokens"
  echo "   4. Add to your shell: export HF_TOKEN='hf_your_token_here'"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Usage:"
echo "  ./record.sh start    # Start recording meeting audio"
echo "  ./record.sh stop     # Stop and auto-transcribe"
