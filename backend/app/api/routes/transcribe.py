import asyncio
import io
import wave
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from app.api.routes.history import save_record
from app.core.config import get_settings
from app.models.schemas import (
    JobAccepted,
    JobStatus,
    Language,
    ProcessingStage,
    SessionType,
    TranscriptRecord,
)
from app.services.audio_service import wav_rms
from app.services.diarization_service import diarize_file, merge_transcript_and_speakers
from app.services.gemini_service import GeminiService

router = APIRouter(prefix="/transcribe", tags=["transcription"])
_tasks: set[asyncio.Task[None]] = set()

ALLOWED_AUDIO_SUFFIXES = {
    ".aac",
    ".flac",
    ".m4a",
    ".mp3",
    ".mp4",
    ".mpeg",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
}


def _start_task(coroutine) -> None:
    """Keep in-process jobs strongly referenced until they finish."""
    task = asyncio.create_task(coroutine)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _read_limited(file: UploadFile, limit_bytes: int) -> bytes:
    content = bytearray()
    while chunk := await file.read(1024 * 1024):
        content.extend(chunk)
        if len(content) > limit_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Audio file exceeds the {limit_bytes // (1024 * 1024)} MB limit",
            )
    if not content:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    return bytes(content)


def _wav_duration(audio: bytes) -> float | None:
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            return wav.getnframes() / wav.getframerate()
    except (wave.Error, EOFError, ZeroDivisionError):
        return None


async def _process(record: TranscriptRecord, path: Path, mime_type: str) -> None:
    record.status = JobStatus.processing
    record.processing_stage = ProcessingStage.transcribing
    await save_record(record)
    try:
        audio = await asyncio.to_thread(path.read_bytes)
        known_duration = record.duration_seconds
        if known_duration is None and path.suffix.lower() == ".wav":
            known_duration = _wav_duration(audio)
        gemini = GeminiService()
        energy = wav_rms(audio) if path.suffix.lower() == ".wav" else None
        if energy is not None and energy < get_settings().live_silence_rms_threshold:
            transcript = []
        else:
            transcript = await gemini.transcribe_file(
                audio,
                mime_type,
                record.language,
                include_speakers=record.diarization,
                audio_duration_seconds=known_duration,
            )
        record.segments = transcript
        if record.diarization and transcript:
            record.processing_stage = ProcessingStage.diarizing
            await save_record(record)
            try:
                # Local inference refines Gemini's fallback labels only after
                # the authoritative transcript is complete.
                speakers = await diarize_file(str(path))
                record.segments = merge_transcript_and_speakers(transcript, speakers)
            except Exception as exc:
                record.segments = transcript
                if any(item.speaker for item in transcript):
                    record.error = (
                        "Local speaker diarization unavailable; using Gemini speaker "
                        f"labels: {exc}"
                    )
                else:
                    record.diarization = False
                    record.error = f"Speaker diarization unavailable: {exc}"
        if record.segments:
            record.duration_seconds = max(item.end for item in record.segments)
        record.transcript = "\n".join(
            f"{segment.speaker}: {segment.text}" if segment.speaker else segment.text
            for segment in record.segments
        )
        record.status = JobStatus.completed
        record.processing_stage = None
    except Exception as exc:
        record.status = JobStatus.failed
        record.processing_stage = None
        record.error = str(exc)
    finally:
        await save_record(record)


@router.post("", response_model=JobAccepted, status_code=status.HTTP_202_ACCEPTED)
async def transcribe_audio(
    file: UploadFile = File(...),
    language: Language = Form(...),
    session_type: SessionType = Form(SessionType.upload),
    diarization: bool = Form(False),
    title: str = Form("Untitled transcript", max_length=200),
    duration_seconds: float | None = Form(default=None, gt=0, le=28_800),
) -> JobAccepted:
    if session_type in (SessionType.live, SessionType.meeting):
        raise HTTPException(status_code=400, detail="Use the realtime API for this session type")
    suffix = Path(file.filename or "audio.wav").suffix.lower() or ".wav"
    if suffix not in ALLOWED_AUDIO_SUFFIXES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported audio format: {suffix}",
        )
    path = get_settings().data_dir / "audio" / f"{uuid4()}{suffix}"
    content = await _read_limited(
        file,
        get_settings().max_upload_mb * 1024 * 1024,
    )
    await asyncio.to_thread(path.write_bytes, content)
    record = TranscriptRecord(
        title=title.strip() or "Untitled transcript",
        language=language,
        session_type=session_type,
        diarization=diarization,
        duration_seconds=duration_seconds,
        audio_filename=path.name,
    )
    await save_record(record)
    _start_task(_process(record, path, file.content_type or "audio/wav"))
    return JobAccepted(id=record.id, status=record.status)
