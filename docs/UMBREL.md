# Umbrel Packaging

This repository includes an Umbrel community app-store layout:

- `umbrel-app-store.yml` defines the custom app store.
- `alexandrio-xandrio/umbrel-app.yml` defines the Xandrio app manifest.
- `alexandrio-xandrio/docker-compose.yml` defines the Umbrel services.
- `Dockerfile` builds the app image used by the Umbrel compose file.

Umbrel hosts the operator's own Xandrio instance. The persistent Umbrel data
directory contains library metadata, provider configuration or session data,
uploaded books or extracted artifacts, generated audio, covers, and any local
voice references. The project does not receive that instance data. The package
uses Edge by default; it does not auto-start local Kokoro or Chatterbox hosts.
Read [SELF_HOSTING.md](SELF_HOSTING.md), [PRIVACY.md](PRIVACY.md), and
[LEGAL-NOTICE.md](../LEGAL-NOTICE.md) before enabling providers or narration.

The app image must be published before Umbrel can install it:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/proofofreach/alexandrio:1.1.0 \
  --push .
```

For local GHCR publishing, authenticate Docker with a token that has
`write:packages` permission. A GitHub `repo` token alone is not enough:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u ProofOfReach --password-stdin
```

Do not edit the source Compose template with an untested tag. After the release
workflow builds and tests the multi-architecture candidate, render the Umbrel
artifact with that exact digest:

```bash
node scripts/release/render-umbrel-release.mjs \
  --tag v1.1.0 \
  --digest sha256:<tested-multi-architecture-digest> \
  --output-dir artifacts/umbrel-1.1.0
```

The release workflow performs this render only after image tests and scans, then
publishes the rendered Umbrel directory as a release artifact. The checked-in
Compose file intentionally remains a fail-closed template.

The published GHCR package must be public for Umbrel to install it without
registry credentials. If anonymous `docker manifest inspect` or `docker pull`
returns `denied`, change the package visibility to public in GitHub Packages.

Current install gate:

```bash
docker manifest inspect \
  ghcr.io/proofofreach/alexandrio:1.1.0@sha256:<tested-multi-architecture-digest>
```

This command must work while logged out of GHCR. If it returns `denied`, open
the package settings in GitHub Packages and change visibility to public, then
run the `Verify Umbrel image` workflow.
