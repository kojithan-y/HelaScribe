import asyncio
import io
import logging
import wave
from contextlib import suppress
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.routes.history import save_record
from app.core.config import get_settings
from app.models.schemas import (
    JobStatus,
    LiveStart,
    ProcessingStage,
    SessionType,
    TranscriptRecord,
    TranscriptSegment,
)
from app.services.audio_service import pcm_rms as _pcm_rms, wav_rms
from app.services.diarization_service import diarize_file, merge_transcript_and_speakers
from app.services.gemini_service import GeminiService

router = APIRouter(tags=["live"])
logger = logging.getLogger(__name__)
_background_tasks: set[asyncio.Task[None]] = set()


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


def _raw_to_wav(raw_path: Path, path: Path, sample_rate: int) -> None:
    """Wrap a streamed PCM file as WAV without loading the session into RAM."""
    with raw_path.open("rb") as source, wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        while chunk := source.read(1024 * 1024):
            output.writeframesraw(chunk)


def _is_committed_segment(segment: TranscriptSegment, commit_after: float) -> bool:
    return (segment.start + segment.end) / 2 >= commit_after


def _can_finalize_from_full_audio(pcm_size: int) -> bool:
    """Return whether the final pass can safely replace unfinished previews."""
    settings = get_settings()
    wav_header_size = 44
    return (
        settings.live_finalize_full_audio
        and pcm_size + wav_header_size <= settings.max_upload_mb * 1024 * 1024
    )


def _enqueue_latest_preview(
    queue: asyncio.Queue[tuple[bytes, float, float] | None],
    item: tuple[bytes, float, float],
) -> bool:
    """Keep audio capture responsive when Gemini preview calls fall behind.

    Live previews are provisional and the retained recording receives an
    authoritative full-audio pass after Stop. Dropping the oldest queued
    preview is therefore safer than blocking the WebSocket audio receiver.
    """
    dropped = False
    if queue.full():
        try:
            queue.get_nowait()
            dropped = True
        except asyncio.QueueEmpty:
            pass
    queue.put_nowait(item)
    return dropped


def _start_background_finalization(record: TranscriptRecord, path: Path) -> None:
    """Keep a strong reference until background finalization completes."""
    task = asyncio.create_task(_finalize_live(record, path))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _transcribe_live_chunk(
    gemini: GeminiService,
    chunk: bytes,
    sample_rate: int,
    record: TranscriptRecord,
    offset: float,
) -> list[TranscriptSegment]:
    settings = get_settings()
    request = {
        "model": settings.gemini_live_model,
        "timestamp_offset": offset,
        "include_speakers": record.diarization,
        "audio_duration_seconds": len(chunk) / (sample_rate * 2),
        "request_timeout_seconds": settings.gemini_live_timeout_seconds,
    }
    return await gemini.transcribe_file(
        _pcm_wav_bytes(chunk, sample_rate),
        "audio/wav",
        record.language,
        **request,
    )


async def _finalize_live(record: TranscriptRecord, path: Path) -> None:
    record.status = JobStatus.processing
    settings = get_settings()
    record.processing_stage = (
        ProcessingStage.transcribing
        if settings.live_finalize_full_audio
        else ProcessingStage.diarizing
        if record.diarization and record.segments
        else ProcessingStage.saving_audio
    )
    await save_record(record)
    try:
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
                    if settings.auto_translate and record.segments and any(
                        not item.translated_text for item in record.segments
                    ):
                        final_gemini = GeminiService()
                        translations = await final_gemini.translate_segments(
                            record.segments, settings.target_language
                        )
                        record.segments = [
                            item.model_copy(update={"translated_text": translated})
                            for item, translated in zip(
                                record.segments, translations, strict=True
                            )
                        ]
                    record.error = None
                else:
                    record.error = (
                        "Full-session quality pass skipped because the recording "
                        f"exceeds {settings.max_upload_mb} MB; chunk previews were retained"
                    )
            except Exception as exc:
                record.segments = preview_segments
                record.error = f"Full-session quality pass unavailable: {exc}"
        if record.diarization and record.segments:
            record.processing_stage = ProcessingStage.diarizing
            await save_record(record)
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
        record.processing_stage = None
    except Exception as exc:
        logger.exception("Live finalize failed for record %s", record.id)
        record.status = JobStatus.failed
        record.processing_stage = None
        record.error = str(exc)
    await save_record(record)


