import asyncio
import io
import struct
import wave
from pathlib import Path
from types import SimpleNamespace

from app.api.routes import live
from app.models.schemas import (
    JobStatus,
    Language,
    SessionType,
    TranscriptRecord,
    TranscriptSegment,
)


def test_pcm_wav_bytes_preserves_stream_format() -> None:
    pcm = b"\x00\x00\xff\x7f\x00\x80"

    encoded = live._pcm_wav_bytes(pcm, sample_rate=16_000)

    with wave.open(io.BytesIO(encoded), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getframerate() == 16_000
        assert wav.readframes(wav.getnframes()) == pcm


def test_pcm_rms_rejects_silence_and_detects_audio() -> None:
    assert live._pcm_rms(b"\x00\x00" * 1_000) == 0

    alternating_signal = struct.pack("<1000h", *([-1_000, 1_000] * 500))
    assert live._pcm_rms(alternating_signal) == 1_000


def test_overlap_commits_each_segment_once_by_midpoint() -> None:
    old_overlap = TranscriptSegment(start=7.1, end=7.8, text="already emitted")
    boundary_word = TranscriptSegment(start=7.8, end=8.4, text="keep intact")

    assert live._is_committed_segment(old_overlap, 8.0) is False
    assert live._is_committed_segment(boundary_word, 8.0) is True


def test_preview_queue_can_be_skipped_when_full_audio_will_replace_it(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(live_finalize_full_audio=True, max_upload_mb=20),
    )

    assert live._can_finalize_from_full_audio(1_000_000) is True


def test_preview_queue_is_drained_when_final_pass_is_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(live_finalize_full_audio=False, max_upload_mb=20),
    )
    assert live._can_finalize_from_full_audio(1_000_000) is False

    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(live_finalize_full_audio=True, max_upload_mb=1),
    )
    assert live._can_finalize_from_full_audio(2_000_000) is False


def test_live_chunk_requests_provisional_gemini_speakers(monkeypatch) -> None:
    calls: list[dict] = []

    class FakeGemini:
        async def transcribe_file(self, *_args, **kwargs):
            calls.append(kwargs)
            return []

    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(
            gemini_live_model="live-model",
            gemini_live_timeout_seconds=12.0,
        ),
    )
    record = TranscriptRecord(
        title="Live test",
        language=Language.english,
        session_type=SessionType.live,
        diarization=True,
    )

    asyncio.run(
        live._transcribe_live_chunk(
            FakeGemini(),
            b"\x00\x00" * 16_000,
            16_000,
            record,
            7.0,
        )
    )

    assert calls == [
        {
            "model": "live-model",
            "timestamp_offset": 7.0,
            "include_speakers": True,
            "audio_duration_seconds": 1.0,
            "request_timeout_seconds": 12.0,
        }
    ]


def test_finalize_preserves_transcript_when_diarization_fails(monkeypatch) -> None:
    record = TranscriptRecord(
        title="Live test",
        language=Language.english,
        session_type=SessionType.live,
        diarization=True,
        status=JobStatus.processing,
        segments=[TranscriptSegment(start=0, end=1, text="hello")],
    )

    async def fail_diarization(_path: str):
        raise RuntimeError("model could not load")

    async def ignore_save(saved: TranscriptRecord):
        return saved

    monkeypatch.setattr(live, "diarize_file", fail_diarization)
    monkeypatch.setattr(live, "save_record", ignore_save)
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(live_finalize_full_audio=False),
    )

    asyncio.run(live._finalize_live(record, Path("unused.wav")))

    assert record.status == JobStatus.completed
    assert record.transcript == "hello"
    assert record.diarization is False
    assert record.error == "Speaker diarization unavailable: model could not load"


def test_finalize_replaces_chunk_previews_with_full_quality_pass(
    monkeypatch, tmp_path: Path
) -> None:
    path = tmp_path / "live.wav"
    path.write_bytes(b"complete recording")
    record = TranscriptRecord(
        title="Live test",
        language=Language.mixed,
        session_type=SessionType.live,
        status=JobStatus.processing,
        segments=[TranscriptSegment(start=0, end=1, text="preview")],
    )

    class FakeGemini:
        async def transcribe_file(self, *_args, **_kwargs):
            return [
                TranscriptSegment(
                    start=0,
                    end=2,
                    text="final transcript",
                )
            ]

    async def ignore_save(saved: TranscriptRecord):
        return saved

    monkeypatch.setattr(live, "GeminiService", FakeGemini)
    monkeypatch.setattr(live, "save_record", ignore_save)
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(
            live_finalize_full_audio=True,
            max_upload_mb=20,
            gemini_batch_model="batch-model",
        ),
    )

    asyncio.run(live._finalize_live(record, path))

    assert [item.text for item in record.segments] == ["final transcript"]
    assert record.transcript == "final transcript"
    assert record.status == JobStatus.completed
