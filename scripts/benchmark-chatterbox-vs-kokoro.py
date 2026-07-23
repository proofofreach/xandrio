#!/usr/bin/env python3
"""
Benchmark local free TTS candidates for Xandrio audiobook use.

Outputs:
  - report.html: listening report with audio controls
  - report.json: raw metrics and environment details
  - *.mp3: generated samples normalized to Xandrio's 24 kHz mono MP3 target

Typical use:
  chatterbox-venv/bin/python scripts/benchmark-chatterbox-vs-kokoro.py
"""

from __future__ import annotations

import argparse
import hashlib
import html
import inspect
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


KOKORO_URL = os.environ.get("KOKORO_TTS_URL", "http://127.0.0.1:8766").rstrip("/")
DEFAULT_OUTPUT_DIR = Path("/tmp/xandrio-chatterbox-vs-kokoro")
DEFAULT_MAX_RTF = 1.25

SAMPLES = {
    "narrative": "\n".join(
        [
            "Chapter One",
            "",
            "The rain had stopped before dawn, leaving the garden washed and shining.",
            "Clara stood by the library window with the letter folded in her hand, listening to the slow drip of water from the ivy.",
            "For years the house had seemed asleep, but that morning every board and hinge appeared to be waiting for her decision.",
        ]
    ),
    "dialogue": "\n".join(
        [
            "\"You heard it too,\" Marcus said.",
            "\"I heard a door,\" Elena replied. \"That does not mean someone opened it.\"",
            "\"Doors do not whisper your name from an empty corridor.\"",
            "She turned the lamp down until the flame was no larger than a coin, and the room seemed to lean closer around them.",
        ]
    ),
    "nonfiction": "\n".join(
        [
            "A good audiobook voice has to do more than pronounce words correctly.",
            "It needs stable pacing, clean sentence boundaries, and enough variation to avoid fatigue over several hours.",
            "The hard cases are names, quotations, punctuation, and short headings, because each one exposes whether the model understands the shape of the text.",
        ]
    ),
}

VARIANTS: dict[str, dict[str, Any]] = {
    "kokoro-am_michael": {
        "provider": "kokoro",
        "label": "Kokoro Michael",
        "voice": "am_michael",
        "language": "en",
    },
    "kokoro-af_heart": {
        "provider": "kokoro",
        "label": "Kokoro Heart",
        "voice": "af_heart",
        "language": "en",
    },
    "kokoro-bm_george": {
        "provider": "kokoro",
        "label": "Kokoro George",
        "voice": "bm_george",
        "language": "en-gb",
    },
    "chatterbox-narration": {
        "provider": "chatterbox",
        "label": "Chatterbox Narration",
        "model": "english",
        "kwargs": {
            "exaggeration": 0.35,
            "cfg_weight": 0.45,
            "temperature": 0.75,
            "repetition_penalty": 1.2,
            "min_p": 0.05,
            "top_p": 1.0,
        },
    },
    "chatterbox-expressive": {
        "provider": "chatterbox",
        "label": "Chatterbox Expressive",
        "model": "english",
        "kwargs": {
            "exaggeration": 0.65,
            "cfg_weight": 0.30,
            "temperature": 0.80,
            "repetition_penalty": 1.2,
            "min_p": 0.05,
            "top_p": 1.0,
        },
    },
    "chatterbox-turbo": {
        "provider": "chatterbox",
        "label": "Chatterbox Turbo",
        "model": "turbo",
        "kwargs": {
            "temperature": 0.8,
            "top_p": 0.95,
            "top_k": 1000,
            "repetition_penalty": 1.2,
        },
    },
    "chatterbox-multilingual-v3": {
        "provider": "chatterbox",
        "label": "Chatterbox Multilingual V3",
        "model": "multilingual-v3",
        "kwargs": {
            "language_id": "en",
            "exaggeration": 0.5,
            "cfg_weight": 0.5,
            "temperature": 0.8,
            "repetition_penalty": 2.0,
            "min_p": 0.05,
            "top_p": 1.0,
        },
    },
}

DEFAULT_VARIANTS = [
    "kokoro-am_michael",
    "kokoro-af_heart",
    "chatterbox-narration",
    "chatterbox-expressive",
    "chatterbox-turbo",
]


