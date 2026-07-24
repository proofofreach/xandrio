#!/usr/bin/env python3
"""
Chatterbox (Original) MLX 8-bit FastAPI server for Xandrio audiobook player.

Runs mlx-community/chatterbox-8bit via mlx-audio — Original-model quality at
RTF ~0.54 on M4 (vs 9.42 for PyTorch MPS). Same HTTP contract as
chatterbox-server.py so lib/chunked-tts.js needs no changes.

Install:
  python3 -m venv mlx-venv
  mlx-venv/bin/pip install mlx-audio transformers==4.57.1 fastapi uvicorn soundfile numpy setproctitle

Run:
  mlx-venv/bin/python m4-server/chatterbox-mlx-server.py

POST /tts { "text": "...", "voice": "brick-scott", "format": "mp3" }
GET /health
"""

import asyncio
import io
import json
import logging
import os
import subprocess
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
log = logging.getLogger("chatterbox-mlx-server")

ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("CHATTERBOX_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHATTERBOX_PORT", "8767"))
set_process_title(f"xandrio-chatterbox-mlx:{PORT}")
MODEL_REPO = os.environ.get("CHATTERBOX_MLX_MODEL", "mlx-community/chatterbox-8bit")
VOICE_DIR = Path(os.environ.get("CHATTERBOX_VOICE_DIR", ROOT / "data" / "voice-references"))
DEFAULT_VOICE = os.environ.get("CHATTERBOX_DEFAULT_VOICE", "brick-scott")

# temp 0.65 / top_p 0.95 won a blind A/B against the model's 0.8/1.0 defaults
# for audiobook narration (steadier pacing, fewer rushed words). Changing
# these requires a CHATTERBOX_REF_VERSION bump in lib/chatterbox-tuning.js so
# cached Chatterbox audio regenerates.
DEFAULT_TEMPERATURE = float(os.environ.get("CHATTERBOX_TEMPERATURE", "0.65"))
DEFAULT_TOP_P = float(os.environ.get("CHATTERBOX_TOP_P", "0.95"))
DEFAULT_REPETITION_PENALTY = float(os.environ.get("CHATTERBOX_REPETITION_PENALTY", "1.2"))
DEFAULT_EXAGGERATION = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.5"))
DEFAULT_CFG_WEIGHT = float(os.environ.get("CHATTERBOX_CFG_WEIGHT", "0.5"))

# Xet transfer stalls behind some proxies/filters; plain HTTP works everywhere.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

model = None
_inference_lock = threading.Lock()
# Voice reference conditionals, keyed by (resolved path, mtime, exaggeration).
# Encoding the reference clip costs a few seconds; cache it per voice.
_conds_cache = {}


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
    repetition_penalty: float | None = None
    exaggeration: float | None = None
    cfg_weight: float | None = None
    seed: int | None = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_REPO,
        "device": "mlx",
        "voiceDir": str(VOICE_DIR),
        "voices": _available_voices(),
        "formats": ["wav", "mp3"],
    }


def _get_model():
    global model
    if model is None:
        try:
            import dns_patch

            dns_patch.apply()
        except Exception:
            log.warning("dns_patch unavailable; continuing with system DNS")
        from mlx_audio.tts.utils import load_model

        log.info("Loading Chatterbox MLX model=%s voice_dir=%s", MODEL_REPO, VOICE_DIR)
        model = load_model(MODEL_REPO)
    return model


def _available_voices() -> list:
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


def _voice_tuning(voice: str) -> dict:
    """Load optional operator-owned generation/mastering settings for a voice."""
    path = _voice_path(voice)
    settings_path = path.with_suffix(".json")
    try:
        value = json.loads(settings_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}
    if not isinstance(value, dict):
        return {}

    ranges = {
        "temperature": (0.05, 2.0),
        "top_p": (0.05, 1.0),
        "repetition_penalty": (0.5, 3.0),
        "exaggeration": (0.0, 2.0),
        "cfg_weight": (0.0, 2.0),
        "pitch_semitones": (-4.0, 4.0),
        "tempo": (0.75, 1.25),
    }
    tuning = {}
    for key, (minimum, maximum) in ranges.items():
        try:
            number = float(value[key])
        except (KeyError, TypeError, ValueError):
            continue
        if minimum <= number <= maximum:
            tuning[key] = number
    try:
        seed = int(value["seed"])
    except (KeyError, TypeError, ValueError):
        seed = None
    if seed is not None and 0 <= seed <= 2_147_483_647:
        tuning["seed"] = seed
    return tuning


def _request_or_tuning(request_value, tuning: dict, key: str, default: float) -> float:
    if request_value is not None:
        return request_value
    return tuning.get(key, default)


