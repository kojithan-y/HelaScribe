import asyncio
from types import SimpleNamespace

from app.api.routes import history
from app.models.schemas import (
    JobStatus,
    Language,
    SessionType,
    SummaryContent,
    SummaryPoint,
    TranscriptRecord,
)
from app.services.gemini_service import GeminiService


def test_gemini_summary_uses_structured_response() -> None:
    expected = SummaryContent(
        overview="A concise overview.",
        key_points=[SummaryPoint(text="A supported point", start_seconds=2.5)],
    )
    request = {}

    class FakeModels:
        async def generate_content(self, **kwargs):
            request.update(kwargs)
            return SimpleNamespace(parsed=expected, text=None)

    service = GeminiService.__new__(GeminiService)
    service.settings = SimpleNamespace(
        gemini_batch_model="gemini-3.5-flash",
        gemini_batch_timeout_seconds=10,
        gemini_max_retries=0,
        gemini_retry_base_seconds=0,
    )
    service.client = SimpleNamespace(aio=SimpleNamespace(models=FakeModels()))

    result = asyncio.run(
        service.summarize_transcript("[2.50] SPEAKER_00: A supported point", Language.english)
    )

    assert result == expected
    assert request["model"] == "gemini-3.5-flash"
    assert request["config"].response_schema is SummaryContent


def test_summary_endpoint_generates_and_persists(monkeypatch) -> None:
    record = TranscriptRecord(
        title="Conversation",
        language=Language.english,
        session_type=SessionType.record,
        status=JobStatus.completed,
        transcript="We agreed to send the report tomorrow.",
    )
    saved = []

    async def get_record(_record_id: str):
        return record

    async def save_record(updated: TranscriptRecord):
        saved.append(updated)
        return updated

    class FakeGemini:
        async def summarize_transcript(self, _transcript, _language):
            return SummaryContent(overview="The report will be sent tomorrow.")

    monkeypatch.setattr(history, "get_record", get_record)
    monkeypatch.setattr(history, "save_record", save_record)
    monkeypatch.setattr(history, "GeminiService", FakeGemini)
    history._summary_locks.clear()

    result = asyncio.run(history.generate_summary(record.id))

    assert result.overview == "The report will be sent tomorrow."
    assert record.summary_source_hash
    assert len(saved) == 1


def test_summary_endpoint_returns_cached_result(monkeypatch) -> None:
    record = TranscriptRecord(
        title="Conversation",
        language=Language.english,
        session_type=SessionType.record,
        status=JobStatus.completed,
        transcript="This transcript is long enough to summarize.",
    )
    _, source_hash = history._summary_source(record)
    record.summary = history.TranscriptSummary(overview="Cached summary")
    record.summary_source_hash = source_hash

    async def get_record(_record_id: str):
        return record

    class UnexpectedGemini:
        def __init__(self):
            raise AssertionError("Gemini should not be called for a cached summary")

    monkeypatch.setattr(history, "get_record", get_record)
    monkeypatch.setattr(history, "GeminiService", UnexpectedGemini)

    result = asyncio.run(history.generate_summary(record.id))

    assert result.overview == "Cached summary"
