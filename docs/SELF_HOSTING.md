# Self-hosting Xandrio

Xandrio is an operator-hosted personal reading server. Choose one access mode and keep the instance private unless you have configured appropriate authentication and TLS.

## Native Node.js

Install Node.js 24 LTS, ffmpeg, unzip, Poppler utilities, and optionally OCRmyPDF/Tesseract for scanned PDFs. For the Anna fallback, install Chromium through Playwright. Then run:

```bash
git clone https://github.com/ProofOfReach/alexandrio.git xandrio
cd xandrio
npm ci
npx playwright install chromium
cp .env.template .env
npm start
```

Open `http://127.0.0.1:8181`. Keep `data/`, `cache/`, and `.env` out of source control and back them up before upgrades.

## Docker

The standard image includes the lightweight Edge path and disables automatic Kokoro and Chatterbox startup. Mount both persistent directories:

```bash
docker build -t xandrio:local .
docker run --rm --name xandrio -p 127.0.0.1:8181:8181 \
  -v xandrio-data:/app/data -v xandrio-cache:/app/cache \
  --env-file .env --env HOST=0.0.0.0 xandrio:local
```

For Docker Compose, use the same two persistent mounts and pass environment variables through the Compose `environment` or `env_file` section. Do not publish port `8181` to every interface unless the access controls and reverse proxy described below are in place. Local engines require separately managed Python/model hosts or a purpose-built image/profile; they are not automatically included in the standard container.

The repository includes a localhost-bound Compose file. It uses Docker-managed `xandrio-data` and `xandrio-cache` volumes so the non-root container can initialize them safely on Linux:

```bash
cp .env.template .env
docker compose build --pull
docker compose up -d
docker compose ps
```

## Optional local Kokoro and Chatterbox containers

The standard image remains Edge-default and does not contain Python, PyTorch, or TTS models. Use the supplemental Compose file only when local narration is required. It starts Xandrio, Kokoro, and Linux/CPU Chatterbox on an internal application network; the engines have no published ports. A separate engine-only egress network permits required first-run model downloads. Model downloads persist in named Docker volumes. A one-shot initializer creates the voice-reference directory and assigns the shared data/cache volumes to UID 1000. Xandrio and the engines use that non-root UID. Chatterbox mounts the data volume read-only, so it can read Xandrio's `0600` uploaded references but cannot change the library or reference files.

Start the stack, then upload an authorized reference in Settings. The Compose
deployment uses a Docker-managed data volume; a file placed in the checkout's
`data/voice-references/` directory is not mounted into that volume.

```bash
cp .env.template .env
docker compose -f docker-compose.yml -f docker-compose.local-engines.yml --profile local-engines build --pull
docker compose -f docker-compose.yml -f docker-compose.local-engines.yml --profile local-engines up -d
docker compose -f docker-compose.yml -f docker-compose.local-engines.yml --profile local-engines ps
```

For an operator-managed pre-existing reference, copy it into the running app
container and retain the same private permissions as a UI upload:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-engines.yml --profile local-engines \
  cp ./authorized-reference.wav xandrio:/app/data/voice-references/my-voice.wav
docker compose -f docker-compose.yml -f docker-compose.local-engines.yml --profile local-engines \
  exec --user 0:0 xandrio sh -c \
  'chown 1000:1000 /app/data/voice-references/my-voice.wav && chmod 0600 /app/data/voice-references/my-voice.wav'
```

The first start downloads model data and may remain `starting` until each engine has loaded. Inspect it with:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-engines.yml --profile local-engines logs -f kokoro chatterbox
```

Select a `kokoro:*` or `chatterbox:*` voice in Xandrio only after the corresponding health check is healthy. Do not publish engine ports or attach the `local-engines` network to unrelated containers. To stop the optional stack while retaining its model cache, run `docker compose -f docker-compose.yml -f docker-compose.local-engines.yml --profile local-engines down`. To remove downloaded models as well, append `--volumes`; this forces a fresh download on the next startup.

### Local-engine resources, architecture, and troubleshooting

