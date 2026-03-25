# Meeting Transcriber

Privacy-first Chrome extension that captures meeting tab audio, sends it to a local Whisper server, and merges the transcript with real speaker names scraped from Google Meet, Microsoft Teams, and Zoom web.

No cloud transcription. No bots. Everything stays on your machine.

## Quick Start

```bash
git clone https://github.com/reymuniziii-svg/meeting-transcriber.git
cd meeting-transcriber
./install.sh
./start-server.sh
```

Then:

1. Open `chrome://extensions/`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this folder
5. Join a supported meeting
6. Open the extension popup and click `Connect Audio` if Chrome requires a user gesture

## How It Works

```text
Chrome content script
  -> detects meeting state
  -> scrapes participant names + active speaker changes
  -> sends speaker events to background.js

background.js
  -> requests tabCapture stream ID
  -> creates offscreen document
  -> collects speaker timeline + Whisper results
  -> merges transcript text with real names
  -> saves markdown + opens review page

offscreen.js
  -> captures tab audio
  -> resamples to 16 kHz mono PCM
  -> streams audio to ws://127.0.0.1:9090

server/transcription-server.py
  -> buffers audio windows
  -> runs whisper.cpp
  -> optionally runs pyannote diarization
  -> sends timestamped JSON back to the extension
```

## File Structure

```text
meeting-transcriber/
├── manifest.json
├── background.js
├── offscreen.html
├── offscreen.js
├── popup.html
├── popup.js
├── review.html
├── review.js
├── start-server.sh
├── install.sh
├── content-scripts/
│   ├── google-meet.js
│   ├── ms-teams.js
│   └── zoom-web.js
├── lib/
│   ├── markdown-formatter.js
│   ├── selector-validator.js
│   ├── speaker-tracker.js
│   └── storage.js
├── server/
│   ├── transcription-server.py
│   └── whisper_utils.py
├── fallback/
│   ├── requirements.txt
│   └── transcribe.py
└── docs/
    └── selector-maintenance.md
```

## Required Installs

Homebrew packages:

```bash
brew install whisper-cpp
```

Python packages:

```bash
python3 -m venv fallback/.venv
source fallback/.venv/bin/activate
pip install -r fallback/requirements.txt
```

## Environment Variables

Required for pyannote diarization only:

```bash
export HF_TOKEN="hf_your_token_here"
```

If `HF_TOKEN` is missing, Whisper transcription still works. Speaker diarization falls back to DOM speaker events only.

## How To Run

```bash
./install.sh
./start-server.sh
```

Optional server flags:

```bash
./start-server.sh --prompt "Weekly product planning meeting"
./start-server.sh --vocab "Cadwraethwr,SQLx,Pyannote"
```

Health check:

```bash
./install.sh --check
```

## Chrome Permissions And Local Access

- `activeTab`: lets the popup initiate capture for the current meeting tab
- `tabCapture`: reads tab audio only after Chrome grants capture
- `offscreen`: runs the hidden audio-processing document required by MV3
- `storage`: saves meeting state for crash recovery and review
- `downloads`: writes markdown transcripts to your downloads folder

Read/write behavior:

- Reads meeting DOM only on supported meeting URLs
- Writes transcript files through the Chrome downloads API
- Writes in-progress state to `chrome.storage.local`
- Opens a local WebSocket connection to `ws://127.0.0.1:9090`

Authentication flow:

- No app login
- No external API auth for Whisper
- Optional Hugging Face token for pyannote model download/use

Rate limits:

- No cloud API rate limits
- Throughput is limited by your local CPU/GPU and Whisper model size

## Security Considerations

- The Whisper server binds to `127.0.0.1` by default, not the public network
- The extension talks only to your local server over localhost WebSocket
- There is no transport auth on the localhost WebSocket, so keep it bound to localhost only
- Meeting audio and transcripts remain on-device unless you manually move the files elsewhere
- `HF_TOKEN` should be stored in your shell profile, not hard-coded in repo files

## Output

Markdown transcripts are saved to Chrome’s configured downloads location using filenames like:

```text
Meeting Transcripts/2026-03-24_14-30_google-meet_weekly-planning.md
```

## Verification Checklist

1. `./start-server.sh` starts and listens on port `9090`
2. The popup shows `Whisper server: Connected`
3. Joining a meeting changes the popup state to `Meeting detected`
4. Clicking `Connect Audio` changes capture status to `Connected`
5. Segment count increases during speech
6. Ending the meeting saves a markdown transcript and opens the review page

## Notes

- Google Meet, Teams, and Zoom DOM selectors can drift over time. See `docs/selector-maintenance.md`.
- The extension currently supports one live audio capture session at a time.

## License

MIT
