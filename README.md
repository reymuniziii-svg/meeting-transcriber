# Meeting Transcriber

Free, privacy-first Chrome extension that auto-captures meeting transcripts with speaker names from **Google Meet**, **Microsoft Teams**, and **Zoom** (browser-based).

No bots. No cloud APIs. No subscriptions. Everything runs locally.

## Quick Start

```bash
git clone https://github.com/reymuniziii-svg/meeting-transcriber.git
cd meeting-transcriber
./install.sh
```

Then load the Chrome extension:

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `meeting-transcriber` folder
4. Set Chrome's download folder to `~/Desktop/` (Settings → Downloads)

**Done.** Join a meeting — transcription starts automatically.

## How It Works

**Primary mode**: The extension scrapes native captions from each platform's UI using DOM observation. Since it reads the platform's own captions, speaker names come for free.

**Whisper fallback**: For meetings without captions, an optional local pipeline records audio via BlackHole, transcribes with whisper.cpp, and identifies speakers with pyannote — all on-device.

## Features

- **Three platforms**: Google Meet, Microsoft Teams (web), Zoom (web client)
- **Speaker attribution**: Captures who said what, not just text
- **Auto-start**: Detects meeting join, auto-enables captions when possible
- **Markdown output**: Clean files with metadata, saved to `~/Desktop/Meeting Transcripts/`
- **Post-meeting review**: Verify and correct speaker names after each meeting
- **Selector validation**: Warns you if platform UI changes break the extension
- **Whisper fallback**: Local transcription with VAD, hallucination filtering, custom vocabulary
- **Audio health check**: Verifies your recording setup before you start
- **Crash recovery**: Persists transcript to Chrome storage in case of tab crash
- **Zero cost**: No API keys, no subscriptions, no cloud services

## Output

```markdown
# Meeting Transcript

- **Date**: Monday, March 24, 2026
- **Platform**: Google Meet
- **Duration**: 45 minutes
- **Participants**: Alice, Bob, Carol

---

## Transcript

**Alice** (10:00 AM)
Welcome everyone, let's get started with the project update.

**Bob** (10:01 AM)
The backend migration is 80% complete.
```

Files are named: `YYYY-MM-DD_HH-MM_platform_meeting-title.md`

## Platform Notes

| Platform | Auto-Enable Captions | Notes |
|----------|---------------------|-------|
| Google Meet | Yes (clicks CC button) | Works with free and Workspace accounts |
| Microsoft Teams | Yes (keyboard shortcut) | Must use web client, not desktop app |
| Zoom | No | Host must enable live transcription |

## Whisper Fallback

For meetings where captions aren't available:

```bash
# Verify your audio setup
./fallback/record.sh check

# Test audio levels (records 5 seconds)
./fallback/record.sh test

# Record a meeting
./fallback/record.sh start    # Begin
./fallback/record.sh stop     # Stop & auto-transcribe
```

Custom vocabulary for better accuracy with domain terms:

```bash
python3 fallback/transcribe.py recording.wav --vocab "Kubernetes,PRAI,rmOS"
python3 fallback/transcribe.py recording.wav --prompt "Sprint planning for the PRAI product"
```

The fallback pipeline includes:
- **Voice Activity Detection** (Silero VAD) — skips silence, prevents hallucinations
- **Hallucination filtering** — removes repeated phrases, phantom text during quiet periods
- **Timestamp alignment** — 500ms tolerance window for matching speech to speakers
- **Quality report** — shows speaker distribution, confidence scores, and warnings

See [docs/whisper-fallback.md](docs/whisper-fallback.md) for detailed setup.

## Mitigations for Known Issues

| Issue | Mitigation |
|-------|-----------|
| Whisper hallucinations during silence | Silero VAD pre-filters silent segments; pattern-based hallucination removal |
| Speaker misattribution | Post-meeting review page lets you correct names before final save |
| Audio routing breaks (AirPods, sleep) | `record.sh check` and `record.sh test` verify setup before recording |
| Platform UI changes break selectors | Selector validator warns on load; selectors use semantic attributes where possible |
| Jargon/proper nouns transcribed wrong | `--vocab` and `--prompt` flags prime Whisper with your terminology |
| Timestamp misalignment Whisper↔pyannote | 500ms tolerance window with weighted overlap scoring |

## Install Verification

```bash
./install.sh --check
```

Shows the status of every dependency with clear fix instructions for anything missing.

## Architecture

```
meeting-transcriber/
├── manifest.json              # Chrome extension manifest (V3)
├── background.js              # Service worker: file saving, state, review
├── popup.html/js              # Extension popup UI
├── review.html/js             # Post-meeting speaker name review
├── content-scripts/
│   ├── google-meet.js         # Meet caption DOM observer
│   ├── ms-teams.js            # Teams caption DOM observer
│   └── zoom-web.js            # Zoom web caption DOM observer
├── lib/
│   ├── caption-parser.js      # Unified dedup & buffering
│   ├── markdown-formatter.js  # Transcript → markdown
│   ├── selector-validator.js  # DOM selector health checks
│   └── storage.js             # Chrome storage persistence
├── fallback/                  # Whisper pipeline
│   ├── record.sh              # Audio recording with health checks
│   ├── transcribe.py          # Whisper + pyannote + VAD + filtering
│   ├── requirements.txt       # Python dependencies
│   └── setup.sh               # Dependency installer
├── install.sh                 # One-command setup
└── docs/
    ├── whisper-fallback.md    # Fallback setup guide
    └── selector-maintenance.md # DOM selector update guide
```

## Contributing

DOM selectors break when platforms update their UI. If transcription stops working:

1. Open the meeting in Chrome DevTools
2. Find the new captions container / speaker name elements
3. Update the `SELECTORS` object in the relevant content script
4. Submit a PR

See [docs/selector-maintenance.md](docs/selector-maintenance.md) for a walkthrough.

## Privacy

- All processing happens locally — browser or on-device
- No data sent to any external server
- No analytics or telemetry
- Transcripts stored only on your machine

## Requirements

- macOS (Apple Silicon recommended)
- Chrome browser
- Homebrew (for Whisper fallback dependencies)
- Python 3.8+ (for Whisper fallback)

## License

MIT