The optional stack runs three containers: Xandrio reaches Kokoro and Chatterbox on the internal `local-engines` network; only the engines join `model-download` for first-run downloads. Neither engine has a host port. The app data volume is read-write only for Xandrio; Chatterbox sees it read-only. `init: true` and a 30-second stop grace period let Docker forward SIGTERM and give an in-flight synthesis a bounded time to finish.

Kokoro is the smaller CPU-oriented choice. Chatterbox uses substantially more CPU and memory and downloads a larger model. Start with at least 4 GB RAM for Kokoro or 8 GB RAM for Chatterbox, plus free disk for model caches and generated audio. These are planning baselines, not performance guarantees: model download size, first-load time, narration speed, and memory use depend on the engine version, host architecture, available CPU, and text length. For v1.1.0, the optional Linux/CPU engine images are supported on `linux/amd64`; the standard Xandrio image remains supported on both `linux/amd64` and `linux/arm64`. On Apple Silicon, use the native Kokoro route or native Chatterbox MLX route. Other ARM64 local-engine builds are experimental until their full model runtime is verified.

If an engine remains `starting`, inspect its logs and wait for the first model download to complete. If it restarts, run `docker compose -f docker-compose.yml -f docker-compose.local-engines.yml --profile local-engines ps` and confirm that the host has enough free disk and memory. If Chatterbox reports a missing reference, upload the reference again, verify the selected `chatterbox:<voice>` name, and inspect its health payload with `docker compose -f docker-compose.yml -f docker-compose.local-engines.yml --profile local-engines exec chatterbox python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8767/health').read().decode())"`; do not loosen the reference file from `0600`. If a prior manually created named volume is owned by another UID, rerun the initializer with `docker compose -f docker-compose.yml -f docker-compose.local-engines.yml --profile local-engines rm -sf xandrio-volume-init` followed by the normal `up -d` command. Do not run `docker compose down --volumes` unless you intend to delete model caches.

## Native local engines

Native engines are useful when Docker is unavailable or hardware-specific acceleration is desired. Bind them to loopback and configure Xandrio with their loopback URLs; leave `KOKORO_AUTO_START=false` and `CHATTERBOX_AUTO_START=false` so Xandrio does not attempt to manage the processes.

For either native route, add only the endpoint(s) you run to `.env`:

```dotenv
KOKORO_AUTO_START=false
KOKORO_TTS_URL=http://127.0.0.1:8766
CHATTERBOX_AUTO_START=false
CHATTERBOX_TTS_URL=http://127.0.0.1:8767
```

### Kokoro (native)

On macOS 14 or later on Apple Silicon, install the speech and audio libraries
first, then use the platform-specific lock in `python/`:

```bash
brew install espeak-ng libsndfile
python3.12 -m venv kokoro-venv
kokoro-venv/bin/python -m pip install --require-hashes --only-binary=:all: -r python/requirements-kokoro-macos-arm64.txt
KOKORO_HOST=127.0.0.1 KOKORO_PORT=8766 kokoro-venv/bin/python m4-server/kokoro-server.py
```

Set `KOKORO_TTS_URL=http://127.0.0.1:8766` in `.env`. On Linux x86_64, install
the distribution equivalents of `espeak-ng` and `libsndfile`, create a
CPython 3.12 virtual environment, and install
`python/requirements-kokoro.txt` with the same `--require-hashes
--only-binary=:all:` options.

### Chatterbox (native PyTorch)

This hash-checked native PyTorch route supports Linux x86_64 only. On Apple
Silicon, use the MLX route below; the Linux lock must not be installed on macOS.

Create a reference file before starting the server. Its filename without the extension is the voice name Xandrio sends (for example, `brick-scott.wav`).

```bash
mkdir -p data/voice-references
python3.12 -m venv chatterbox-venv
chatterbox-venv/bin/python -m pip install --require-hashes --only-binary=:all: -r python/requirements-chatterbox.txt
CHATTERBOX_HOST=127.0.0.1 CHATTERBOX_PORT=8767 CHATTERBOX_VOICE_DIR="$PWD/data/voice-references" chatterbox-venv/bin/python m4-server/chatterbox-server.py
```

Set `CHATTERBOX_TTS_URL=http://127.0.0.1:8767` in `.env`.

### Chatterbox MLX (Apple Silicon macOS only)