@dataclass
class LoadedModel:
    name: str
    model: Any
    sample_rate: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate matched Kokoro and Chatterbox audiobook samples."
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help=f"Directory for report and generated audio. Default: {DEFAULT_OUTPUT_DIR}",
    )
    parser.add_argument(
        "--variants",
        default=",".join(DEFAULT_VARIANTS),
        help="Comma-separated variant ids. Use --list-variants to see options.",
    )
    parser.add_argument(
        "--samples",
        default="narrative,dialogue,nonfiction",
        help=f"Comma-separated sample ids. Built-ins: {', '.join(SAMPLES)}",
    )
    parser.add_argument("--text", default="", help="Custom text. Overrides --samples.")
    parser.add_argument("--text-file", default="", help="Read custom text from a file.")
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "mps", "cuda", "cpu"],
        help="Device for Chatterbox. Default: auto.",
    )
    parser.add_argument(
        "--kokoro-url",
        default=KOKORO_URL,
        help=f"Kokoro server URL. Default: {KOKORO_URL}",
    )
    parser.add_argument(
        "--kokoro-timeout",
        type=float,
        default=120,
        help="Kokoro HTTP timeout in seconds.",
    )
    parser.add_argument(
        "--audio-prompt",
        default="",
        help="Optional reference WAV/MP3 for Chatterbox voice cloning.",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=1,
        help="Repeat each variant/sample this many times. Default: 1.",
    )
    parser.add_argument(
        "--max-rtf",
        type=float,
        default=DEFAULT_MAX_RTF,
        help="Real-time-factor threshold considered fast enough. Default: 1.25.",
    )
    parser.add_argument(
        "--list-variants",
        action="store_true",
        help="Print available variants and exit.",
    )
    return parser.parse_args()


def split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def resolve_samples(args: argparse.Namespace) -> dict[str, str]:
    if args.text_file:
        path = Path(args.text_file)
        return {path.stem or "custom": path.read_text(encoding="utf-8")}
    if args.text:
        return {"custom": args.text}

    samples: dict[str, str] = {}
    for name in split_csv(args.samples):
        if name not in SAMPLES:
            raise SystemExit(f"Unknown sample '{name}'. Built-ins: {', '.join(SAMPLES)}")
        samples[name] = SAMPLES[name]
    return samples


def resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def safe_id(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in value)


def run_command(args: list[str]) -> str:
    proc = subprocess.run(args, check=True, capture_output=True, text=True)
    return proc.stdout.strip()


def duration_seconds(path: Path) -> float:
    output = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    return float(output)


def convert_to_target_mp3(input_path: Path, output_path: Path) -> None:
    run_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(input_path),
            "-ar",
            "24000",
            "-ac",
            "1",
            "-b:a",
            "48k",
            str(output_path),
        ]
    )


def output_path(output_dir: Path, variant_id: str, sample_id: str, iteration: int) -> Path:
    digest = hashlib.sha1(f"{variant_id}:{sample_id}:{iteration}".encode()).hexdigest()[:8]
    return output_dir / f"{safe_id(variant_id)}-{safe_id(sample_id)}-{iteration + 1}-{digest}.mp3"


def post_json(url: str, payload: dict[str, Any], timeout: float) -> tuple[bytes, str]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read(), response.headers.get("content-type", "")
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{url} failed {err.code}: {body}") from err


def synthesize_kokoro(
    text: str,
    variant: dict[str, Any],
    output_file: Path,
    kokoro_url: str,
    timeout: float,
) -> dict[str, Any]:
    started = time.perf_counter()
    audio, content_type = post_json(
        f"{kokoro_url.rstrip('/')}/tts",
        {
            "text": text,
            "voice": variant["voice"],
            "language": variant.get("language", "en"),
            "format": "mp3",
        },
        timeout,
    )

    if "audio/mpeg" in content_type or audio.startswith(b"ID3") or audio[:2] == b"\xff\xfb":
        output_file.write_bytes(audio)
    else:
        temp_wav = output_file.with_suffix(".kokoro.tmp.wav")
        try:
            temp_wav.write_bytes(audio)
            convert_to_target_mp3(temp_wav, output_file)
        finally:
            temp_wav.unlink(missing_ok=True)

    elapsed_ms = (time.perf_counter() - started) * 1000
    duration = duration_seconds(output_file)
    return {
        "elapsedMs": elapsed_ms,
        "durationSeconds": duration,
        "rtf": elapsed_ms / 1000 / duration if duration else None,
        "bytes": output_file.stat().st_size,
        "contentType": content_type,
    }


