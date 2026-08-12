import asyncio
import io
import json
import secrets
import shutil
import time
import wave
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any

from app.api.routes.history import save_record
from app.core.config import get_settings
from app.models.schemas import (
    JobStatus,
    Language,
    MeetingParticipant,
    ProcessingStage,
    TranscriptRecord,
    TranscriptSegment,
)
from app.services.audio_service import pcm_rms
from app.services.diarization_service import diarize_file, merge_transcript_and_speakers
from app.services.gemini_service import GeminiService

SAMPLE_RATE = 16_000
TRANSCRIPT_TOPIC = "transcript.segment"


def generate_room_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


def normalize_display_name(value: str) -> str:
    name = " ".join(value.strip().split())
    if not name:
        raise ValueError("Display name is required")
    return name[:80]


def participant_identity() -> str:
    return f"user-{secrets.token_urlsafe(9)}"


def pcm_wav_bytes(pcm: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return output.getvalue()


def label_segments(
    segments: list[TranscriptSegment],
    *,
    identity: str,
    display_name: str,
    offset: float,
) -> list[TranscriptSegment]:
    return [
        item.model_copy(
            update={
                "start": item.start + offset,
                "end": item.end + offset,
                "speaker": display_name,
                "participant_identity": identity,
            }
        )
        for item in segments
    ]


def merge_room_segments(states: list["TrackState"]) -> list[TranscriptSegment]:
    return sorted(
        (segment for state in states for segment in state.final_segments),
        key=lambda item: (item.start, item.end, item.participant_identity or ""),
    )


@dataclass
class TrackState:
    identity: str
    display_name: str
    shared_mic: bool
    start_offset: float
    pcm: bytearray = field(default_factory=bytearray)
    pcm_size: int = 0
    raw_path: Path | None = None
    raw_file: Any = None
    pending: bytearray = field(default_factory=bytearray)
    queued_bytes: int = 0
    first_chunk: bool = True
    preview_segments: list[TranscriptSegment] = field(default_factory=list)
    final_segments: list[TranscriptSegment] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    queue: asyncio.Queue[tuple[bytes, float, float] | None] = field(
        default_factory=lambda: asyncio.Queue(maxsize=4)
    )
    worker: asyncio.Task[None] | None = None
    capture_tasks: set[asyncio.Task[None]] = field(default_factory=set)

    @property
    def duration(self) -> float:
        return (self.pcm_size + len(self.pcm)) / (SAMPLE_RATE * 2)

    def append_audio(self, data: bytes) -> None:
        if self.raw_file is not None:
            self.raw_file.write(data)
            self.pcm_size += len(data)
        else:
            self.pcm.extend(data)


def raw_pcm_to_wav(raw_path: Path, wav_path: Path) -> None:
    with raw_path.open("rb") as source, wave.open(str(wav_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        shutil.copyfileobj(source, output, length=1024 * 1024)


class MeetingSession:
    def __init__(
        self,
        code: str,
        host_secret: str,
        record: TranscriptRecord,
        language: Language,
    ) -> None:
        self.code = code
        self.room_name = f"helascribe-{code.lower()}"
        self.host_secret = host_secret
        self.record = record
        self.language = language
        self.started_at = time.monotonic()
        self.states: dict[str, TrackState] = {}
        self.room: Any = None
        self.stop_event = asyncio.Event()
        self.task: asyncio.Task[None] | None = None
        self.ending = False

    def add_participant(
        self, identity: str, display_name: str, shared_mic: bool
    ) -> MeetingParticipant:
        participant = MeetingParticipant(
            identity=identity,
            display_name=display_name,
            shared_mic=shared_mic,
        )
        self.record.participants.append(participant)
        self.record.diarization = self.record.diarization or shared_mic
        return participant

    async def start(self) -> None:
        self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        try:
            from livekit import api, rtc

            settings = get_settings()
            token = (
                api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
                .with_identity(f"transcriber-{self.code.lower()}")
                .with_name("HelaScribe Transcriber")
                .with_ttl(timedelta(minutes=settings.livekit_token_minutes))
                .with_grants(
                    api.VideoGrants(
                        room_join=True,
                        room=self.room_name,
                        can_publish=False,
                        can_subscribe=True,
                        can_publish_data=True,
                        hidden=True,
                    )
                )
            ).to_jwt()
            room = rtc.Room()
            self.room = room

            @room.on("track_subscribed")
            def on_track_subscribed(track, _publication, participant) -> None:
                if track.kind != rtc.TrackKind.KIND_AUDIO or self.ending:
                    return
                metadata = self._participant_metadata(participant)
                state = self._state_for(
                    participant.identity,
                    participant.name or participant.identity,
                    bool(metadata.get("shared_mic", False)),
                )
                self._pad_reconnect_gap(state)
                task = asyncio.create_task(self._consume_track(track, state))
                state.capture_tasks.add(task)
                task.add_done_callback(state.capture_tasks.discard)

            await room.connect(settings.livekit_url, token)
            self.record.status = JobStatus.processing
            self.record.processing_stage = ProcessingStage.recording
            await save_record(self.record)
            await self.stop_event.wait()
            await self._finalize()
            await room.disconnect()
        except Exception as exc:
            self.record.status = JobStatus.failed
            self.record.processing_stage = None
            self.record.error = f"Meeting worker failed: {exc}"
            await save_record(self.record)
        finally:
            for state in self.states.values():
                if state.raw_file is not None:
                    state.raw_file.close()
                    state.raw_file = None
                if state.raw_path and state.raw_path.exists():
                    try:
                        state.raw_path.unlink()
                    except OSError:
                        pass

    @staticmethod
    def _participant_metadata(participant: Any) -> dict[str, Any]:
        try:
            return json.loads(participant.metadata or "{}")
        except (TypeError, json.JSONDecodeError):
            return {}

    def _state_for(
        self, identity: str, display_name: str, shared_mic: bool
    ) -> TrackState:
        state = self.states.get(identity)
        if state:
            return state
        state = TrackState(
            identity=identity,
            display_name=display_name,
            shared_mic=shared_mic,
            start_offset=max(0.0, time.monotonic() - self.started_at),
        )
        settings = get_settings()
        safe_identity = "".join(
            character if character.isalnum() or character in "-_" else "_"
            for character in identity
        )
        state.raw_path = settings.data_dir / "audio" / f"{self.record.id}-{safe_identity}.pcm.part"
        state.raw_file = state.raw_path.open("wb")
        state.queue = asyncio.Queue(
            maxsize=max(2, getattr(settings, "live_preview_queue_size", 4))
        )
        state.worker = asyncio.create_task(self._transcribe_chunks(state))
        self.states[identity] = state
        return state

    def _pad_reconnect_gap(self, state: TrackState) -> None:
        target_duration = max(0.0, time.monotonic() - self.started_at - state.start_offset)
        missing = int((target_duration - state.duration) * SAMPLE_RATE * 2)
        if missing > 0:
            silence = b"\0" * (missing - (missing % 2))
            state.append_audio(silence)
            state.pending.extend(silence)

    async def _consume_track(self, track: Any, state: TrackState) -> None:
        from livekit import rtc

        settings = get_settings()
        chunk_bytes = int(settings.live_chunk_seconds * SAMPLE_RATE * 2)
        overlap_bytes = min(
            chunk_bytes // 2,
            int(settings.live_chunk_overlap_seconds * SAMPLE_RATE * 2),
        )
        advance_bytes = chunk_bytes - overlap_bytes
        stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1)
        try:
            async for event in stream:
                if self.ending:
                    break
                data = bytes(event.frame.data)
                state.append_audio(data)
                state.pending.extend(data)
                while len(state.pending) >= chunk_bytes:
                    chunk = bytes(state.pending[:chunk_bytes])
                    offset = state.start_offset + state.queued_bytes / (SAMPLE_RATE * 2)
                    commit_after = (
                        0.0
                        if state.first_chunk
                        else offset + settings.live_chunk_overlap_seconds
                    )
                    await state.queue.put((chunk, offset, commit_after))
                    del state.pending[:advance_bytes]
                    state.queued_bytes += advance_bytes
                    state.first_chunk = False
        except Exception as exc:
            state.warnings.append(f"{state.display_name} audio track failed: {exc}")
        finally:
            await stream.aclose()

    async def _transcribe_chunks(self, state: TrackState) -> None:
        gemini = GeminiService()
        settings = get_settings()
        while True:
            queued = await state.queue.get()
            if queued is None:
                return
            chunk, offset, commit_after = queued
            if pcm_rms(chunk) < settings.live_silence_rms_threshold:
                continue
            try:
                raw = await gemini.transcribe_file(
                    pcm_wav_bytes(chunk),
                    "audio/wav",
                    self.language,
                    model=settings.gemini_live_model,
                    audio_duration_seconds=len(chunk) / (SAMPLE_RATE * 2),
                    request_timeout_seconds=settings.gemini_live_timeout_seconds,
                )
                labeled = label_segments(
                    raw,
                    identity=state.identity,
                    display_name=state.display_name,
                    offset=offset,
                )
                for segment in labeled:
                    if (segment.start + segment.end) / 2 < commit_after:
                        continue
                    state.preview_segments.append(segment)
                    self.record.segments.append(segment)
                    await self._broadcast_segment(segment)
                await save_record(self.record)
            except Exception as exc:
                state.warnings.append(f"{state.display_name} preview failed: {exc}")

    async def _broadcast_segment(self, segment: TranscriptSegment) -> None:
        if not self.room:
            return
        payload = json.dumps(
            {"type": "transcript", "segment": segment.model_dump(mode="json")},
            ensure_ascii=False,
        ).encode("utf-8")
        await self.room.local_participant.publish_data(
            payload, reliable=True, topic=TRANSCRIPT_TOPIC
        )

    async def end(self) -> None:
        if self.ending:
            return
        self.ending = True
        self.record.status = JobStatus.processing
        self.record.processing_stage = ProcessingStage.saving_audio
        await save_record(self.record)
        self.stop_event.set()

    async def _finalize(self) -> None:
        settings = get_settings()
        self.record.processing_stage = ProcessingStage.transcribing
        await save_record(self.record)
        for state in self.states.values():
            if state.capture_tasks:
                for task in tuple(state.capture_tasks):
                    task.cancel()
                await asyncio.gather(*state.capture_tasks, return_exceptions=True)
            if state.raw_file is not None:
                state.raw_file.close()
                state.raw_file = None
            if state.pending:
                offset = state.start_offset + state.queued_bytes / (SAMPLE_RATE * 2)
                commit_after = (
                    0.0
                    if state.first_chunk
                    else offset + settings.live_chunk_overlap_seconds
                )
                await state.queue.put((bytes(state.pending), offset, commit_after))
                state.pending.clear()
            await state.queue.put(None)
            if state.worker:
                await state.worker
            try:
                await self._finalize_state(state)
            except Exception as exc:
                state.final_segments = state.preview_segments
                state.warnings.append(
                    f"{state.display_name} finalization failed; preview retained: {exc}"
                )

        self.record.segments = merge_room_segments(list(self.states.values()))
        self.record.transcript = "\n".join(
            f"{item.speaker}: {item.text}" if item.speaker else item.text
            for item in self.record.segments
        )
        self.record.duration_seconds = max(
            (item.end for item in self.record.segments), default=0.0
        )
        warnings = [warning for state in self.states.values() for warning in state.warnings]
        self.record.error = "; ".join(warnings) or None
        self.record.status = JobStatus.completed
        self.record.processing_stage = None
        await save_record(self.record)

    async def _finalize_state(self, state: TrackState) -> None:
        if state.duration <= 0:
            state.final_segments = state.preview_segments
            return
        settings = get_settings()
        if self.record.processing_stage != ProcessingStage.transcribing:
            self.record.processing_stage = ProcessingStage.transcribing
            await save_record(self.record)
        safe_identity = "".join(
            character if character.isalnum() or character in "-_" else "_"
            for character in state.identity
        )
        filename = f"{self.record.id}-{safe_identity}.wav"
        path = settings.data_dir / "audio" / filename
        if state.raw_path and state.raw_path.is_file():
            await asyncio.to_thread(raw_pcm_to_wav, state.raw_path, path)
            await asyncio.to_thread(state.raw_path.unlink)
            state.raw_path = None
            if path.stat().st_size > settings.max_upload_mb * 1024 * 1024:
                state.final_segments = state.preview_segments
                state.warnings.append(
                    f"{state.display_name} full-session pass skipped above "
                    f"{settings.max_upload_mb} MB; live previews retained"
                )
                self.record.participant_audio[state.identity] = filename
                return
            audio = await asyncio.to_thread(path.read_bytes)
            pcm_for_rms = audio[44:]
        else:
            pcm_for_rms = bytes(state.pcm)
            audio = pcm_wav_bytes(pcm_for_rms)
            await asyncio.to_thread(path.write_bytes, audio)
        self.record.participant_audio[state.identity] = filename
        try:
            if pcm_rms(pcm_for_rms) < settings.live_silence_rms_threshold:
                final: list[TranscriptSegment] = []
            else:
                final = await GeminiService().transcribe_file(
                    audio,
                    "audio/wav",
                    self.language,
                    model=settings.gemini_batch_model,
                    include_speakers=state.shared_mic,
                    audio_duration_seconds=state.duration,
                )
            if state.shared_mic and final:
                self.record.processing_stage = ProcessingStage.diarizing
                await save_record(self.record)
                try:
                    turns = await diarize_file(str(path))
                    final = merge_transcript_and_speakers(final, turns)
                except Exception as exc:
                    state.warnings.append(
                        f"{state.display_name} diarization unavailable: {exc}"
                    )
            state.final_segments = []
            for segment in final:
                nested_speaker = segment.speaker if state.shared_mic else None
                speaker = (
                    f"{state.display_name} / {nested_speaker}"
                    if nested_speaker
                    else state.display_name
                )
                state.final_segments.append(
                    segment.model_copy(
                        update={
                            "start": segment.start + state.start_offset,
                            "end": segment.end + state.start_offset,
                            "speaker": speaker,
                            "participant_identity": state.identity,
                        }
                    )
                )
        except Exception as exc:
            state.final_segments = state.preview_segments
            state.warnings.append(
                f"{state.display_name} final pass unavailable; preview retained: {exc}"
            )


class MeetingRegistry:
    def __init__(self) -> None:
        self.sessions: dict[str, MeetingSession] = {}
        self.lock = asyncio.Lock()

    async def create(self, record: TranscriptRecord, language: Language) -> MeetingSession:
        async with self.lock:
            code = generate_room_code()
            while code in self.sessions:
                code = generate_room_code()
            session = MeetingSession(code, secrets.token_urlsafe(32), record, language)
            self.sessions[code] = session
        await session.start()
        if session.task:
            session.task.add_done_callback(
                lambda _task, room_code=code: self.sessions.pop(room_code, None)
            )
        return session

    def get(self, code: str) -> MeetingSession | None:
        return self.sessions.get(code.strip().upper())


meeting_registry = MeetingRegistry()


def create_join_token(
    session: MeetingSession,
    identity: str,
    display_name: str,
    shared_mic: bool,
) -> str:
    from livekit import api

    settings = get_settings()
    metadata = json.dumps({"shared_mic": shared_mic})
    return (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(display_name)
        .with_metadata(metadata)
        .with_ttl(timedelta(minutes=settings.livekit_token_minutes))
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=session.room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=False,
                can_publish_sources=["microphone"],
            )
        )
    ).to_jwt()


def require_livekit_settings() -> None:
    settings = get_settings()
    if not all(
        (settings.livekit_url, settings.livekit_api_key, settings.livekit_api_secret)
    ):
        raise RuntimeError("LiveKit Meeting mode is not configured")