MLX requires native macOS 14 or later on Apple Silicon. It is not supported by, and is deliberately not included in, the Linux Chatterbox container. Use this separate native process instead:

```bash
mkdir -p data/voice-references
python3.14 -m venv mlx-venv
mlx-venv/bin/python -m pip install --require-hashes --only-binary=:all: -r python/requirements-chatterbox-mlx.txt
CHATTERBOX_HOST=127.0.0.1 CHATTERBOX_PORT=8767 CHATTERBOX_VOICE_DIR="$PWD/data/voice-references" mlx-venv/bin/python m4-server/chatterbox-mlx-server.py
```

Set `CHATTERBOX_ENGINE=mlx` and `CHATTERBOX_TTS_URL=http://127.0.0.1:8767` in `.env`. Do not run the native PyTorch and MLX Chatterbox servers on the same port.

An explicitly converted V3 checkpoint can use the same server with a separate
cache identity:

```dotenv
CHATTERBOX_ENGINE=v3-mlx
CHATTERBOX_MLX_MODEL=models/chatterbox-v3-mlx-8bit
```

The current MLX server supports this V3 conversion for English synthesis. Use
the PyTorch V3 route below when multilingual generation is required.

### Chatterbox Multilingual V3 (Apple Silicon macOS)

The official Chatterbox Multilingual V3 model can run through PyTorch MPS on
Apple Silicon. It is more natural and preserves cloned-speaker identity better
than the older MLX conversion, but it is substantially slower and downloads
about 3.2 GB of weights. Use the Python 3.12 `chatterbox-venv` and start
`m4-server/chatterbox-v3-server.py` through Xandrio by setting:

```dotenv
CHATTERBOX_ENGINE=v3
CHATTERBOX_DEVICE=mps
CHATTERBOX_CHUNK_SIZE=160
HF_HUB_DISABLE_XET=1
PYTORCH_ENABLE_MPS_FALLBACK=1
PYTORCH_MPS_HIGH_WATERMARK_RATIO=1.0
PYTORCH_MPS_LOW_WATERMARK_RATIO=0.9
PYTORCH_MPS_PREFER_METAL=1
```

The 160-character chunk size and MPS allocator settings are measured starting
points for an M4 Mac with 24 GB of unified memory. Keep Chatterbox concurrency
at one, benchmark on the target Mac, and increase chunk size only when latency
and memory pressure remain acceptable. Do not disable the MPS high-watermark
limit; doing so can exhaust system-wide unified memory.

## Private remote access

Tailscale is the simplest remote mode: bind Xandrio to localhost, use Tailscale Serve or a private reverse proxy, and require Tailscale identity/access controls. Do not treat `0.0.0.0` as private. For another reverse proxy, terminate TLS there, restrict the upstream to the proxy, configure the documented origin/authentication settings, and test library and audio access from an unauthorized client.

Set `XANDRIO_CANONICAL_ORIGIN` to the one HTTPS origin users should install and
open, for example `https://reader.example.com`. The browser treats every origin
as a separate app with separate sign-in state and offline downloads; Xandrio
shows a move link and does not register a service worker when opened through a
different hostname. The value must be an origin only, without a path. Plain
HTTP remains suitable only for localhost development because remote PWA
installation, offline playback, and related platform APIs require a secure
context.

To notify an installed PWA after a long server-side audio preparation finishes,
generate one Web Push VAPID key pair with `npx web-push generate-vapid-keys`.
Set `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and
`WEB_PUSH_SUBJECT` (a monitored `mailto:` or HTTPS contact URI), then restart
Xandrio. Keep the private key secret and stable across upgrades. iPhone and iPad
Web Push requires the site to be installed to the Home Screen and notification
permission to be granted from the user's **Prepare for offline** action.
Preparation itself does not depend on Web Push; without it, readiness appears
the next time Xandrio opens.

When introducing or changing the canonical origin, browser state does not move
automatically. Sign in at the new origin, confirm the server-backed library and
positions, then download any needed titles again. Existing offline downloads
and sign-in state remain in the old origin's browser storage; after verifying
the new install, clear site data for the old origin to reclaim space. Keep the
old address available until this is complete if users still need those local
copies.

## Backups, updates, rollback, and removal

For a native installation, stop Xandrio and archive `data/` and `cache/`. For the standard Compose installation, stop writes and archive both named volumes:

```bash
docker compose stop
docker run --rm \
  -v xandrio-data:/data:ro -v xandrio-cache:/cache:ro \
  -v "$PWD:/backup" alpine:3.22 \
  tar -czf "/backup/xandrio-backup-$(date +%Y%m%d-%H%M%S).tar.gz" /data /cache
