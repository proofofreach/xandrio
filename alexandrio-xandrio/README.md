# Xandrio for Umbrel

This directory is an Umbrel community app-store entry for Xandrio.

Build and publish a multi-architecture image before installing through Umbrel.
The release workflow builds a candidate once, tests its immutable multi-architecture
digest, signs it, and only then promotes that digest to the release and `stable`
tags. It renders the final Umbrel bundle as a release artifact. Do not publish this
source template with a mutable tag or an invented digest.

To build a local candidate instead:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/proofofreach/alexandrio:sha-<commit> \
  --push .
```

Local GHCR publishing requires a token with `write:packages` permission:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u ProofOfReach --password-stdin
```

After testing the pushed candidate digest, render the release bundle with the
matching version and digest. This replaces the fail-closed template variables:

```bash
node scripts/release/render-umbrel-release.mjs \
  --tag v1.1.0 \
  --digest sha256:<tested-multiarch-digest> \
  --output-dir release/umbrel
```

The GHCR package must be public for Umbrel to install it without registry
credentials.

Verify anonymous pullability before installing through Umbrel:

```bash
docker manifest inspect \
  ghcr.io/proofofreach/alexandrio:1.1.0@sha256:<tested-multiarch-digest>
```

Umbrel persists:

- `${APP_DATA_DIR}/data/library` mounted at `/app/data` for library metadata, preferences, source credentials, users, and playback positions.
- `${APP_DATA_DIR}/data/cache` mounted at `/app/cache` for uploaded/downloaded books, covers, extracted artifacts, generated audio, and voice samples.

Local Kokoro auto-start is disabled in this package because the production
image does not include the Python model runtime. Edge TTS remains available.
