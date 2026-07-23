# Feature and verification matrix

This matrix records the v1.1.0 release surface. Release preparation preserves every listed capability. Rights-status labels describe available metadata; they do not decide whether a use is permitted.

| Area | Capability | v1.1.0 status | Verification |
| --- | --- | --- | --- |
| Import | Operator upload | Retained | Unit and browser smoke tests |
| Import | EPUB, MOBI, PRC, AZW, AZW3, PDF | Retained | Parser, importer, Kindle, PDF, and server tests |
| Source | Standard Ebooks public OPDS | Retained; enabled when reachable | Provider unit tests |
| Source | Project Gutenberg | Retained; rights metadata available | Provider and server tests |
| Source | Internet Archive | Retained; unverified-rights acknowledgement applies | Provider unit tests |
| Source | Anna's Archive primary and browser fallback | Retained; optional configuration and unverified-rights acknowledgement apply | Provider, fallback, redaction, and server tests |
| Source | Z-Library anonymous search and account download | Retained; unverified-rights acknowledgement applies | Provider, auth-state, quota, redaction, and server tests |
| Source | Generic operator-configured OPDS | Retained | OPDS parser, registry, and client-settings tests |
| Metadata | Deterministic cross-source work resolution, bounded title/creator typo handling, version ranking, fallback compatibility, cover lookup, provenance | Implemented | Resolver fixtures, catalog, query-correction, grouping, server fallback, browser, cover SSRF, metadata, and provenance tests |
| Search | Work-first desktop grid and mobile shelf rows; sticky controls, modal filters, bounded misspelling ranking, and one disclosed catalog-validated retry after a healthy zero-result search | Implemented | Query orchestration, catalog ranking, metadata adapter, Pixel-sized browser geometry, focus, touch-target, mini-player clearance, and browser smoke tests |
| Narration | Microsoft Edge | Retained; remote unofficial consumer endpoint | Calibrated audio fixture and engine tests |
| Narration | Local Kokoro | Retained | Calibrated audio fixture, adapter, and tuning tests |
| Narration | Local Chatterbox | Retained | Calibrated audio fixture and adapter tests |
| Voice | Built-in voices, samples, custom Chatterbox references | Retained; custom reference requires authority confirmation | Voice authority, preferences, and permissions tests |
| Playback | Chunked and single-file chapter audio, iOS path, Range requests | Retained | Server, audio-response, player, and browser smoke tests |
| Playback | Queue, prioritization, retry quarantine, premium preparation | Retained | Queue, chunked-TTS, orchestration, and server tests |
| Playback | Speed, sleep timer, bookmarks, pronunciation repair | Retained | Client, bookmark, pronunciation, and browser tests |
| Offline | PWA shell and cached playback | Retained | Service-worker and browser smoke tests |
| State | Positions, batch sync, profiles, devices, pairing, client settings | Retained | User-library-state, route, and browser tests |
| Deletion | Books, extracted sources, generated audio, positions, bookmarks, offline copies, and voice references | Retained | Server, state-cleanup, offline, and release persistence tests |
| Security | Optional full-API token auth, signed cookie, bearer clients, CORS, CSP, rate limits | Implemented | Auth, HTTP security, rate-limit, Range, and browser tests |
| Packaging | Native Node.js 24 | Supported | CI test and audio-verification jobs |
| Packaging | Docker and Docker Compose | Supported | Build-context, health, persistence, and release workflow checks |
| Packaging | Optional Kokoro and Chatterbox containers | Supported, source-built | Pinned Python manifests; private service ports; first-run model egress; release build/import/scan gate |
| Packaging | Umbrel digest-pinned bundle | Supported | Renderer and image-verification workflows |
| Release | amd64 and arm64 OCI image, SBOM, signing, scan, checksums | Implemented but unpublished | Signed-tag release workflow; owner-controlled approval gate |

The local test baseline on 2026-07-13 is 1,593 passing tests across 55 suites on Node 24, with Edge, Kokoro, and Chatterbox calibration fixtures passing. Live provider availability and provider terms are external conditions; mocked tests cannot guarantee them. The public release remains blocked by `docs/RELEASE_APPROVALS.md`, the historical secret scan, and `docs/ASSET_PROVENANCE.md`.
