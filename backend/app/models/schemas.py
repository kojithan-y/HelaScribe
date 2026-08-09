from datetime import datetime, timezone
from enum import Enum
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator


class Language(str, Enum):
    sinhala = "Sinhala"
    tamil = "Tamil"
    english = "English"
    mixed = "Mixed"


class SessionType(str, Enum):
    record = "Record"
    live = "Live"
    upload = "Upload"


class JobStatus(str, Enum):
    queued = "queued"
    processing = "processing"
    completed = "completed"
    failed = "failed"


class SpokenLanguage(str, Enum):
    sinhala = "Sinhala"
    tamil = "Tamil"
    english = "English"
    unknown = "Unknown"


class TranscriptSegment(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str
    speaker: str | None = None
    detected_language: SpokenLanguage | None = None

    @model_validator(mode="after")
    def validate_timeline(self) -> "TranscriptSegment":
        self.text = self.text.strip()
        if self.end < self.start:
            raise ValueError("segment end must be greater than or equal to start")
        return self


class TranscriptRecord(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    title: str
    language: Language
    session_type: SessionType
    diarization: bool = False
    status: JobStatus = JobStatus.queued
    transcript: str = ""
    segments: list[TranscriptSegment] = Field(default_factory=list)
    duration_seconds: float | None = None
    audio_filename: str | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class JobAccepted(BaseModel):
    id: str
    status: JobStatus


class LiveStart(BaseModel):
    language: Language
    diarization: bool = False
    sample_rate: int = Field(default=16000, ge=8000, le=48000)
    title: str = Field(default="Live transcription", min_length=1, max_length=200)


class GeminiTranscript(BaseModel):
    segments: list[TranscriptSegment]
