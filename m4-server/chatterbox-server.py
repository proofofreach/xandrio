#!/usr/bin/env python3
"""
Chatterbox Turbo FastAPI server for Xandrio audiobook player.

Install:
  python3 -m venv chatterbox-venv
  chatterbox-venv/bin/pip install chatterbox-tts soundfile fastapi uvicorn numpy setproctitle

Run:
  chatterbox-venv/bin/python m4-server/chatterbox-server.py

POST /tts { "text": "...", "voice": "brick-scott", "format": "mp3" }
GET /health
"""

import asyncio
import io
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

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
log = logging.getLogger("chatterbox-server")

ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("CHATTERBOX_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHATTERBOX_PORT", "8767"))
set_process_title(f"xandrio-chatterbox:{PORT}")
DEVICE = os.environ.get("CHATTERBOX_DEVICE")
VOICE_DIR = Path(os.environ.get("CHATTERBOX_VOICE_DIR", ROOT / "data" / "voice-references"))
DEFAULT_VOICE = os.environ.get("CHATTERBOX_DEFAULT_VOICE", "brick-scott")

DEFAULT_TEMPERATURE = float(os.environ.get("CHATTERBOX_TEMPERATURE", "0.76"))
DEFAULT_TOP_P = float(os.environ.get("CHATTERBOX_TOP_P", "0.95"))
DEFAULT_TOP_K = int(os.environ.get("CHATTERBOX_TOP_K", "1000"))
DEFAULT_REPETITION_PENALTY = float(os.environ.get("CHATTERBOX_REPETITION_PENALTY", "1.18"))
DEFAULT_EXAGGERATION = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.0"))
DEFAULT_CFG_WEIGHT = float(os.environ.get("CHATTERBOX_CFG_WEIGHT", "0.0"))

model = None
model_device = None
_inference_lock = threading.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.to_thread(_get_model)
    yield


app = FastAPI(lifespan=lifespan)


class TTSRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE
    format: str = "mp3"
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    repetition_penalty: float | None = None
    exaggeration: float | None = None
    cfg_weight: float | None = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": "ResembleAI/chatterbox-turbo",
        "device": model_device or DEVICE or "auto",
        "voiceDir": str(VOICE_DIR),
        "voices": _available_voices(),
        "formats": ["wav", "mp3"],
    }


def _resolve_device() -> str:
    if DEVICE:
        return DEVICE
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _get_model():
    global model, model_device
    if model is None:
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        model_device = _resolve_device()
        log.info("Loading Chatterbox Turbo device=%s voice_dir=%s", model_device, VOICE_DIR)
        model = ChatterboxTurboTTS.from_pretrained(device=model_device)
    return model


def _available_voices() -> list[str]:
    if not VOICE_DIR.exists():
        return []
    voices = []
    for path in VOICE_DIR.iterdir():
        if path.suffix.lower() in {".wav", ".mp3", ".m4a", ".flac", ".ogg"}:
            voices.append(path.stem)
    return sorted(voices)


def _voice_path(voice: str) -> Path:
    clean = "".join(ch for ch in (voice or DEFAULT_VOICE) if ch.isalnum() or ch in {"-", "_"}).strip()
    if not clean:
        clean = DEFAULT_VOICE

    for suffix in (".wav", ".mp3", ".m4a", ".flac", ".ogg"):
        candidate = VOICE_DIR / f"{clean}{suffix}"
        if candidate.exists():
            return candidate

    raise FileNotFoundError(f"Chatterbox voice reference not found: {clean}")


def _encode_audio(audio: np.ndarray, sample_rate: int, audio_format: str) -> tuple[bytes, str]:
    normalized = (audio_format or "mp3").lower()
    buf = io.BytesIO()

    if normalized == "mp3":
        sf.write(buf, audio, sample_rate, format="MP3")
        return buf.getvalue(), "audio/mpeg"

    if normalized == "wav":
        sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
        return buf.getvalue(), "audio/wav"

    raise ValueError(f"Unsupported audio format: {audio_format}")


def _run_inference(req: TTSRequest) -> tuple[bytes, str]:
    started = time.perf_counter()
    local_model = _get_model()
    prompt_path = _voice_path(req.voice)

    with _inference_lock:
        wav = local_model.generate(
            req.text,
            audio_prompt_path=str(prompt_path),
            temperature=req.temperature if req.temperature is not None else DEFAULT_TEMPERATURE,
            top_p=req.top_p if req.top_p is not None else DEFAULT_TOP_P,
            top_k=req.top_k if req.top_k is not None else DEFAULT_TOP_K,
            repetition_penalty=req.repetition_penalty if req.repetition_penalty is not None else DEFAULT_REPETITION_PENALTY,
            exaggeration=req.exaggeration if req.exaggeration is not None else DEFAULT_EXAGGERATION,
            cfg_weight=req.cfg_weight if req.cfg_weight is not None else DEFAULT_CFG_WEIGHT,
            norm_loudness=True,
        )

    arr = wav.detach().cpu().numpy() if hasattr(wav, "detach") else np.asarray(wav)
    arr = np.squeeze(arr).astype(np.float32)
    audio_bytes, media_type = _encode_audio(arr, int(local_model.sr), req.format)
    log.info(
        "Synthesized %d chars with voice=%s format=%s in %.2fs",
        len(req.text),
        req.voice,
        req.format,
        time.perf_counter() - started,
    )
    return audio_bytes, media_type


@app.post("/tts")
async def synthesize(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(400, "Empty text")

    try:
        audio_bytes, media_type = await asyncio.to_thread(_run_inference, req)
    except FileNotFoundError as err:
        raise HTTPException(404, str(err)) from err
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    except Exception as err:
        log.exception("Chatterbox synthesis failed")
        raise HTTPException(500, str(err)) from err

    if not audio_bytes:
        raise HTTPException(500, "No audio generated")

    return Response(content=audio_bytes, media_type=media_type)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
