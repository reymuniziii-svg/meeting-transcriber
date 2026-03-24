#!/bin/bash
#
# Meeting Transcriber — One-Command Install
#
# Usage:
#   ./install.sh          # Install everything
#   ./install.sh --check  # Check what's installed / what's missing
#
# What this installs:
#   1. BlackHole 2ch (virtual audio driver for capturing meeting audio)
#   2. sox (audio recording)
#   3. whisper.cpp + base.en model (speech-to-text)
#   4. Python dependencies: pyannote.audio, silero-vad (speaker diarization + voice detection)
#   5. Creates the Multi-Output audio device (guides you through it)
#   6. Downloads Whisper model if missing
#
# Everything is free and runs locally on your Mac.
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
BOLD='\033[1m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FALLBACK_DIR="${SCRIPT_DIR}/fallback"
VENV_DIR="${FALLBACK_DIR}/.venv"
MODEL_DIR="/opt/homebrew/share/whisper-cpp/models"

print_header() {
  echo ""
  echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}${BOLD}  Meeting Transcriber — Installer${NC}"
  echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════${NC}"
  echo ""
}

print_step() {
  echo -e "\n${BOLD}[$1/7]${NC} $2"
}

print_ok() {
  echo -e "  ${GREEN}✓${NC} $1"
}

print_skip() {
  echo -e "  ${YELLOW}→${NC} $1 (already installed)"
}

print_action() {
  echo -e "  ${BLUE}↓${NC} $1"
}

print_warn() {
  echo -e "  ${YELLOW}!${NC} $1"
}

print_fail() {
  echo -e "  ${RED}✗${NC} $1"
}

# ─── Check mode ───────────────────────────────────────────────────────
if [[ "${1:-}" == "--check" ]]; then
  print_header
  echo -e "${BOLD}Dependency Status:${NC}\n"

  check() {
    if eval "$2" &>/dev/null; then
      echo -e "  ${GREEN}✓${NC} $1"
    else
      echo -e "  ${RED}✗${NC} $1 — $3"
    fi
  }

  check "Homebrew" "command -v brew" "Install from https://brew.sh"
  check "BlackHole 2ch" "brew list blackhole-2ch" "brew install blackhole-2ch"
  check "sox" "command -v sox" "brew install sox"
  check "whisper.cpp" "command -v whisper-cpp || test -f /opt/homebrew/bin/whisper-cpp" "brew install whisper-cpp"
  check "Whisper model" "ls ${MODEL_DIR}/ggml-base.en.bin ${MODEL_DIR}/ggml-medium.en.bin ${MODEL_DIR}/ggml-large-v3-turbo.bin 2>/dev/null | head -1" "Run ./install.sh to download"
  check "Python 3" "python3 --version" "Install Python 3.8+"
  check "Python venv" "test -d ${VENV_DIR}" "Run ./install.sh to create"

  if [ -d "$VENV_DIR" ]; then
    check "pyannote.audio" "${VENV_DIR}/bin/python -c 'import pyannote.audio'" "pip install pyannote.audio"
    check "silero-vad" "${VENV_DIR}/bin/python -c 'import torch; torch.hub.load(\"snakers4/silero-vad\", \"silero_vad\")'" "Installed with torch"
  fi

  check "HF_TOKEN" "test -n \"${HF_TOKEN:-}\"" "See install instructions for setup"

  echo ""
  echo -e "${BOLD}Chrome Extension:${NC}"
  echo "  Load manually at chrome://extensions/ → Load unpacked → select this folder"
  echo ""
  exit 0
fi

# ─── Install mode ─────────────────────────────────────────────────────
print_header

# Pre-flight
if ! command -v brew &>/dev/null; then
  echo -e "${RED}Homebrew is required. Install it first:${NC}"
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
fi

if ! python3 --version &>/dev/null; then
  echo -e "${RED}Python 3 is required. Install with: brew install python${NC}"
  exit 1
fi

# ─── Step 1: BlackHole ────────────────────────────────────────────────
print_step 1 "BlackHole 2ch (virtual audio driver)"
if brew list blackhole-2ch &>/dev/null; then
  print_skip "BlackHole 2ch"
else
  print_action "Installing BlackHole 2ch..."
  brew install blackhole-2ch
  print_ok "BlackHole 2ch installed"
fi

# ─── Step 2: sox ──────────────────────────────────────────────────────
print_step 2 "sox (audio recording)"
if command -v sox &>/dev/null; then
  print_skip "sox"
else
  print_action "Installing sox..."
  brew install sox
  print_ok "sox installed"
fi

