#!/bin/bash
#
# Record system audio via BlackHole for meeting transcription fallback.
#
# Usage:
#   ./record.sh start    # Begin recording (runs health check first)
#   ./record.sh stop     # Stop recording and transcribe
#   ./record.sh check    # Verify audio routing is working
#   ./record.sh test     # Record 5 seconds and report audio levels
#

set -euo pipefail

RECORDINGS_DIR="${HOME}/Desktop/Meeting Transcripts/recordings"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/.venv"
VENV_PYTHON="${VENV_DIR}/bin/python"

mkdir -p "$RECORDINGS_DIR"

TIMESTAMP=$(date +"%Y-%m-%d_%H-%M")
RECORDING_FILE="${RECORDINGS_DIR}/${TIMESTAMP}_recording.wav"
PID_FILE="${RECORDINGS_DIR}/.recording.pid"
RECORDING_PATH_FILE="${RECORDINGS_DIR}/.recording.path"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ─── Health Check ─────────────────────────────────────────────────────

check_audio_routing() {
  echo "Checking audio setup..."

  # 1. Verify BlackHole is installed
  if ! system_profiler SPAudioDataType 2>/dev/null | grep -qi "BlackHole"; then
    echo -e "${RED}✗ BlackHole not found.${NC}"
    echo "  Run: brew install blackhole-2ch"
    return 1
  fi
  echo -e "  ${GREEN}✓${NC} BlackHole driver installed"

  # 2. Check if BlackHole is part of current output device
  CURRENT_OUTPUT=$(system_profiler SPAudioDataType 2>/dev/null | grep -A2 "Default Output Device" | tail -1 | xargs 2>/dev/null || echo "unknown")
  echo "  Current output: ${CURRENT_OUTPUT}"

  # 3. Check if sox can see BlackHole as input
  if command -v sox &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} sox available"
  else
    echo -e "${RED}✗ sox not found.${NC} Run: brew install sox"
    return 1
  fi

  # 4. Check system input device includes BlackHole
  if system_profiler SPAudioDataType 2>/dev/null | grep -qi "BlackHole"; then
    echo -e "  ${GREEN}✓${NC} BlackHole available as audio device"
  fi

  # 5. Warn if Multi-Output Device might not be configured
  if ! system_profiler SPAudioDataType 2>/dev/null | grep -qi "Multi-Output"; then
    echo -e "  ${YELLOW}! Multi-Output Device not detected.${NC}"
    echo "    You may not hear audio while recording."
    echo "    Open Audio MIDI Setup → Create Multi-Output Device"
    echo "    (BlackHole + your speakers)"
  else
    echo -e "  ${GREEN}✓${NC} Multi-Output Device configured"
  fi

  return 0
}

# Record 5 seconds and check if audio was actually captured
test_audio() {
  echo "Recording 5 seconds of audio to test levels..."
  TEST_FILE="${RECORDINGS_DIR}/.test_recording.wav"

  # Record 5 seconds
  timeout 6 sox -d -r 16000 -c 1 -b 16 "$TEST_FILE" trim 0 5 2>/dev/null || true

  if [ ! -f "$TEST_FILE" ]; then
    echo -e "${RED}✗ Failed to create test recording.${NC}"
    echo "  Make sure your system input is set to BlackHole 2ch."
    return 1
  fi

  # Check file size (silence = very small file)
  FILE_SIZE=$(stat -f%z "$TEST_FILE" 2>/dev/null || echo "0")
  if [ "$FILE_SIZE" -lt 1000 ]; then
    echo -e "${RED}✗ Recording is empty (${FILE_SIZE} bytes).${NC}"
    echo "  BlackHole is not receiving audio from Chrome."
    echo "  Make sure your system output is set to the Multi-Output Device."
    rm -f "$TEST_FILE"
    return 1
  fi

  # Check RMS level with sox
  STATS=$(sox "$TEST_FILE" -n stat 2>&1 || true)
  RMS=$(echo "$STATS" | grep "RMS.*amplitude" | head -1 | awk '{print $NF}')

  if [ -n "$RMS" ]; then
    # RMS below 0.001 means essentially silence
    IS_SILENT=$(python3 -c "print('yes' if float('${RMS}') < 0.001 else 'no')" 2>/dev/null || echo "unknown")
    if [ "$IS_SILENT" = "yes" ]; then
      echo -e "${YELLOW}! Audio level is very low (RMS: ${RMS}).${NC}"
      echo "  This might be silence. Make sure audio is playing in Chrome."
      echo "  If a meeting is active with people speaking, your audio routing may be broken."
    else
      echo -e "${GREEN}✓ Audio detected (RMS: ${RMS})${NC}"
    fi
  fi

  rm -f "$TEST_FILE"
  return 0
}

