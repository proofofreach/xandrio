#!/usr/bin/env python3
"""Convert the explicit Chatterbox Multilingual V3 checkpoint to MLX.

This wrapper fixes two unsafe assumptions in mlx-audio's generic Chatterbox
converter: it selects the V3 T3 checkpoint by name, and it marks the resulting
model as multilingual so the runtime loads the correct tokenizer.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

import numpy as np
from safetensors import safe_open


REQUIRED_FILES = {
    "ve.safetensors": "ve.safetensors",
    "t3_mtl23ls_v3.safetensors": "t3_mtl23ls_v3.safetensors",
    "s3gen.safetensors": "s3gen.safetensors",
    "tokenizer.json": "tokenizer.json",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert Chatterbox Multilingual V3 to MLX FP16 or quantized weights."
    )
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--bits", type=int, choices=(4, 8), default=None)
    parser.add_argument("--group-size", type=int, default=64)
    return parser.parse_args()


def load_safetensors_numpy(path: Path) -> dict[str, np.ndarray]:
    with safe_open(path, framework="numpy") as weights:
        return {key: weights.get_tensor(key) for key in weights.keys()}


def validate_source(source: Path) -> None:
    missing = [name for name in REQUIRED_FILES.values() if not (source / name).is_file()]
    if missing:
        raise FileNotFoundError(f"Missing V3 source files: {', '.join(missing)}")


def main() -> None:
    args = parse_args()
    source = args.source.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    validate_source(source)

    from mlx_audio.tts.models.chatterbox.scripts import convert

    with tempfile.TemporaryDirectory(prefix="chatterbox-v3-mlx-") as temp_dir:
        staged = Path(temp_dir)
        for staged_name, source_name in REQUIRED_FILES.items():
            (staged / staged_name).symlink_to(source / source_name)

        convert.download_chatterbox_weights = lambda _repo_id, _cache_dir: staged
        convert.load_pytorch_safetensors = load_safetensors_numpy
        convert.convert_all(
            repo_id="ResembleAI/chatterbox-v3-explicit",
            output_dir=output_dir,
            cache_dir=None,
            upload_repo=None,
            quantize=args.bits is not None,
            bits=args.bits or 8,
            group_size=args.group_size,
            dry_run=True,
        )

    config_path = output_dir / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config.update(
        {
            "model_type": "chatterbox",
            "multilingual": True,
            "version": "3",
            "source_checkpoint": "t3_mtl23ls_v3.safetensors",
            "vocab_size": 2454,
        }
    )
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote explicit V3 metadata to {config_path}")


if __name__ == "__main__":
    main()
