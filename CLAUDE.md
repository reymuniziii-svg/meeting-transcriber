# CLAUDE.md

## About this repo

**What it does:** Privacy-first Chrome MV3 extension that captures meeting *tab audio* on Google Meet, Microsoft Teams, and Zoom web, streams 16 kHz mono PCM to a **local** Python WebSocket server (`ws://127.0.0.1:9090`) that runs **whisper.cpp** for transcription (with Silero VAD and optional pyannote diarization), and merges the transcript with **real speaker names** scraped from the meeting UI. No cloud transcription, no meeting bot — audio stays on the machine. Finished transcripts are written as Markdown via the Chrome Downloads API and can be corrected on a post-meeting review page.

**Stack:**
- Extension (vanilla JS, MV3): `background.js` service worker (capture lifecycle + state), `offscreen.js` (tab-audio capture → PCM → WebSocket), per-platform content scripts in `content-scripts/`, shared `lib/` (speaker-tracker, markdown-formatter, selector-validator, storage), `popup.*`, `review.*`.
- Local server (Python 3): `server/transcription-server.py` (asyncio + `websockets`), `server/whisper_utils.py` (whisper.cpp subprocess, Silero VAD, pyannote). Deps: `whisper-cpp` (Homebrew), torch/torchaudio, optional `pyannote.audio`.
- Ops: macOS `launchd` LaunchAgent for auto-start; Bash `install.sh` / `start-server.sh`.

**Commands:**
- Install: `./install.sh` (installs whisper-cpp, downloads a model, creates venv + `pip install -r fallback/requirements.txt`, writes config + launchd agent).
- Build: none — load unpacked at `chrome://extensions/`.
- Test: `python3 -m unittest discover -s server/tests`.
- Run: launchd auto-start at login, or `./start-server.sh` (dev fallback).
- Health check: `./install.sh --check`.

**Riskiest area:** The `background.js` service-worker state machine (capture start/stop/finalize/recovery, meeting state persisted by `tabId`, single-capture invariant) and the **unauthenticated localhost WebSocket boundary** — the Python server enforces no `Origin` check and only the shell wrapper (`start-server.sh`), not the server itself, enforces the `127.0.0.1` bind.