def _apply_voice_mastering(
    audio: np.ndarray,
    sample_rate: int,
    pitch_semitones: float = 0.0,
    tempo: float = 1.0,
) -> np.ndarray:
    """Apply pitch and tempo independently with ffmpeg's resampling filters."""
    if abs(pitch_semitones) < 0.001 and abs(tempo - 1.0) < 0.001:
        return audio

    pitch_factor = 2 ** (pitch_semitones / 12.0)
    adjusted_rate = max(1000, round(sample_rate * pitch_factor))
    # asetrate changes pitch and duration together. atempo compensates for
    # that duration change, then applies the requested independent tempo.
    tempo_filter = (1.0 / pitch_factor) * tempo
    filter_graph = (
        f"asetrate={adjusted_rate},"
        f"aresample={sample_rate},"
        f"atempo={tempo_filter:.6f}"
    )
    completed = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
            "-af", filter_graph,
            "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1",
        ],
        input=np.asarray(audio, dtype="<f4").tobytes(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return np.frombuffer(completed.stdout, dtype="<f4").copy()


def _load_reference(path: Path):
    """Load a voice reference clip as a mono mx.array plus its sample rate.

    prepare_conditionals resamples internally, so no resampling here.
    (mlx_audio's own load_audio lives in generate.py, which imports
    sounddevice — a playback dependency this server doesn't need.)
    """
    import mlx.core as mx

    samples, sr = sf.read(str(path), dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return mx.array(samples), int(sr)


def _voice_conditionals(local_model, voice: str, exaggeration: float):
    path = _voice_path(voice)
    key = (str(path), path.stat().st_mtime, exaggeration)
    conds = _conds_cache.get(key)
    if conds is None:
        started = time.perf_counter()
        ref_wav, ref_sr = _load_reference(path)
        conds = local_model.prepare_conditionals(ref_wav, ref_sr, exaggeration=exaggeration)
        _conds_cache[key] = conds
        log.info(
            "Prepared voice conditionals for %s in %.2fs", voice, time.perf_counter() - started
        )
    return conds


def _encode_audio(audio: np.ndarray, sample_rate: int, audio_format: str):
    normalized = (audio_format or "mp3").lower()
    buf = io.BytesIO()

    if normalized == "mp3":
        sf.write(buf, audio, sample_rate, format="MP3")
        return buf.getvalue(), "audio/mpeg"

    if normalized == "wav":
        sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
        return buf.getvalue(), "audio/wav"

    raise ValueError(f"Unsupported audio format: {audio_format}")


def _run_inference(req: TTSRequest):
    started = time.perf_counter()
    local_model = _get_model()
    tuning = _voice_tuning(req.voice)
    exaggeration = _request_or_tuning(
        req.exaggeration, tuning, "exaggeration", DEFAULT_EXAGGERATION
    )

    with _inference_lock:
        seed = req.seed if req.seed is not None else tuning.get("seed")
        if seed is not None:
            import mlx.core as mx

            mx.random.seed(seed)
        conds = _voice_conditionals(local_model, req.voice, exaggeration)
        segments = local_model.generate(
            req.text,
            conds=conds,
            exaggeration=exaggeration,
            cfg_weight=_request_or_tuning(
                req.cfg_weight, tuning, "cfg_weight", DEFAULT_CFG_WEIGHT
            ),
            temperature=_request_or_tuning(
                req.temperature, tuning, "temperature", DEFAULT_TEMPERATURE
            ),
            top_p=_request_or_tuning(req.top_p, tuning, "top_p", DEFAULT_TOP_P),
            repetition_penalty=_request_or_tuning(
                req.repetition_penalty,
                tuning,
                "repetition_penalty",
                DEFAULT_REPETITION_PENALTY,
            ),
            verbose=False,
        )
        chunks = [np.asarray(seg.audio, dtype=np.float32) for seg in segments]

    if not chunks:
        raise RuntimeError("Model produced no audio segments")
    arr = np.squeeze(np.concatenate([np.atleast_1d(np.squeeze(c)) for c in chunks]))
    arr = _apply_voice_mastering(
        arr,
        int(local_model.sample_rate),
        tuning.get("pitch_semitones", 0.0),
        tuning.get("tempo", 1.0),
    )
    audio_bytes, media_type = _encode_audio(arr, int(local_model.sample_rate), req.format)
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
        log.exception("Chatterbox MLX synthesis failed")
        raise HTTPException(500, str(err)) from err

    if not audio_bytes:
        raise HTTPException(500, "No audio generated")

    return Response(content=audio_bytes, media_type=media_type)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
