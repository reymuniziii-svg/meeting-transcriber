#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/fallback/.venv"

if [ ! -d "${VENV_DIR}" ]; then
  echo "Python virtual environment not found at ${VENV_DIR}"
  echo "Run ./install.sh first."
  exit 1
fi

source "${VENV_DIR}/bin/activate"
cd "${SCRIPT_DIR}/server"
python3 transcription-server.py "$@"
