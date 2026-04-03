import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from server import whisper_utils


class WhisperUtilsTests(unittest.TestCase):
    def tearDown(self):
        whisper_utils.reset_runtime_caches()

    @mock.patch("server.whisper_utils.subprocess.run")
    def test_find_whisper_command_accepts_whisper_cpp(self, run_mock):
        run_mock.return_value = mock.Mock(returncode=0)

        command = whisper_utils.find_whisper_command()

        self.assertEqual(command, "whisper-cpp")
        run_mock.assert_called_once_with(
            ["whisper-cpp", "--help"],
            capture_output=True,
            text=True,
            timeout=5,
        )

    @mock.patch.dict(os.environ, {}, clear=True)
    def test_diarization_status_without_token(self):
        status = whisper_utils.get_diarization_status()
        self.assertEqual(status, "missing_hf_token")

    @mock.patch.dict(os.environ, {"HF_TOKEN": "hf_test"}, clear=True)
    @mock.patch("builtins.__import__")
    def test_diarization_status_without_pyannote(self, import_mock):
        real_import = __import__

        def side_effect(name, *args, **kwargs):
            if name == "pyannote.audio":
                raise ImportError("missing")
            return real_import(name, *args, **kwargs)

        import_mock.side_effect = side_effect

        status = whisper_utils.get_diarization_status()

        self.assertEqual(status, "unavailable")

    @mock.patch("server.whisper_utils.get_silero_vad")
    def test_detect_speech_segments_uses_cached_vad_loader_once(self, get_vad_mock):
        read_audio = mock.Mock(return_value="wav")
        get_timestamps = mock.Mock(return_value=[{"start": 0, "end": 16000}])
        get_vad_mock.return_value = ("model", (get_timestamps, None, read_audio, None, None))

        first = whisper_utils.detect_speech_segments("sample.wav")
        second = whisper_utils.detect_speech_segments("sample.wav")

        self.assertEqual(first, [(0.0, 1.0)])
        self.assertEqual(second, [(0.0, 1.0)])
        self.assertEqual(get_vad_mock.call_count, 2)
        self.assertEqual(read_audio.call_count, 2)

    @mock.patch.dict(os.environ, {"HF_TOKEN": "hf_test"}, clear=True)
    def test_pyannote_pipeline_is_cached(self):
        fake_pipeline = mock.Mock()
        pipeline_cls = mock.Mock()
        pipeline_cls.from_pretrained.return_value = fake_pipeline

        with mock.patch.dict("sys.modules", {"pyannote.audio": mock.Mock(Pipeline=pipeline_cls)}):
            first = whisper_utils._build_pyannote_pipeline()
            second = whisper_utils._build_pyannote_pipeline()

        self.assertIs(first, fake_pipeline)
        self.assertIs(second, fake_pipeline)
        pipeline_cls.from_pretrained.assert_called_once_with(
            whisper_utils.PYANNOTE_MODEL_NAME,
            use_auth_token="hf_test",
        )


if __name__ == "__main__":
    unittest.main()