docker compose start
```

Restore a selected archive only while Xandrio is stopped. This replaces the current contents of both volumes:

```bash
docker compose stop
BACKUP="$PWD/xandrio-backup-YYYYMMDD-HHMMSS.tar.gz"
docker run --rm \
  -v xandrio-data:/data -v xandrio-cache:/cache \
  -v "$BACKUP:/backup/xandrio-backup.tar.gz:ro" alpine:3.22 \
  sh -c 'find /data /cache -mindepth 1 -delete && tar -xzf /backup/xandrio-backup.tar.gz -C /'
docker compose start
```

After restoring, verify `/health`, the library, one book, and one audio Range request before resuming normal use.

To upgrade a source checkout, fetch and check out the signed release tag, run `npm ci` for a native installation, or rebuild the Compose service with `docker compose build --pull && docker compose up -d`. On the first start after the bounded-generation upgrade, a versioned migration discards unfinished legacy speculative work, including untagged jobs, while preserving completed audio, premium preparation, explicit download intents, and quarantine records. Every start also releases transient playback and import warm-up claims so ended sessions are not resurrected; a shared chapter remains recoverable when it still has an explicit download owner. After the 48 kbps offline-package upgrade, an unfinished legacy preparation restarts its package scan at chapter one, reuses completed narration, and transcodes compact derivatives without rerunning TTS for ready chapters. A legacy preparation already marked ready is migrated when an opted-in device next opens Xandrio. Confirm `/health`, library access, one book, and one audio Range request before deleting the backup.

For the project-operated systemd deployment, `npm run release:production` is
the sole operator command. It waits for the sanitized public PR and required
checks, then streams the approved deploy implementation to the VPS and passes
the exact merged revision. The VPS serializes releases with `flock`, prepares
dependencies under `/opt/xandrio/releases/<sha>`, atomically switches
`/opt/xandrio/current`, and polls both `/ready` and the external origin. A
failed restart or readiness check automatically restores the previous symlink
and service. Receipts are stored under `/opt/xandrio/deployments/`, and the
last five releases are retained for rollback.

`scripts/deploy-prod.sh` is an internal exact-revision primitive rather than an
operator shortcut. Its explicit form is
`scripts/deploy-prod.sh --root /opt/xandrio --origin https://example.com <40-char-sha>`;
`--dry-run` prints the immutable-release plan without changing production.

To roll back, stop Xandrio, check out the previous signed tag or select the previous image digest, restore the matching native directories or named-volume archive, and start the service. Do not run two versions against the same writable storage. The release workflow tests candidate restart persistence on both OCI architectures and, when a prior `stable` image exists, starts the prior image, candidate, and prior image again against the same disposable volumes.

Browser offline data is separate from the server backup and is local to that
browser/PWA profile. Downloads are namespaced by account within a shared
profile; they do not appear on another device. The browser is asked for
eviction-resistant storage, but may still deny the request or clear data under
storage pressure. A server-side deletion is recorded in
`data/book-deletions.json`; connected devices, and offline devices when they
next reconnect, remove local copies older than the deletion. Include that file
with `data/` backups so deletion cursors remain monotonic after restore.
Configured Web Push subscriptions live in `data/push-subscriptions.json`;
include them in encrypted backups or omit that file to require devices to
subscribe again.

Clear browser site data when removing an instance or immediately erasing a
device that cannot reconnect. Then remove associated server cache files, voice
references, and backups under the operator's retention policy. The deletion
log currently has no automatic retention window.

The first-run decision is stored in `data/settings.json`. Before it is accepted,
uploads and providers with reported rights metadata remain available, while
unverified-rights providers stay disabled. The operator can disable those
providers again with `PUT /api/legal/operator-policy` without deleting their
configuration or removing any integration.

