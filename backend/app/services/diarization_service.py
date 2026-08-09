import asyncio
from functools import lru_cache
from typing import Any

from app.core.config import get_settings
from app.models.schemas import TranscriptSegment


@lru_cache(maxsize=1)
def _load_pipeline() -> Any:
    settings = get_settings()
    if not settings.huggingface_token:
        raise RuntimeError(
            "HUGGINGFACE_TOKEN is required. Accept the Community-1 model terms first."
        )
    # Lazy loading keeps the API and non-diarization paths usable on hosts that
    # intentionally do not install the large optional inference stack.
    from pyannote.audio import Pipeline

    return Pipeline.from_pretrained(
        settings.pyannote_model, token=settings.huggingface_token
    )


def _run_pipeline(path: str) -> list[TranscriptSegment]:
    output = _load_pipeline()(path)
    # Community-1's exclusive timeline guarantees a single active speaker and
    # is specifically intended for reconciling diarization with ASR timestamps.
    annotation = getattr(
        output,
        "exclusive_speaker_diarization",
        getattr(output, "speaker_diarization", output),
    )
    segments: list[TranscriptSegment] = []
    if hasattr(annotation, "itertracks"):
        iterator = ((turn, speaker) for turn, _, speaker in annotation.itertracks(yield_label=True))
    else:
        iterator = iter(annotation)
    for turn, speaker in iterator:
        segments.append(
            TranscriptSegment(
                start=float(turn.start),
                end=float(turn.end),
                text="",
                speaker=str(speaker),
            )
        )
    return segments


async def diarize_file(path: str) -> list[TranscriptSegment]:
    """Run gated pyannote inference without blocking FastAPI's event loop."""
    return await asyncio.to_thread(_run_pipeline, path)


def merge_transcript_and_speakers(
    transcript: list[TranscriptSegment], speakers: list[TranscriptSegment]
) -> list[TranscriptSegment]:
    merged: list[TranscriptSegment] = []
    for utterance in transcript:
        best_speaker: str | None = None
        best_overlap = 0.0
        midpoint = (utterance.start + utterance.end) / 2
        for turn in speakers:
            overlap = max(
                0.0,
                min(utterance.end, turn.end) - max(utterance.start, turn.start),
            )
            contains_midpoint = turn.start <= midpoint <= turn.end
            score = overlap + (0.001 if contains_midpoint else 0)
            if score > best_overlap:
                best_overlap = score
                best_speaker = turn.speaker
        merged.append(
            utterance.model_copy(
                update={"speaker": best_speaker or "SPEAKER_UNKNOWN"}
            )
        )
    return merged
