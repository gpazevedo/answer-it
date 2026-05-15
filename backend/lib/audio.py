import asyncio
import gc
import logging
import subprocess
from collections.abc import Callable

import imageio_ffmpeg
import numpy as np
from faster_whisper import WhisperModel

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

log = logging.getLogger("uvicorn")

_whisper_models: dict[str, WhisperModel] = {}


def get_whisper_model(name: str) -> WhisperModel:
    if name not in _whisper_models:
        _whisper_models[name] = WhisperModel(name, compute_type="int8")
    return _whisper_models[name]


def clear_model_cache() -> None:
    models = list(_whisper_models.values())
    _whisper_models.clear()
    del models
    gc.collect()
    gc.collect()


class FfmpegPcmDecoder:
    """Persistent async ffmpeg process: feed webm chunks, accumulate float32 PCM.

    Eliminates per-call subprocess spawn overhead for streaming sessions.
    """

    async def start(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            FFMPEG,
            "-fflags", "nobuffer",
            "-i", "pipe:0",
            "-f", "f32le", "-acodec", "pcm_f32le",
            "-ar", "16000", "-ac", "1",
            "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._pcm: bytearray = bytearray()
        self._drain_task = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        while True:
            data = await self._proc.stdout.read(8192)
            if not data:
                break
            self._pcm.extend(data)

    def feed(self, chunk: bytes) -> None:
        self._proc.stdin.write(chunk)

    async def flush(self) -> None:
        await self._proc.stdin.drain()
        await asyncio.sleep(0)

    def get_pcm(self) -> np.ndarray:
        aligned = len(self._pcm) & ~3
        return np.frombuffer(bytes(self._pcm[:aligned]), dtype=np.float32)

    async def close(self) -> None:
        try:
            self._proc.stdin.close()
        except Exception:
            pass
        try:
            await asyncio.wait_for(self._drain_task, timeout=5.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self._drain_task.cancel()


def decode_webm_to_pcm(audio_bytes: bytes) -> np.ndarray:
    """Decode webm/opus audio to 16kHz float32 PCM via ffmpeg."""
    proc = subprocess.run(
        [
            FFMPEG, "-i", "pipe:0",
            "-f", "f32le", "-acodec", "pcm_f32le",
            "-ar", "16000", "-ac", "1",
            "pipe:1",
        ],
        input=audio_bytes,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode()}")
    return np.frombuffer(proc.stdout, dtype=np.float32)


def transcribe_pcm(model: WhisperModel, pcm: np.ndarray, language: str, vad_filter: bool = True) -> str:
    """Transcribe float32 16kHz PCM, return text."""
    if len(pcm) < 1600:
        return ""
    rms = float(np.sqrt(np.mean(pcm ** 2)))
    log.info("PCM rms=%.4f len=%.1fs vad=%s", rms, len(pcm) / 16000, vad_filter)
    segments, _ = model.transcribe(
        pcm,
        language=language,
        vad_filter=vad_filter,
        vad_parameters={"min_silence_duration_ms": 300},
    )
    parts = [s.text.strip() for s in segments if s.text.strip()]
    result = ""
    for part in parts:
        if result:
            result += ("\n" if result.endswith(".") else " ") + part
        else:
            result = part
    return result
