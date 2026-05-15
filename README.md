# Answer It

Voice-based question practice app. A random question is spoken aloud, the user answers by voice, and the answer is transcribed in real time.

## Prerequisites

- Python 3.14+ (the backend includes `.python-version` with `3.14`; `uv python install 3.14` can install it if needed)
- Node.js `^20.19.0 || >=22.12.0` (required by Vite 8)
- [uv](https://docs.astral.sh/uv/) for the backend. The first `uv run ...` creates the virtual environment and installs backend dependencies from `pyproject.toml`/`uv.lock`.

## How to run

Start the backend and frontend in separate terminals.

Backend:

```bash
cd backend
uv run uvicorn main:app --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

## How it works

1. **Questions tab** — Add, edit, remove questions. Toggle which are eligible for random selection.
2. **Practice tab** — A random eligible question is spoken via TTS. The user answers by voice while a timer runs. Transcription appears in real time. After 4 seconds of silence, the answer is automatically submitted. History persists to a JSON file.

## Tech

- **Frontend:** React 18 + Vite 8
- **Backend:** FastAPI + edge-tts + faster-whisper
- **Transcription:** WebSocket streaming with persistent ffmpeg decoder (1s intervals)
