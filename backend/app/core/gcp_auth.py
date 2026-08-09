import json
from functools import lru_cache

from google.oauth2 import service_account

from app.core.config import get_settings


SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


@lru_cache
def load_vertex_credentials() -> tuple[service_account.Credentials, str]:
    settings = get_settings()
    key_path = settings.vertex_service_account_json.expanduser().resolve()
    if not key_path.is_file():
        raise FileNotFoundError(
            f"Vertex service-account JSON not found at {key_path}. "
            "Set VERTEX_SERVICE_ACCOUNT_JSON in backend/.env."
        )
    credentials = service_account.Credentials.from_service_account_file(
        key_path, scopes=SCOPES
    )
    project = settings.gcp_project
    if not project:
        with key_path.open(encoding="utf-8") as key_file:
            project = json.load(key_file).get("project_id")
    if not project:
        raise ValueError("GCP_PROJECT is missing and the key file has no project_id")
    return credentials, project
