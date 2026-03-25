#!/bin/bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'
BOLD='\033[1m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FALLBACK_DIR="${SCRIPT_DIR}/fallback"
VENV_DIR="${FALLBACK_DIR}/.venv"
MODEL_DIR="/opt/homebrew/share/whisper-cpp/models"
SHELL_RC="${HOME}/.zshrc"
SERVER_ALIAS='alias meeting-transcriber-server="'"${SCRIPT_DIR}"'/start-server.sh"'

print_header() {
  echo ""
  echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}${BOLD}  Meeting Transcriber — Installer${NC}"
  echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════${NC}"
  echo ""
}

print_step() {
  echo -e "\n${BOLD}[$1/5]${NC} $2"
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

check() {
  if eval "$2" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $1"
  else
    echo -e "  ${RED}✗${NC} $1 — $3"
  fi
}

if [[ "${1:-}" == "--check" ]]; then
  print_header
  echo -e "${BOLD}Dependency Status:${NC}\n"

  check "Homebrew" "command -v brew" "Install from https://brew.sh"
  check "Python 3" "python3 --version" "Install Python 3.10+"
  check "whisper.cpp" "command -v whisper-cpp || test -f /opt/homebrew/bin/whisper-cpp" "brew install whisper-cpp"
  check "Whisper model" "ls ${MODEL_DIR}/ggml-base.en.bin ${MODEL_DIR}/ggml-medium.en.bin ${MODEL_DIR}/ggml-large-v3-turbo.bin 2>/dev/null | head -1" "Run ./install.sh to download"
  check "Python venv" "test -d ${VENV_DIR}" "Run ./install.sh to create"

  if [ -d "${VENV_DIR}" ]; then
    check "pyannote.audio" "${VENV_DIR}/bin/python -c 'import pyannote.audio'" "Run ./install.sh"
    check "torch" "${VENV_DIR}/bin/python -c 'import torch'" "Run ./install.sh"
    check "torchaudio" "${VENV_DIR}/bin/python -c 'import torchaudio'" "Run ./install.sh"
    check "websockets" "${VENV_DIR}/bin/python -c 'import websockets'" "Run ./install.sh"
  fi

  check "HF_TOKEN" "test -n \"${HF_TOKEN:-}\"" "Optional but required for pyannote diarization"
  check "Whisper server reachable" "nc -z 127.0.0.1 9090" "Run ./start-server.sh"

  echo ""
  echo -e "${BOLD}Chrome Extension:${NC}"
  echo "  Load manually at chrome://extensions/ → Load unpacked → select this folder"
  echo ""
  exit 0
fi

print_header

if ! command -v brew &>/dev/null; then
  echo -e "${RED}Homebrew is required. Install it first:${NC}"
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo -e "${RED}Python 3 is required. Install with: brew install python${NC}"
  exit 1
fi

print_step 1 "whisper.cpp"
if command -v whisper-cpp &>/dev/null || [ -f /opt/homebrew/bin/whisper-cpp ]; then
  print_skip "whisper.cpp"
else
  print_action "Installing whisper.cpp..."
  brew install whisper-cpp
  print_ok "whisper.cpp installed"
fi

print_step 2 "Whisper model"
FOUND_MODEL=""
for model_file in "ggml-large-v3-turbo.bin" "ggml-medium.en.bin" "ggml-base.en.bin"; do
  if [ -f "${MODEL_DIR}/${model_file}" ]; then
    FOUND_MODEL="${model_file}"
    break
  fi
done

if [ -n "${FOUND_MODEL}" ]; then
  print_skip "Model: ${FOUND_MODEL}"
else
  print_action "Downloading ggml-base.en model..."
  mkdir -p "${MODEL_DIR}"
  if command -v whisper-cpp-download-ggml-model &>/dev/null; then
    whisper-cpp-download-ggml-model base.en
  else
    curl -L --progress-bar \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" \
      -o "${MODEL_DIR}/ggml-base.en.bin"
  fi
  print_ok "Model downloaded"
  echo ""
  echo -e "  ${YELLOW}Tip:${NC} For best accuracy, also download:"
  echo "    whisper-cpp-download-ggml-model large-v3-turbo"
fi

print_step 3 "Python environment"
if [ ! -d "${VENV_DIR}" ]; then
  print_action "Creating virtual environment..."
  python3 -m venv "${VENV_DIR}"
fi

print_action "Installing Python dependencies..."
"${VENV_DIR}/bin/pip" install --quiet --upgrade pip
"${VENV_DIR}/bin/pip" install --quiet -r "${FALLBACK_DIR}/requirements.txt"
print_ok "Python dependencies installed"

print_step 4 "Server launch helper"
chmod +x "${SCRIPT_DIR}/start-server.sh"
if [ -f "${SHELL_RC}" ] && grep -Fq 'meeting-transcriber-server=' "${SHELL_RC}"; then
  print_skip "Shell alias in ${SHELL_RC}"
else
  print_action "Adding meeting-transcriber-server alias to ${SHELL_RC}..."
  {
    echo ""
    echo "# Meeting Transcriber local Whisper server"
    echo "${SERVER_ALIAS}"
  } >> "${SHELL_RC}"
  print_ok "Alias added"
fi

print_step 5 "Optional diarization auth"
if [ -n "${HF_TOKEN:-}" ]; then
  print_ok "HF_TOKEN is set"
else
  print_warn "HF_TOKEN is not set"
  echo ""
  echo "  Pyannote diarization is optional but improves fallback speaker labeling."
  echo "  1. Create account:  https://huggingface.co/join"
  echo "  2. Accept terms:    https://huggingface.co/pyannote/speaker-diarization-3.1"
  echo "  3. Create token:    https://huggingface.co/settings/tokens"
  echo ""
  echo "  Then add to ${SHELL_RC}:"
  echo "    export HF_TOKEN=\"hf_your_token_here\""
fi

echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Install complete!${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo ""
echo "  How to run:"
echo "    1. source ${SHELL_RC}"
echo "    2. ./start-server.sh"
echo "    3. Load the extension at chrome://extensions/ → Load unpacked"
echo ""
echo "  Verification:"
echo "    ./install.sh --check"
echo ""
