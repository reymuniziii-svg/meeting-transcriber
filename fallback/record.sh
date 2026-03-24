#!/bin/bash
#
# Record system audio via BlackHole for meeting transcription fallback.
#
# Prerequisites:
#   brew install blackhole-2ch
#   brew install sox  (or ffmpeg)
#
# Setup (one-time):
#   1. Open Audio MIDI Setup (Applications > Utilities)
#   2. Click "+" > Create Multi-Output Device
#   3. Check both "BlackHole 2ch" and your speakers/headphones
#   4. Set this Multi-Output Device as your system output
#   5. Now Chrome audio goes to both your ears AND BlackHole
#
# Usage:
#   ./record.sh start   # Begin recording
#   ./record.sh stop    # Stop recording and process
#

RECORDINGS_DIR="${HOME}/Desktop/Meeting Transcripts/recordings"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$RECORDINGS_DIR"

TIMESTAMP=$(date +"%Y-%m-%d_%H-%M")
RECORDING_FILE="${RECORDINGS_DIR}/${TIMESTAMP}_recording.wav"
PID_FILE="${RECORDINGS_DIR}/.recording.pid"

case "${1:-start}" in
  start)
    if [ -f "$PID_FILE" ]; then
      echo "Recording already in progress (PID: $(cat "$PID_FILE"))"
      echo "Run: $0 stop"
      exit 1
    fi

    echo "Starting recording via BlackHole..."
    echo "Output: $RECORDING_FILE"
    echo "Press Ctrl+C or run '$0 stop' to finish."

    # Record from BlackHole input
    # sox: record from BlackHole 2ch device
    if command -v sox &> /dev/null; then
      sox -d -r 16000 -c 1 -b 16 "$RECORDING_FILE" &
      echo $! > "$PID_FILE"
      echo "Recording started (PID: $!). Using sox."
    elif command -v ffmpeg &> /dev/null; then
      ffmpeg -f avfoundation -i ":BlackHole 2ch" -ar 16000 -ac 1 "$RECORDING_FILE" &
      echo $! > "$PID_FILE"
      echo "Recording started (PID: $!). Using ffmpeg."
    else
      echo "Error: Neither sox nor ffmpeg found."
      echo "Install with: brew install sox"
      exit 1
    fi

    # Trap Ctrl+C to stop gracefully
    trap "$0 stop; exit 0" INT TERM
    wait
    ;;

  stop)
    if [ ! -f "$PID_FILE" ]; then
      echo "No recording in progress."
      exit 1
    fi

    PID=$(cat "$PID_FILE")
    echo "Stopping recording (PID: $PID)..."
    kill "$PID" 2>/dev/null
    rm -f "$PID_FILE"

    # Find the most recent recording
    LATEST=$(ls -t "${RECORDINGS_DIR}"/*.wav 2>/dev/null | head -1)
    if [ -z "$LATEST" ]; then
      echo "No recording file found."
      exit 1
    fi

    echo "Recording saved: $LATEST"
    echo ""
    echo "Processing with Whisper + pyannote..."
    python3 "${SCRIPT_DIR}/transcribe.py" "$LATEST"
    ;;

  *)
    echo "Usage: $0 {start|stop}"
    exit 1
    ;;
esac