## Experimental PDF hyphen repairs

This optional import step uses Jev through Vercel AI Gateway. It is disabled by default. Set `AI_GATEWAY_API_KEY` to an AI Gateway inference key, not a Vercel management token. Set both `XANDRIO_JEV_REPAIRS_ENABLED=true` and `XANDRIO_JEV_EXTERNAL_TEXT_ACKNOWLEDGED=true` only after accepting the external-text flow described in [PRIVACY.md](PRIVACY.md#experimental-jev-pdf-repairs). Keep the key in protected server environment configuration. Restart the service through your normal deployment procedure to apply configuration changes.

The outbound inference destination is `https://ai-gateway.vercel.sh`; the restricted upstream provider is TypeSafe. The model alias is `typesafe-ai/jev`. Limits are 64 excerpts per imported PDF candidate, 800 context characters per excerpt, four concurrent calls across imports, and a 15-second request-pass deadline. No inference runs during playback or artifact rebuilding. This improves a few ambiguous compounds; it adds latency and is not a speed optimization. See [measured results](JEV_REAL_BOOK_RESULTS.md).

### Upgrade and rollback

No data migration or automatic reprocessing is required. Existing artifacts stay readable. New artifacts with accepted repairs retain the original PDF and include optional source/decision metadata. Back up both `data/` and `cache/` before upgrading, including retained originals. Unset either enablement flag and restart to stop future requests. Existing repaired text remains; reimport the retained original with the feature disabled to return to local processing. Do not delete the retained original merely because an artifact exists. The standalone Gutenberg license metadata correction applies when chapters are normalized; version-30 disk chapter caches migrate without re-extraction, retaining chapter text, order and indices on their next read under cache version 31.

### Experimental Jev guide verifier

Set `XANDRIO_JEV_GUIDE_VERIFIER_ENABLED=true`,
`XANDRIO_JEV_EXTERNAL_TEXT_ACKNOWLEDGED=true`, and a server-side
`AI_GATEWAY_API_KEY` to use `typesafe-ai/jev` through Vercel AI Gateway for
study-guide evidence checks. This also works with the private Codex guide
provider; uncertain answers use whichever verifier is already configured.
Generation, composition and repair stay with the existing provider.

The cascade accepts probabilities at least 0.95 and rejects probabilities at
most 0.05. Other cases use the configured verifier. Missing credentials,
malformed answers, route mismatches, capacity errors and a two-second deadline
fall back to that verifier. A bounded queue admits one Jev call at a time while preserving configured
fallback concurrency. A failure opens a 60-second cooldown; queued calls
recheck it before sending. The queue slot is released before any fallback. There are no Jev
retries within a batch. The model alias is not an immutable model version.

Enabling the cascade changes certification and checkpoint provenance. An old
verifier certificate does not certify Jev. Existing certification requirements
remain in force; the deployment must not turn on `allowUncertified` to bypass
these requirements. Disable the feature flag and restart to return to the
configured verifier. Existing published guides remain available. The PDF repair
flag is independent and remains disabled unless separately enabled.

New imports preserve PRE line breaks and can recover Kindle chapters when a
complete consecutive source-heading sequence matches the contents page. Existing
retained `.xbook` artifacts are not recut. Reimport an original book to use these
changes; do not delete retained artifacts or saved positions as a migration.

### Reviewed recovery release for diverged source history

When the active source tree matches public/main but private main has unrelated
unmerged work, an explicitly reviewed release may preserve private main and
publish a branch based on public/main. This is a recovery procedure, not a way
to skip the normal release gates. Record the exception and exact source SHA in
the release plan. Require a clean committed tree, an exact private branch mirror
(`XANDRIO_SOURCE_BRANCH=<branch> node scripts/release/check-source-mirror.mjs`),
the full local suite, browser smoke and committed-candidate import benchmark.
Publish through a protected public PR with every required check passing.
Verify that the tested source commit is an ancestor of merged public/main and
that their trees match before using the internal exact-revision deploy script.
Check the running process revision, service state, internal/external readiness
and durable deployment receipt. Preserve the previous env file and restore it
with the previous release on failure. Do not move the normal public-sync-base
checkpoint or force-update private main during this recovery procedure.
