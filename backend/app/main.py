from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import history, live, transcribe
from app.core.config import get_settings

settings = get_settings()
app = FastAPI(title=settings.app_name, version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=settings.origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(transcribe.router, prefix=settings.api_prefix)
app.include_router(live.router, prefix=settings.api_prefix)
app.include_router(history.router, prefix=settings.api_prefix)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
