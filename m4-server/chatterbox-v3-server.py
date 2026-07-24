#!/usr/bin/env python3
"""Chatterbox Multilingual V3 FastAPI server for Xandrio."""

import asyncio
import gc
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
    except Exception:
        pass


logging.basicConfig(level=logging.INFO)
log = logging.getLogger("chatterbox-v3-server")

ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("CHATTERBOX_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHATTERBOX_PORT", "8767"))
VOICE_DIR = Path(os.environ.get("CHATTERBOX_VOICE_DIR", ROOT / "data" / "voice-references"))
DEFAULT_VOICE = os.environ.get("CHATTERBOX_DEFAULT_VOICE", "brick-scott")
DEVICE = os.environ.get("CHATTERBOX_DEVICE", "mps")

DEFAULT_TEMPERATURE = float(os.environ.get("CHATTERBOX_TEMPERATURE", "0.7"))
DEFAULT_TOP_P = float(os.environ.get("CHATTERBOX_TOP_P", "0.95"))
DEFAULT_REPETITION_PENALTY = float(os.environ.get("CHATTERBOX_REPETITION_PENALTY", "1.2"))
DEFAULT_MIN_P = float(os.environ.get("CHATTERBOX_MIN_P", "0.05"))
DEFAULT_EXAGGERATION = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.35"))
DEFAULT_CFG_WEIGHT = float(os.environ.get("CHATTERBOX_CFG_WEIGHT", "0.3"))

set_process_title(f"xandrio-chatterbox-v3:{PORT}")

model = None
model_device = None
_inference_lock = threading.Lock()
_conditioned_reference = None


class TTSRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE
    format: str = "mp3"
    language_id: str = "en"
    temperature: float | None = None
    top_p: float | None = None
    repetition_penalty: float | None = None
    min_p: float | None = None
    exaggeration: float | None = None
    cfg_weight: float | None = None
    seed: int | None = None


def _available_voices() -> list[str]:
    if not VOICE_DIR.exists():
        return []
    return sorted(
        path.stem
        for path in VOICE_DIR.iterdir()
        if path.suffix.lower() in {".wav", ".mp3", ".m4a", ".flac", ".ogg"}
    )


def _voice_path(voice: str) -> Path:
    clean = "".join(
        character
        for character in (voice or DEFAULT_VOICE)
        if character.isalnum() or character in {"-", "_"}
    ).strip() or DEFAULT_VOICE
    for suffix in (".wav", ".mp3", ".m4a", ".flac", ".ogg"):
        candidate = VOICE_DIR / f"{clean}{suffix}"
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"Chatterbox voice reference not found: {clean}")


def _voice_tuning(voice: str) -> dict:
    settings_path = _voice_path(voice).with_suffix(".json")
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
        "min_p": (0.0, 1.0),
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
    return request_value if request_value is not None else tuning.get(key, default)


def _clear_mps_cache(torch) -> None:
    if model_device != "mps" or not torch.backends.mps.is_available():
        return
    gc.collect()
    torch.mps.empty_cache()


