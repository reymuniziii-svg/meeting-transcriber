# Meeting Transcriber

A Chrome extension that transcribes your Google Meet, Microsoft Teams, and Zoom web calls locally, then labels each line with the real speaker names pulled from the meeting UI. No cloud transcription service, no meeting bot, no audio leaving your machine.

It is a local-install project, not a hosted app. On macOS you run `./install.sh` once, load the extension in Chrome, and a Whisper server runs in the background bound to `127.0.0.1`. Install steps are below.

## Why local-only

Most meeting transcribers either join your call as a visible bot or ship your audio to a third-party API. This one does neither. The extension captures tab audio in the browser and streams it to a Whisper server running on your own machine, over a loopback WebSocket that is never exposed to the network.

Data flow:

```text
Chrome content script   reads participant + active-speaker info from the meeting page
        |
background.js           tracks the active meeting, checks the local server is up
        |
offscreen.js            captures tab audio, resamples to 16 kHz mono PCM
        |
ws://127.0.0.1:9090     loopback WebSocket, never bound to a public interface
        |
transcription-server.py runs whisper.cpp, merges speaker names, returns transcript
```

The only network calls are to `127.0.0.1`. Transcripts are written to your browser's downloads folder as Markdown. Nothing is uploaded unless you move a file yourself.

## Stack

- Chrome extension: Manifest V3, plain JavaScript (service worker, offscreen document, content scripts). No build step, no bundler.
- Transcription server: Python, `whisper.cpp` via the `whisper-cpp` Homebrew binary, served over a `websockets` WebSocket on `127.0.0.1:9090`.
- Speaker diarization: optional, via `pyannote.audio`. Off by default and only used when an `HF_TOKEN` is set.
- Auto-start on macOS: a per-user `launchd` agent.

## Install (macOS)

```bash
./install.sh
```

The installer is idempotent and runs five steps: install `whisper.cpp`, fetch a Whisper model, create the Python virtualenv in `fallback/.venv` and install dependencies, register the `launchd` agent so the server starts at login, and create a config file at `~/.config/meeting-transcriber/server.env`.

Then load the extension:

1. Open `chrome://extensions/`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this repository folder

Check the install at any time:

```bash
./install.sh --check
```

For development, you can run the server in the foreground instead of through `launchd`:

```bash
./start-server.sh
```

`start-server.sh` refuses to bind to anything other than `127.0.0.1`.

## Configuration

The installer copies `config/server.env.example` to `~/.config/meeting-transcriber/server.env`. The server reads config from that installed file, not from your shell profile, because `launchd` agents do not reliably inherit shell startup files.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `MEETING_TRANSCRIBER_HOST` | no | `127.0.0.1` | Must stay `127.0.0.1`. The server refuses any other bind address. |
| `MEETING_TRANSCRIBER_PORT` | no | `9090` | WebSocket port. |
| `MEETING_TRANSCRIBER_LOG_LEVEL` | no | `INFO` | Standard Python log levels. |
| `HF_TOKEN` | no | unset | Optional. Enables `pyannote` speaker diarization. If unset, diarization is skipped cleanly and Whisper transcription still works. |

`HF_TOKEN` is optional and is only used by the local Python process. To enable diarization, create a Hugging Face token, accept the `pyannote/speaker-diarization-3.1` terms, and set it in your installed config file:

```bash
HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Do not commit a real token. Keep it in `~/.config/meeting-transcriber/server.env`, never in the repo.

## How capture works

- A content script detects the meeting and scrapes participants and active-speaker events on supported URLs only.
- `background.js` persists active meetings by `tabId` and rehydrates them if the service worker restarts.
- `offscreen.js` runs the hidden MV3 document that captures and resamples tab audio.
- `transcription-server.py` buffers PCM windows, runs `whisper.cpp`, caches Silero VAD once per process, and merges transcript segments with the scraped speaker names.

Only one capture session runs at a time. Corrected saves from the review page use a `-corrected` suffix so they never overwrite the first transcript.

## Tests

```bash
node --test tests/                          # extension behavior tests
python3 -m unittest discover -s server/tests # server tests
```

## Logs

```text
~/Library/Logs/MeetingTranscriber/server.log
~/Library/Logs/MeetingTranscriber/server-error.log
```

## Security notes

- The localhost WebSocket is intentionally unauthenticated, so it must stay bound to `127.0.0.1`. `start-server.sh` enforces this.
- The `launchd` agent is per-user, not system-wide.
- The review page renders participant names with `textContent`, not `innerHTML`, so names cannot inject markup.
- Meeting content stays on your machine unless you move an exported file yourself.

## License

MIT. See [LICENSE](LICENSE).
