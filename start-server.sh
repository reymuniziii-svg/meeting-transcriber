#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/fallback/.venv"
CONFIG_DIR="${MEETING_TRANSCRIBER_CONFIG_DIR:-${HOME}/.config/meeting-transcriber}"
CONFIG_FILE="${CONFIG_DIR}/server.env"
MODEL_DIR="/opt/homebrew/share/whisper-cpp/models"

if [ -f "${CONFIG_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${CONFIG_FILE}"
  set +a
fi

if [ ! -d "${VENV_DIR}" ]; then
  echo "Python virtual environment not found at ${VENV_DIR}"
  echo "Run ./install.sh first."
  exit 1
fi

WHISPER_CMD=""
for candidate in whisper-cpp whisper-cli whisper /opt/homebrew/bin/whisper-cpp /opt/homebrew/bin/whisper-cli; do
  if command -v "${candidate}" >/dev/null 2>&1 || [ -x "${candidate}" ]; then
    WHISPER_CMD="${candidate}"
    break
  fi
done

if [ -z "${WHISPER_CMD}" ]; then
  echo "whisper.cpp binary not found."
  echo "Run ./install.sh first."
  exit 1
fi

FOUND_MODEL=""
for model_file in \
  "ggml-large-v3-turbo.bin" \
  "ggml-large-v3.bin" \
  "ggml-medium.en.bin" \
  "ggml-medium.bin" \
  "ggml-base.en.bin" \
  "ggml-base.bin" \
  "ggml-small.en.bin" \
  "ggml-small.bin"; do
  if [ -f "${MODEL_DIR}/${model_file}" ]; then
    FOUND_MODEL="${MODEL_DIR}/${model_file}"
    break
  fi
done

if [ -z "${FOUND_MODEL}" ]; then
  echo "No Whisper model found in ${MODEL_DIR}."
  echo "Run ./install.sh first."
  exit 1
fi

HOST="${MEETING_TRANSCRIBER_HOST:-127.0.0.1}"
PORT="${MEETING_TRANSCRIBER_PORT:-9090}"
LOG_LEVEL="${MEETING_TRANSCRIBER_LOG_LEVEL:-INFO}"

if [ "${HOST}" != "127.0.0.1" ]; then
  echo "Refusing to start with host ${HOST}."
  echo "Meeting Transcriber must stay bound to 127.0.0.1 only."
  exit 1
fi

source "${VENV_DIR}/bin/activate"
cd "${SCRIPT_DIR}/server"
exec python3 transcription-server.py \
  --host "${HOST}" \
  --port "${PORT}" \
  --log-level "${LOG_LEVEL}" \
  "$@"