def chatterbox_import_error() -> str | None:
    try:
        import chatterbox  # noqa: F401

        return None
    except Exception as err:
        return str(err)


def load_chatterbox_model(model_name: str, device: str) -> LoadedModel:
    if model_name == "english":
        from chatterbox.tts import ChatterboxTTS

        model = ChatterboxTTS.from_pretrained(device=device)
        return LoadedModel(model_name, model, int(model.sr))

    if model_name == "turbo":
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        model = ChatterboxTurboTTS.from_pretrained(device=device)
        return LoadedModel(model_name, model, int(model.sr))

    if model_name == "multilingual-v3":
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        signature = inspect.signature(ChatterboxMultilingualTTS.from_pretrained)
        if "t3_model" in signature.parameters:
            model = ChatterboxMultilingualTTS.from_pretrained(device=device, t3_model="v3")
        else:
            raise RuntimeError(
                "Installed chatterbox-tts does not expose Multilingual V3. "
                "Install from the current GitHub source to use this variant."
            )
        return LoadedModel(model_name, model, int(model.sr))

    raise ValueError(f"Unsupported Chatterbox model: {model_name}")


def save_tensor_audio(wav: Any, sample_rate: int, output_file: Path) -> None:
    import numpy as np
    import soundfile as sf

    array = wav.detach().cpu().numpy() if hasattr(wav, "detach") else np.asarray(wav)
    array = np.squeeze(array)
    temp_wav = output_file.with_suffix(".chatterbox.tmp.wav")
    try:
        sf.write(temp_wav, array, sample_rate)
        convert_to_target_mp3(temp_wav, output_file)
    finally:
        temp_wav.unlink(missing_ok=True)


def synthesize_chatterbox(
    text: str,
    variant: dict[str, Any],
    output_file: Path,
    loaded: LoadedModel,
    audio_prompt: str,
) -> dict[str, Any]:
    kwargs = dict(variant.get("kwargs", {}))
    if audio_prompt:
        kwargs["audio_prompt_path"] = audio_prompt

    started = time.perf_counter()
    wav = loaded.model.generate(text, **kwargs)
    save_tensor_audio(wav, loaded.sample_rate, output_file)
    elapsed_ms = (time.perf_counter() - started) * 1000
    duration = duration_seconds(output_file)
    return {
        "elapsedMs": elapsed_ms,
        "durationSeconds": duration,
        "rtf": elapsed_ms / 1000 / duration if duration else None,
        "bytes": output_file.stat().st_size,
        "sampleRate": loaded.sample_rate,
    }


def collect_environment(device: str, kokoro_url: str) -> dict[str, Any]:
    env: dict[str, Any] = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "device": device,
        "kokoroUrl": kokoro_url,
        "ffmpeg": shutil.which("ffmpeg"),
        "ffprobe": shutil.which("ffprobe"),
    }
    try:
        import torch

        env["torch"] = torch.__version__
        env["mpsAvailable"] = bool(torch.backends.mps.is_available())
        env["cudaAvailable"] = bool(torch.cuda.is_available())
    except Exception as err:
        env["torchError"] = str(err)
    try:
        import importlib.metadata as metadata

        env["chatterboxTts"] = metadata.version("chatterbox-tts")
    except Exception as err:
        env["chatterboxTtsError"] = str(err)
    return env


def summarize(results: list[dict[str, Any]], max_rtf: float) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for result in results:
        grouped.setdefault(result["variantId"], []).append(result)

    summary = []
    for variant_id, items in grouped.items():
        rtfs = [item["rtf"] for item in items if isinstance(item.get("rtf"), (int, float))]
        elapsed = [item["elapsedMs"] for item in items if "elapsedMs" in item]
        durations = [item["durationSeconds"] for item in items if "durationSeconds" in item]
        failures = [item for item in items if item.get("error")]
        avg_rtf = sum(rtfs) / len(rtfs) if rtfs else None
        summary.append(
            {
                "variantId": variant_id,
                "label": items[0]["label"],
                "provider": items[0]["provider"],
                "runs": len(items),
                "failures": len(failures),
                "avgElapsedMs": sum(elapsed) / len(elapsed) if elapsed else None,
                "avgDurationSeconds": sum(durations) / len(durations) if durations else None,
                "avgRtf": avg_rtf,
                "fastEnough": avg_rtf is not None and avg_rtf <= max_rtf,
            }
        )
    return sorted(
        summary,
        key=lambda item: (
            item["failures"],
            999 if item["avgRtf"] is None else item["avgRtf"],
            item["variantId"],
        ),
    )


