# Xandrio Architecture

Xandrio is a single self-hosted Node.js application. It serves a vanilla JavaScript PWA and stores instance state in local JSON files. The operator supplies the machine, network, providers, credentials, and retention policy.

## Components

| Component | Responsibility |
| --- | --- |
| `server.js` | Express routes, import workflow, library state, provider orchestration, playback APIs, and local persistence |
| `lib/search-providers/` | Anna's Archive, Z-Library, Project Gutenberg, Internet Archive, Standard Ebooks, and OPDS adapters |
| `lib/book-importer.js` | Format validation, metadata extraction, persistence, and source artifact handling |
| `lib/chunked-tts.js`, `lib/tts-queue.js` | Chunk scheduling, narration generation, cache variants, and playback manifests |
| `lib/narration-*` and adapters | Edge, Kokoro, and Chatterbox engine selection and runtime health |
| `public/` | PWA shell, library, search, settings, player, offline cache, and client settings |
| `data/` | Persistent library and instance state |
| `cache/` | Imported files/artifacts, covers, narration cache, search covers, and voice samples |

## Provider and metadata flow

1. The browser requests a search from selected providers.
2. The server calls those providers directly from the operator's host and returns normalized results with source status.
3. If healthy selected providers return no results, the server can request one spelling suggestion from English Wikipedia, validate the bounded edit and Open Library identity, retry the same providers once, and disclose the correction.
4. When an operator imports a result, Xandrio records source provenance where the provider supplies it, including provider identity, item identifier, source URL/domain, acquisition time, and reported rights/licence fields when available.
5. Metadata and cover enrichment can call Open Library; provider cover URLs can also be fetched and cached.
6. The imported book and generated artifacts remain in local persistent storage until deletion or the operator's retention process removes them.

Provider result labels communicate whether a result is an operator upload, carries reported rights metadata, has unverified rights status, or comes from an operator-configured catalog. They are not copyright or legal determinations.

## Narration flow

1. Xandrio extracts book text and splits it into chapter chunks.
2. The TTS queue chooses the selected engine and generates audio.
3. The server stores generated chunks in `cache/` under a voice/variant-specific key.
4. The player streams chunks, supports Range requests, and reuses cached audio for later and offline playback.

Edge sends narration text to Microsoft through an unofficial consumer-endpoint integration. Kokoro and Chatterbox send narration to the local host chosen by the operator. Chatterbox can read an operator-supplied voice reference. See [PRIVACY.md](PRIVACY.md) for the outbound-data table.

## Accounts and authentication

Three modes share one auth stack (`lib/auth.js`, `lib/accounts.js`):

- **Trusted-LAN** — no `XANDRIO_TOKEN` and no accounts: every caller is an
  implicit admin, and per-device sync profiles (self-asserted
  `X-Xandrio-User-Id` header) namespace positions and bookmarks.
- **Shared token** — `XANDRIO_TOKEN` set, no accounts: the historical
  single-credential mode; browsers exchange the token for a session cookie.
- **Accounts** — one or more username/password accounts exist
  (`data/accounts.json`, scrypt-hashed; managed by
  `scripts/manage-accounts.js`): browsers sign in with credentials and get an
  opaque, revocable server-side session (`data/sessions.json` stores only the
  token's sha256). The session — never a client header — determines whose
  positions, bookmarks, settings, and shelf a request touches. Roles: admins
  manage instance settings, provider credentials, and any book; members keep
  full library powers (import, TTS, downloads) and can delete only books they
  added. A still-configured `XANDRIO_TOKEN` stays valid as an
  admin-equivalent `Authorization: Bearer` credential for scripts.

Sessions slide: any authenticated request past 24 hours since the session was
issued (or last renewed) extends it to a full TTL again — 30 days by default,
`XANDRIO_SESSION_TTL_HOURS` to change, 90-day cap. A device in regular use
therefore never re-prompts; only devices idle past the full TTL sign in again.
Renewal applies to both account sessions and shared-token session cookies.

Account ids share the `usr_*` space with the older sync profiles, so binding
an account to an existing profile id (`manage-accounts.js add --profile`)
adopts its data with no migration. Every user sees the shared library
(`books.json`); `data/shelves.json` holds each user's personal shelf, and the
TTS cache stays shared because it is keyed by book and voice, not user.

## Storage boundary

The project does not receive instance data. Operators should protect `data/`, `cache/`, `.env`, backups, and browser site storage as private data. `data/` can include provider configuration, sessions, sync state, and voice metadata; `cache/` can include books, extracted text artifacts, audio, and voice samples. The default container mounts `data/` and `cache/` as persistent volumes.

## Deployment boundary

Supported operator modes are localhost/native Node.js, Docker or Docker Compose, Umbrel, and a private remote path such as Tailscale or a TLS reverse proxy. Local engines require a separately managed local model/runtime in the standard container path. Read [SELF_HOSTING.md](SELF_HOSTING.md) before exposing an instance to a network.

## Design constraints

- Preserve existing providers, import formats, engines, voice features, playback, offline behavior, and sync behavior.
- Do not introduce a project-operated content, credential, catalog, proxy, or TTS service.
- Do not silently remove a feature. Removal requires an announced proposal, migration path, and explicit project-owner approval.
- Do not make jurisdiction-wide legal claims about sources or operator use.
