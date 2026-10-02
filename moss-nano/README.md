# MOSS-TTS-Nano

Optional local CPU narration with 18 built-in voices: five English, six Chinese,
and seven Japanese. The application offers them in both voice pickers when
explicitly enabled. The existing default voice stays unchanged.

Select a Nano voice and use **Prepare audio** for a book. Preparation uses the
existing durable queue, saves completed chapters, and resumes after an app
restart. A compatible enabled instant voice can play while preparation runs.
Without one, playback waits for Nano. Disabling Nano pauses its saved work;
re-enabling resumes it. Foreground requests take priority at chunk boundaries.
An already running chunk finishes before another local engine gets the slot.

## Install on the current Linux VPS

Run from the application checkout with Python 3.12 and sufficient disk space
(allow 1 GB for dependencies and approximately 350 MB for pinned model files).
Installation is explicit; playback never downloads weights.

```sh
python3.12 -m venv moss-nano-venv
moss-nano-venv/bin/python -m pip install -r moss-nano/requirements.txt
moss-nano-venv/bin/python moss-nano/install-models.py --directory moss-nano/models
moss-nano-venv/bin/python moss-nano/install-models.py --directory moss-nano/models --verify-only
```

Set these application environment values, then restart the application through
its normal supervisor. Append `moss-nano` to `XANDRIO_VOICE_PROVIDERS` if that
allowlist is set; for example, `edge,kokoro,moss-nano`.

```dotenv
MOSS_NANO_ENABLED=true
MOSS_NANO_TTS_URL=http://127.0.0.1:8768
MOSS_NANO_AUTO_START=true
```

Auto-start owns only the worker child it creates. Alternatively, set auto-start
false and supervise `moss-nano-venv/bin/python moss-nano/server.py` separately.
Use the checkout as its working directory. For systemd on this 8 GB server,
use `Nice=10`, `MemoryMax=3G`, `MemorySwapMax=0`, `Restart=on-failure`, and
`TimeoutStopSec=15`. The worker itself lowers its CPU scheduling priority.
Check `http://127.0.0.1:8768/health` for `status: online`. Health stays responsive
during generation and reports `busy`. Startup verifies all model digests.
Missing or corrupt assets report `models-uninstalled`; runtime failures report
`offline`. Restart the worker after replacing or repairing assets.

`MOSS_NANO_MODEL_DIR`, `MOSS_NANO_PYTHON`, and `MOSS_NANO_TTS_URL` accept explicit
locations. `MOSS_NANO_THREADS` is bounded to 1–4 (default 4). The worker listens
only on loopback by default and has no authentication: do not expose it publicly.
For containerized Xandrio, operate the worker separately on a private reachable
address, keep auto-start false, and point the app's URL at it. The default app
image does not install Python or models and has no dependency on this worker.

## Resource and audio behavior

A bounded four-chunk run on the existing 4-vCPU / 8 GB Hetzner server produced
55.68 seconds of speech in 48.44 seconds, with about 1.2 GiB peak cgroup memory
and no memory-limit events. That is about 52 seconds per minute of speech.
These short samples do not guarantee book-length throughput. Prepare ahead for
1.5× or 2× listening. No larger server is required for this integration.

The worker loads four ONNX graphs, disables idle thread-pool spinning, and
incrementally decodes eight frames at a time. It writes anonymous temporary
48 kHz stereo PCM, then the app masters to 24 kHz mono MP3 (or the configured
playback format). Per-voice fixed gains in `calibration.json` avoid independent
normalization of each short chunk. Model, codec, runtime, render revision, voice,
gain and output settings participate in cache identity. Calibration is measured
on first-take passages; loudness can still vary with text.

Requests are limited to 16 KiB, 1,200 characters, 256 text tokens, 375 frames and
180 seconds. The application splits narration into approximately 160-character
chunks. Exhaustion, invalid audio and cancellation never publish a partial
successful file. Decoder state and the fixed sampling seed reset per request.
The internal `MOSS_NANO_MAX_FRAMES` override is for failure verification only;
do not change it in a serving instance without revising cache identity.

## Repeatable checks

```sh
npm run verify:moss-nano
moss-nano-venv/bin/python scripts/verify-moss-nano-worker.py --models moss-nano/models
```

The first command runs real application HTTP/browser checks with a bounded
speech-service fixture. It covers both pickers, cache reuse, shared admission,
foreground priority, restart/disable/re-enable, prepared playback and language
fallback. The second uses real models and emits WAVs plus checks for input
rejection, health, cancellation, decoder isolation, EOS exhaustion and missing
models. Reports, traces and screenshots go in `output/moss-nano/`.

To audit loudness, run `scripts/calibrate-moss-nano.py` against an isolated worker;
it emits first takes and a proposed raw calibration without changing the app.
Run `node scripts/verify-moss-nano-calibration.js` to master those WAVs with the
serving gains and write the final 18-voice acoustic report. The checked-in
Weiguo gain includes a measured correction after peak limiting.

## Provenance

The unmodified vendored `vendor/ort_cpu_runtime.py` comes from
[OpenMOSS/MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano) at the commit
recorded in `models.lock.json`; its Apache-2.0 license is in `vendor/LICENSE`.
The worker subclass restricts the upstream runtime to built-in voice references.
The model lock records exact Hugging Face revisions, URLs, sizes and SHA-256
hashes. Model weights and generated audio are excluded from Git and images.
No uploaded reference voice cloning is offered by this adapter.
