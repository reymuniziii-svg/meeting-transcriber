#!/usr/bin/env python3
"""
Local WebSocket server for live meeting transcription.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

import websockets
from websockets.exceptions import ConnectionClosed

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
    transcribe_with_whisper,
    write_pcm_wav,
)


class StreamingSession:
    """Handles one browser tab's live transcription session."""

    def __init__(self, websocket, whisper_cmd: str, model_path: str, args):
        self.websocket = websocket
        self.whisper_cmd = whisper_cmd
        self.model_path = model_path
        self.args = args
        self.audio_buffer = bytearray()
        self.window_seconds = args.window_seconds
        self.overlap_seconds = args.overlap_seconds
        self.window_step_seconds = max(self.window_seconds - self.overlap_seconds, 1)
        self.diarization_interval_seconds = args.diarization_interval
        self.sample_rate = 16000
        self.session_id = "unknown"
        self.prompt = build_whisper_prompt(args.vocab, args.prompt)
        self.next_window_start = 0.0
        self.next_diarization_at = float(self.diarization_interval_seconds)
        self.emitted_until = 0.0
        self.processing_lock = asyncio.Lock()

    @property
    def bytes_per_second(self) -> int:
        return self.sample_rate * 2

    @property
    def duration_seconds(self) -> float:
        return len(self.audio_buffer) / self.bytes_per_second

    async def handle_message(self, message) -> None:
        if isinstance(message, bytes):
            self.audio_buffer.extend(message)
            await self.process_available_audio(final=False)
            return

        payload = json.loads(message)
        message_type = payload.get("type")

        if message_type == "start":
            self.session_id = payload.get("sessionId", self.session_id)
            client_prompt = build_whisper_prompt(
                payload.get("vocab"),
                payload.get("prompt"),
            )
            if client_prompt:
                base_prompt = build_whisper_prompt(self.args.vocab, self.args.prompt)
                self.prompt = " ".join(
                    piece for piece in [base_prompt, client_prompt] if piece
                )

            await self.websocket.send(
                json.dumps(
                    {
                        "type": "ready",
                        "sessionId": self.session_id,
                        "model": os.path.basename(self.model_path),
                    }
                )
            )
            return

        if message_type == "stop":
            await self.process_available_audio(final=True)
            await self.websocket.send(
                json.dumps({"type": "sessionStopped", "sessionId": self.session_id})
            )

    async def process_available_audio(self, final: bool) -> None:
        async with self.processing_lock:
            while True:
                total_duration = self.duration_seconds
                next_window_end = self.next_window_start + self.window_seconds
                has_full_window = total_duration >= next_window_end
                has_partial_final = final and total_duration > self.next_window_start

                if not has_full_window and not has_partial_final:
                    break

                window_end = min(total_duration, next_window_end)
                segments = await asyncio.to_thread(
                    self.transcribe_window,
                    self.next_window_start,
                    window_end,
                )
                if segments:
                    await self.websocket.send(
                        json.dumps(
                            {
                                "type": "transcription",
                                "sessionId": self.session_id,
                                "segments": segments,
                            }
                        )
                    )

                self.next_window_start += self.window_step_seconds
                if window_end >= total_duration and not has_full_window:
                    break

            if (final and self.duration_seconds > 0) or (
                self.duration_seconds >= self.next_diarization_at
            ):
                speakers = await asyncio.to_thread(self.run_diarization)
                if speakers:
                    await self.websocket.send(
                        json.dumps(
                            {
                                "type": "diarization",
                                "sessionId": self.session_id,
                                "speakers": speakers,
                            }
                        )
                    )
                while self.next_diarization_at <= self.duration_seconds:
                    self.next_diarization_at += self.diarization_interval_seconds

    def transcribe_window(self, start_seconds: float, end_seconds: float) -> list[dict]:
        start_byte = int(start_seconds * self.bytes_per_second)
        end_byte = int(end_seconds * self.bytes_per_second)
        pcm_bytes = bytes(self.audio_buffer[start_byte:end_byte])

        if len(pcm_bytes) < self.bytes_per_second:
            return []

        with tempfile.TemporaryDirectory(prefix="meeting-transcriber-window-") as tmpdir:
            audio_path = Path(tmpdir) / "window.wav"
            write_pcm_wav(audio_path, pcm_bytes, sample_rate=self.sample_rate)

            speech_segments = None if self.args.no_vad else detect_speech_segments(str(audio_path))
            if speech_segments == []:
                return []

            segments = transcribe_with_whisper(
                str(audio_path),
                self.whisper_cmd,
                self.model_path,
                prompt=self.prompt,
            )
            if not segments:
                return []

            if not self.args.no_filter:
                segments = filter_hallucinations(segments, speech_segments)

        adjusted_segments = []
        for segment in segments:
            adjusted = {
                "start": round(segment["start"] + start_seconds, 3),
                "end": round(segment["end"] + start_seconds, 3),
                "text": segment["text"],
            }

            if adjusted["end"] <= self.emitted_until + 0.05:
                continue

            adjusted_segments.append(adjusted)

        if adjusted_segments:
            self.emitted_until = max(
                self.emitted_until,
                max(segment["end"] for segment in adjusted_segments),
            )

        return adjusted_segments

    def run_diarization(self) -> list[dict]:
        if not os.environ.get("HF_TOKEN"):
            return []

        with tempfile.TemporaryDirectory(prefix="meeting-transcriber-diarization-") as tmpdir:
            audio_path = Path(tmpdir) / "meeting.wav"
            write_pcm_wav(audio_path, bytes(self.audio_buffer), sample_rate=self.sample_rate)
            speakers = diarize_with_pyannote(str(audio_path))

        normalized = []
        seen_order = []
        for speaker in speakers:
            speaker_id = speaker["speaker"]
            if speaker_id not in seen_order:
                seen_order.append(speaker_id)

        speaker_map = {
            speaker_id: f"Speaker {index + 1}"
            for index, speaker_id in enumerate(seen_order)
        }

        for speaker in speakers:
            normalized.append(
                {
                    "start": round(speaker["start"], 3),
                    "end": round(speaker["end"], 3),
                    "speaker_id": speaker["speaker"],
                    "label": speaker_map[speaker["speaker"]],
                }
            )

        return normalized


