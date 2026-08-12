import json
import logging
import time
from collections import Counter
from datetime import datetime, timezone
from threading import Lock


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        request_id = getattr(record, "request_id", None)
        if request_id:
            payload["request_id"] = request_id
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


class AppMetrics:
    def __init__(self) -> None:
        self.started_at = time.time()
        self.requests = Counter()
        self.failures = Counter()
        self.total_duration = Counter()
        self.lock = Lock()

    def observe(self, method: str, path: str, status: int, duration: float) -> None:
        key = f"{method} {path}"
        with self.lock:
            self.requests[key] += 1
            self.total_duration[key] += duration
            if status >= 500:
                self.failures[key] += 1

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "uptime_seconds": round(time.time() - self.started_at, 3),
                "requests": dict(self.requests),
                "server_errors": dict(self.failures),
                "total_request_seconds": dict(self.total_duration),
            }


metrics = AppMetrics()


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def configure_error_monitoring(dsn: str | None, environment: str) -> None:
    if not dsn:
        return
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=dsn,
            environment=environment,
            traces_sample_rate=0.1,
            send_default_pii=False,
        )
    except ImportError:
        logging.getLogger(__name__).warning(
            "SENTRY_DSN is configured but sentry-sdk is not installed"
        )