def fmt_number(value: Any, digits: int = 2) -> str:
    if not isinstance(value, (int, float)):
        return ""
    return f"{value:.{digits}f}"


def relpath(path: str | Path, base: Path) -> str:
    try:
        return Path(path).resolve().relative_to(base.resolve()).as_posix()
    except Exception:
        return str(path)


def write_report(output_dir: Path, report: dict[str, Any]) -> None:
    summary_rows = []
    for item in report["summary"]:
        verdict = "yes" if item["fastEnough"] else "no"
        summary_rows.append(
            "<tr>"
            f"<td>{html.escape(item['label'])}</td>"
            f"<td>{html.escape(item['provider'])}</td>"
            f"<td>{item['runs']}</td>"
            f"<td>{item['failures']}</td>"
            f"<td>{fmt_number(item['avgElapsedMs'] / 1000 if item['avgElapsedMs'] else None, 2)}s</td>"
            f"<td>{fmt_number(item['avgDurationSeconds'], 2)}s</td>"
            f"<td>{fmt_number(item['avgRtf'], 3)}</td>"
            f"<td>{verdict}</td>"
            "</tr>"
        )

    detail_rows = []
    for item in report["results"]:
        error = item.get("error")
        source = relpath(item.get("file", ""), output_dir) if item.get("file") else ""
        audio = f'<audio controls preload="none" src="{html.escape(source)}"></audio>' if source and not error else ""
        detail_rows.append(
            "<tr>"
            f"<td>{html.escape(item['sampleId'])}</td>"
            f"<td>{html.escape(item['label'])}</td>"
            f"<td>{html.escape(str(item.get('preset', '')))}</td>"
            f"<td>{item.get('chars', '')}</td>"
            f"<td>{fmt_number(item.get('elapsedMs', 0) / 1000 if item.get('elapsedMs') else None, 2)}s</td>"
            f"<td>{fmt_number(item.get('durationSeconds'), 2)}s</td>"
            f"<td>{fmt_number(item.get('rtf'), 3)}</td>"
            f"<td>{audio}</td>"
            f"<td>{html.escape(error or source)}</td>"
            "</tr>"
        )

    sample_blocks = []
    for sample_id, text in report["samples"].items():
        sample_blocks.append(
            f"<h3>{html.escape(sample_id)}</h3><pre>{html.escape(text)}</pre>"
        )

    body = f"""<!doctype html>
<meta charset="utf-8">
<title>Xandrio TTS Benchmark</title>
<style>
body{{font:14px -apple-system,BlinkMacSystemFont,sans-serif;max-width:1280px;margin:32px auto;background:#101010;color:#eeeeee;line-height:1.45}}
table{{width:100%;border-collapse:collapse;margin:16px 0 28px}}
td,th{{border-bottom:1px solid #303030;padding:9px 10px;text-align:left;vertical-align:middle}}
th{{color:#cfcfcf;font-weight:600}}
audio{{width:290px}}
pre{{white-space:pre-wrap;background:#191919;border:1px solid #303030;padding:12px;border-radius:6px}}
.muted{{color:#aaa}}
a{{color:#d4af37}}
</style>
<h1>Xandrio TTS Benchmark</h1>
<p class="muted">Goal: highest quality local/free narration that remains fast enough for chunked audiobook playback. Fast enough threshold: RTF <= {report['maxRtf']}.</p>
<h2>Summary</h2>
<table>
  <thead><tr><th>Variant</th><th>Provider</th><th>Runs</th><th>Failures</th><th>Avg elapsed</th><th>Avg audio</th><th>Avg RTF</th><th>Fast enough</th></tr></thead>
  <tbody>{''.join(summary_rows)}</tbody>
</table>
<h2>Listening Samples</h2>
<table>
  <thead><tr><th>Sample</th><th>Variant</th><th>Preset</th><th>Chars</th><th>Elapsed</th><th>Audio</th><th>RTF</th><th>Listen</th><th>File/Error</th></tr></thead>
  <tbody>{''.join(detail_rows)}</tbody>
</table>
<h2>Quality Rubric</h2>
<p class="muted">Score manually while listening: pronunciation, pacing, punctuation/pauses, emotional fit, fatigue risk, and chunk-boundary tolerance. RTF is only a speed filter, not a quality score.</p>
<h2>Input Text</h2>
{''.join(sample_blocks)}
<h2>Environment</h2>
<pre>{html.escape(json.dumps(report['environment'], indent=2))}</pre>
<h2>Raw JSON</h2>
<pre>{html.escape(json.dumps(report, indent=2))}</pre>
"""
    (output_dir / "report.html").write_text(body, encoding="utf-8")
    (output_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


def print_variants() -> None:
    for variant_id, variant in VARIANTS.items():
        print(f"{variant_id}: {variant['label']} ({variant['provider']})")


def main() -> None:
    args = parse_args()
    if args.list_variants:
        print_variants()
        return

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise SystemExit("ffmpeg and ffprobe are required.")

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    variant_ids = split_csv(args.variants)
    for variant_id in variant_ids:
        if variant_id not in VARIANTS:
            raise SystemExit(f"Unknown variant '{variant_id}'. Run with --list-variants.")

    samples = resolve_samples(args)
    device = resolve_device(args.device)
    environment = collect_environment(device, args.kokoro_url)
    results: list[dict[str, Any]] = []
    loaded_models: dict[str, LoadedModel] = {}

    for variant_id in variant_ids:
        variant = VARIANTS[variant_id]
        provider = variant["provider"]
        loaded_model: LoadedModel | None = None

        if provider == "chatterbox":
            error = chatterbox_import_error()
            if error:
                raise SystemExit(
                    "chatterbox-tts is not importable in this Python environment: "
                    f"{error}"
                )
            model_name = variant["model"]
            if model_name not in loaded_models:
                print(f"Loading {variant['label']} on {device}...")
                loaded_models[model_name] = load_chatterbox_model(model_name, device)
            loaded_model = loaded_models[model_name]

        for sample_id, text in samples.items():
            for iteration in range(max(1, args.iterations)):
                file_path = output_path(output_dir, variant_id, sample_id, iteration)
                base_result = {
                    "variantId": variant_id,
                    "label": variant["label"],
                    "provider": provider,
                    "preset": variant.get("model") or variant.get("voice"),
                    "sampleId": sample_id,
                    "iteration": iteration + 1,
                    "chars": len(text),
                    "file": str(file_path),
                }

                try:
                    if provider == "kokoro":
                        metrics = synthesize_kokoro(
                            text,
                            variant,
                            file_path,
                            args.kokoro_url,
                            args.kokoro_timeout,
                        )
                    elif provider == "chatterbox" and loaded_model is not None:
                        metrics = synthesize_chatterbox(
                            text,
                            variant,
                            file_path,
                            loaded_model,
                            args.audio_prompt,
                        )
                    else:
                        raise RuntimeError(f"Unsupported provider: {provider}")

                    result = {**base_result, **metrics}
                    print(
                        f"{variant_id} {sample_id} #{iteration + 1}: "
                        f"{result['elapsedMs'] / 1000:.2f}s, "
                        f"{result['durationSeconds']:.2f}s audio, "
                        f"RTF {result['rtf']:.3f}"
                    )
                except Exception as err:
                    result = {**base_result, "error": str(err)}
                    print(f"{variant_id} {sample_id} #{iteration + 1}: ERROR {err}")
                results.append(result)

    report = {
        "environment": environment,
        "maxRtf": args.max_rtf,
        "samples": samples,
        "variants": {variant_id: VARIANTS[variant_id] for variant_id in variant_ids},
        "summary": summarize(results, args.max_rtf),
        "results": results,
        "sources": {
            "chatterbox": "https://github.com/resemble-ai/chatterbox",
            "kokoro": "https://huggingface.co/hexgrad/Kokoro-82M",
        },
    }
    write_report(output_dir, report)
    print(f"Report: {output_dir / 'report.html'}")


if __name__ == "__main__":
    main()