# ─── Step 3: whisper.cpp ──────────────────────────────────────────────
print_step 3 "whisper.cpp (speech-to-text)"
if command -v whisper-cpp &>/dev/null || [ -f /opt/homebrew/bin/whisper-cpp ]; then
  print_skip "whisper.cpp"
else
  print_action "Installing whisper.cpp..."
  brew install whisper-cpp
  print_ok "whisper.cpp installed"
fi

# ─── Step 4: Whisper model ────────────────────────────────────────────
print_step 4 "Whisper model download"
# Check for any usable model
FOUND_MODEL=""
for model_file in "ggml-large-v3-turbo.bin" "ggml-medium.en.bin" "ggml-base.en.bin"; do
  if [ -f "${MODEL_DIR}/${model_file}" ]; then
    FOUND_MODEL="${model_file}"
    break
  fi
done

if [ -n "$FOUND_MODEL" ]; then
  print_skip "Model: ${FOUND_MODEL}"
else
  print_action "Downloading ggml-base.en model (142MB)..."
  mkdir -p "$MODEL_DIR"
  if command -v whisper-cpp-download-ggml-model &>/dev/null; then
    whisper-cpp-download-ggml-model base.en
  else
    curl -L --progress-bar \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" \
      -o "${MODEL_DIR}/ggml-base.en.bin"
  fi
  print_ok "Model downloaded"
  echo ""
  echo -e "  ${YELLOW}Tip:${NC} For better accuracy, also download the large-v3-turbo model (1.5GB):"
  echo "    whisper-cpp-download-ggml-model large-v3-turbo"
fi

# ─── Step 5: Python venv + dependencies ──────────────────────────────
print_step 5 "Python dependencies (venv)"
if [ -d "$VENV_DIR" ] && "${VENV_DIR}/bin/python" -c "import pyannote.audio" &>/dev/null; then
  print_skip "Python venv with pyannote.audio"
else
  print_action "Creating virtual environment..."
  python3 -m venv "$VENV_DIR"

  print_action "Installing pyannote.audio, torch, torchaudio (this takes a few minutes)..."
  "${VENV_DIR}/bin/pip" install --quiet --upgrade pip
  "${VENV_DIR}/bin/pip" install --quiet pyannote.audio torch torchaudio
  print_ok "Python dependencies installed"
fi

# ─── Step 6: HuggingFace token ────────────────────────────────────────
print_step 6 "HuggingFace token (for speaker diarization)"
if [ -n "${HF_TOKEN:-}" ]; then
  print_ok "HF_TOKEN is set"
else
  print_warn "HF_TOKEN is not set"
  echo ""
  echo "  Speaker diarization requires a free HuggingFace token."
  echo "  Three steps:"
  echo ""
  echo "    1. Create account:  https://huggingface.co/join"
  echo "    2. Accept terms:    https://huggingface.co/pyannote/speaker-diarization-3.1"
  echo "    3. Create token:    https://huggingface.co/settings/tokens"
  echo ""
  echo "  Then add to your shell profile (~/.zshrc):"
  echo ""
  echo "    export HF_TOKEN=\"hf_your_token_here\""
  echo ""
fi

# ─── Step 7: Audio device setup ──────────────────────────────────────
print_step 7 "Audio device configuration"
echo ""
echo -e "  ${YELLOW}Manual step required:${NC} Create a Multi-Output Device so you can"
echo "  hear meeting audio AND record it simultaneously."
echo ""
echo "  1. Open: Audio MIDI Setup (Applications → Utilities)"
echo "  2. Click '+' at bottom-left → Create Multi-Output Device"
echo "  3. Check BOTH:"
echo "     ☑ BlackHole 2ch"
echo "     ☑ Your speakers or headphones"
echo "  4. Right-click it → 'Use This Device For Sound Output'"
echo ""
echo -e "  ${YELLOW}Note:${NC} You'll need to re-select this after plugging in new"
echo "  audio devices (AirPods, headphones, etc.)"

# ─── Done ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Install complete!${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Load the Chrome extension:"
echo "     → Open chrome://extensions/"
echo "     → Enable Developer mode (top-right toggle)"
echo "     → Click 'Load unpacked'"
echo "     → Select: ${SCRIPT_DIR}"
echo ""
echo "  2. Set Chrome's download folder to ~/Desktop/"
echo "     → Chrome Settings → Downloads → Location"
echo "     → Transcripts save to Desktop/Meeting Transcripts/"
echo ""
echo "  3. Join a meeting — the extension handles the rest."
echo ""
echo "  For Whisper fallback (when captions aren't available):"
echo "     ./fallback/record.sh start   # Begin recording"
echo "     ./fallback/record.sh stop    # Stop & transcribe"
echo ""
echo "  Run ./install.sh --check anytime to verify your setup."
echo ""