def _apply_voice_mastering(
    audio: np.ndarray,
    sample_rate: int,
    pitch_semitones: float = 0.0,
    tempo: float = 1.0,
) -> np.ndarray:
    if abs(pitch_semitones) < 0.001 and abs(tempo - 1.0) < 0.001:
        return audio
    pitch_factor = 2 ** (pitch_semitones / 12.0)
    adjusted_rate = max(1000, round(sample_rate * pitch_factor))
    tempo_filter = (1.0 / pitch_factor) * tempo
    completed = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
            "-af",
            f"asetrate={adjusted_rate},aresample={sample_rate},atempo={tempo_filter:.6f}",
            "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1",
        ],
        input=np.asarray(audio, dtype="<f4").tobytes(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return np.frombuffer(completed.stdout, dtype="<f4").copy()


def _get_model():
    global model, model_device
    if model is None:
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        requested = DEVICE
        if requested == "mps" and not torch.backends.mps.is_available():
            requested = "cpu"
        model_device = requested
        log.info("Loading Chatterbox Multilingual V3 device=%s voice_dir=%s", requested, VOICE_DIR)
        model = ChatterboxMultilingualTTS.from_pretrained(
            device=requested,
            t3_model="v3",
        )
    return model


def _encode_audio(audio: np.ndarray, sample_rate: int, audio_format: str) -> tuple[bytes, str]:
    normalized = (audio_format or "mp3").lower()
    buffer = io.BytesIO()
    if normalized == "mp3":
        sf.write(buffer, audio, sample_rate, format="MP3")
        return buffer.getvalue(), "audio/mpeg"
    if normalized == "wav":
        sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
        return buffer.getvalue(), "audio/wav"
    raise ValueError(f"Unsupported audio format: {audio_format}")


def _run_inference(request: TTSRequest) -> tuple[bytes, str]:
    global _conditioned_reference

    import torch

    started = time.perf_counter()
    local_model = _get_model()
    tuning = _voice_tuning(request.voice)
    reference_path = _voice_path(request.voice)
    exaggeration = _request_or_tuning(
        request.exaggeration, tuning, "exaggeration", DEFAULT_EXAGGERATION
    )
    seed = request.seed if request.seed is not None else tuning.get("seed")

    with _inference_lock:
        _clear_mps_cache(torch)
        if seed is not None:
            torch.manual_seed(seed)
            if torch.backends.mps.is_available():
                torch.mps.manual_seed(seed)

        reference_key = (
            str(reference_path.resolve()),
            reference_path.stat().st_mtime_ns,
        )
        if _conditioned_reference != reference_key:
            conditioning_started = time.perf_counter()
            local_model.prepare_conditionals(
                str(reference_path),
                exaggeration=exaggeration,
            )
            _conditioned_reference = reference_key
            log.info(
                "Prepared and cached V3 voice conditioning voice=%s in %.2fs",
                request.voice,
                time.perf_counter() - conditioning_started,
            )

        waveform = local_model.generate(
            request.text,
            language_id=request.language_id or "en",
            audio_prompt_path=None,
            exaggeration=exaggeration,
            cfg_weight=_request_or_tuning(
                request.cfg_weight, tuning, "cfg_weight", DEFAULT_CFG_WEIGHT
            ),
            temperature=_request_or_tuning(
                request.temperature, tuning, "temperature", DEFAULT_TEMPERATURE
            ),
            repetition_penalty=_request_or_tuning(
                request.repetition_penalty,
                tuning,
                "repetition_penalty",
                DEFAULT_REPETITION_PENALTY,
            ),
            min_p=_request_or_tuning(request.min_p, tuning, "min_p", DEFAULT_MIN_P),
            top_p=_request_or_tuning(request.top_p, tuning, "top_p", DEFAULT_TOP_P),
        )
        audio = np.squeeze(waveform.detach().cpu().numpy()).astype(np.float32)
        del waveform
        _clear_mps_cache(torch)

    audio = _apply_voice_mastering(
        audio,
        int(local_model.sr),
        tuning.get("pitch_semitones", 0.0),
        tuning.get("tempo", 1.0),
    )
    encoded, media_type = _encode_audio(audio, int(local_model.sr), request.format)
    log.info(
        "Synthesized %d chars with V3 voice=%s in %.2fs",
        len(request.text),
        request.voice,
        time.perf_counter() - started,
    )
    return encoded, media_type


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.to_thread(_get_model)
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": "ResembleAI/Chatterbox-Multilingual-TTS-V3",
        "device": model_device or DEVICE,
        "voiceDir": str(VOICE_DIR),
        "voices": _available_voices(),
        "formats": ["wav", "mp3"],
        "language": "en",
        "conditioningCache": True,
    }


@app.post("/tts")
async def synthesize(request: TTSRequest):
    if not request.text.strip():
        raise HTTPException(400, "Empty text")
    try:
        audio, media_type = await asyncio.to_thread(_run_inference, request)
    except FileNotFoundError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except Exception as error:
        log.exception("Chatterbox V3 synthesis failed")
        raise HTTPException(500, str(error)) from error
    if not audio:
        raise HTTPException(500, "No audio generated")
    return Response(content=audio, media_type=media_type)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
