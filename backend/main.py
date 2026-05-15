import asyncio
import base64
import json
import logging
import time
import uuid
from io import BytesIO
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

import edge_tts
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lib.audio import decode_webm_to_pcm, get_whisper_model, transcribe_pcm, FfmpegPcmDecoder, clear_model_cache

log = logging.getLogger("uvicorn")
app = FastAPI()


@app.on_event("startup")
async def startup():
    model_name = "small"
    log.info("Pre-warming Whisper model '%s'...", model_name)
    await asyncio.to_thread(get_whisper_model, model_name)
    log.info("Whisper model '%s' ready", model_name)


@app.on_event("shutdown")
async def shutdown():
    clear_model_cache()


# ── Question storage ──────────────────────────────────────────────

QUESTIONS_FILE = Path(__file__).parent / "questions.json"


def _load_questions() -> list[dict]:
    if QUESTIONS_FILE.exists():
        return json.loads(QUESTIONS_FILE.read_text())
    return []


def _save_questions(qs: list[dict]) -> None:
    QUESTIONS_FILE.write_text(json.dumps(qs, indent=2))


class QuestionIn(BaseModel):
    text: str
    eligible: bool = True


class QuestionOut(BaseModel):
    id: str
    text: str
    eligible: bool


@app.get("/api/questions")
async def list_questions():
    return _load_questions()


@app.post("/api/questions")
async def add_question(q: QuestionIn):
    qs = _load_questions()
    item = {"id": uuid.uuid4().hex[:8], "text": q.text.strip(), "eligible": q.eligible}
    qs.append(item)
    _save_questions(qs)
    return item


@app.put("/api/questions/{qid}")
async def update_question(qid: str, q: QuestionIn):
    qs = _load_questions()
    for item in qs:
        if item["id"] == qid:
            item["text"] = q.text.strip()
            item["eligible"] = q.eligible
            _save_questions(qs)
            return item
    return {"error": "not found"}, 404


@app.delete("/api/questions/{qid}")
async def delete_question(qid: str):
    qs = _load_questions()
    qs = [item for item in qs if item["id"] != qid]
    _save_questions(qs)
    return {"ok": True}


@app.get("/api/questions/random")
async def random_question():
    qs = _load_questions()
    eligible = [q for q in qs if q.get("eligible", True)]
    if not eligible:
        return {"error": "no eligible questions"}, 404
    import random
    return random.choice(eligible)


# ── History storage ────────────────────────────────────────────────

HISTORY_FILE = Path(__file__).parent / "history.json"


def _load_history() -> list[dict]:
    if HISTORY_FILE.exists():
        return json.loads(HISTORY_FILE.read_text())
    return []


def _save_history(items: list[dict]) -> None:
    HISTORY_FILE.write_text(json.dumps(items, indent=2))


class HistoryIn(BaseModel):
    question: str
    answer: str
    time: int


@app.get("/api/history")
async def list_history():
    items = _load_history()
    items.sort(key=lambda x: x.get("id", 0), reverse=True)
    return items


@app.post("/api/history")
async def add_history(entry: HistoryIn):
    items = _load_history()
    items.append({
        "id": int(time.time() * 1000),
        "question": entry.question.strip(),
        "answer": entry.answer.strip(),
        "time": entry.time,
    })
    _save_history(items)
    return {"ok": True}


# ── TTS ────────────────────────────────────────────────────────────

class SpeakRequest(BaseModel):
    text: str
    voice: str = "en-US-EricNeural"


CHUNK_SIZE = 3


@app.get("/api/voices")
async def list_voices():
    voices = await edge_tts.list_voices()
    return [
        {"name": v["Name"], "locale": v["Locale"], "gender": v["Gender"]}
        for v in voices
    ]


def _split_chunks(text: str) -> list[str]:
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paras:
        return [text]
    return ["\n\n".join(paras[i:i + CHUNK_SIZE]) for i in range(0, len(paras), CHUNK_SIZE)]


@app.post("/api/speak")
async def speak(req: SpeakRequest):
    chunks = _split_chunks(req.text)

    async def generate():
        for i, chunk_text in enumerate(chunks):
            communicate = edge_tts.Communicate(chunk_text, req.voice)
            audio_buf = BytesIO()
            boundaries = []
            async for item in communicate.stream():
                if item["type"] == "audio":
                    audio_buf.write(item["data"])
                elif item["type"] == "SentenceBoundary":
                    boundaries.append({
                        "word": item["text"],
                        "offset_ms": item["offset"] // 10_000,
                        "duration_ms": item["duration"] // 10_000,
                    })
            yield json.dumps({
                "audio_b64": base64.b64encode(audio_buf.getvalue()).decode(),
                "boundaries": boundaries,
                "chunk_size": CHUNK_SIZE,
                "chunk": i,
                "is_last": i == len(chunks) - 1,
            }) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


# ── Transcription WebSocket ────────────────────────────────────────

