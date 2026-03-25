#!/usr/bin/env python3
"""
Shared Whisper / diarization utilities for both batch and streaming flows.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import wave
from collections import Counter
from pathlib import Path


HALLUCINATION_PATTERNS = [
    r"^(.{5,}?)\1{2,}$",
    r"^thanks?\s+for\s+watching\.?$",
    r"^please\s+subscribe\.?$",
    r"^like\s+and\s+subscribe\.?$",
    r"^thank\s+you\.?\s*$",
    r"^bye\.?\s*$",
    r"^you$",
    r"^\.\s*$",
    r"^♪.*♪$",
    r"^\[.*\]$",
    r"^\(.*\)$",
]

HALLUCINATION_REGEXES = [
    re.compile(pattern, re.IGNORECASE) for pattern in HALLUCINATION_PATTERNS
]

MIN_SEGMENT_DURATION = 0.3
MAX_WORDS_FOR_SHORT_SEGMENT = 2


def build_whisper_prompt(vocab: str | None = None, prompt: str | None = None) -> str | None:
    """Combine custom vocabulary and free-form context into one Whisper prompt."""
    parts: list[str] = []

    if vocab:
        terms = [term.strip() for term in vocab.split(",") if term.strip()]
        if terms:
            parts.append(f"Terms: {', '.join(terms)}.")

    if prompt:
        clean_prompt = prompt.strip()
        if clean_prompt:
            parts.append(clean_prompt)

    return " ".join(parts) if parts else None


def check_dependencies() -> str:
    """Verify all required dependencies are available."""
    errors = []

    whisper_cmd = find_whisper_command()
    if not whisper_cmd:
        errors.append("whisper.cpp not found. Run ./install.sh from project root.")

    try:
        import pyannote.audio  # noqa: F401
    except ImportError:
        errors.append("pyannote.audio not found. Run ./install.sh from project root.")

    if errors:
        print("Missing dependencies:")
        for error in errors:
            print(f"  \u2717 {error}")
        sys.exit(1)

    return whisper_cmd


def find_whisper_command() -> str | None:
    """Find the whisper.cpp binary."""
    candidates = ["whisper-cpp", "whisper", "main"]
    for command in candidates:
        try:
            subprocess.run([command, "--help"], capture_output=True, timeout=5)
            return command
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    brew_path = Path("/opt/homebrew/bin/whisper-cpp")
    if brew_path.exists():
        return str(brew_path)

    return None


def find_whisper_model() -> str:
    """Find the best available Whisper model, preferring larger models."""
    model_dirs = [
        Path("/opt/homebrew/share/whisper-cpp/models"),
        Path.home() / ".cache" / "whisper",
        Path.home() / "models",
        Path("."),
    ]

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


def write_pcm_wav(audio_path: str | Path, pcm_bytes: bytes, sample_rate: int = 16000) -> None:
    """Write raw 16-bit PCM mono audio to a WAV file."""
    with wave.open(str(audio_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_bytes)


def detect_speech_segments(audio_path: str) -> list[tuple[float, float]] | None:
    """
    Use Silero VAD to detect speech-containing segments.
    Returns None when VAD fails, [] when silence is confirmed.
    """
    try:
        import torch

        model, utils = torch.hub.load(
            "snakers4/silero-vad",
            "silero_vad",
            trust_repo=True,
        )
        get_speech_timestamps, _, read_audio, _, _ = utils

        wav = read_audio(audio_path, sampling_rate=16000)
        speech_timestamps = get_speech_timestamps(
            wav,
            model,
            sampling_rate=16000,
            min_speech_duration_ms=500,
            min_silence_duration_ms=300,
            speech_pad_ms=200,
        )

        if not speech_timestamps:
            return []

        return [
            (timestamp["start"] / 16000.0, timestamp["end"] / 16000.0)
            for timestamp in speech_timestamps
        ]
    except Exception:
        return None


def transcribe_with_whisper(
    audio_path: str,
    whisper_cmd: str,
    model_path: str,
    prompt: str | None = None,
) -> list[dict]:
    """Run whisper.cpp on the audio file and return JSON segments."""
    output_path = audio_path.replace(".wav", "")

    command = [
        whisper_cmd,
        "-m",
        model_path,
        "-f",
        audio_path,
        "-oj",
        "-of",
        output_path,
        "-t",
        "4",
        "--no-prints",
    ]

    if prompt:
        command.extend(["--prompt", prompt])

    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "whisper.cpp failed")

    json_path = f"{output_path}.json"
    if not os.path.exists(json_path):
        raise RuntimeError(f"Whisper JSON output not found at {json_path}")

    with open(json_path, encoding="utf-8") as handle:
        data = json.load(handle)

    segments = []
    for segment in data.get("transcription", []):
        text = segment["text"].strip()
        if not text:
            continue
        segments.append(
            {
                "start": segment["offsets"]["from"] / 1000.0,
                "end": segment["offsets"]["to"] / 1000.0,
                "text": text,
            }
        )

    try:
        os.remove(json_path)
    except OSError:
        pass

    return segments


def filter_hallucinations(
    segments: list[dict],
    speech_segments: list[tuple[float, float]] | None = None,
) -> list[dict]:
    """Remove likely Whisper hallucinations and duplicate fragments."""
    filtered = []
    removed_reasons = Counter()

    for segment in segments:
        text = segment["text"].strip()
        duration = segment["end"] - segment["start"]

        if any(regex.match(text) for regex in HALLUCINATION_REGEXES):
            removed_reasons["pattern_match"] += 1
            continue

        if speech_segments is not None:
            midpoint = (segment["start"] + segment["end"]) / 2.0
            in_speech = any(start <= midpoint <= end for start, end in speech_segments)
            if not in_speech:
                removed_reasons["during_silence"] += 1
                continue

        if filtered and text == filtered[-1]["text"]:
            removed_reasons["duplicate"] += 1
            continue

        if filtered:
            previous_text = filtered[-1]["text"]
            if len(text) > 10 and len(previous_text) > 10:
                shorter = min(text, previous_text, key=len)
                longer = max(text, previous_text, key=len)
                if shorter in longer:
                    removed_reasons["near_duplicate"] += 1
                    if len(text) > len(previous_text):
                        filtered[-1] = segment
                    continue

        word_count = len(text.split())
        if duration < MIN_SEGMENT_DURATION and word_count <= MAX_WORDS_FOR_SHORT_SEGMENT:
            removed_reasons["too_short"] += 1
            continue

        filtered.append(segment)

    return filtered


def diarize_with_pyannote(audio_path: str) -> list[dict]:
    """Run pyannote speaker diarization. Returns speaker segments."""
    from pyannote.audio import Pipeline

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        return []

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token,
    )

    try:
        import torch

        if torch.backends.mps.is_available():
            pipeline.to("mps")
    except Exception:
        pass

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

    return speaker_segments


def merge_transcription_and_diarization(
    whisper_segments: list[dict],
    speaker_segments: list[dict],
) -> list[dict]:
    """Merge Whisper text with diarization labels using weighted overlap."""
    tolerance_seconds = 0.5
    merged = []

    for whisper_segment in whisper_segments:
        start = whisper_segment["start"] - tolerance_seconds
        end = whisper_segment["end"] + tolerance_seconds
        duration = whisper_segment["end"] - whisper_segment["start"]

        best_speaker = "Unknown Speaker"
        best_score = 0.0

        for speaker_segment in speaker_segments:
            overlap_start = max(start, speaker_segment["start"])
            overlap_end = min(end, speaker_segment["end"])
            overlap = max(0.0, overlap_end - overlap_start)
            if overlap <= 0:
                continue

            score = overlap / max(duration, 0.1)
            if score > best_score:
                best_score = score
                best_speaker = speaker_segment["speaker"]

        merged.append(
            {
                "speaker": best_speaker,
                "text": whisper_segment["text"],
                "start": whisper_segment["start"],
                "end": whisper_segment["end"],
                "confidence": min(best_score, 1.0),
            }
        )

    return merged
