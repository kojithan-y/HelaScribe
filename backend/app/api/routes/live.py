import asyncio
import io
import wave
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.routes.history import save_record
from app.core.config import get_settings
from app.models.schemas import (
    JobStatus,
    LiveStart,
    SessionType,
    TranscriptRecord,
    TranscriptSegment,
)
from app.services.audio_service import pcm_rms as _pcm_rms, wav_rms
from app.services.diarization_service import diarize_file, merge_transcript_and_speakers
from app.services.gemini_service import GeminiService

router = APIRouter(tags=["live"])


def _pcm_wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


def _write_pcm_wav(path: Path, pcm: bytes, sample_rate: int) -> None:
    path.write_bytes(_pcm_wav_bytes(pcm, sample_rate))


def _is_committed_segment(segment: TranscriptSegment, commit_after: float) -> bool:
    return (segment.start + segment.end) / 2 >= commit_after


async def _finalize_live(record: TranscriptRecord, path: Path) -> None:
    record.status = JobStatus.processing
    await save_record(record)
    try:
        settings = get_settings()
        if settings.live_finalize_full_audio:
            # Chunk results are a low-latency preview. Re-transcribe the retained
            # recording once so chunk boundaries cannot corrupt the final result.
            preview_segments = record.segments
            try:
                audio = await asyncio.to_thread(path.read_bytes)
                inline_limit = settings.max_upload_mb * 1024 * 1024
                energy = wav_rms(audio)
                if energy is not None and energy < settings.live_silence_rms_threshold:
                    record.segments = []
                elif len(audio) <= inline_limit:
                    record.segments = await GeminiService().transcribe_file(
                        audio,
                        "audio/wav",
                        record.language,
                        model=settings.gemini_batch_model,
                        include_speakers=record.diarization,
                        audio_duration_seconds=record.duration_seconds,
                    )
                else:
                    record.error = (
                        "Full-session quality pass skipped because the recording "
                        f"exceeds {settings.max_upload_mb} MB; chunk previews were retained"
                    )
            except Exception as exc:
                record.segments = preview_segments
                record.error = f"Full-session quality pass unavailable: {exc}"
        if record.diarization and record.segments:
            try:
                speakers = await diarize_file(str(path))
                record.segments = merge_transcript_and_speakers(record.segments, speakers)
            except Exception as exc:
                # Preserve the authoritative Gemini speaker labels when the
                # optional local refinement cannot safely load or execute.
                if any(item.speaker for item in record.segments):
                    warning = (
                        "Local speaker diarization unavailable; using Gemini speaker "
                        f"labels: {exc}"
                    )
                else:
                    record.diarization = False
                    warning = f"Speaker diarization unavailable: {exc}"
                record.error = f"{record.error}; {warning}" if record.error else warning
        record.transcript = "\n".join(
            f"{item.speaker}: {item.text}" if item.speaker else item.text
            for item in record.segments
        )
        record.status = JobStatus.completed
    except Exception as exc:
        record.status = JobStatus.failed
        record.error = str(exc)
    await save_record(record)


@router.websocket("/live")
async def live_transcription(websocket: WebSocket) -> None:
    await websocket.accept()
    pcm = bytearray()
    pending = bytearray()
    record: TranscriptRecord | None = None
    stopped = False
    worker: asyncio.Task | None = None
    try:
        start = LiveStart.model_validate(await websocket.receive_json())
        record = TranscriptRecord(
            title=start.title,
            language=start.language,
            session_type=SessionType.live,
            diarization=start.diarization,
            status=JobStatus.processing,
            audio_filename="pending.wav",
        )
        record.audio_filename = f"{record.id}.wav"
        await save_record(record)
        await websocket.send_json({"type": "ready", "id": record.id})

        settings = get_settings()
        gemini = GeminiService()
        chunk_bytes = max(
            start.sample_rate * 2,
            int(settings.live_chunk_seconds * start.sample_rate * 2),
        )
        queue: asyncio.Queue[tuple[bytes, float, float] | None] = asyncio.Queue()

        async def transcribe_chunks() -> None:
            while True:
                queued = await queue.get()
                if queued is None:
                    return
                chunk, offset, commit_after = queued
                if _pcm_rms(chunk) < settings.live_silence_rms_threshold:
                    continue
                segments = await gemini.transcribe_file(
                    _pcm_wav_bytes(chunk, start.sample_rate),
                    "audio/wav",
                    start.language,
                    model=settings.gemini_live_model,
                    timestamp_offset=offset,
                    audio_duration_seconds=len(chunk) / (start.sample_rate * 2),
                )
                for segment in segments:
                    if not _is_committed_segment(segment, commit_after):
                        continue
                    record.segments.append(segment)
                    await websocket.send_json(
                        {"type": "transcript", "segment": segment.model_dump()}
                    )

        worker = asyncio.create_task(transcribe_chunks())
        queued_bytes = 0
        overlap_bytes = min(
            chunk_bytes // 2,
            int(settings.live_chunk_overlap_seconds * start.sample_rate * 2),
        )
        advance_bytes = chunk_bytes - overlap_bytes
        first_chunk = True
        max_pcm_bytes = int(settings.max_live_minutes * 60 * start.sample_rate * 2)
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                chunk = message["bytes"]
                if len(pcm) + len(chunk) > max_pcm_bytes:
                    raise ValueError(
                        f"Live session exceeds the {settings.max_live_minutes:g} minute limit"
                    )
                pcm.extend(chunk)
                pending.extend(chunk)
                while len(pending) >= chunk_bytes:
                    live_chunk = bytes(pending[:chunk_bytes])
                    offset = queued_bytes / (start.sample_rate * 2)
                    commit_after = 0.0 if first_chunk else offset + settings.live_chunk_overlap_seconds
                    await queue.put((live_chunk, offset, commit_after))
                    del pending[:advance_bytes]
                    queued_bytes += advance_bytes
                    first_chunk = False
            elif message.get("text") == "stop":
                stopped = True
                if pending:
                    offset = queued_bytes / (start.sample_rate * 2)
                    commit_after = 0.0 if first_chunk else offset + settings.live_chunk_overlap_seconds
                    await queue.put((bytes(pending), offset, commit_after))
                    queued_bytes += len(pending)
                    pending.clear()
                await queue.put(None)
                await worker
                break

        path = settings.data_dir / "audio" / record.audio_filename
        await asyncio.to_thread(_write_pcm_wav, path, bytes(pcm), start.sample_rate)
        record.duration_seconds = len(pcm) / (start.sample_rate * 2)
        await save_record(record)
        asyncio.create_task(_finalize_live(record, path))
        await websocket.send_json({"type": "finalizing", "id": record.id})
        await websocket.close()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        if record:
            record.status = JobStatus.failed
            record.error = str(exc)
            await save_record(record)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        if worker and not worker.done():
            worker.cancel()
        if record and not stopped and record.status == JobStatus.processing:
            record.status = JobStatus.failed
            record.error = "Live connection closed before the session was stopped"
            await save_record(record)
