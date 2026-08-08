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

1. Xandrio extracts book text and splits it into chapter chunks. Import warms
   only the preferred playable chapter; startup does not backfill the library.
2. Meaningful playback maintains a three-playable-chapter look-ahead window.
   Full-title downloads create durable intents and materialize one chapter per
   title across at most two titles.
3. The TTS queue chooses the selected engine and arbitrates current playback,
   next-chapter playback, look-ahead, downloads, and background work in that
   order. A waiting download receives bounded progress without overtaking live
   playback.
4. The server stores generated chunks in `cache/` under a voice/variant-specific key.
5. The player streams chunks, supports Range requests, and can create a verified
   full-title browser download containing every chapter plus a compact
   title/chapter snapshot and cover.
6. The service worker serves downloaded chapter audio and covers. The local
   snapshot rebuilds the library and player after a cold offline launch. Server
   preparation and generated narration are shared across devices, but the
   Downloaded view and transferred Cache Storage entries are scoped to the
   current account, browser profile, and device.

### Scheduling is reconciled, not remembered

Generation used to advance only on queue events — `complete`, `error`,
`settled` — matched back to a manifest through an in-memory job map. Every one
of those edges can be missed: a completion whose mapping a concurrent pump has
already removed is dropped, a cancelled job emits nothing that re-pumps its
manifest, and a job whose queue record has aged out of the finished-job cache
reports no status at all. Miss the last edge for a chapter and it stops dead —
pending chunks, no jobs, and nothing that will ever look at it again — while
chapter status still answers `preparing: true`. A production session lost 56 of
91 minutes to exactly this.

So the scheduler re-derives its state instead of trusting that it was told:

- `ChunkedTTS.reconcile()` compares every live manifest against the queue and
  re-materializes anything with outstanding work and no scheduled jobs. It runs
  on an unref'd timer, is safe to call at any moment, and does nothing when
  everything is healthy. It covers background and offline preparation, which no
  waiter is watching, and variant workers inherit it.
- `waitForChapter()` keeps its own bounded watchdog so a caller learns about a
  chapter that cannot be revived (`CHAPTER_GENERATION_STRANDED`) rather than
  awaiting forever.

**Rendered audio is never re-synthesized.** Chunk paths are content-addressed —
book, chapter, index, variant and output format — and stale audio is deleted
wholesale when the source text hash changes, so a file at the expected path is
that chunk's audio. Both the manifest pump and the queue check for it before
generating. TTS is the most expensive thing this server does; that check is a
`stat`.

## Local-first playback

A chapter already on this device is played from this device, whether or not
there is a network. Connectivity used to gate that check, so a fully downloaded
book streamed anyway whenever the phone had signal.

- The explicitly scoped offline media URL (`/api/audio/…?xandrio-offline-scope=`)
  is **cache-only** in the service worker. This is a permanent contract, not a
  fallback strategy. The server route behind that URL serves a different encode
  from the downloaded offline package, so a network fall-through would stream the
  wrong artifact — and re-run TTS — while appearing to play locally. Ordinary
  online media still bypasses the worker entirely.
- Scoped responses carry `X-Xandrio-Offline-Cache: hit|miss`, diagnostic worker
  build, and an `X-Xandrio-Offline-Contract` number. The build id forces worker
  installation; the explicit contract decides compatibility, so routine worker
  builds do not invalidate a proven download.
- Before hash routing can choose audio, the idle boot page certifies its
  controlling worker. If the current worker lacks the cache-only contract, the
  fully installed replacement activates and that idle page reloads once under
  it. Activation is refused while another window is open because
  `skipWaiting()` itself would switch that tab's controller. The cached chapter
  is visibly blocked with a reload action until the other tab closes instead of
  silently streaming.
- Routing is presence-only — a manifest entry plus a cache hit. It never hashes
  a body, because doing so on the load path would stall the first play of every
  chapter. No scoped URL is offered when the page has no worker controller.
