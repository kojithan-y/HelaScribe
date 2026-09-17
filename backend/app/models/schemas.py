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
    meeting = "Meeting"


class JobStatus(str, Enum):
    queued = "queued"
    processing = "processing"
    completed = "completed"
    failed = "failed"


class ProcessingStage(str, Enum):
    recording = "recording"
    saving_audio = "saving_audio"
    transcribing = "transcribing"
    diarizing = "diarizing"


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
    participant_identity: str | None = None
    uncertain: bool = False
    translated_text: str | None = None

    @model_validator(mode="after")
    def validate_timeline(self) -> "TranscriptSegment":
        self.text = self.text.strip()
        if self.end < self.start:
            raise ValueError("segment end must be greater than or equal to start")
        return self


class MeetingParticipant(BaseModel):
    identity: str
    display_name: str
    shared_mic: bool = False


class SummaryPoint(BaseModel):
    text: str = Field(min_length=1)
    start_seconds: float | None = Field(default=None, ge=0)


class SummaryActionItem(BaseModel):
    text: str = Field(min_length=1)
    assignee: str | None = None
    due_date: str | None = None
    start_seconds: float | None = Field(default=None, ge=0)


class SummaryContent(BaseModel):
    overview: str = Field(min_length=1)
    key_points: list[SummaryPoint] = Field(default_factory=list)
    decisions: list[SummaryPoint] = Field(default_factory=list)
    action_items: list[SummaryActionItem] = Field(default_factory=list)
    follow_ups: list[SummaryPoint] = Field(default_factory=list)


class TranscriptSummary(SummaryContent):
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class TranscriptRecord(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    title: str
    language: Language
    session_type: SessionType
    diarization: bool = False
    status: JobStatus = JobStatus.queued
    processing_stage: ProcessingStage | None = None
    transcript: str = ""
    segments: list[TranscriptSegment] = Field(default_factory=list)
    duration_seconds: float | None = None
    audio_filename: str | None = None
    participant_audio: dict[str, str] = Field(default_factory=dict)
    participants: list[MeetingParticipant] = Field(default_factory=list)
    summary: TranscriptSummary | None = None
    summary_source_hash: str | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class JobAccepted(BaseModel):
    id: str
    status: JobStatus


class LiveStart(BaseModel):
    language: Language
    session_type: SessionType = SessionType.live
    diarization: bool = False
    sample_rate: int = Field(default=16000, ge=8000, le=48000)
    title: str = Field(default="Live transcription", min_length=1, max_length=200)


class GeminiTranscript(BaseModel):
    segments: list[TranscriptSegment]


class MeetingCreate(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)
    language: Language
    shared_mic: bool = False


class MeetingJoin(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)
    shared_mic: bool = False


class MeetingConnection(BaseModel):
    livekit_url: str
    token: str
    room_code: str
    meeting_id: str
    participant_identity: str
    display_name: str
    is_host: bool = False
    host_secret: str | None = None


class MeetingEnd(BaseModel):
    host_secret: str = Field(min_length=1)


class TranscriptEdit(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    segments: list[TranscriptSegment] | None = None


class SpeakerRename(BaseModel):
    old_name: str = Field(min_length=1, max_length=120)
    new_name: str = Field(min_length=1, max_length=120)


class TranscriptTranslate(BaseModel):
    target_language: Language
