# HelaScribe

A cross-platform Sinhala, Tamil, English, and mixed-language voice transcription app. The repository contains one Expo/React Native client and one FastAPI backend.

## Projects

- `frontend/` — Expo SDK 57 app for Android, iOS, and web
- `backend/` — FastAPI API with Gemini Live/batch transcription, pyannote diarization, and JSON-backed transcript history

## Backend setup

Python 3.11 is recommended. From `backend/`:

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env
python run.py
```

An initial `backend/.env` is already included locally and is gitignored. Edit these required values before starting:

- `VERTEX_SERVICE_ACCOUNT_JSON` — path to the existing Vertex AI service-account JSON
- `HUGGINGFACE_TOKEN` — Hugging Face access token after accepting the gated [pyannote Community-1 model terms](https://huggingface.co/pyannote/speaker-diarization-community-1)

Server host, port, reload mode, CORS origins, model IDs, GCP location, and data directory are also configured in `.env`. `GCP_PROJECT` may remain blank when `project_id` exists in the service-account JSON. `python run.py` reads `APP_HOST`, `APP_PORT`, and `APP_RELOAD` from this file.

Uploaded and recorded files use `gemini-3.5-flash` through the `global`
Vertex endpoint. Live PCM uses the same quality model in overlapping WAV chunks;
`LIVE_CHUNK_SECONDS` and `LIVE_CHUNK_OVERLAP_SECONDS` control the preview tradeoff.
Availability still depends on the configured Vertex project having the Vertex AI
API enabled and permission to use these models.

API routes:

- `POST /api/transcribe` — multipart Record/Upload job; returns `202`
- `WS /api/live` — raw mono PCM16 WebSocket stream
- `POST /api/meetings` — create an optional LiveKit Cloud meeting
- `POST /api/meetings/{code}/join` — join with a participant-scoped token
- `POST /api/meetings/{code}/end` — host-only meeting finalization
- `GET /api/history` and `GET /api/history/{id}` — job/history polling
- `POST /api/history/{id}/summary` — generate or return a cached structured Gemini summary
- `DELETE /api/history/{id}` — remove a history entry
- `GET /health` — health check

Pyannote inference always runs in an async job and is dispatched to a worker thread, so it never blocks the API event loop or initial HTTP response.

## Frontend setup

From `frontend/`:

```bash
npm install
npm run start
```

`npm run start` explicitly starts Expo Go in LAN mode. With the backend running, connect
the Android phone to the same Wi-Fi network and scan the QR code in Expo Go. A local
`frontend/.env` must set `EXPO_PUBLIC_API_URL` to the development computer's LAN address
(for example, `http://192.168.1.100:8000/api`), because `localhost` on a physical phone
refers to the phone itself. Android Emulator commonly uses `http://10.0.2.2:8000/api`.

USB-only development is also supported on Android. Enable USB debugging, connect and
authorize the phone, make sure `adb` is installed and available on `PATH`, then run
`npm run start:usb`. This reverses Metro port `8081` and API port `8000` through ADB and
temporarily overrides the API URL with `http://127.0.0.1:8000/api`; it does not modify
the LAN value stored in `frontend/.env`. Keep the cable connected while using this mode.

If the phone cannot reach Metro over the local network, use `npm run start:tunnel` for
the JavaScript bundle. The API URL still needs to be reachable by the phone; Windows
Firewall may prompt you to allow Node.js and Python on private networks.

`npm run android:native` remains available for a locally built development client, but
it is not needed for Expo Go.

Meeting mode is the exception: LiveKit uses native WebRTC code and therefore does not
run in Expo Go. Use `npm run android:native` (or `npm run android:build`) for Android
Meeting tests. Record, Upload, and single-device Live continue to work without LiveKit.
The default `npm run start` bundle deliberately excludes native LiveKit modules so Expo
Go remains compatible. After installing the development build, use
`npm run start:dev-client` to serve a bundle with native Meeting support enabled.

## Optional multi-user Meeting mode

Create a LiveKit Cloud project and add these values to `backend/.env`:

```env
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_key
LIVEKIT_API_SECRET=your_secret
```

Meeting mode uses LiveKit only for rooms, WebRTC audio tracks, participant identity,
reconnection, and transcript data events. A hidden backend participant subscribes to
each microphone track and reuses the existing Gemini chunk preview. When the host ends
the meeting, each retained participant track receives a full-audio Gemini pass and the
results are merged on the common room timeline. Tracks marked as shared microphones are
the only tracks sent through pyannote.

This is intentionally a POC: room state and host secrets are in process, there is no
user authentication, and a backend restart invalidates active room codes.

Useful checks:

```bash
npm run typecheck
npm run build:web
```

## Processing behavior

- Live PCM is transcribed in overlapping chunks by Gemini 3.5 Transcribe Live Preview as a provisional preview. Overlap prevents words at chunk boundaries from being cut in half; midpoint filtering prevents duplicate preview segments.
- Meeting audio uses the same preview/final models per LiveKit participant track. Remote participants use their stable LiveKit identity; shared-device tracks optionally add pyannote speaker labels.
- On stop, recordings within the configured inline-size limit are transcribed once more as a complete file by Gemini 3.5 Transcribe Preview. This authoritative pass removes chunk-boundary errors; if it is unavailable, the preview is retained with a warning.
- When speaker identification is enabled, the authoritative Gemini pass returns stable anonymous speaker labels. Community-1 then refines them with its exclusive timeline; if the local model cannot safely load, the Gemini labels remain available with a warning.
- Record/Upload uses one Gemini 3.5 Transcribe Preview pass. With diarization enabled, Community-1 starts only after Gemini finishes, then both outputs are merged by maximum timestamp overlap.
- Sinhala, Tamil, and English modes enforce one language. Mixed mode preserves all three in native scripts and labels each utterance with its detected language.
- Retained Record, Upload, and Live audio can be replayed from the current transcript and History views.

Uploads are streamed into memory with a configurable `MAX_UPLOAD_MB` limit and an audio-extension allowlist. Live duration is capped by `MAX_LIVE_MINUTES`. History replacement is atomic, and deleting a transcript also deletes its retained audio.

See [`docs/architecture-review.md`](docs/architecture-review.md) for the provider comparison, decision record, production gaps, and verification matrix.

Audio and transcript artifacts are written under `backend/data/`, which is gitignored. Service-account files and `.env` files are also gitignored.