@app.websocket("/api/transcribe")
async def transcribe_ws(ws: WebSocket):
    await ws.accept()
    audio_chunks = BytesIO()
    model = None
    language = "en"
    vad_filter = True
    closed = False
    partial_task: asyncio.Task | None = None
    last_partial_pcm_len: int = 0
    last_partial_text: str = ""

    async def do_transcribe(is_final: bool):
        nonlocal last_partial_pcm_len, last_partial_text
        if closed:
            return
        size = audio_chunks.tell()
        if size == 0 or model is None:
            if is_final and last_partial_text:
                await ws.send_json({"type": "transcript", "text": last_partial_text, "is_final": True})
            return

        audio_chunks.seek(0)
        audio_data = audio_chunks.read()
        audio_chunks.seek(0, 2)
        pcm = await asyncio.to_thread(decode_webm_to_pcm, audio_data)

        if is_final and last_partial_pcm_len > 0:
            delta_pcm = pcm[last_partial_pcm_len:]
            delta_text = await asyncio.to_thread(transcribe_pcm, model, delta_pcm, language, vad_filter)
            if delta_text:
                sep = "\n" if last_partial_text.endswith(".") else " "
                text = (last_partial_text + sep + delta_text).strip()
            else:
                text = last_partial_text
        else:
            text = await asyncio.to_thread(transcribe_pcm, model, pcm, language, vad_filter)
            if not is_final:
                last_partial_pcm_len = len(pcm)
                last_partial_text = text

        if closed:
            return
        await ws.send_json({"type": "transcript", "text": text, "is_final": is_final})

    try:
        while True:
            try:
                message = await ws.receive()
            except RuntimeError:
                break  # disconnect already received

            if "text" in message:
                data = json.loads(message["text"])

                if data["type"] == "start":
                    language = data.get("language", "en")
                    model_name = data.get("model", "small")
                    vad_filter = data.get("vad", True)
                    log.info("Loading whisper model '%s'...", model_name)
                    model = await asyncio.to_thread(get_whisper_model, model_name)
                    log.info("Model '%s' ready", model_name)
                    await ws.send_json({"type": "ready"})

                elif data["type"] == "pause_detected":
                    if partial_task is None or partial_task.done():
                        partial_task = asyncio.create_task(do_transcribe(is_final=False))

                elif data["type"] == "stop":
                    if partial_task and not partial_task.done():
                        try:
                            await partial_task
                        except Exception:
                            pass
                    try:
                        await do_transcribe(is_final=True)
                    except Exception as e:
                        log.error("Final transcription error: %s", e)
                        await ws.send_json({"type": "error", "message": str(e)})
                    break

            elif "bytes" in message:
                audio_chunks.write(message["bytes"])

    except WebSocketDisconnect:
        log.info("WebSocket disconnected")
    finally:
        closed = True


# ── Streaming transcription (near real-time) ────────────────────────

@app.websocket("/api/transcribe-streaming")
async def transcribe_streaming_ws(ws: WebSocket):
    """Transcribes audio progressively every second using a persistent ffmpeg decoder.
    Only processes the PCM delta since last transcription for efficiency."""
    await ws.accept()
    decoder = FfmpegPcmDecoder()
    model = None
    language = "en"
    vad_filter = True
    closed = False
    transcribed_pcm_len = 0
    last_text = ""
    transcribe_task: asyncio.Task | None = None

    async def do_streaming_transcribe():
        nonlocal transcribed_pcm_len, last_text
        if closed or model is None:
            return

        await decoder.flush()
        pcm = decoder.get_pcm()
        total_len = len(pcm)

        if total_len <= transcribed_pcm_len:
            return

        delta_pcm = pcm[transcribed_pcm_len:]
        if len(delta_pcm) < 1600:
            return

        log.info("[streaming] Transcribing %.1fs delta", len(delta_pcm) / 16000)
        try:
            text = await asyncio.to_thread(transcribe_pcm, model, delta_pcm, language, vad_filter)
        except Exception as e:
            log.error("[streaming] Transcription error: %s", e)
            return

        transcribed_pcm_len = total_len

        if not closed and text:
            full_text = (last_text + (" " if last_text else "") + text).strip()
            last_text = full_text
            log.info("[streaming] Partial: %s", full_text[:100])
            await ws.send_json({"type": "transcript", "text": full_text, "is_final": False})

    async def transcribe_loop():
        while not closed:
            try:
                await asyncio.sleep(1)
                await do_streaming_transcribe()
            except Exception as e:
                log.error("[streaming] Loop error: %s", e)

    try:
        while True:
            try:
                message = await ws.receive()
            except RuntimeError:
                break  # disconnect already received

            if "text" in message:
                data = json.loads(message["text"])

                if data["type"] == "start":
                    language = data.get("language", "en")
                    model_name = data.get("model", "small")
                    vad_filter = data.get("vad", True)
                    log.info("[streaming] Loading model '%s'", model_name)
                    model = await asyncio.to_thread(get_whisper_model, model_name)
                    await decoder.start()
                    log.info("[streaming] Model ready, starting transcribe loop")
                    await ws.send_json({"type": "ready"})
                    transcribe_task = asyncio.create_task(transcribe_loop())

                elif data["type"] == "stop":
                    log.info("[streaming] Stop received")
                    if transcribe_task:
                        transcribe_task.cancel()
                        try:
                            await transcribe_task
                        except asyncio.CancelledError:
                            pass

                    await do_streaming_transcribe()

                    if last_text:
                        await ws.send_json({"type": "transcript", "text": last_text, "is_final": True})
                    break

            elif "bytes" in message:
                decoder.feed(message["bytes"])

    except WebSocketDisconnect:
        log.info("[streaming] WebSocket disconnected")
    finally:
        closed = True
        if transcribe_task and not transcribe_task.done():
            transcribe_task.cancel()
        await decoder.close()


# ── Static files ───────────────────────────────────────────────────

static_path = Path(__file__).parent / "static"
if static_path.exists():
    app.mount("/", StaticFiles(directory=static_path, html=True), name="static")
