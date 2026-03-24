# Whisper Fallback Setup

The Whisper fallback pipeline provides local transcription with speaker diarization for meetings where native captions aren't available (e.g., Zoom host hasn't enabled live transcription).

It runs entirely on your Mac — no cloud services involved.

## What You Get

- **Transcription**: whisper.cpp with Metal GPU acceleration on Apple Silicon
- **Speaker diarization**: pyannote identifies who spoke when
- **Output**: Same markdown format as the Chrome extension
- **Performance**: ~4 minutes to process a 1-hour meeting on M4

## Prerequisites

- macOS with Apple Silicon (M1/M2/M3/M4)
- Homebrew installed
- Python 3.8+
- Free HuggingFace account

## Automated Setup

Run the setup script to install everything at once:

```bash
cd meeting-transcriber/fallback
./setup.sh
```

This installs:
- BlackHole 2ch (virtual audio driver)
- sox (audio recording)
- whisper.cpp (transcription)
- whisper base.en model (142MB)
- pyannote.audio (speaker diarization)

## Manual Setup

### 1. BlackHole (Virtual Audio Driver)

BlackHole lets you capture audio from Chrome without external hardware.

```bash
brew install blackhole-2ch
```

After installing, configure audio routing:

1. Open **Audio MIDI Setup** (Applications → Utilities)
2. Click **+** at the bottom left → **Create Multi-Output Device**
3. Check both **BlackHole 2ch** and your speakers/headphones
4. Right-click the Multi-Output Device → **Use This Device For Sound Output**

Now Chrome audio goes to both your ears AND BlackHole (where it can be recorded).

### 2. Sox (Audio Recording)

```bash
brew install sox
```

### 3. Whisper.cpp (Transcription)

```bash
brew install whisper-cpp
```

Download a model (base.en for speed, medium.en for quality):

```bash
# Fast, good enough for most meetings (142MB)
whisper-cpp-download-ggml-model base.en

# Better quality, slower (1.5GB)
whisper-cpp-download-ggml-model medium.en
```

### 4. Pyannote (Speaker Diarization)

```bash
pip3 install pyannote.audio torch torchaudio
```

### 5. HuggingFace Token

Pyannote requires a free HuggingFace token:

1. Create an account at [huggingface.co](https://huggingface.co)
2. Accept the model terms at [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
3. Create a token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
4. Add to your shell profile:

```bash
# Add to ~/.zshrc or ~/.bashrc
export HF_TOKEN="hf_your_token_here"
```

## Usage

### Start Recording

```bash
cd meeting-transcriber/fallback
./record.sh start
```

This begins capturing Chrome/system audio via BlackHole.

### Stop and Transcribe

```bash
./record.sh stop
```

This stops recording and automatically runs the transcription pipeline:
1. whisper.cpp transcribes the audio
2. pyannote identifies speakers
3. Results are merged and saved as markdown

The transcript is saved to `~/Desktop/Meeting Transcripts/`.

### Transcribe an Existing Recording

```bash
python3 transcribe.py /path/to/recording.wav
```

## Output

The fallback produces the same markdown format, with speaker labels:

```markdown
**Speaker 1** (0:00)
Welcome everyone, let's get started.

**Speaker 2** (0:15)
Thanks. I have the quarterly numbers ready.
```

Since the pipeline works from audio alone (not the meeting UI), speakers are labeled as "Speaker 1", "Speaker 2", etc. rather than by name.

## Speaker Name Mapping

After transcription, you can manually replace speaker labels with real names in the markdown file. A future version may support automatic mapping by cross-referencing with the Chrome extension's participant list.

## Troubleshooting

**"No audio captured" or empty recording**
- Make sure your system output is set to the Multi-Output Device (not just speakers)
- Check Audio MIDI Setup — BlackHole should be part of the Multi-Output Device
- Try `sox -d -r 16000 -c 1 test.wav` and play audio to verify recording works

**"whisper-cpp not found"**
- Run `brew install whisper-cpp`
- Or check `/opt/homebrew/bin/whisper-cpp`

**"No whisper model found"**
- Run `whisper-cpp-download-ggml-model base.en`
- Models are stored in `/opt/homebrew/share/whisper-cpp/models/`

**"HF_TOKEN not set"**
- Add `export HF_TOKEN="hf_..."` to your `~/.zshrc` and restart terminal
- Or run inline: `HF_TOKEN=hf_... python3 transcribe.py audio.wav`

**Slow performance**
- The base.en model is fastest (~15x realtime on M4)
- pyannote uses MPS (Apple GPU) automatically if available
- Close other GPU-intensive apps during processing
