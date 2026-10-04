# MOSS-TTS-Nano

Optional local CPU narration with 18 built-in voices: five English, six Chinese,
and seven Japanese. The application offers them in both voice pickers when
explicitly enabled. The existing default voice stays unchanged.

The built-in English male voices are **Adam, Nathan, and Trump**. The
[upstream voice catalog](https://github.com/OpenMOSS/MOSS-TTS-Nano-Reader/blob/main/assets/voice_browser_metadata.json)
identifies language and gender, but does not rate accent or depth. Settings
therefore shows all three in a separate Nano preview group beside confirmed
US deep male matches. They remain visible when filtering to MOSS Nano. This
does not classify them as verified US or deep voices; use their previews to compare.

Select a Nano narrator for a book and use **Prepare book**. Each book keeps its
own narrator; Settings changes the library default. Preparation saves completed
chapters and resumes after restart. **Pause** keeps saved audio and survives
restart and narrator changes; **Resume** continues missing work. The player shows
continuous listening time from the current position at the selected speed.

Playback waits for the selected narrator by default. Choose an available instant
voice under **When a chapter is not ready** to opt into fallback. The player
names the actual audio narrator; each open stream retains one voice. Disabling
Nano pauses its saved work;
re-enabling resumes it. Foreground requests take priority at chunk boundaries.
An already running chunk finishes before another local engine gets the slot.

## Install on the current Linux VPS

Run from the application checkout with Python 3.12 and sufficient disk space
(allow 1 GB for dependencies and approximately 700 MB for pinned model files).
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
use `Nice=10`, `CPUQuota=400%`, `MemoryMax=2G`, `MemorySwapMax=0`, `Restart=on-failure`, and
`TimeoutStopSec=15`. The worker itself lowers its CPU scheduling priority.
The production layout is recorded in `xandrio-moss-nano.service.example`.
Its virtual environment and verified models live outside immutable releases.
The web service uses `Wants=xandrio-moss-nano.service` and
`After=xandrio-moss-nano.service`; the worker follows web restarts.
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

A complete short-book trial on the existing 4-vCPU / 8 GB Hetzner server rendered
all 50 paragraph-preserving chunks of *The Tale of Peter Rabbit* (950 words):
405.52 seconds of raw speech in 377.75 seconds of inference. The initial complete
run restarted the worker after chunk 25; the final chunk was regenerated with
the exact application's heading punctuation. The worker ran under a 2 GiB
limit with no swap; an earlier complete run measured 1.27 GiB peak cgroup memory.
This is a short-book result, not a multi-hour audiobook stress test. Prepare
ahead for 1.5× or 2× listening. No larger server is required for this integration.

The worker loads four ONNX graphs, disables idle thread-pool spinning, and
incrementally decodes eight frames at a time. It writes anonymous temporary
48 kHz stereo PCM, then the app masters to 24 kHz mono MP3 (or the configured
playback format). Per-voice fixed gains in `calibration.json` avoid independent
normalization of each short chunk. Model, codec, runtime, render revision, voice,
gain and output settings participate in cache identity. Calibration is measured
on first-take passages; loudness can still vary with text.

Requests are limited to 16 KiB, 1,200 characters, 256 text tokens, 375 frames and
180 seconds. The application uses paragraph-preserving chunks of approximately
160 characters, with heading cues attached to nearby prose. This avoids Nano
dropping later dialogue from a request containing several paragraphs. The split
policy has its own cache identity. Exhaustion, invalid audio and cancellation never publish a partial
successful file. Decoder state and the sampling seed reset per request.
The default seed remains 1234. If a take reaches the frame limit without natural
EOS, the worker discards it and returns HTTP 422 with code `NANO_FRAME_LIMIT`.
For that specific failure, or audio that fails the duration or static-noise check,
the app retries the identical text and voice with seeds 1235 and 1236. If all
three fail, it subdivides the already prepared text at sentence boundaries or
whitespace and validates every smaller fragment. Exact text order and the voice
are preserved. New fragments try seeds 1235, 1236, then 1234; the normal
request sequence stays unchanged. Recovery has a shared limit of 12 additional takes, three split
levels and 180 seconds. Fragments use lossless PCM; the final output is encoded
once with one end pause and no second gain/limiter pass. Unsplittable text or
exhausted subdivision reports a terminal failure instead of replaying the same
deterministic recipe at chapter level. Probe/transport/conversion failures do
not trigger subdivision. All Nano attempts are staged privately until validated. Inserted pauses do not count toward the speech-duration minimum;
missing audio probes also fail validation. Failed and cancelled attempts remove
their output before it can be reused after restart. Frame-limit and audio-check
failures share a maximum of three takes; other HTTP errors stop the current
attempt sequence. Each request retains its existing timeout and can be cancelled.

This recovery policy extends previously rejected synthesis without changing the
first take, mastering, or cache namespace. Existing verified audio and persisted
preparation jobs remain compatible; they do not need to start over. Worker logs
record the seed, and the app logs when a later seed recovers a failed take.
Automatic transcription still found possible pronunciation errors and repeated
sound effects. This model is an optional
narrator; the trial does not establish word-perfect reading or human-rated quality.
The internal `MOSS_NANO_MAX_FRAMES` override is for failure verification only;
do not change it in a serving instance without revising cache identity.

## Repeatable checks

```sh
npm run verify:moss-nano
npm run verify:moss-nano-recovery
node scripts/verify-moss-nano-adaptive.js
npm run verify:narration
moss-nano-venv/bin/python scripts/verify-moss-nano-worker.py --models moss-nano/models
```

The first command runs real application HTTP/browser checks with a bounded
speech-service fixture. It covers both pickers, cache reuse, shared admission,
foreground priority, restart/disable/re-enable, prepared playback and language
fallback. The second checks per-book choices, durable preparation, and access
control. The third uses real models and emits WAVs plus checks for input
rejection, health, cancellation, decoder isolation, EOS exhaustion and missing
models. Reports, traces and screenshots go in `output/moss-nano/`.

For a captured real-model book trial, run `npm run verify:moss-nano-book -- DIR`.
The directory contains `book.txt`, `chunks.json`, `result/report.json` with each
WAV's SHA-256, and numbered `result/000.wav` files. The check replays these exact
model outputs through the real application's mastering, rejects an injected
loud-white-noise response, and plays the complete prepared book at 2× in the
browser with no midstream stalls. It saves the MP3, trace, screenshots and report.
This is a test speed; it does not change the user's playback preference.

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
