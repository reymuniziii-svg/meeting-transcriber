#!/usr/bin/env python3
"""
Batch transcription helper using whisper.cpp + pyannote speaker diarization.
"""

import argparse
import os
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from server.whisper_utils import (  # noqa: E402
    build_whisper_prompt,
    check_dependencies,
    detect_speech_segments,
    diarize_with_pyannote,
    filter_hallucinations,
    find_whisper_model,
    merge_transcription_and_diarization,
    transcribe_with_whisper,
)


def generate_quality_report(segments, speech_segments, hallucinations_removed):
    """Generate a quality assessment section for the transcript."""
    lines = []
    lines.append("## Quality Report\n")

    speaker_words = Counter()
    speaker_time = Counter()
    for segment in segments:
        words = len(segment["text"].split())
        duration = segment["end"] - segment["start"]
        speaker_words[segment["speaker"]] += words
        speaker_time[segment["speaker"]] += duration

    lines.append("### Speaker Distribution\n")
    lines.append("| Speaker | Words | Speaking Time | Avg Confidence |")
    lines.append("|---------|-------|--------------|----------------|")

    for speaker in sorted(speaker_words.keys()):
        words = speaker_words[speaker]
        time_seconds = speaker_time[speaker]
        time_str = f"{int(time_seconds // 60)}m {int(time_seconds % 60)}s"
        confidences = [segment["confidence"] for segment in segments if segment["speaker"] == speaker]
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0
        lines.append(
            f"| {speaker} | {words} | {time_str} | {avg_confidence:.0%} |"
        )

    lines.append("")

    warnings = []
    if hallucinations_removed > 0:
        warnings.append(f"- {hallucinations_removed} suspected hallucinations were removed")

    low_confidence_segments = [segment for segment in segments if segment["confidence"] < 0.3]
    if low_confidence_segments:
        warnings.append(
            f"- {len(low_confidence_segments)} segments have low speaker attribution confidence"
        )

    unknown_segments = [segment for segment in segments if segment["speaker"] == "Unknown Speaker"]
    if unknown_segments:
        warnings.append(
            f"- {len(unknown_segments)} segments could not be attributed to any speaker"
        )

    if warnings:
        lines.append("### Warnings\n")
        lines.extend(warnings)
        lines.append("")

    lines.append(
        "*Speaker labels are best-effort. Review names before sharing the transcript.*\n"
    )

    return "\n".join(lines)


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

    participants = sorted(set(segment["speaker"] for segment in segments))
    duration_seconds = segments[-1]["end"] if segments else 0
    duration_minutes = int(duration_seconds / 60)

    markdown = "# Meeting Transcript\n\n"
    markdown += f"- **Date**: {date_str}\n"
    markdown += f"- **Time**: {time_str}\n"
    markdown += "- **Platform**: Local audio file\n"
    markdown += f"- **Duration**: {duration_minutes} minutes\n"
    markdown += f"- **Participants**: {', '.join(participants)}\n"
    markdown += f"- **Source**: `{os.path.basename(audio_path)}`\n"
    markdown += "- **Model**: whisper.cpp\n"
    markdown += "\n---\n\n"
    markdown += "## Transcript\n\n"

    if not segments:
        markdown += "*No speech detected in audio.*\n"
        return markdown

    for segment in segments:
        timestamp = format_timestamp(segment["start"])
        marker = " \u26A0" if segment.get("confidence", 1.0) < 0.3 else ""
        markdown += f"**{segment['speaker']}**{marker} ({timestamp})\n"
        markdown += f"{segment['text']}\n\n"

    if quality_report:
        markdown += "---\n\n"
        markdown += quality_report

    return markdown


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
        help="Skip voice activity detection",
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
    print("  Meeting Transcriber — Whisper Pipeline")
    print(f"{'═' * 50}")
    print(f"\n  Input: {audio_path}\n")

    whisper_cmd = check_dependencies()
    model_path = find_whisper_model()

    whisper_prompt = build_whisper_prompt(args.vocab, args.prompt)
    if whisper_prompt:
        print(f"  Whisper prompt: {whisper_prompt}\n")

    if not os.environ.get("HF_TOKEN"):
        print(
            "  HF_TOKEN is not set. Pyannote diarization will be skipped, so speaker names will stay generic.\n"
        )

    speech_segments = None
    if not args.no_vad:
        speech_segments = detect_speech_segments(audio_path)
        if speech_segments is not None and len(speech_segments) == 0:
            print("No speech detected. Nothing to transcribe.")
            sys.exit(0)

    whisper_segments = transcribe_with_whisper(
        audio_path,
        whisper_cmd,
        model_path,
        prompt=whisper_prompt,
    )
    if not whisper_segments:
        print("Whisper produced no output.")
        sys.exit(0)

    hallucinations_removed = 0
    if not args.no_filter:
        original_count = len(whisper_segments)
        whisper_segments = filter_hallucinations(whisper_segments, speech_segments)
        hallucinations_removed = original_count - len(whisper_segments)

    if not whisper_segments:
        print("All segments were filtered as hallucinations. Nothing to save.")
        sys.exit(0)

    speaker_segments = diarize_with_pyannote(audio_path)
    if speaker_segments:
        seen_order = []
        for segment in speaker_segments:
            if segment["speaker"] not in seen_order:
                seen_order.append(segment["speaker"])
        speaker_map = {
            speaker_id: f"Speaker {index + 1}"
            for index, speaker_id in enumerate(seen_order)
        }
        for segment in speaker_segments:
            segment["speaker"] = speaker_map[segment["speaker"]]

    merged = merge_transcription_and_diarization(whisper_segments, speaker_segments)
    quality_report = generate_quality_report(
        merged,
        speech_segments,
        hallucinations_removed,
    )
    markdown = generate_markdown(merged, audio_path, quality_report)

    output_dir = Path.home() / "Desktop" / "Meeting Transcripts"
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M")
    output_file = output_dir / f"{timestamp}_whisper_meeting.md"
    with open(output_file, "w", encoding="utf-8") as handle:
        handle.write(markdown)

    speakers = sorted(set(segment["speaker"] for segment in merged))
    low_confidence = sum(1 for segment in merged if segment["confidence"] < 0.3)

    print(f"\n{'═' * 50}")
    print("  Done!")
    print(f"{'═' * 50}")
    print(f"\n  Transcript: {output_file}")
    print(f"  Segments:   {len(merged)}")
    print(f"  Speakers:   {', '.join(speakers)}")
    if hallucinations_removed:
        print(f"  Filtered:   {hallucinations_removed} hallucinations removed")
    if low_confidence:
        print(f"  Warning:    {low_confidence} segments have uncertain speaker attribution")
    print("")


if __name__ == "__main__":
    main()
