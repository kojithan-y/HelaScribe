import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import history, live, meetings, transcribe
from app.core.config import get_settings
from app.models.schemas import JobStatus, ProcessingStage, SessionType
from app.services.diarization_service import warm_up_diarization

logger = logging.getLogger(__name__)


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


async def _resume_interrupted_live_finalizations() -> None:
    """Resume only persisted live jobs that had reached finalization."""
    settings = get_settings()
    recoverable_stages = {
        ProcessingStage.saving_audio,
        ProcessingStage.transcribing,
        ProcessingStage.diarizing,
    }
    for record in await history.list_history():
        if (
            record.session_type != SessionType.live
            or record.status != JobStatus.processing
            or record.processing_stage not in recoverable_stages
            or not record.audio_filename
        ):
            continue
        path = settings.data_dir / "audio" / record.audio_filename
        if path.is_file():
            logger.info("Resuming interrupted live finalization for %s", record.id)
            live._start_background_finalization(record, path)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.diarization_ready = False
    # Do not hold FastAPI startup (and the phone's WebSocket connection) while
    # a large model is downloaded or loaded. The warm-up continues in-process.
    preload_task = asyncio.create_task(_preload_diarization(app))
    await _resume_interrupted_live_finalizations()
    yield
    if not preload_task.done():
        preload_task.cancel()
        with suppress(asyncio.CancelledError):
            await preload_task

settings = get_settings()
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


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
