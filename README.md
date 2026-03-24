# Meeting Transcriber

A free, privacy-first Chrome extension that automatically captures meeting transcripts with speaker names from **Google Meet**, **Microsoft Teams**, and **Zoom** (browser-based).

No bots. No cloud APIs. No subscriptions. Everything runs locally in your browser.

## How It Works

The extension scrapes native captions directly from each meeting platform's UI using DOM observation. When you join a meeting with captions enabled, it:

1. Detects which platform you're on
2. Auto-enables captions (when possible)
3. Captures speaker names and their words in real-time
4. Saves a clean markdown transcript when the meeting ends

Since it reads the platform's own captions, you get the same quality transcription the platform provides — with speaker attribution included.

## Features

- **Three platforms**: Google Meet, Microsoft Teams (web), Zoom (web client)
- **Speaker names**: Captures who said what, not just the text
- **Auto-start**: Detects when you join a meeting and begins capturing
- **Markdown output**: Clean, readable transcript files with metadata
- **Crash recovery**: Persists transcript to Chrome storage in case of tab crash
- **Whisper fallback**: Optional local transcription pipeline for meetings without captions
- **Zero cost**: No API keys, no subscriptions, no cloud services

## Quick Start

### 1. Install the Extension

1. Clone this repo or [download the ZIP](../../archive/refs/heads/main.zip)
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select the `meeting-transcriber` folder
5. Pin the extension to your toolbar for easy access

### 2. Set Your Download Folder

So transcripts save to your Desktop:

1. Open Chrome Settings → Downloads
2. Set download location to `~/Desktop/`
3. Transcripts will save to `Desktop/Meeting Transcripts/`

### 3. Join a Meeting

That's it. Join any meeting in Google Meet, Teams, or Zoom web — the extension handles the rest.

> **Note**: Captions/live transcription must be enabled in the meeting. The extension will attempt to auto-enable them, but some platforms require the host to turn on this feature.

## Output Format

Transcripts are saved as markdown files with this structure:

```markdown
# Meeting Transcript

- **Date**: Monday, March 24, 2026
- **Time**: 10:00 AM
- **Platform**: Google Meet
- **Title**: Weekly Standup
- **Duration**: 45 minutes
- **Participants**: Alice, Bob, Carol

---

## Transcript

**Alice** (10:00 AM)
Welcome everyone, let's get started with the project update.

**Bob** (10:01 AM)
Thanks Alice. The backend migration is 80% complete.

**Carol** (10:03 AM)
I have a question about the timeline.
```

Files are named: `YYYY-MM-DD_HH-MM_platform_meeting-title.md`

## Platform Notes

| Platform | Captions Source | Auto-Enable | Notes |
|----------|----------------|-------------|-------|
| Google Meet | Built-in captions | Yes (clicks CC button) | Works with free and Workspace accounts |
| Microsoft Teams | Live captions | Yes (keyboard shortcut) | Must use web client (teams.microsoft.com) |
| Zoom | Live transcription | No | Host must enable live transcription in Zoom settings |

### Google Meet
- Works automatically when you join a meeting
- Captions must be available (most accounts have this)
- "You" is automatically replaced with your display name

### Microsoft Teams
- Use the **web client** (teams.microsoft.com), not the desktop app
- The extension sends `Cmd+Shift+A` (Mac) to toggle captions on
- Supports speaker aliasing if names appear differently

### Zoom Web Client
- You must join via browser (app.zoom.us), not the desktop app
- The **host** must enable "Live Transcription" in their Zoom settings
- Speaker names are matched via avatar images when text names aren't available

## Whisper Fallback (Optional)

For meetings where captions aren't available, there's an optional local transcription pipeline using whisper.cpp and pyannote speaker diarization.

See [docs/whisper-fallback.md](docs/whisper-fallback.md) for setup instructions.

**What it does**: Records system audio via BlackHole, transcribes with Whisper, identifies speakers with pyannote — all locally on your Mac.

**Trade-off**: Gives "Speaker 1", "Speaker 2" labels instead of real names (since it's working from audio alone, not the meeting UI).

## Privacy

- All processing happens locally in your browser
- No data is sent to any server
- No analytics, no telemetry
- Transcripts are stored only on your machine
- The extension only activates on meeting URLs

## Requirements

- macOS (tested on Apple Silicon M-series)
- Chrome browser
- Meeting platform accounts with caption access

## Troubleshooting

**Captions aren't being captured**
- Make sure captions/live transcription is turned on in the meeting
- Check the extension popup — it should show "Recording..." with a red dot
- Refresh the page and rejoin if the extension loaded after the meeting started

**Speaker names show as "Unknown Speaker"**
- The platform may have changed its DOM structure
- Open an issue with the platform name and Chrome version

**Transcript didn't save automatically**
- Click the extension icon and use "Download Transcript" to save manually
- Check that Chrome's download folder is set correctly

**Extension not loading**
- Go to `chrome://extensions/` and check for errors
- Make sure Developer mode is enabled
- Try removing and re-loading the extension

## Architecture

```
meeting-transcriber/
├── manifest.json              # Chrome extension manifest (V3)
├── background.js              # Service worker: file saving, state
├── popup.html/js              # Extension popup UI
├── content-scripts/
│   ├── google-meet.js         # Meet caption DOM observer
│   ├── ms-teams.js            # Teams caption DOM observer
│   └── zoom-web.js            # Zoom web caption DOM observer
├── lib/
│   ├── caption-parser.js      # Unified dedup & buffering
│   ├── markdown-formatter.js  # Transcript → markdown
│   └── storage.js             # Chrome storage persistence
├── fallback/                  # Optional Whisper pipeline
│   ├── setup.sh               # One-time dependency install
│   ├── record.sh              # Start/stop audio recording
│   └── transcribe.py          # Whisper + pyannote processing
└── docs/
    ├── whisper-fallback.md    # Fallback setup guide
    └── selector-maintenance.md # Guide for updating DOM selectors
```

## Contributing

DOM selectors break when platforms update their UI. If you notice broken capture on any platform:

1. Open the meeting in Chrome DevTools
2. Find the captions container and speaker name elements
3. Update the `SELECTORS` object at the top of the relevant content script
4. Submit a PR

See [docs/selector-maintenance.md](docs/selector-maintenance.md) for a detailed guide.

## License

MIT
