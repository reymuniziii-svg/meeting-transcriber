# Meeting Transcriber

Privacy-first Chrome extension that captures meeting tab audio, streams it to a local Whisper server on `127.0.0.1`, and merges transcript segments with real speaker names detected from Google Meet, Microsoft Teams, and Zoom web.

No cloud transcription. No meeting bot. Audio stays on your machine.

## Default Operating Mode

On macOS, the production path is:

1. Run `./install.sh` once.
2. Load the extension in Chrome.
3. The local server starts automatically at login through `launchd`.
4. Open a meeting and click `Connect Audio` if Chrome requires a user gesture for tab audio capture.

Manual `./start-server.sh` is now a development fallback, not the primary production workflow.

## File Structure

```text
meeting-transcriber/
├── background.js
├── config/
│   └── server.env.example
├── content-scripts/
│   ├── google-meet.js
│   ├── ms-teams.js
│   └── zoom-web.js
├── docs/
│   └── selector-maintenance.md
├── fallback/
│   ├── requirements.txt
│   └── transcribe.py
├── launchd/
│   └── com.rey.meeting-transcriber.server.plist.template
├── lib/
│   ├── markdown-formatter.js
│   ├── selector-validator.js
│   ├── speaker-tracker.js
│   └── storage.js
├── offscreen.html
├── offscreen.js
├── popup.html
├── popup.js
├── review.html
├── review.js
├── server/
│   ├── transcription-server.py
│   ├── whisper_utils.py
│   └── tests/
│       └── test_whisper_utils.py
├── install.sh
├── manifest.json
└── start-server.sh
```

## Required Installs

Homebrew:

```bash
brew install whisper-cpp
```

Python:

```bash
python3 -m venv fallback/.venv
source fallback/.venv/bin/activate
pip install -r fallback/requirements.txt
```

Chrome:

1. Open `chrome://extensions/`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this repo folder

## Environment Variables

Repo example file:

`/Users/rey/Desktop/meeting-transcriber/config/server.env.example`

Installed local config:

`~/.config/meeting-transcriber/server.env`

Example:

```bash
HF_TOKEN=hf_your_token_here
MEETING_TRANSCRIBER_HOST=127.0.0.1
MEETING_TRANSCRIBER_PORT=9090
MEETING_TRANSCRIBER_LOG_LEVEL=INFO
```

Notes:

- `HF_TOKEN` is optional. If missing, diarization is disabled cleanly and Whisper transcription still works.
- `MEETING_TRANSCRIBER_HOST` must stay `127.0.0.1`. `start-server.sh` refuses other bind addresses.
- LaunchAgents do not reliably inherit shell startup files, so put server config in `~/.config/meeting-transcriber/server.env`, not `.zshrc`.

## How To Run

Production install on macOS:

```bash
./install.sh
```

Development fallback:

```bash
./start-server.sh
```

Health check:

```bash
./install.sh --check
```

Useful log files:

```text
~/Library/Logs/MeetingTranscriber/server.log
~/Library/Logs/MeetingTranscriber/server-error.log
```

## How It Works

```text
Chrome content script
  -> detects meeting state
  -> scrapes participants + active speaker events
  -> sends meeting state to background.js

background.js
  -> persists active meetings by tabId
  -> retries local server reachability before starting capture
  -> coordinates offscreen lifecycle, recovery, finalize, and downloads

offscreen.js
  -> captures tab audio
  -> resamples to 16 kHz mono PCM
  -> streams audio to ws://127.0.0.1:9090
  -> reports terminal states back to the background worker

server/transcription-server.py
  -> buffers PCM windows
  -> runs whisper.cpp
  -> caches Silero VAD once per process
  -> optionally caches pyannote once per process
  -> emits transcription and diarization updates over WebSocket
```

## Permissions, Access, and Auth

Chrome permissions:

- `activeTab`: allows user-initiated capture for the current meeting tab
- `tabCapture`: reads meeting tab audio after Chrome grants permission
- `offscreen`: runs the hidden MV3 audio capture document
- `storage`: persists in-progress meeting state and the last finalized transcript
- `downloads`: writes markdown transcripts to the browser downloads location

Read/write behavior:

- Reads meeting DOM only on supported meeting URLs
- Writes active meeting state to `chrome.storage.local`
- Writes review payload to `lastTranscript` in `chrome.storage.local`
- Writes transcript markdown files through the Chrome Downloads API
- Writes user config to `~/.config/meeting-transcriber/server.env`
- Writes server logs to `~/Library/Logs/MeetingTranscriber/`
- Writes a LaunchAgent plist to `~/Library/LaunchAgents/`

Network/auth flow:

- No OAuth or external REST auth flow is introduced in this pass
- The extension talks only to `ws://127.0.0.1:9090`
- `HF_TOKEN` is only used locally by the Python process if diarization is enabled

API scopes and rate limits:

- No cloud transcription API scopes
- No external API rate limits in the hot path
- Runtime throughput is bounded by local CPU/GPU, Whisper model size, and diarization cost

## Stability Notes

- Only one live capture session is allowed at a time in this pass.
- Active meetings are persisted by `tabId` in `currentMeetingsByTabId`.
- The service worker rehydrates active meetings from storage after restarts.
- Review-page corrected saves use a deterministic `-corrected` suffix to avoid clobbering the first saved transcript.
- The Python server keeps at most `2700` seconds of PCM audio in memory by default. That is roughly 86 MB of raw mono 16 kHz 16-bit PCM before Python overhead.

## Security Considerations

- The localhost WebSocket is intentionally unauthenticated, so it must remain bound to `127.0.0.1` only.
- Launchd config is per-user, not system-wide.
- Meeting content stays local unless you manually move exported files elsewhere.
- `HF_TOKEN` should live in `~/.config/meeting-transcriber/server.env`, not inside repo files.
- Review rendering now uses DOM node creation and `textContent` instead of raw `innerHTML`, which prevents participant-name markup injection from rendering as HTML.

## Verification

Quick checks:

```bash
./install.sh --check
python3 -m unittest discover -s server/tests
```

Manual acceptance targets for this pass:

1. Install on macOS, log out/in, and confirm the server is listening on `127.0.0.1:9090` without manually running `./start-server.sh`.
2. Kill the Python server process and confirm `launchd` restarts it.
3. Start capture with the server available and confirm the popup shows `Meeting detected` and a stable capture state.
4. Start capture with the server temporarily down and confirm the popup waits briefly, then shows a clear failure.
5. End a meeting or close the tab abruptly and confirm the final transcript includes the last spoken segment.
6. Save a corrected transcript and confirm success appears only after the download request succeeds.

## License

MIT
