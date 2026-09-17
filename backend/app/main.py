import asyncio
import logging
import mimetypes
import time
from uuid import uuid4
from contextlib import asynccontextmanager, suppress
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import history, live, meetings, transcribe
from app.core.config import get_settings
from app.core.observability import configure_error_monitoring, configure_logging, metrics
from app.models.schemas import JobStatus, ProcessingStage, SessionType
from app.services.diarization_service import warm_up_diarization

logger = logging.getLogger(__name__)
configure_logging()


async def _preload_diarization(app: FastAPI) -> None:
    try:
        app.state.diarization_ready = await warm_up_diarization()
        if app.state.diarization_ready:
            logger.info("Pyannote diarization pipeline is preloaded")
        else:
            logger.info("Pyannote preload skipped because HUGGINGFACE_TOKEN is not set")
    except Exception:
        # Diarization is an optional refinement. Keep Gemini transcription
        # available and let the existing per-job fallback report the issue.
        logger.exception("Pyannote preload failed; Gemini fallback remains available")


async def _recover_interrupted_live_jobs() -> None:
    """Resume finalization jobs and terminate orphaned recording sessions.

    A live job can remain persisted as ``processing`` when the API process exits
    before the WebSocket cleanup runs.  There is no microphone connection to
    resume after startup, so leaving that record active makes clients poll it
    forever.
    """
    settings = get_settings()
    recoverable_stages = {
        ProcessingStage.saving_audio,
        ProcessingStage.transcribing,
        ProcessingStage.diarizing,
    }
    for record in await history.list_history():
        if record.session_type != SessionType.live or record.status != JobStatus.processing:
            continue

        path = (
            settings.data_dir / "audio" / record.audio_filename
            if record.audio_filename
            else None
        )
        if (
            record.processing_stage in recoverable_stages
            and path is not None
            and path.is_file()
        ):
            logger.info("Resuming interrupted live finalization for %s", record.id)
            live._start_background_finalization(record, path)
            continue

        # ``recording`` (and legacy records with no stage) cannot be resumed:
        # their WebSocket and any unwritten in-memory PCM disappeared with the
        # previous process. Move them to a terminal state so the UI can stop
        # displaying an endless loading indicator.
        record.status = JobStatus.failed
        record.processing_stage = None
        record.error = "Live recording was interrupted before it could be saved"
        await history.save_record(record)
        logger.warning("Marked interrupted live recording %s as failed", record.id)


async def _recover_file_jobs() -> None:
    """Requeue persisted Record/Upload work after an API restart."""
    settings = get_settings()
    for record in await history.list_history():
        if record.session_type not in (SessionType.record, SessionType.upload):
            continue
        if record.status not in (JobStatus.queued, JobStatus.processing):
            continue
        path = settings.data_dir / "audio" / (record.audio_filename or "")
        if not record.audio_filename or not path.is_file():
            record.status = JobStatus.failed
            record.processing_stage = None
            record.error = "Source audio is unavailable after restart"
            await history.save_record(record)
            continue
        logger.info("Requeuing interrupted transcription %s", record.id)
        transcribe._start_task(
            transcribe._process(
                record, path, mimetypes.guess_type(path.name)[0] or "audio/wav"
            ),
            record.id,
        )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.diarization_ready = False
    # Warm the optional model in the background. API and WebSocket handshakes
    # must remain available while a large checkpoint is downloading/loading.
    preload_task = asyncio.create_task(_preload_diarization(app))
    await _recover_interrupted_live_jobs()
    await _recover_file_jobs()
    yield
    if not preload_task.done():
        preload_task.cancel()
        with suppress(asyncio.CancelledError):
            await preload_task

settings = get_settings()
configure_error_monitoring(settings.sentry_dsn, settings.app_environment)
app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=settings.origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(transcribe.router, prefix=settings.api_prefix)
app.include_router(live.router, prefix=settings.api_prefix)
app.include_router(meetings.router, prefix=settings.api_prefix)
app.include_router(history.router, prefix=settings.api_prefix)


@app.middleware("http")
async def observe_requests(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid4())
    started = time.perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        response.headers["x-request-id"] = request_id
        return response
    finally:
        metrics.observe(
            request.method,
            request.url.path,
            status_code,
            time.perf_counter() - started,
        )


@app.get("/health")
async def health() -> dict:
    audio_dir = settings.data_dir / "audio"
    checks = {
        "storage": audio_dir.is_dir(),
        "vertex_credentials": settings.vertex_service_account_json.is_file(),
        "diarization_ready": bool(getattr(app.state, "diarization_ready", False)),
        "livekit_configured": bool(
            settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret
        ),
    }
    return {"status": "ok" if checks["storage"] else "degraded", "checks": checks}


@app.get("/metrics")
async def application_metrics() -> dict:
    return metrics.snapshot()
