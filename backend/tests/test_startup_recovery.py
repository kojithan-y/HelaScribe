import asyncio
from pathlib import Path
from types import SimpleNamespace

from app import main
from app.models.schemas import (
    JobStatus,
    Language,
    ProcessingStage,
    SessionType,
    TranscriptRecord,
)


def _live_record(stage: ProcessingStage | None) -> TranscriptRecord:
    return TranscriptRecord(
        title="Interrupted live session",
        language=Language.tamil,
        session_type=SessionType.live,
        status=JobStatus.processing,
        processing_stage=stage,
        audio_filename="recording.wav",
    )


def test_startup_marks_orphaned_recordings_as_failed(monkeypatch, tmp_path: Path) -> None:
    records = [
        _live_record(ProcessingStage.recording),
        _live_record(None),  # Legacy interrupted sessions did not retain a stage.
    ]
    saved: list[TranscriptRecord] = []

    async def list_history():
        return records

    async def save_record(item: TranscriptRecord):
        saved.append(item)
        return item

    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(data_dir=tmp_path))
    monkeypatch.setattr(main.history, "list_history", list_history)
    monkeypatch.setattr(main.history, "save_record", save_record)

    asyncio.run(main._recover_interrupted_live_jobs())

    assert saved == records
    assert all(record.status == JobStatus.failed for record in records)
    assert all(record.processing_stage is None for record in records)
    assert all(
        record.error == "Live recording was interrupted before it could be saved"
        for record in records
    )


def test_startup_resumes_saved_live_finalization(monkeypatch, tmp_path: Path) -> None:
    record = _live_record(ProcessingStage.transcribing)
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    path = audio_dir / "recording.wav"
    path.write_bytes(b"saved audio")
    resumed: list[tuple[TranscriptRecord, Path]] = []

    async def list_history():
        return [record]

    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(data_dir=tmp_path))
    monkeypatch.setattr(main.history, "list_history", list_history)
    monkeypatch.setattr(
        main.live,
        "_start_background_finalization",
        lambda item, audio_path: resumed.append((item, audio_path)),
    )

    asyncio.run(main._recover_interrupted_live_jobs())

    assert resumed == [(record, path)]
    assert record.status == JobStatus.processing
