from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.models.schemas import Language

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    app_name: str = "HelaScribe API"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_reload: bool = True
    api_prefix: str = "/api"
    allowed_origins: str = "*"

    vertex_service_account_json: Path = Path("service_account.json")
    gcp_project: str | None = None
    # Both transcription models use the global generateContent endpoint.
    gcp_location: str = "global"
    gemini_live_model: str = "gemini-3.5-transcribe"
    gemini_batch_model: str = "gemini-3.5-transcribe-preview"
    gemini_text_model: str = "gemini-3.5-flash"
    auto_translate: bool = True
    target_language: Language = Language.tamil
    gemini_max_retries: int = 3
    gemini_retry_base_seconds: float = 1.0
    gemini_live_timeout_seconds: float = 30.0
    gemini_batch_timeout_seconds: float = 90.0
    # Short speech windows keep the chunked generateContent preview responsive.
    # The retained full recording is still transcribed after Stop for accuracy.
    live_chunk_seconds: float = 2.0
    live_chunk_overlap_seconds: float = 0.25
    live_stop_preview_grace_seconds: float = 3.0
    live_preview_queue_size: int = 8
    live_silence_rms_threshold: float = 20.0
    live_finalize_full_audio: bool = True
    max_live_minutes: float = 120.0
    max_upload_mb: int = 20

    livekit_url: str | None = None
    livekit_api_key: str | None = None
    livekit_api_secret: str | None = None
    livekit_token_minutes: int = 120

    huggingface_token: str | None = None
    pyannote_model: str = "pyannote/speaker-diarization-community-1"
    data_dir: Path = Path("data")
    sentry_dsn: str | None = None
    app_environment: str = "development"

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