# ─── Start Recording ──────────────────────────────────────────────────

start_recording() {
  if [ -f "$PID_FILE" ]; then
    echo "Recording already in progress (PID: $(cat "$PID_FILE"))"
    echo "Run: $0 stop"
    exit 1
  fi

  # Run health check first
  if ! check_audio_routing; then
    echo ""
    echo -e "${RED}Audio setup check failed. Fix the issues above and try again.${NC}"
    exit 1
  fi

  echo ""
  echo "Starting recording..."
  echo "Output: $RECORDING_FILE"

  # Record from default input (should be BlackHole if configured correctly)
  sox -d -r 16000 -c 1 -b 16 "$RECORDING_FILE" &
  SOX_PID=$!
  echo $SOX_PID > "$PID_FILE"
  echo "$RECORDING_FILE" > "$RECORDING_PATH_FILE"

  # Verify sox started successfully
  sleep 1
  if ! kill -0 "$SOX_PID" 2>/dev/null; then
    echo -e "${RED}✗ Recording failed to start.${NC}"
    rm -f "$PID_FILE" "$RECORDING_PATH_FILE"
    exit 1
  fi

  echo -e "${GREEN}● Recording (PID: ${SOX_PID})${NC}"
  echo ""
  echo "Run '$0 stop' to stop and transcribe."
  echo "Or press Ctrl+C."

  # Trap Ctrl+C
  trap 'stop_recording; exit 0' INT TERM
  wait "$SOX_PID" 2>/dev/null || true
}

# ─── Stop Recording ───────────────────────────────────────────────────

stop_recording() {
  if [ ! -f "$PID_FILE" ]; then
    echo "No recording in progress."
    exit 1
  fi

  PID=$(cat "$PID_FILE")
  echo "Stopping recording (PID: $PID)..."
  kill "$PID" 2>/dev/null || true
  sleep 1

  # Get the recording path
  if [ -f "$RECORDING_PATH_FILE" ]; then
    LATEST=$(cat "$RECORDING_PATH_FILE")
  else
    LATEST=$(ls -t "${RECORDINGS_DIR}"/*.wav 2>/dev/null | head -1)
  fi

  rm -f "$PID_FILE" "$RECORDING_PATH_FILE"

  if [ -z "$LATEST" ] || [ ! -f "$LATEST" ]; then
    echo -e "${RED}No recording file found.${NC}"
    exit 1
  fi

  # Check recording isn't empty
  FILE_SIZE=$(stat -f%z "$LATEST" 2>/dev/null || echo "0")
  DURATION_INFO=$(sox --i -D "$LATEST" 2>/dev/null || echo "0")
  echo "Recording saved: $LATEST"
  echo "Duration: ${DURATION_INFO}s | Size: ${FILE_SIZE} bytes"

  if [ "$FILE_SIZE" -lt 10000 ]; then
    echo -e "${YELLOW}! Recording is very small — may be empty/silent.${NC}"
    echo "  Check your audio routing before the next meeting."
  fi

  echo ""
  echo "Processing with Whisper + pyannote..."

  # Use venv python if available, else system python
  if [ -f "$VENV_PYTHON" ]; then
    "$VENV_PYTHON" "${SCRIPT_DIR}/transcribe.py" "$LATEST"
  else
    python3 "${SCRIPT_DIR}/transcribe.py" "$LATEST"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────

case "${1:-start}" in
  start)
    start_recording
    ;;
  stop)
    stop_recording
    ;;
  check)
    check_audio_routing
    echo ""
    echo "Run '$0 test' to record 5 seconds and verify audio levels."
    ;;
  test)
    check_audio_routing
    echo ""
    test_audio
    ;;
  *)
    echo "Usage: $0 {start|stop|check|test}"
    echo ""
    echo "  start  — Begin recording (health check runs first)"
    echo "  stop   — Stop recording and auto-transcribe"
    echo "  check  — Verify audio routing is configured correctly"
    echo "  test   — Record 5 seconds and check audio levels"
    exit 1
    ;;
esac
