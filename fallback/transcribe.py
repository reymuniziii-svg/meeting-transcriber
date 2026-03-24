#!/usr/bin/env python3
"""
Meeting transcription fallback using whisper.cpp + pyannote speaker diarization.

Usage:
    python3 transcribe.py <audio_file.wav>

Prerequisites:
    brew install whisper-cpp
    pip install pyannote.audio torch torchaudio
    # Accept pyannote model terms at https://huggingface.co/pyannote/speaker-diarization-3.1
    # Set HF_TOKEN environment variable with your HuggingFace token

Output:
    Saves a markdown transcript to ~/Desktop/Meeting Transcripts/
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path


def check_dependencies():
    """Verify all dependencies are available."""
    errors = []

    # Check whisper.cpp
    whisper_cmd = find_whisper_command()
    if not whisper_cmd:
        errors.append(
            "whisper.cpp not found. Install with: brew install whisper-cpp"
        )

    # Check pyannote
    try:
        import pyannote.audio  # noqa: F401
    except ImportError:
        errors.append(
            "pyannote.audio not found. Install with: pip install pyannote.audio torch torchaudio"
        )

    # Check HuggingFace token
    if not os.environ.get("HF_TOKEN"):
        errors.append(
            "HF_TOKEN not set. Get a free token at https://huggingface.co/settings/tokens"
        )

    if errors:
        print("Missing dependencies:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    return whisper_cmd


def find_whisper_command():
    """Find the whisper.cpp command on the system."""
    candidates = ["whisper-cpp", "whisper", "main"]
    for cmd in candidates:
        try:
            subprocess.run(
                [cmd, "--help"],
                capture_output=True,
                timeout=5,
            )
            return cmd
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    # Check common install locations
    brew_path = Path("/opt/homebrew/bin/whisper-cpp")
    if brew_path.exists():
        return str(brew_path)

    return None


def find_whisper_model():
    """Find an available whisper model file."""
    model_dirs = [
        Path("/opt/homebrew/share/whisper-cpp/models"),
        Path.home() / ".cache" / "whisper",
        Path.home() / "models",
        Path("."),
    ]

    # Prefer medium for quality, fall back to base
    preferred = [
        "ggml-medium.en.bin",
        "ggml-medium.bin",
        "ggml-base.en.bin",
        "ggml-base.bin",
        "ggml-small.en.bin",
        "ggml-small.bin",
    ]

    for model_dir in model_dirs:
        for model_name in preferred:
            model_path = model_dir / model_name
            if model_path.exists():
                return str(model_path)

    print("No whisper model found. Download one with:")
    print(
        "  whisper-cpp-download-ggml-model base.en"
    )
    print("  # or for better quality:")
    print(
        "  whisper-cpp-download-ggml-model medium.en"
    )
    sys.exit(1)


def transcribe_with_whisper(audio_path, whisper_cmd, model_path):
    """Run whisper.cpp on the audio file. Returns JSON segments."""
    print(f"Transcribing with whisper.cpp ({os.path.basename(model_path)})...")

    output_path = audio_path.replace(".wav", "")

    result = subprocess.run(
        [
            whisper_cmd,
            "-m",
            model_path,
            "-f",
            audio_path,
            "-oj",  # Output JSON
            "-of",
            output_path,
            "-t",
            "4",  # Threads
            "--no-prints",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"Whisper error: {result.stderr}")
        sys.exit(1)

    json_path = f"{output_path}.json"
    if not os.path.exists(json_path):
        print(f"Whisper JSON output not found at {json_path}")
        sys.exit(1)

    with open(json_path) as f:
        data = json.load(f)

    segments = []
    for seg in data.get("transcription", []):
        start_ms = seg["offsets"]["from"]
        end_ms = seg["offsets"]["to"]
        text = seg["text"].strip()
        if text:
            segments.append(
                {
                    "start": start_ms / 1000.0,
                    "end": end_ms / 1000.0,
                    "text": text,
                }
            )

    print(f"  {len(segments)} segments transcribed.")
    return segments


def diarize_with_pyannote(audio_path):
    """Run pyannote speaker diarization. Returns speaker segments."""
    print("Running speaker diarization with pyannote...")

    from pyannote.audio import Pipeline

    hf_token = os.environ["HF_TOKEN"]

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token,
    )

    # Use MPS (Apple Silicon GPU) if available
    try:
        import torch

        if torch.backends.mps.is_available():
            import torchaudio  # noqa: F401

            pipeline.to("mps")
            print("  Using Apple Silicon GPU (MPS).")
        else:
            print("  Using CPU.")
    except Exception:
        print("  Using CPU.")

    diarization = pipeline(audio_path)

    speaker_segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speaker_segments.append(
            {
                "start": turn.start,
                "end": turn.end,
                "speaker": speaker,
            }
        )

    # Rename speakers to friendly names
    unique_speakers = sorted(set(s["speaker"] for s in speaker_segments))
    speaker_map = {
        s: f"Speaker {i + 1}" for i, s in enumerate(unique_speakers)
    }

    for seg in speaker_segments:
        seg["speaker"] = speaker_map[seg["speaker"]]

    print(f"  {len(unique_speakers)} speakers identified.")
    return speaker_segments


def merge_transcription_and_diarization(whisper_segments, speaker_segments):
    """
    Merge whisper text segments with pyannote speaker labels.
    For each whisper segment, find the speaker who was talking at that time.
    """
    print("Merging transcription with speaker labels...")

    merged = []
    for w_seg in whisper_segments:
        mid_time = (w_seg["start"] + w_seg["end"]) / 2.0

        # Find the speaker segment that overlaps with this whisper segment
        best_speaker = "Unknown Speaker"
        best_overlap = 0

        for s_seg in speaker_segments:
            # Calculate overlap
            overlap_start = max(w_seg["start"], s_seg["start"])
            overlap_end = min(w_seg["end"], s_seg["end"])
            overlap = max(0, overlap_end - overlap_start)

            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = s_seg["speaker"]

        # Fallback: find speaker at midpoint
        if best_overlap == 0:
            for s_seg in speaker_segments:
                if s_seg["start"] <= mid_time <= s_seg["end"]:
                    best_speaker = s_seg["speaker"]
                    break

        merged.append(
            {
                "speaker": best_speaker,
                "text": w_seg["text"],
                "start": w_seg["start"],
                "end": w_seg["end"],
            }
        )

    # Consolidate consecutive segments from same speaker
    consolidated = []
    for seg in merged:
        if (
            consolidated
            and consolidated[-1]["speaker"] == seg["speaker"]
        ):
            consolidated[-1]["text"] += " " + seg["text"]
            consolidated[-1]["end"] = seg["end"]
        else:
            consolidated.append(dict(seg))

    print(f"  {len(consolidated)} consolidated segments.")
    return consolidated


def format_timestamp(seconds):
    """Format seconds as HH:MM:SS or MM:SS."""
    td = timedelta(seconds=int(seconds))
    total_seconds = int(td.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def generate_markdown(segments, audio_path):
    """Generate a markdown transcript file."""
    now = datetime.now()
    date_str = now.strftime("%A, %B %d, %Y")
    time_str = now.strftime("%-I:%M %p")

    participants = sorted(set(s["speaker"] for s in segments))
    duration_seconds = segments[-1]["end"] if segments else 0
    duration_min = int(duration_seconds / 60)

    md = f"# Meeting Transcript\n\n"
    md += f"- **Date**: {date_str}\n"
    md += f"- **Time**: {time_str}\n"
    md += f"- **Platform**: Unknown (audio fallback)\n"
    md += f"- **Duration**: {duration_min} minutes\n"
    md += f"- **Participants**: {', '.join(participants)}\n"
    md += f"- **Source**: {os.path.basename(audio_path)}\n"
    md += f"\n---\n\n"
    md += f"## Transcript\n\n"

    for seg in segments:
        ts = format_timestamp(seg["start"])
        md += f"**{seg['speaker']}** ({ts})\n"
        md += f"{seg['text']}\n\n"

    return md


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 transcribe.py <audio_file.wav>")
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f"File not found: {audio_path}")
        sys.exit(1)

    print(f"\nProcessing: {audio_path}\n")

    whisper_cmd = check_dependencies()
    model_path = find_whisper_model()

    # Step 1: Transcribe with whisper.cpp
    whisper_segments = transcribe_with_whisper(audio_path, whisper_cmd, model_path)

    # Step 2: Diarize with pyannote
    speaker_segments = diarize_with_pyannote(audio_path)

    # Step 3: Merge
    merged = merge_transcription_and_diarization(whisper_segments, speaker_segments)

    # Step 4: Generate markdown
    markdown = generate_markdown(merged, audio_path)

    # Save to Meeting Transcripts folder
    output_dir = Path.home() / "Desktop" / "Meeting Transcripts"
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M")
    output_file = output_dir / f"{timestamp}_audio-fallback_meeting.md"

    with open(output_file, "w") as f:
        f.write(markdown)

    print(f"\nTranscript saved to: {output_file}")
    print(f"Segments: {len(merged)}")
    print(
        f"Speakers: {', '.join(sorted(set(s['speaker'] for s in merged)))}"
    )


if __name__ == "__main__":
    main()