- The app, not the worker, owns a **single** fallback to streaming after a local
  failure, and says so in the UI.

### Corruption and failure handling

A media error is not evidence of a bad download; mobile Safari raises them
routinely. Distrust is therefore session-only, and durable state changes require
deterministic evidence:

| Evidence | Manifest | Cached bytes |
| --- | --- | --- |
| Any playback failure | untouched | kept |
| Compatible-contract `504` + `miss` | entry cleared | **kept**, so a repair revalidates cheaply |
| 3 failures + hash mismatch | entry cleared | deleted (the only case) |
| 3 failures + hash match | untouched | kept; chapter streams for the session |
| Anything else (no controller, transport failure, incompatible contract, malformed, transient 5xx) | untouched | kept |

### Download completion

Bytes are verified against the server hash, then the exact scoped worker route
is probed with a two-byte Range request. Only an exact `206`, matching
`Content-Range` size, `Content-Length: 2`, `hit` marker and compatible route
contract promotes a download to `ready`/Downloaded. Anything else leaves it in
`verifying` — bytes intact — and it is re-probed at startup and on
`controllerchange`. `verifying` and partial downloads are never reported as
Downloaded, but remain hydratable so partial offline playback keeps working.

## Resume

A resume must reach `audio.play()` inside the user-activation window iOS opened
for the tap; any `await` first loses it.

- Tap, lock-screen and Control Center paths call `play()` synchronously. Smart
  Rewind applies via a synchronous seek or is deferred — it never reloads a
  nonseekable HLS source, which both closed the activation window and minted a
  server session.
- Manual recovery **prepares the source before offering Resume**, so the tap only
  plays. A failed preparation offers "Try again" instead of claiming a one-tap
  resume.
- One immutable snapshot of the canonical request (`book`, `chapter`, exact
  offset, tier, end chapter) is captured when a failure is handled and replayed
  verbatim by every automatic attempt and the preloaded manual Resume. The
  automatic-to-manual handoff preserves the same two-attempt budget until 30
  seconds of stable playback or real navigation.
- The client session id is stable per canonical tuple, so retries join the
  existing server HLS session. A resume should create **one** session.
- A ready, running HLS session is never reclaimed merely because the client is
  request-silent. Native iOS can consume minutes of buffered audio without an
  HTTP request, including while locked. Sessions remain bounded by active and
  retained LRU counts plus the storage cap; they end on explicit owner
  replacement, bounded eviction, or service shutdown. Elapsed request silence
  alone never invalidates a native media resource the lock screen may still own.
- One recovery attempt owns the player at a time; at most two automatic attempts;
  a `429` is reported with its `Retry-After` and never retried into.
- The client abandons a load at `CLIENT_LOAD_DEADLINE_MS` (30 s). Cancellation is
  disconnect-driven; the server's HLS readiness timeout is derived from that
  constant purely as a backstop for sockets that never close.
- TTS scheduling is unchanged. First-segment latency is instrumented only.
7. Title deletion cancels its generation intents and removes server artifacts
   first, then the initiating browser clears its audio, cover, manifest,
   checkpoint, and pending position records.

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

Supported operator modes are localhost/native Node.js, Docker or Docker Compose, Umbrel, and a private remote path such as Tailscale or a TLS reverse proxy. Local engines require a separately managed local model/runtime in the standard container path. Read [SELF_HOSTING.md](SELF_HOSTING.md) before exposing an instance to a network, and [DEPLOYMENT_TOPOLOGY.md](DEPLOYMENT_TOPOLOGY.md) for the reference split between a public web instance (accounts, Edge TTS) and a local engine host (Kokoro/Chatterbox).

## Design constraints

- Preserve existing providers, import formats, engines, voice features, playback, offline behavior, and sync behavior.
- Do not introduce a project-operated content, credential, catalog, proxy, or TTS service.
- Do not silently remove a feature. Removal requires an announced proposal, migration path, and explicit project-owner approval.
- Do not make jurisdiction-wide legal claims about sources or operator use.
