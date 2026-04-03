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
CONFIG_DIR="${HOME}/.config/meeting-transcriber"
CONFIG_FILE="${CONFIG_DIR}/server.env"
LOG_DIR="${HOME}/Library/Logs/MeetingTranscriber"
LAUNCH_AGENT_LABEL="com.rey.meeting-transcriber.server"
LAUNCH_AGENT_DIR="${HOME}/Library/LaunchAgents"
LAUNCH_AGENT_PATH="${LAUNCH_AGENT_DIR}/${LAUNCH_AGENT_LABEL}.plist"
LAUNCH_AGENT_TEMPLATE="${SCRIPT_DIR}/launchd/${LAUNCH_AGENT_LABEL}.plist.template"

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
    check "pyannote.audio (optional)" "${VENV_DIR}/bin/python -c 'import pyannote.audio'" "Optional: install fallback/requirements.txt for diarization"
    check "torch" "${VENV_DIR}/bin/python -c 'import torch'" "Run ./install.sh"
    check "torchaudio" "${VENV_DIR}/bin/python -c 'import torchaudio'" "Run ./install.sh"
    check "websockets" "${VENV_DIR}/bin/python -c 'import websockets'" "Run ./install.sh"
  fi

  check "Config env file" "test -f ${CONFIG_FILE}" "Run ./install.sh to create ${CONFIG_FILE}"
  check "LaunchAgent installed" "test -f ${LAUNCH_AGENT_PATH}" "Run ./install.sh to install launchd agent"
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

print_step 4 "Server auto-start"
chmod +x "${SCRIPT_DIR}/start-server.sh"

mkdir -p "${CONFIG_DIR}" "${LOG_DIR}" "${LAUNCH_AGENT_DIR}"

if [ -f "${CONFIG_FILE}" ]; then
  print_skip "Config file at ${CONFIG_FILE}"
else
  print_action "Creating ${CONFIG_FILE} from example..."
  cp "${SCRIPT_DIR}/config/server.env.example" "${CONFIG_FILE}"
  print_ok "Config file created"
fi

TMP_PLIST="$(mktemp)"
sed \
  -e "s|__START_SERVER_PATH__|${SCRIPT_DIR}/start-server.sh|g" \
  -e "s|__REPO_DIR__|${SCRIPT_DIR}|g" \
  -e "s|__CONFIG_DIR__|${CONFIG_DIR}|g" \
  -e "s|__LOG_DIR__|${LOG_DIR}|g" \
  "${LAUNCH_AGENT_TEMPLATE}" > "${TMP_PLIST}"
mv "${TMP_PLIST}" "${LAUNCH_AGENT_PATH}"
print_ok "LaunchAgent installed at ${LAUNCH_AGENT_PATH}"

launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 || true
if launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT_PATH}" >/dev/null 2>&1; then
  print_ok "LaunchAgent bootstrapped for the current macOS session"
else
  print_warn "launchctl bootstrap could not complete; trying kickstart"
fi

if launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1; then
  print_ok "Local server started and managed by launchd"
else
  print_warn "launchctl kickstart failed. You can still run ./start-server.sh manually for development."
fi

print_step 5 "Optional diarization auth"
if grep -Eq '^HF_TOKEN=hf_' "${CONFIG_FILE}" 2>/dev/null; then
  print_ok "HF_TOKEN is configured in ${CONFIG_FILE}"
else
  print_warn "HF_TOKEN is not set"
  echo ""
  echo "  Pyannote diarization is optional but improves fallback speaker labeling."
  echo "  1. Create account:  https://huggingface.co/join"
  echo "  2. Accept terms:    https://huggingface.co/pyannote/speaker-diarization-3.1"
  echo "  3. Create token:    https://huggingface.co/settings/tokens"
  echo ""
  echo "  Then edit ${CONFIG_FILE}:"
  echo "    HF_TOKEN=\"hf_your_token_here\""
fi

echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Install complete!${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo ""
echo "  Default mode:"
echo "    1. Load the extension at chrome://extensions/ → Load unpacked"
echo "    2. Log in normally; launchd starts the local server automatically"
echo "    3. If needed, edit ${CONFIG_FILE} and run:"
echo "       launchctl kickstart -k gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
echo ""
echo "  Development fallback:"
echo "    ./start-server.sh"
echo ""
echo "  Verification:"
echo "    ./install.sh --check"
echo "    tail -f ${LOG_DIR}/server.log"
echo ""