@router.websocket("/live")
async def live_transcription(websocket: WebSocket) -> None:
    await websocket.accept()
    pending = bytearray()
    pcm_size = 0
    record: TranscriptRecord | None = None
    raw_path: Path | None = None
    raw_file = None
    stopped = False
    workers: list[asyncio.Task[None]] = []
    try:
        start = LiveStart.model_validate(await websocket.receive_json())
        record = TranscriptRecord(
            title=start.title,
            language=start.language,
            session_type=start.session_type,
            diarization=start.diarization,
            status=JobStatus.processing,
            processing_stage=ProcessingStage.recording,
            audio_filename="pending.wav",
        )
        record.audio_filename = f"{record.id}.wav"
        raw_path = get_settings().data_dir / "audio" / f"{record.id}.pcm.part"
        raw_file = raw_path.open("wb")
        await save_record(record)
        await websocket.send_json({"type": "ready", "id": record.id})

        settings = get_settings()
        gemini = GeminiService()
        chunk_bytes = max(
            start.sample_rate * 2,
            int(settings.live_chunk_seconds * start.sample_rate * 2),
        )
        queue: asyncio.Queue[tuple[bytes, float, float] | None] = asyncio.Queue(
            maxsize=max(2, getattr(settings, "live_preview_queue_size", 4))
        )

        async def transcribe_chunks() -> None:
            warning_sent = False
            while True:
                queued = await queue.get()
                if queued is None:
                    return
                chunk, offset, commit_after = queued
                if _pcm_rms(chunk) < settings.live_silence_rms_threshold:
                    continue
                try:
                    segments = await _transcribe_live_chunk(
                        gemini,
                        chunk,
                        start.sample_rate,
                        record,
                        offset,
                    )
                except Exception as exc:
                    # A transient Gemini/quota failure must not terminate the
                    # microphone WebSocket. The final full-audio pass can fill
                    # any preview gap after the user stops the session.
                    logger.exception("Live chunk transcription skipped")
                    record.error = f"Live preview delayed: {exc}"
                    await save_record(record)
                    if not warning_sent:
                        await websocket.send_json(
                            {
                                "type": "warning",
                                "message": "Live preview is delayed; audio is still recording",
                            }
                        )
                        warning_sent = True
                    continue
                committed = [
                    segment
                    for segment in segments
                    if _is_committed_segment(segment, commit_after)
                ]
                for segment in committed:
                    record.segments.append(segment)
                    await websocket.send_json(
                        {"type": "transcript", "segment": segment.model_dump()}
                    )

                if settings.auto_translate and committed and any(
                    not item.translated_text for item in committed
                ):
                    try:
                        translations = await gemini.translate_segments(
                            committed, settings.target_language
                        )
                    except Exception as exc:
                        logger.warning("Live translation skipped: %s", exc)
                        continue
                    for segment, translated in zip(committed, translations, strict=True):
                        for index, saved in enumerate(record.segments):
                            if (
                                saved.start == segment.start
                                and saved.end == segment.end
                                and saved.text == segment.text
                            ):
                                translated_segment = saved.model_copy(
                                    update={"translated_text": translated}
                                )
                                record.segments[index] = translated_segment
                                await websocket.send_json(
                                    {
                                        "type": "translation",
                                        "segment": translated_segment.model_dump(),
                                    }
                                )
                                break

        workers = [
            asyncio.create_task(transcribe_chunks())
            for _ in range(2)
        ]
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
                if pcm_size + len(chunk) > max_pcm_bytes:
                    raise ValueError(
                        f"Live session exceeds the {settings.max_live_minutes:g} minute limit"
                    )
                raw_file.write(chunk)
                pcm_size += len(chunk)
                pending.extend(chunk)
                while len(pending) >= chunk_bytes:
                    live_chunk = bytes(pending[:chunk_bytes])
                    offset = queued_bytes / (start.sample_rate * 2)
                    commit_after = 0.0 if first_chunk else offset + settings.live_chunk_overlap_seconds
                    _enqueue_latest_preview(queue, (live_chunk, offset, commit_after))
                    del pending[:advance_bytes]
                    queued_bytes += advance_bytes
                    first_chunk = False
            elif message.get("text") == "stop":
                stopped = True
                if _can_finalize_from_full_audio(pcm_size):
                    # The authoritative full-audio pass will cover the entire
                    # recording. Give only the in-flight preview a short chance
                    # to finish, then stop waiting for stale preview calls.
                    pending.clear()
                    while not queue.empty():
                        queue.get_nowait()
                    for _ in workers:
                        await queue.put(None)
                    try:
                        await asyncio.wait_for(
                            asyncio.shield(asyncio.gather(*workers)),
                            timeout=settings.live_stop_preview_grace_seconds,
                        )
                    except TimeoutError:
                        for task in workers:
                            task.cancel()
                        await asyncio.gather(*workers, return_exceptions=True)
                else:
                    # Preserve the old drain behavior when the full pass is
                    # disabled or the recording is too large for inline input.
                    if pending:
                        offset = queued_bytes / (start.sample_rate * 2)
                        commit_after = 0.0 if first_chunk else offset + settings.live_chunk_overlap_seconds
                        await queue.put((bytes(pending), offset, commit_after))
                        queued_bytes += len(pending)
                        pending.clear()
                    for _ in workers:
                        await queue.put(None)
                    await asyncio.gather(*workers)
                break

        path = settings.data_dir / "audio" / record.audio_filename
        record.processing_stage = ProcessingStage.saving_audio
        await save_record(record)
        raw_file.close()
        raw_file = None
        await asyncio.to_thread(_raw_to_wav, raw_path, path, start.sample_rate)
        await asyncio.to_thread(raw_path.unlink)
        raw_path = None
        record.duration_seconds = pcm_size / (start.sample_rate * 2)
        await save_record(record)
        _start_background_finalization(record, path)
        await websocket.send_json({"type": "finalizing", "id": record.id})
        await websocket.close()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        if record:
            record.status = JobStatus.failed
            record.processing_stage = None
            record.error = str(exc)
            await save_record(record)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        if raw_file:
            raw_file.close()
        if raw_path and raw_path.exists():
            with suppress(OSError):
                raw_path.unlink()
        for task in workers:
            if not task.done():
                task.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)
        if record and not stopped and record.status == JobStatus.processing:
            record.status = JobStatus.failed
            record.processing_stage = None
            record.error = "Live connection closed before the session was stopped"
            await save_record(record)
