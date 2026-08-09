from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    app_name: str = "HelaScribe API"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_reload: bool = True
    api_prefix: str = "/api"
    allowed_origins: str = "*"

    vertex_service_account_json: Path = Path("service-account.json")
    gcp_project: str | None = None
    # Both transcription models use the global generateContent endpoint.
    gcp_location: str = "global"
    gemini_live_model: str = "gemini-3.5-flash"
    gemini_batch_model: str = "gemini-3.5-flash"
    live_chunk_seconds: float = 8.0
    live_chunk_overlap_seconds: float = 1.0
    live_silence_rms_threshold: float = 200.0
    live_finalize_full_audio: bool = True
    max_live_minutes: float = 120.0
    max_upload_mb: int = 20

    huggingface_token: str | None = None
    pyannote_model: str = "pyannote/speaker-diarization-community-1"
    data_dir: Path = Path("data")

    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    @property
    def origins(self) -> list[str]:
        if self.allowed_origins.strip() == "*":
            return ["*"]
        return [item.strip() for item in self.allowed_origins.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if not settings.vertex_service_account_json.is_absolute():
        settings.vertex_service_account_json = (
            BACKEND_DIR / settings.vertex_service_account_json
        ).resolve()
    if not settings.data_dir.is_absolute():
        settings.data_dir = (BACKEND_DIR / settings.data_dir).resolve()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / "audio").mkdir(parents=True, exist_ok=True)
    return settings
