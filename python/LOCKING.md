# Optional-engine Python locks

`requirements-kokoro.txt` and `requirements-chatterbox.txt` are complete,
hash-checked production locks. They support only CPython 3.12 on Linux x86_64
with CPU-only PyTorch. The Dockerfiles fail before installation on every other
target rather than allowing pip to resolve a different graph.

Install a lock exactly as the images do:

```sh
python3.12 -m pip install --require-hashes --only-binary=:all: \
  -r python/requirements-kokoro.txt
python3.12 -m pip install --require-hashes --only-binary=:all: \
  -r python/requirements-chatterbox.txt
```

Regenerate only on a reviewed dependency update, using uv 0.10.8 or later.
The command must run against the named target platform; do not run an
unqualified compile on macOS and commit its result.

```sh
uv pip compile python/requirements-kokoro.in --python 3.12 \
  --python-platform x86_64-unknown-linux-gnu --torch-backend cpu \
  --index-strategy unsafe-best-match --only-binary :all: --generate-hashes --emit-index-url \
  --output-file python/requirements-kokoro.txt

uv pip compile python/requirements-chatterbox.in --python 3.12 \
  --python-platform x86_64-unknown-linux-gnu --torch-backend cpu \
  --index-strategy unsafe-best-match --only-binary :all: --generate-hashes --emit-index-url \
  --output-file python/requirements-chatterbox.txt
```

Review the diff, then run the matching hash-enforced dry run or a Linux x86_64
image build. `requirements-chatterbox-mlx.txt` remains a separate macOS MLX
development path; it is not consumed by either Linux image.

`requirements-kokoro-macos-arm64.txt` is the CPython 3.12 macOS 14+ Apple
Silicon lock. `requirements-chatterbox-mlx.txt` is the CPython 3.14 macOS 14+
Apple Silicon lock. Regenerate them only on a macOS 14+ Apple Silicon host:

```sh
uv pip compile python/requirements-kokoro-macos-arm64.in --python 3.12 \
  --only-binary :all: --generate-hashes --emit-index-url \
  --output-file python/requirements-kokoro-macos-arm64.txt

uv pip compile python/requirements-chatterbox-mlx.in --python 3.14 \
  --only-binary :all: --generate-hashes --emit-index-url \
  --output-file python/requirements-chatterbox-mlx.txt
```

uv's generic `aarch64-apple-darwin` target currently models macOS 13, while
the locked MLX and PyTorch wheels require macOS 14; native resolution is
therefore the faithful target check.
