#!/usr/bin/env python3
"""
Kokoro FastAPI server for Xandrio audiobook player.

Install:
  python3 -m venv kokoro-venv
  kokoro-venv/bin/pip install "kokoro>=0.9.2" soundfile fastapi uvicorn numpy setproctitle
  brew install espeak-ng

Run:
  kokoro-venv/bin/python m4-server/kokoro-server.py

POST /tts { "text": "...", "voice": "af_heart", "language": "en" }
     -> WAV audio bytes (24kHz mono)
GET /health
"""

import asyncio
import io
import logging
import os
import threading
import time
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel


def set_process_title(title: str) -> None:
    try:
        import setproctitle

        setproctitle.setproctitle(title)
        return
    except Exception:
        pass

    try:
        import ctypes

        libc = ctypes.CDLL(None)
        setproctitle_fn = getattr(libc, "setproctitle")
        setproctitle_fn.argtypes = [ctypes.c_char_p]
        setproctitle_fn(title.encode("utf-8"))
    except Exception:
        pass

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("kokoro-server")

SAMPLE_RATE = 24000
REPO_ID = os.environ.get("KOKORO_REPO_ID", "hexgrad/Kokoro-82M")
DEVICE = os.environ.get("KOKORO_DEVICE") or None
HOST = os.environ.get("KOKORO_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOKORO_PORT", "8766"))
set_process_title(f"xandrio-kokoro:{PORT}")
DEFAULT_TORCH_THREADS = str(min(8, max(1, os.cpu_count() or 4)))
TORCH_THREADS = os.environ.get("KOKORO_TORCH_THREADS", DEFAULT_TORCH_THREADS)
PRELOAD_LANGS = [
    item.strip()
    for item in os.environ.get("KOKORO_PRELOAD_LANGS", "a,b").split(",")
    if item.strip()
]
PRELOAD_VOICES = [
    item.strip()
    for item in os.environ.get(
        "KOKORO_PRELOAD_VOICES",
        "af_heart,af_bella,am_adam,am_michael,bm_george,bm_lewis",
    ).split(",")
    if item.strip()
]

LANG_MAP = {
    "en": "a",
    "en-us": "a",
    "en-gb": "b",
    "es": "e",
    "fr": "f",
    "hi": "h",
    "it": "i",
    "ja": "j",
    "pt": "p",
    "zh": "z",
}

pipelines = {}
shared_model = None
_inference_lock = threading.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    def load_all():
        _get_model()
        for lang_code in PRELOAD_LANGS:
            try:
                _get_pipeline(lang_code)
            except Exception:
                log.exception("Failed to preload Kokoro lang_code=%s", lang_code)
        for voice in PRELOAD_VOICES:
            try:
                _get_pipeline(_language_for_voice(voice)).load_voice(voice)
            except Exception:
                log.exception("Failed to preload Kokoro voice=%s", voice)

    await asyncio.to_thread(load_all)
    yield


app = FastAPI(lifespan=lifespan)


class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    language: str = "en"
    format: str = "wav"


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": "hexgrad/Kokoro-82M",
        "loadedLanguages": sorted(pipelines.keys()),
        "preloadLanguages": PRELOAD_LANGS,
        "preloadVoices": PRELOAD_VOICES,
        "formats": ["wav", "mp3"],
        "device": str(_get_model().device) if shared_model is not None else DEVICE or "cpu",
        "torchThreads": TORCH_THREADS or "torch-default",
    }


def _configure_torch():
    if not TORCH_THREADS:
        return

    try:
        import torch

        torch.set_num_threads(max(1, int(TORCH_THREADS)))
        log.info("Set Kokoro torch threads to %s", torch.get_num_threads())
    except Exception:
        log.exception("Failed to set KOKORO_TORCH_THREADS=%s", TORCH_THREADS)


def _get_model():
    global shared_model
    if shared_model is None:
        from kokoro import KModel

        _configure_torch()
        device = DEVICE
        if device is None:
            try:
                import torch

                device = "cuda" if torch.cuda.is_available() else "cpu"
            except Exception:
                device = "cpu"
        log.info("Loading Kokoro shared model repo_id=%s device=%s", REPO_ID, device)
        shared_model = KModel(repo_id=REPO_ID).to(device).eval()
    return shared_model


def _get_pipeline(language: str):
    from kokoro import KPipeline

    normalized = language.lower()
    lang_code = normalized if normalized in LANG_MAP.values() else LANG_MAP.get(normalized, "a")
    if lang_code not in pipelines:
        log.info("Loading Kokoro pipeline for lang_code=%s", lang_code)
        pipelines[lang_code] = KPipeline(lang_code=lang_code, repo_id=REPO_ID, model=_get_model())
    return pipelines[lang_code]


def _language_for_voice(voice: str) -> str:
    if isinstance(voice, str) and voice[:1].lower() in LANG_MAP.values():
        return voice[:1].lower()
    return "a"


def _encode_audio(audio: np.ndarray, audio_format: str) -> tuple[bytes, str]:
    normalized = (audio_format or "wav").lower()
    buf = io.BytesIO()

    if normalized == "mp3":
        sf.write(buf, audio, SAMPLE_RATE, format="MP3")
        return buf.getvalue(), "audio/mpeg"

    if normalized != "wav":
        raise ValueError(f"Unsupported audio format: {audio_format}")

    sf.write(buf, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue(), "audio/wav"


def _run_inference(text: str, voice: str, language: str, audio_format: str) -> tuple[bytes, str]:
    started = time.perf_counter()
    with _inference_lock:
        pipeline = _get_pipeline(language)
        chunks = []
        for _graphemes, _phonemes, audio in pipeline(text, voice=voice):
            chunks.append(np.asarray(audio, dtype=np.float32).squeeze())

    if not chunks:
        return b"", "audio/wav"

    combined = np.concatenate(chunks).astype(np.float32)
    audio_bytes, media_type = _encode_audio(combined, audio_format)
    log.info(
        "Synthesized %d chars with voice=%s language=%s format=%s in %.2fs",
        len(text),
        voice,
        language,
        audio_format,
        time.perf_counter() - started,
    )
    return audio_bytes, media_type


@app.post("/tts")
async def synthesize(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(400, "Empty text")

    try:
        audio_bytes, media_type = await asyncio.to_thread(
            _run_inference,
            req.text,
            req.voice,
            req.language,
            req.format,
        )
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    except Exception as err:
        log.exception("Kokoro synthesis failed")
        raise HTTPException(500, str(err)) from err

    if not audio_bytes:
        raise HTTPException(500, "No audio generated")

    return Response(content=audio_bytes, media_type=media_type)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
