import hmac

from fastapi import APIRouter, HTTPException, status

from app.api.routes.history import save_record
from app.core.config import get_settings
from app.models.schemas import (
    JobStatus,
    MeetingConnection,
    MeetingCreate,
    MeetingEnd,
    MeetingJoin,
    SessionType,
    TranscriptRecord,
)
from app.services.meeting_service import (
    create_join_token,
    meeting_registry,
    normalize_display_name,
    participant_identity,
    require_livekit_settings,
)

router = APIRouter(prefix="/meetings", tags=["meetings"])


def _connection(session, participant, token: str, *, is_host: bool) -> MeetingConnection:
    return MeetingConnection(
        livekit_url=get_settings().livekit_url or "",
        token=token,
        room_code=session.code,
        meeting_id=session.record.id,
        participant_identity=participant.identity,
        display_name=participant.display_name,
        is_host=is_host,
        host_secret=session.host_secret if is_host else None,
    )


@router.post("", response_model=MeetingConnection, status_code=status.HTTP_201_CREATED)
async def create_meeting(body: MeetingCreate) -> MeetingConnection:
    try:
        require_livekit_settings()
        display_name = normalize_display_name(body.display_name)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    record = TranscriptRecord(
        title="Online meeting",
        language=body.language,
        session_type=SessionType.meeting,
        diarization=body.shared_mic,
        status=JobStatus.queued,
    )
    await save_record(record)
    session = await meeting_registry.create(record, body.language)
    identity = participant_identity()
    participant = session.add_participant(identity, display_name, body.shared_mic)
    await save_record(record)
    token = create_join_token(session, identity, display_name, body.shared_mic)
    return _connection(session, participant, token, is_host=True)


@router.post("/{code}/join", response_model=MeetingConnection)
async def join_meeting(code: str, body: MeetingJoin) -> MeetingConnection:
    session = meeting_registry.get(code)
    if not session or session.ending:
        raise HTTPException(status_code=404, detail="Meeting not found or already ended")
    try:
        display_name = normalize_display_name(body.display_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    identity = participant_identity()
    participant = session.add_participant(identity, display_name, body.shared_mic)
    await save_record(session.record)
    token = create_join_token(session, identity, display_name, body.shared_mic)
    return _connection(session, participant, token, is_host=False)


@router.post("/{code}/end", status_code=status.HTTP_202_ACCEPTED)
async def end_meeting(code: str, body: MeetingEnd) -> dict[str, str]:
    session = meeting_registry.get(code)
    if not session:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if not hmac.compare_digest(session.host_secret, body.host_secret):
        raise HTTPException(status_code=403, detail="Only the meeting host can end it")
    await session.end()
    return {"id": session.record.id, "status": "processing"}
