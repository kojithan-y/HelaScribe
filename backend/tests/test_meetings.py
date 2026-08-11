import asyncio
import re
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.schemas import TranscriptSegment
from app.services.meeting_service import (
    TrackState,
    generate_room_code,
    label_segments,
    merge_room_segments,
    normalize_display_name,
)


def test_room_code_is_short_unambiguous_and_random() -> None:
    codes = {generate_room_code() for _ in range(100)}
    assert len(codes) == 100
    assert all(re.fullmatch(r"[A-HJ-NP-Z2-9]{8}", code) for code in codes)


def test_display_name_is_normalized() -> None:
    assert normalize_display_name("  Anu   Kumar  ") == "Anu Kumar"


def test_participant_label_and_room_offset_are_preserved() -> None:
    segment = TranscriptSegment(start=0.25, end=1.5, text="hello")
    result = label_segments(
        [segment], identity="user-1", display_name="Anu", offset=12.0
    )[0]
    assert result.start == 12.25
    assert result.end == 13.5
    assert result.speaker == "Anu"
    assert result.participant_identity == "user-1"


def test_room_merge_orders_independent_participant_tracks() -> None:
    first = TrackState("one", "One", False, 0)
    second = TrackState("two", "Two", False, 0)
    first.final_segments = [
        TranscriptSegment(
            start=3,
            end=4,
            text="later",
            speaker="One",
            participant_identity="one",
        )
    ]
    second.final_segments = [
        TranscriptSegment(
            start=1,
            end=2,
            text="earlier",
            speaker="Two",
            participant_identity="two",
        )
    ]
    assert [item.text for item in merge_room_segments([first, second])] == [
        "earlier",
        "later",
    ]


def test_reconnect_gap_keeps_room_timeline(monkeypatch) -> None:
    from app.services import meeting_service
    from app.models.schemas import Language, SessionType, TranscriptRecord

    record = TranscriptRecord(
        title="Meeting",
        language=Language.english,
        session_type=SessionType.meeting,
    )
    session = meeting_service.MeetingSession("ABCDEFGH", "secret", record, Language.english)
    session.started_at = 100.0
    state = TrackState("one", "One", False, 1.0)
    state.pcm.extend(b"\0\0" * 16_000)  # one second captured
    monkeypatch.setattr(meeting_service.time, "monotonic", lambda: 104.0)

    session._pad_reconnect_gap(state)

    assert state.duration == 3.0
    assert len(state.pending) == 2 * 16_000 * 2


def test_end_is_idempotent(monkeypatch) -> None:
    from app.services import meeting_service
    from app.models.schemas import Language, SessionType, TranscriptRecord

    record = TranscriptRecord(
        title="Meeting",
        language=Language.english,
        session_type=SessionType.meeting,
    )
    session = meeting_service.MeetingSession("ABCDEFGH", "secret", record, Language.english)

    async def ignore_save(_record):
        return _record

    monkeypatch.setattr(meeting_service, "save_record", ignore_save)
    asyncio.run(session.end())
    asyncio.run(session.end())
    assert session.ending is True
    assert session.stop_event.is_set()


def test_participant_token_is_room_scoped_and_microphone_only(monkeypatch) -> None:
    api = pytest.importorskip("livekit.api")
    from app.services import meeting_service
    from app.models.schemas import Language, SessionType, TranscriptRecord

    monkeypatch.setattr(
        meeting_service,
        "get_settings",
        lambda: SimpleNamespace(
            livekit_api_key="test-key",
            livekit_api_secret="test-secret-long-enough-for-jwt",
            livekit_token_minutes=10,
        ),
    )
    record = TranscriptRecord(
        title="Meeting",
        language=Language.english,
        session_type=SessionType.meeting,
    )
    session = meeting_service.MeetingSession("ABCDEFGH", "secret", record, Language.english)

    token = meeting_service.create_join_token(session, "user-1", "Anu", False)
    claims = api.TokenVerifier("test-key", "test-secret-long-enough-for-jwt").verify(token)

    assert claims.video.room_join is True
    assert claims.video.room == "helascribe-abcdefgh"
    assert claims.video.can_publish_sources == ["microphone"]
    assert claims.video.can_publish_data is False


def test_only_host_secret_can_end_meeting(monkeypatch) -> None:
    from app.api.routes import meetings
    from app.models.schemas import MeetingEnd

    class FakeSession:
        host_secret = "correct"
        record = SimpleNamespace(id="meeting-id")

        def __init__(self) -> None:
            self.ended = False

        async def end(self) -> None:
            self.ended = True

    session = FakeSession()
    monkeypatch.setattr(meetings.meeting_registry, "get", lambda _code: session)

    with pytest.raises(HTTPException) as denied:
        asyncio.run(meetings.end_meeting("ABCDEFGH", MeetingEnd(host_secret="wrong")))
    assert denied.value.status_code == 403

    result = asyncio.run(
        meetings.end_meeting("ABCDEFGH", MeetingEnd(host_secret="correct"))
    )
    assert result == {"id": "meeting-id", "status": "processing"}
    assert session.ended is True
