import asyncio
import json
import re
from google import genai
from google.genai import errors
from google.genai import types

from app.core.config import get_settings
from app.core.gcp_auth import load_vertex_credentials
from app.models.schemas import (
    GeminiTranscript,
    Language,
    SpokenLanguage,
    TranscriptSegment,
)


LANGUAGE_GUIDANCE = {
    Language.sinhala: (
        "Transcribe Sinhala speech only, in Sinhala script, without translation. "
        "Omit separate Tamil or English utterances; ordinary loanwords embedded in a "
        "Sinhala sentence may remain as naturally written. Set detected_language to Sinhala."
    ),
    Language.tamil: (
        "Transcribe Tamil speech only, in Tamil script, without translation. "
        "Omit separate Sinhala or English utterances; ordinary loanwords embedded in a "
        "Tamil sentence may remain as naturally written. Set detected_language to Tamil."
    ),
    Language.english: (
        "Transcribe English speech only, without translation. Omit separate Sinhala or "
        "Tamil utterances. Set detected_language to English."
    ),
    Language.mixed: (
        "The audio may switch between Sinhala, Tamil, and English. Transcribe all three, "
        "preserve each in its native script, and never translate. For every utterance set "
        "detected_language to Sinhala, Tamil, English, or Unknown. Split an utterance when "
        "the spoken language changes."
    ),
}

REQUESTED_SPOKEN_LANGUAGE = {
    Language.sinhala: SpokenLanguage.sinhala,
    Language.tamil: SpokenLanguage.tamil,
    Language.english: SpokenLanguage.english,
}

RETRYABLE_API_CODES = {429, 500, 502, 503, 504}


def _load_response_json(value: str) -> dict:
    """Parse model JSON while preserving literal malformed backslash sequences."""
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        # Model-written transcript text can contain a literal ``\u`` that is
        # not a JSON unicode escape. Escape only malformed sequences and retry.
        repaired = re.sub(r"\\u(?![0-9a-fA-F]{4})", r"\\\\u", value)
        repaired = re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", repaired)
        return json.loads(repaired)


def detect_script_language(text: str) -> SpokenLanguage:
    counts = {
        SpokenLanguage.sinhala: sum("\u0d80" <= char <= "\u0dff" for char in text),
        SpokenLanguage.tamil: sum("\u0b80" <= char <= "\u0bff" for char in text),
        SpokenLanguage.english: sum(char.isascii() and char.isalpha() for char in text),
    }
    language, count = max(counts.items(), key=lambda item: item[1])
    return language if count else SpokenLanguage.unknown


def normalize_language_segments(
    segments: list[TranscriptSegment], requested: Language
) -> list[TranscriptSegment]:
    """Enforce monolingual modes and fill deterministic mixed-mode labels."""
    normalized: list[TranscriptSegment] = []
    expected = REQUESTED_SPOKEN_LANGUAGE.get(requested)
    for segment in segments:
        detected = detect_script_language(segment.text)
        if expected and detected not in (expected, SpokenLanguage.unknown):
            continue
        normalized.append(
            segment.model_copy(
                update={"detected_language": expected or detected}
            )
        )
    return normalized


def bound_segments_to_duration(
    segments: list[TranscriptSegment], duration_seconds: float | None
) -> list[TranscriptSegment]:
    if duration_seconds is None:
        return segments
    bounded: list[TranscriptSegment] = []
    for segment in segments:
        if segment.start >= duration_seconds:
            continue
        end = min(segment.end, duration_seconds)
        if end < segment.start:
            continue
        bounded.append(segment.model_copy(update={"end": end}))
    return bounded


class GeminiService:
    def __init__(self) -> None:
        settings = get_settings()
        credentials, project = load_vertex_credentials()
        self.settings = settings
        self.client = genai.Client(
            vertexai=True,
            credentials=credentials,
            project=project,
            location=settings.gcp_location,
        )

    async def transcribe_file(
        self,
        audio: bytes,
        mime_type: str,
        language: Language,
        *,
        model: str | None = None,
        timestamp_offset: float = 0.0,
        include_speakers: bool = False,
        audio_duration_seconds: float | None = None,
        request_timeout_seconds: float | None = None,
    ) -> list[TranscriptSegment]:
        speaker_guidance = (
            "Assign stable anonymous labels SPEAKER_00, SPEAKER_01, and so on to "
            "different voices; do not guess people's names."
            if include_speakers
            else "Do not identify or label speakers; leave speaker null."
        )
        prompt = (
            "Transcribe only clearly intelligible speech in this audio, verbatim. "
            f"{LANGUAGE_GUIDANCE[language]} "
            "Never guess, infer, or invent words from silence, noise, music, or unclear audio. "
            "If there is no clearly intelligible speech, return an empty segments list. "
            "Return short timestamped utterances and split at pauses or speaker changes. "
            f"{speaker_guidance} "
            "Use seconds relative to the start of this audio clip for start and end."
        )
        timeout_seconds = request_timeout_seconds or self.settings.gemini_batch_timeout_seconds
        for attempt in range(self.settings.gemini_max_retries + 1):
            try:
                response = await asyncio.wait_for(
                    self.client.aio.models.generate_content(
                        model=model or self.settings.gemini_batch_model,
                        contents=[
                            types.Part.from_bytes(data=audio, mime_type=mime_type),
                            types.Part.from_text(text=prompt),
                        ],
                        config=types.GenerateContentConfig(
                            temperature=0.0,
                            audio_timestamp=True,
                            response_mime_type="application/json",
                            response_schema=GeminiTranscript,
                        ),
                    ),
                    timeout=timeout_seconds,
                )
                break
            except TimeoutError as exc:
                raise RuntimeError(
                    f"Gemini transcription timed out after {timeout_seconds:g} seconds"
                ) from exc
            except errors.APIError as exc:
                if (
                    exc.code not in RETRYABLE_API_CODES
                    or attempt >= self.settings.gemini_max_retries
                ):
                    raise
                await asyncio.sleep(
                    self.settings.gemini_retry_base_seconds * (2**attempt)
                )
        if getattr(response, "parsed", None):
            parsed = response.parsed
            if isinstance(parsed, GeminiTranscript):
                segments = parsed.segments
            else:
                segments = GeminiTranscript.model_validate(parsed).segments
        else:
            data = _load_response_json(response.text or '{"segments": []}')
            segments = GeminiTranscript.model_validate(data).segments
        normalized = sorted(
            (item for item in segments if item.text),
            key=lambda item: (item.start, item.end),
        )
        normalized = normalize_language_segments(normalized, language)
        normalized = bound_segments_to_duration(normalized, audio_duration_seconds)
        if timestamp_offset:
            normalized = [
                item.model_copy(
                    update={
                        "start": item.start + timestamp_offset,
                        "end": item.end + timestamp_offset,
                    }
                )
                for item in normalized
            ]
        return normalized
