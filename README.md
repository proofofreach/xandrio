# Xandrio

Xandrio is a self-hosted personal reading server. You run it on your hardware and control its library, providers, credentials, generated narration, and playback cache. It is not a hosted content, catalog, account, or TTS service.

It imports EPUB, MOBI, AZW, AZW3, PRC, and PDF files; searches supported sources; and provides mobile-friendly, offline-capable audiobook playback. Narration can use Microsoft Edge, local Kokoro, or local Chatterbox.

> **Operator notice:** Before importing or narrating content, confirm that your use is permitted by applicable law and provider agreements. Provider metadata may be incomplete or wrong. Generated audio is for private playback unless you have broader rights. See [LEGAL-NOTICE.md](LEGAL-NOTICE.md) and the [connector policy](docs/CONNECTOR_POLICY.md).

## Start here

Choose an installation mode in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md): native Node.js, Docker/Docker Compose, Umbrel, or a private remote path such as Tailscale. The short native path is:

```bash
git clone https://github.com/ProofOfReach/alexandrio.git xandrio
cd xandrio
npm ci
npx playwright install chromium
cp .env.template .env
npm start
```

Open `http://127.0.0.1:8181` and complete the first-run acknowledgement. Use a private network path; do not expose a library server to the public internet without authentication and TLS.

For Docker Compose, copy `.env.template` to `.env`, set `XANDRIO_TOKEN`, then run `docker compose up -d --build`.

### Requirements

- Node.js 24 LTS and npm 11
- ffmpeg, unzip, and Poppler utilities
- Chromium installed through Playwright for the Anna fallback
- OCRmyPDF and Tesseract only when OCR is enabled for scanned PDFs
- A local Python/model host only when using Kokoro or Chatterbox

## Providers and rights status

Xandrio preserves every supported import path. The UI labels provider results so an operator can distinguish an upload, a source with reported rights metadata, a source with unverified rights status, and an operator-configured catalog. Those labels are not legal conclusions.

| Source | Status | Configuration |
| --- | --- | --- |
| Upload | Operator-supplied | No provider connection |
| Standard Ebooks | Rights metadata available | Built-in source when reachable |
| Project Gutenberg | Rights metadata available | Built-in source when enabled |
| Internet Archive | Rights status unverified | Built-in source |
| Anna's Archive | Rights status unverified | Optional secret key; provider acknowledgement required |
| Z-Library | Rights status unverified | Anonymous search; account connection required for downloads |
| OPDS | Operator-configured catalog | Configure the catalog and its credentials if needed |

Providers are independent services. Their terms, availability, accounts, rate limits, and rights status can change. Sources with unverified rights status are disabled on a new instance until the operator separately enables them. A provider can be left unconfigured or excluded without disabling upload or any other provider. Anna browser search is disabled by default and runs only after its primary search returns no results when the operator sets `ANNAS_BROWSER_SEARCH_MODE=permitted`. It uses automation-fingerprint compatibility measures, can fail when upstream defenses change, does not solve interactive challenges, and must be enabled only when the operator has confirmed automated access is permitted.

Xandrio does not include ebook DRM-removal functionality and rejects known DRM-protected Kindle imports. It does not provide project accounts, shared credentials, provider proxies, or content mirrors. Anna keys are managed in Settings, which is also the recommended path — a key entered there travels over TLS into the server's private auth file and never lands in shell history or terminal transcripts. A Settings key takes precedence over `ANNAS_SECRET_KEY`; removing it falls back to the environment key until that is deleted from `.env`. Neither action rotates or revokes a provider-side key.

## Narration and voice references

Edge uses an unofficial consumer-endpoint integration. It sends narration text and selected voice settings to Microsoft and may break without notice. Kokoro and Chatterbox send narration to the local host configured by the operator; they do not require Microsoft. An official Azure Speech integration would be a separate, opt-in cloud option if added; it does not replace Edge.

Chatterbox can use an operator-supplied voice reference. Use one only with authority and required consent. Xandrio stores the reference and generated playback audio locally under the operator's configured data paths. It does not offer social sharing or audiobook publishing.

## Storage and privacy

`data/` contains library metadata, settings, credentials or sessions, playback state, sync state, and custom-voice metadata. `cache/` contains imported material or extracted playback artifacts, covers, voice samples, and generated audio. Browser storage may hold the PWA shell and offline material. Generated audio is cached so it can be reused and played offline.

See [docs/PRIVACY.md](docs/PRIVACY.md) for the outbound-data matrix, retention, and disablement controls. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for private deployment, backups, upgrades, and deletion.

## Configuration

Copy [`.env.template`](.env.template) to `.env` and set only the features you use. `ANNAS_SECRET_KEY` is optional. The default Anna origin is allowed automatically; an operator-selected mirror must also appear in `ANNAS_ALLOWED_ORIGINS` so a browser client cannot redirect the fallback toward an internal service. Z-Library credentials are entered in Settings; a successful connection retains session data, not the submitted password. Search resolves only high-confidence cross-source work aliases; operators can temporarily set `SEARCH_WORK_GROUPING_MODE=exact` to disable typo and publisher/imprint alias resolution. The standard container defaults to Edge and disables local engine auto-start.

Common controls include `PORT`, `HOST`, `XANDRIO_TOKEN`, provider timeouts, upload/OCR limits, and local-engine URLs. The template is the current configuration reference.

Multiple people can share one instance: create username/password accounts with `node --env-file-if-exists=.env scripts/manage-accounts.js add <username> [--admin]`. Each account gets its own reading progress, bookmarks, settings, and shelf over the shared library; sessions are per-device and revocable (sign-out, password change). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the auth modes and role split.

## Project docs

- [Self-hosting](docs/SELF_HOSTING.md)
- [Privacy and data flow](docs/PRIVACY.md)
- [Connector policy](docs/CONNECTOR_POLICY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Legal notice](LEGAL-NOTICE.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Feature and verification matrix](docs/FEATURE_MATRIX.md)
- [API reference](docs/API.md)
- [Umbrel packaging](docs/UMBREL.md)
- [Contributing](CONTRIBUTING.md)

## Contributing and governance

Contributions use the Developer Certificate of Origin. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Features are not silently removed: any removal or permanent disablement requires an announced proposal, migration path, and explicit project-owner approval.

## Licence

[MIT](LICENSE). The licence grant has no field-of-use restriction; responsible-use notices are informational and do not alter it.
