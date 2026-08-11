import asyncio
import io
import wave
from pathlib import Path
from types import SimpleNamespace

from app.services import diarization_service


def test_decode_audio_returns_pyannote_in_memory_input(tmp_path: Path) -> None:
    path = tmp_path / "audio.wav"
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(b"\x00\x00" * 1_600)
    path.write_bytes(output.getvalue())

    decoded = diarization_service._decode_audio(str(path))

    assert decoded["sample_rate"] == 16_000
    assert decoded["waveform"].shape == (1, 1_600)


def test_warm_up_preloads_pipeline_when_configured(monkeypatch) -> None:
    loaded: list[bool] = []

    monkeypatch.setattr(
        diarization_service,
        "get_settings",
        lambda: SimpleNamespace(huggingface_token="configured"),
    )
    monkeypatch.setattr(
        diarization_service,
        "_load_pipeline",
        lambda: loaded.append(True),
    )

    assert asyncio.run(diarization_service.warm_up_diarization()) is True
    assert loaded == [True]


def test_warm_up_skips_pipeline_without_token(monkeypatch) -> None:
    monkeypatch.setattr(
        diarization_service,
        "get_settings",
        lambda: SimpleNamespace(huggingface_token=None),
    )

    assert asyncio.run(diarization_service.warm_up_diarization()) is False
