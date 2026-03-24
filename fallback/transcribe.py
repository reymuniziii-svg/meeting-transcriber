#!/usr/bin/env python3
"""
Meeting transcription fallback using whisper.cpp + pyannote speaker diarization.

Includes mitigations for common failure modes:
  - Voice Activity Detection (VAD) to skip silent segments and prevent hallucinations
  - Hallucination filtering (repeated phrases, nonsense during silence)
  - Custom vocabulary/prompt support for domain-specific terms
  - Improved timestamp alignment between Whisper and pyannote
  - Post-transcription quality report

Usage:
    python3 transcribe.py <audio_file.wav>
    python3 transcribe.py <audio_file.wav> --vocab "Kubernetes,PRAI,rmOS"
    python3 transcribe.py <audio_file.wav> --prompt "Meeting about the PRAI product launch"

Prerequisites:
    Run ./install.sh from the project root to install all dependencies.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path


# ─── Hallucination Patterns ──────────────────────────────────────────
# Whisper commonly hallucinates these during silence or low-quality audio

HALLUCINATION_PATTERNS = [
    # Repeated phrases (Whisper loop artifacts)
    r"^(.{5,}?)\1{2,}$",  # Same phrase repeated 3+ times
    # Common Whisper hallucinations during silence
    r"^thanks?\s+for\s+watching\.?$",
    r"^please\s+subscribe\.?$",
    r"^like\s+and\s+subscribe\.?$",
    r"^thank\s+you\.?\s*$",
    r"^bye\.?\s*$",
    r"^you$",
    r"^\.\s*$",
    r"^♪.*♪$",  # Music notation
    r"^\[.*\]$",  # Bracketed annotations like [Music], [Applause]
    r"^\(.*\)$",  # Parenthetical annotations
]

HALLUCINATION_REGEXES = [re.compile(p, re.IGNORECASE) for p in HALLUCINATION_PATTERNS]

# Segments shorter than this (seconds) with very few words are suspicious
MIN_SEGMENT_DURATION = 0.3
MAX_WORDS_FOR_SHORT_SEGMENT = 2


def check_dependencies():
    """Verify all dependencies are available."""
    errors = []

    whisper_cmd = find_whisper_command()
    if not whisper_cmd:
        errors.append(
            "whisper.cpp not found. Run ./install.sh from project root."
        )

    try:
        import pyannote.audio  # noqa: F401
    except ImportError:
        errors.append(
            "pyannote.audio not found. Run ./install.sh from project root."
        )

    if not os.environ.get("HF_TOKEN"):
        errors.append(
            "HF_TOKEN not set. See install instructions: "
            "https://huggingface.co/settings/tokens"
        )

    if errors:
        print("Missing dependencies:")
        for e in errors:
            print(f"  ✗ {e}")
        sys.exit(1)

    return whisper_cmd


def find_whisper_command():
    """Find the whisper.cpp binary."""
    candidates = ["whisper-cpp", "whisper", "main"]
    for cmd in candidates:
        try:
            subprocess.run([cmd, "--help"], capture_output=True, timeout=5)
            return cmd
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    brew_path = Path("/opt/homebrew/bin/whisper-cpp")
    if brew_path.exists():
        return str(brew_path)

    return None


def find_whisper_model():
    """Find the best available whisper model, preferring larger models."""
    model_dirs = [
        Path("/opt/homebrew/share/whisper-cpp/models"),
        Path.home() / ".cache" / "whisper",
        Path.home() / "models",
        Path("."),
    ]

    # Prefer large-v3-turbo > medium > base (best quality first)
    preferred = [
        "ggml-large-v3-turbo.bin",
        "ggml-large-v3.bin",
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

    print("No whisper model found. Run ./install.sh or:")
    print("  whisper-cpp-download-ggml-model base.en")
    sys.exit(1)


# ─── Voice Activity Detection ────────────────────────────────────────

def detect_speech_segments(audio_path):
    """
    Use Silero VAD to detect segments containing speech.
    Returns list of (start_seconds, end_seconds) tuples.
    Filters out silence to prevent Whisper hallucinations.
    """
    print("Running voice activity detection (Silero VAD)...")

    try:
        import torch
        import torchaudio

        # Load Silero VAD
        model, utils = torch.hub.load(
            "snakers4/silero-vad",
            "silero_vad",
            trust_repo=True,
        )
        get_speech_timestamps, _, read_audio, _, _ = utils

        # Read audio (Silero expects 16kHz mono)
        wav = read_audio(audio_path, sampling_rate=16000)

        # Get speech timestamps
        speech_timestamps = get_speech_timestamps(
            wav,
            model,
            sampling_rate=16000,
            min_speech_duration_ms=500,   # Ignore speech < 500ms
            min_silence_duration_ms=300,  # Allow 300ms pauses within speech
            speech_pad_ms=200,            # Pad speech segments by 200ms
        )

        if not speech_timestamps:
            print("  ⚠ No speech detected in audio.")
            return []

        # Convert sample indices to seconds
        segments = []
        for ts in speech_timestamps:
            start = ts["start"] / 16000.0
            end = ts["end"] / 16000.0
            segments.append((start, end))

        total_speech = sum(end - start for start, end in segments)
        total_audio = len(wav) / 16000.0
        speech_pct = (total_speech / total_audio * 100) if total_audio > 0 else 0

        print(f"  {len(segments)} speech segments found")
        print(f"  {total_speech:.0f}s speech / {total_audio:.0f}s total ({speech_pct:.0f}%)")

        return segments

    except Exception as e:
        print(f"  ⚠ VAD failed ({e}), processing full audio (hallucination risk higher)")
        return None  # None = process everything


# ─── Whisper Transcription ───────────────────────────────────────────

def transcribe_with_whisper(audio_path, whisper_cmd, model_path, prompt=None):
    """Run whisper.cpp on the audio file. Returns JSON segments."""
    model_name = os.path.basename(model_path)
    print(f"Transcribing with whisper.cpp ({model_name})...")

    output_path = audio_path.replace(".wav", "")

    cmd = [
        whisper_cmd,
        "-m", model_path,
        "-f", audio_path,
        "-oj",         # Output JSON
        "-of", output_path,
        "-t", "4",     # Threads
        "--no-prints",
    ]

    # Custom prompt/vocabulary helps Whisper with domain-specific terms
    if prompt:
        cmd.extend(["--prompt", prompt])

    result = subprocess.run(cmd, capture_output=True, text=True)

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
            segments.append({
                "start": start_ms / 1000.0,
                "end": end_ms / 1000.0,
                "text": text,
            })

    print(f"  {len(segments)} raw segments transcribed.")
    return segments


# ─── Hallucination Filtering ─────────────────────────────────────────

def filter_hallucinations(segments, speech_segments=None):
    """
    Remove likely Whisper hallucinations:
    1. Text matching known hallucination patterns
    2. Segments during detected silence (if VAD available)
    3. Repeated consecutive identical segments
    4. Suspiciously short segments with very few words
    """
    print("Filtering hallucinations...")

    original_count = len(segments)
    filtered = []
    removed_reasons = Counter()

    for i, seg in enumerate(segments):
        text = seg["text"].strip()
        duration = seg["end"] - seg["start"]

        # Check 1: Known hallucination patterns
        is_hallucination = False
        for regex in HALLUCINATION_REGEXES:
            if regex.match(text):
                is_hallucination = True
                removed_reasons["pattern_match"] += 1
                break

        if is_hallucination:
            continue

        # Check 2: Segment falls during silence (no speech detected by VAD)
        if speech_segments is not None:
            seg_mid = (seg["start"] + seg["end"]) / 2.0
            in_speech = any(
                start <= seg_mid <= end for start, end in speech_segments
            )
            if not in_speech:
                removed_reasons["during_silence"] += 1
                continue

        # Check 3: Duplicate of previous segment (Whisper loop)
        if filtered and text == filtered[-1]["text"]:
            removed_reasons["duplicate"] += 1
            continue

        # Check 4: Near-duplicate (>80% text overlap with previous)
        if filtered:
            prev_text = filtered[-1]["text"]
            if len(text) > 10 and len(prev_text) > 10:
                # Simple overlap check
                shorter = min(text, prev_text, key=len)
                longer = max(text, prev_text, key=len)
                if shorter in longer:
                    removed_reasons["near_duplicate"] += 1
                    # Keep the longer one
                    if len(text) > len(prev_text):
                        filtered[-1] = seg
                    continue

        # Check 5: Very short segment with few words
        word_count = len(text.split())
        if duration < MIN_SEGMENT_DURATION and word_count <= MAX_WORDS_FOR_SHORT_SEGMENT:
            removed_reasons["too_short"] += 1
            continue

        filtered.append(seg)

    removed_count = original_count - len(filtered)
    if removed_count > 0:
        print(f"  Removed {removed_count} suspected hallucinations:")
        for reason, count in removed_reasons.most_common():
            print(f"    {reason}: {count}")
    else:
        print("  No hallucinations detected.")

    print(f"  {len(filtered)} clean segments remaining.")
    return filtered


# ─── Speaker Diarization ─────────────────────────────────────────────

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
            pipeline.to("mps")
            print("  Using Apple Silicon GPU (MPS).")
        else:
            print("  Using CPU.")
    except Exception:
        print("  Using CPU.")

    diarization = pipeline(audio_path)

    speaker_segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speaker_segments.append({
            "start": turn.start,
            "end": turn.end,
            "speaker": speaker,
        })

    # Rename to friendly names, ordered by first appearance
    seen_order = []
    for seg in speaker_segments:
        if seg["speaker"] not in seen_order:
            seen_order.append(seg["speaker"])

    speaker_map = {s: f"Speaker {i + 1}" for i, s in enumerate(seen_order)}

    for seg in speaker_segments:
        seg["speaker"] = speaker_map[seg["speaker"]]

    print(f"  {len(seen_order)} speakers identified.")
    return speaker_segments


# ─── Improved Merge with Timestamp Alignment ─────────────────────────

def merge_transcription_and_diarization(whisper_segments, speaker_segments):
    """
    Merge whisper text segments with pyannote speaker labels.

    Uses weighted overlap scoring with tolerance window to handle
    timestamp misalignment between the two systems.
    """
    print("Merging transcription with speaker labels...")

    TOLERANCE_S = 0.5  # Allow 500ms of timing slack

    merged = []
    for w_seg in whisper_segments:
        # Expand the whisper segment window slightly for matching
        w_start = w_seg["start"] - TOLERANCE_S
        w_end = w_seg["end"] + TOLERANCE_S
        w_duration = w_seg["end"] - w_seg["start"]

        best_speaker = "Unknown Speaker"
        best_score = 0

        for s_seg in speaker_segments:
            # Calculate overlap with tolerance
            overlap_start = max(w_start, s_seg["start"])
            overlap_end = min(w_end, s_seg["end"])
            overlap = max(0, overlap_end - overlap_start)

            if overlap <= 0:
                continue

            # Score = overlap normalized by whisper segment duration
            # This prevents long diarization segments from always winning
            score = overlap / max(w_duration, 0.1)

            if score > best_score:
                best_score = score
                best_speaker = s_seg["speaker"]

        merged.append({
            "speaker": best_speaker,
            "text": w_seg["text"],
            "start": w_seg["start"],
            "end": w_seg["end"],
            "confidence": min(best_score, 1.0),  # 0-1 match confidence
        })

    # Consolidate consecutive segments from same speaker
    consolidated = []
    for seg in merged:
        if consolidated and consolidated[-1]["speaker"] == seg["speaker"]:
            consolidated[-1]["text"] += " " + seg["text"]
            consolidated[-1]["end"] = seg["end"]
            # Average the confidence
            consolidated[-1]["confidence"] = (
                consolidated[-1]["confidence"] + seg["confidence"]
            ) / 2
        else:
            consolidated.append(dict(seg))

    print(f"  {len(consolidated)} consolidated segments.")

    # Report low-confidence attributions
    low_conf = [s for s in consolidated if s["confidence"] < 0.3]
    if low_conf:
        print(f"  ⚠ {len(low_conf)} segments with low speaker confidence (<30%)")

    return consolidated


# ─── Quality Report ──────────────────────────────────────────────────

def generate_quality_report(segments, speech_segments, hallucinations_removed):
    """Generate a quality assessment section for the transcript."""
    lines = []
    lines.append("## Quality Report\n")

    # Speaker distribution
    speaker_words = Counter()
    speaker_time = Counter()
    for seg in segments:
        words = len(seg["text"].split())
        duration = seg["end"] - seg["start"]
        speaker_words[seg["speaker"]] += words
        speaker_time[seg["speaker"]] += duration

    lines.append("### Speaker Distribution\n")
    lines.append("| Speaker | Words | Speaking Time | Avg Confidence |")
    lines.append("|---------|-------|--------------|----------------|")

    for speaker in sorted(speaker_words.keys()):
        words = speaker_words[speaker]
        time_s = speaker_time[speaker]
        time_str = f"{int(time_s // 60)}m {int(time_s % 60)}s"
        # Average confidence for this speaker
        confs = [s["confidence"] for s in segments if s["speaker"] == speaker]
        avg_conf = sum(confs) / len(confs) if confs else 0
        conf_str = f"{avg_conf:.0%}"
        lines.append(f"| {speaker} | {words} | {time_str} | {conf_str} |")

    lines.append("")

    # Warnings
    warnings = []
    if hallucinations_removed > 0:
        warnings.append(
            f"- {hallucinations_removed} suspected hallucinations were removed"
        )

    low_conf_segs = [s for s in segments if s["confidence"] < 0.3]
    if low_conf_segs:
        warnings.append(
            f"- {len(low_conf_segs)} segments have low speaker attribution "
            f"confidence — speaker names may be wrong"
        )

    unknown_segs = [s for s in segments if s["speaker"] == "Unknown Speaker"]
    if unknown_segs:
        warnings.append(
            f"- {len(unknown_segs)} segments could not be attributed to any speaker"
        )

    if warnings:
        lines.append("### Warnings\n")
        for w in warnings:
            lines.append(w)
        lines.append("")

    lines.append(
        "*Speaker labels (Speaker 1, 2, etc.) are based on voice analysis. "
        "Review and replace with actual names if needed.*\n"
    )

    return "\n".join(lines)


# ─── Markdown Output ─────────────────────────────────────────────────

def format_timestamp(seconds):
    """Format seconds as HH:MM:SS or MM:SS."""
    total = int(seconds)
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def generate_markdown(segments, audio_path, quality_report=""):
    """Generate a markdown transcript file."""
    now = datetime.now()
    date_str = now.strftime("%A, %B %d, %Y")
    time_str = now.strftime("%-I:%M %p")

    participants = sorted(set(s["speaker"] for s in segments))
    duration_seconds = segments[-1]["end"] if segments else 0
    duration_min = int(duration_seconds / 60)

    md = "# Meeting Transcript\n\n"
    md += f"- **Date**: {date_str}\n"
    md += f"- **Time**: {time_str}\n"
    md += f"- **Platform**: Audio capture (Whisper fallback)\n"
    md += f"- **Duration**: {duration_min} minutes\n"
    md += f"- **Participants**: {', '.join(participants)}\n"
    md += f"- **Source**: `{os.path.basename(audio_path)}`\n"
    md += f"- **Model**: whisper.cpp\n"
    md += "\n---\n\n"
    md += "## Transcript\n\n"

    if not segments:
        md += "*No speech detected in audio.*\n"
        return md

    for seg in segments:
        ts = format_timestamp(seg["start"])
        confidence = seg.get("confidence", 1.0)

        # Mark low-confidence attributions
        conf_marker = ""
        if confidence < 0.3:
            conf_marker = " ⚠️"

        md += f"**{seg['speaker']}**{conf_marker} ({ts})\n"
        md += f"{seg['text']}\n\n"

    if quality_report:
        md += "---\n\n"
        md += quality_report

    return md


# ─── Main Pipeline ───────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Transcribe meeting audio with speaker diarization."
    )
    parser.add_argument("audio_file", help="Path to .wav audio file")
    parser.add_argument(
        "--vocab",
        help="Comma-separated custom vocabulary (e.g. 'Kubernetes,PRAI,rmOS')",
    )
    parser.add_argument(
        "--prompt",
        help="Context prompt for Whisper (e.g. 'Meeting about Q4 product launch')",
    )
    parser.add_argument(
        "--no-vad",
        action="store_true",
        help="Skip voice activity detection (faster but more hallucinations)",
    )
    parser.add_argument(
        "--no-filter",
        action="store_true",
        help="Skip hallucination filtering",
    )

    args = parser.parse_args()

    audio_path = args.audio_file
    if not os.path.exists(audio_path):
        print(f"File not found: {audio_path}")
        sys.exit(1)

    print(f"\n{'═' * 50}")
    print(f"  Meeting Transcriber — Whisper Pipeline")
    print(f"{'═' * 50}")
    print(f"\n  Input: {audio_path}\n")

    whisper_cmd = check_dependencies()
    model_path = find_whisper_model()

    # Build Whisper prompt from vocab and/or custom prompt
    whisper_prompt = None
    prompt_parts = []
    if args.vocab:
        terms = [t.strip() for t in args.vocab.split(",")]
        prompt_parts.append(f"Terms: {', '.join(terms)}.")
    if args.prompt:
        prompt_parts.append(args.prompt)
    if prompt_parts:
        whisper_prompt = " ".join(prompt_parts)
        print(f"  Whisper prompt: {whisper_prompt}\n")

    # Step 1: Voice Activity Detection
    speech_segments = None
    if not args.no_vad:
        speech_segments = detect_speech_segments(audio_path)
        if speech_segments is not None and len(speech_segments) == 0:
            print("\nNo speech detected. Nothing to transcribe.")
            sys.exit(0)

    # Step 2: Transcribe with Whisper
    whisper_segments = transcribe_with_whisper(
        audio_path, whisper_cmd, model_path, prompt=whisper_prompt
    )

    if not whisper_segments:
        print("\nWhisper produced no output.")
        sys.exit(0)

    # Step 3: Filter hallucinations
    hallucinations_removed = 0
    if not args.no_filter:
        original_count = len(whisper_segments)
        whisper_segments = filter_hallucinations(whisper_segments, speech_segments)
        hallucinations_removed = original_count - len(whisper_segments)

    if not whisper_segments:
        print("\nAll segments were filtered as hallucinations. No transcript to save.")
        sys.exit(0)

    # Step 4: Speaker diarization
    speaker_segments = diarize_with_pyannote(audio_path)

    # Step 5: Merge with improved alignment
    merged = merge_transcription_and_diarization(whisper_segments, speaker_segments)

    # Step 6: Generate quality report
    quality_report = generate_quality_report(
        merged, speech_segments, hallucinations_removed
    )

    # Step 7: Generate and save markdown
    markdown = generate_markdown(merged, audio_path, quality_report)

    output_dir = Path.home() / "Desktop" / "Meeting Transcripts"
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M")
    output_file = output_dir / f"{timestamp}_whisper_meeting.md"

    with open(output_file, "w") as f:
        f.write(markdown)

    # Summary
    speakers = sorted(set(s["speaker"] for s in merged))
    low_conf = sum(1 for s in merged if s["confidence"] < 0.3)

    print(f"\n{'═' * 50}")
    print(f"  Done!")
    print(f"{'═' * 50}")
    print(f"\n  Transcript: {output_file}")
    print(f"  Segments:   {len(merged)}")
    print(f"  Speakers:   {', '.join(speakers)}")
    if hallucinations_removed:
        print(f"  Filtered:   {hallucinations_removed} hallucinations removed")
    if low_conf:
        print(f"  ⚠ Warning:  {low_conf} segments with uncertain speaker attribution")
    print()


if __name__ == "__main__":
    main()
