import asyncio
import io
import mimetypes
import wave
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from app.api.routes.history import get_record, save_record
from app.core.config import get_settings
from app.models.schemas import (
    JobAccepted,
    JobStatus,
    Language,
    ProcessingStage,
    SessionType,
    TranscriptRecord,
)
from app.services.audio_service import audio_duration_seconds, wav_rms
from app.services.diarization_service import diarize_file, merge_transcript_and_speakers
from app.services.gemini_service import GeminiService

router = APIRouter(prefix="/transcribe", tags=["transcription"])
_tasks: set[asyncio.Task[None]] = set()
_tasks_by_record: dict[str, asyncio.Task[None]] = {}

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


def _start_task(coroutine, record_id: str | None = None) -> None:
    """Keep in-process jobs strongly referenced until they finish."""
    task = asyncio.create_task(coroutine)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    if record_id:
        _tasks_by_record[record_id] = task
        task.add_done_callback(lambda _task: _tasks_by_record.pop(record_id, None))


async def cancel_task(record_id: str) -> bool:
    task = _tasks_by_record.get(record_id)
    if not task or task.done():
        return False
    task.cancel()
    return True


async def _write_upload_limited(file: UploadFile, path: Path, limit_bytes: int) -> None:
    """Stream an upload to disk instead of retaining the whole file in RAM."""
    written = 0
    try:
        with path.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > limit_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Audio file exceeds the {limit_bytes // (1024 * 1024)} MB limit",
                    )
                await asyncio.to_thread(output.write, chunk)
        if written == 0:
            raise HTTPException(status_code=400, detail="Audio file is empty")
    except Exception:
        if path.exists():
            await asyncio.to_thread(path.unlink)
        raise


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
        if known_duration is None:
            known_duration = (
                _wav_duration(audio)
                if path.suffix.lower() == ".wav"
                else await asyncio.to_thread(audio_duration_seconds, path)
            )
            if known_duration is not None:
                record.duration_seconds = known_duration
        gemini = GeminiService()
        energy = wav_rms(audio) if path.suffix.lower() == ".wav" else None
        if energy is not None and energy < get_settings().live_silence_rms_threshold:
            transcript = []
        else:
            diarization_task = (
                asyncio.create_task(diarize_file(str(path)))
                if record.diarization
                else None
            )
            transcript = await gemini.transcribe_file(
                audio,
                mime_type,
                Language.mixed,
                include_speakers=record.diarization,
                audio_duration_seconds=known_duration,
                translate_to=get_settings().target_language
                if get_settings().auto_translate
                else None,
            )
            settings = get_settings()
            if settings.auto_translate and transcript and any(
                not item.translated_text for item in transcript
            ):
                translations = await gemini.translate_segments(
                    transcript, settings.target_language
                )
                transcript = [
                    item.model_copy(update={"translated_text": translated})
                    for item, translated in zip(transcript, translations, strict=True)
                ]
        record.segments = transcript
        if record.diarization and transcript:
            record.processing_stage = ProcessingStage.diarizing
            await save_record(record)
            try:
                # Local inference refines Gemini's fallback labels only after
                # the authoritative transcript is complete.
                speakers = await diarization_task if diarization_task else []
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
        # A client-captured duration describes the complete recording, including
        # silence after the final utterance. Only infer it from segments when the
        # recorder or uploaded file could not provide an authoritative value.
        if record.segments and record.duration_seconds is None:
            record.duration_seconds = max(item.end for item in record.segments)
        record.transcript = "\n".join(
            f"{segment.speaker}: {segment.text}" if segment.speaker else segment.text
            for segment in record.segments
        )
        record.status = JobStatus.completed
        record.processing_stage = None
    except asyncio.CancelledError:
        record.status = JobStatus.failed
        record.processing_stage = None
        record.error = "Transcription cancelled"
        raise
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
    await _write_upload_limited(
        file, path, get_settings().max_upload_mb * 1024 * 1024
    )
    record = TranscriptRecord(
        title=title.strip() or "Untitled transcript",
        language=language,
        session_type=session_type,
        diarization=diarization,
        duration_seconds=duration_seconds,
        audio_filename=path.name,
    )
    await save_record(record)
    _start_task(_process(record, path, file.content_type or "audio/wav"), record.id)
    return JobAccepted(id=record.id, status=record.status)


@router.post("/{record_id}/cancel", response_model=JobAccepted)
async def cancel_transcription(record_id: str) -> JobAccepted:
    record = await get_record(record_id)
    if not record:
        raise HTTPException(status_code=404, detail="Transcript not found")
    if record.status not in (JobStatus.queued, JobStatus.processing):
        raise HTTPException(status_code=409, detail="Job is not active")
    cancelled = await cancel_task(record_id)
    if not cancelled:
        raise HTTPException(status_code=409, detail="Job cannot be cancelled on this worker")
    record.status = JobStatus.failed
    record.processing_stage = None
    record.error = "Transcription cancelled"
    await save_record(record)
    return JobAccepted(id=record.id, status=record.status)


@router.post("/{record_id}/retry", response_model=JobAccepted, status_code=202)
async def retry_transcription(record_id: str) -> JobAccepted:
    record = await get_record(record_id)
    if not record:
        raise HTTPException(status_code=404, detail="Transcript not found")
    if record.status != JobStatus.failed or not record.audio_filename:
        raise HTTPException(status_code=409, detail="Only failed file jobs can be retried")
    path = get_settings().data_dir / "audio" / Path(record.audio_filename).name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Source audio not found")
    record.status = JobStatus.queued
    record.processing_stage = None
    record.error = None
    await save_record(record)
    _start_task(
        _process(record, path, mimetypes.guess_type(path.name)[0] or "audio/wav"),
        record.id,
    )
    return JobAccepted(id=record.id, status=record.status)