async def handle_connection(websocket, whisper_cmd: str, model_path: str, args) -> None:
    session = StreamingSession(websocket, whisper_cmd, model_path, args)

    try:
        async for message in websocket:
            await session.handle_message(message)
    except ConnectionClosed:
        return
    except Exception as exc:
        try:
            await websocket.send(
                json.dumps(
                    {"type": "error", "error": str(exc), "sessionId": session.session_id}
                )
            )
        except Exception:
            pass


async def main_async(args) -> None:
    whisper_cmd = check_dependencies()
    model_path = find_whisper_model()

    print("=" * 56)
    print("Meeting Transcriber — Local Whisper Server")
    print("=" * 56)
    print(f"Listening on ws://{args.host}:{args.port}")
    print(f"Model: {model_path}")
    if args.prompt or args.vocab:
        print(f"Prompt: {build_whisper_prompt(args.vocab, args.prompt)}")
    if not os.environ.get("HF_TOKEN"):
        print("HF_TOKEN not set. Pyannote diarization will be skipped.")
    print("")

    async with websockets.serve(
        lambda websocket: handle_connection(websocket, whisper_cmd, model_path, args),
        args.host,
        args.port,
        max_size=8 * 1024 * 1024,
        ping_interval=20,
        ping_timeout=20,
    ):
        await asyncio.Future()


def parse_args():
    parser = argparse.ArgumentParser(
        description="Stream meeting audio into whisper.cpp over WebSocket."
    )
    parser.add_argument("--host", default="127.0.0.1", help="WebSocket bind host")
    parser.add_argument("--port", type=int, default=9090, help="WebSocket bind port")
    parser.add_argument(
        "--window-seconds",
        type=int,
        default=5,
        help="Whisper transcription window size in seconds",
    )
    parser.add_argument(
        "--overlap-seconds",
        type=int,
        default=1,
        help="Overlap between Whisper windows in seconds",
    )
    parser.add_argument(
        "--diarization-interval",
        type=int,
        default=30,
        help="How often to refresh pyannote diarization, in seconds",
    )
    parser.add_argument("--vocab", help="Comma-separated custom vocabulary for Whisper")
    parser.add_argument("--prompt", help="Context prompt for Whisper")
    parser.add_argument(
        "--no-vad",
        action="store_true",
        help="Disable Silero VAD before Whisper windows",
    )
    parser.add_argument(
        "--no-filter",
        action="store_true",
        help="Disable hallucination filtering",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
