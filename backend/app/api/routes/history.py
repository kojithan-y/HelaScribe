import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.core.config import get_settings
from app.models.schemas import TranscriptRecord

router = APIRouter(prefix="/history", tags=["history"])
_records: dict[str, TranscriptRecord] = {}
_lock = asyncio.Lock()
_loaded = False


def _history_path() -> Path:
    return get_settings().data_dir / "history.json"


def _write_history(payload: str) -> None:
    """Atomically replace history so a crash cannot leave partial JSON."""
    path = _history_path()
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


async def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    async with _lock:
        if _loaded:
            return
        path = _history_path()
        if path.exists():
            raw = await asyncio.to_thread(path.read_text, encoding="utf-8")
            for item in json.loads(raw or "[]"):
                record = TranscriptRecord.model_validate(item)
                _records[record.id] = record
        _loaded = True


async def save_record(record: TranscriptRecord) -> TranscriptRecord:
    await _ensure_loaded()
    record.updated_at = datetime.now(timezone.utc)
    async with _lock:
        _records[record.id] = record
        payload = json.dumps(
            [item.model_dump(mode="json") for item in _records.values()],
            ensure_ascii=False,
            indent=2,
        )
        await asyncio.to_thread(_write_history, payload)
    return record


async def get_record(record_id: str) -> TranscriptRecord | None:
    await _ensure_loaded()
    return _records.get(record_id)


@router.get("", response_model=list[TranscriptRecord])
async def list_history() -> list[TranscriptRecord]:
    await _ensure_loaded()
    return sorted(_records.values(), key=lambda item: item.created_at, reverse=True)


@router.get("/{record_id}", response_model=TranscriptRecord)
async def history_detail(record_id: str) -> TranscriptRecord:
    record = await get_record(record_id)
    if not record:
        raise HTTPException(status_code=404, detail="Transcript not found")
    return record


@router.get("/{record_id}/audio", response_class=FileResponse)
async def history_audio(record_id: str) -> FileResponse:
    record = await get_record(record_id)
    if not record or not record.audio_filename:
        raise HTTPException(status_code=404, detail="Recorded audio not found")
    path = get_settings().data_dir / "audio" / Path(record.audio_filename).name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Recorded audio not found")
    return FileResponse(path, filename=path.name)


@router.delete("/{record_id}", status_code=204)
async def delete_history(record_id: str) -> None:
    await _ensure_loaded()
    if record_id not in _records:
        raise HTTPException(status_code=404, detail="Transcript not found")
    async with _lock:
        record = _records.pop(record_id)
        payload = json.dumps(
            [item.model_dump(mode="json") for item in _records.values()],
            ensure_ascii=False,
            indent=2,
        )
        await asyncio.to_thread(_write_history, payload)
    if record.audio_filename:
        audio_path = get_settings().data_dir / "audio" / Path(record.audio_filename).name
        if audio_path.is_file():
            await asyncio.to_thread(audio_path.unlink)
    for filename in record.participant_audio.values():
        audio_path = get_settings().data_dir / "audio" / Path(filename).name
        if audio_path.is_file():
            await asyncio.to_thread(audio_path.unlink)
