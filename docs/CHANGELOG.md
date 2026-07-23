# Xandrio — Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Changed

- Mobile book search now uses compact horizontal shelf rows, sticky search and
  sort controls, and a focus-trapped filter sheet. Pixel-sized layouts expose
  several actionable results per viewport while preserving full desktop cards,
  version selection, safe-area spacing, and mini-player clearance.
- Search now handles bounded misspellings in both provider results and user
  queries. Cross-source work grouping accepts a single corroborated title typo
  or a missing/transposed creator character while retaining hard conflict and
  ambiguity guards. Healthy zero-result searches may apply one Wikipedia
  spelling suggestion only after Open Library validation, retry the same
  sources once, and disclose the correction in the UI and API.
- Work resolution now treats compatible primary-creator forms—initials,
  surname-first order, and bounded bibliographic abbreviations such as `Wm.`—as
  aliases. Official `Title: Subtitle` listings can resolve to an unsuffixed
  title, while different creators, sibling subtitles, derivatives, adaptations,
  languages, volumes, and conflicting catalog keys remain separate.
- Calibre-style/generated Anna edition-page covers are now last-resort
  fallbacks. High-confidence Open Library and Google Books covers are tried
  first, and the search-cover cache revision forces older choices to be
  reconsidered.
- Open Library candidates discovered through an overall author query are now
  scored against each provider listing's own title and primary author. This
  prevents unrelated results from inheriting one work identity, merging into
  false versions, or receiving that work's cover.
- Search now resolves high-confidence cross-source work aliases into one clean
  card while preserving every provider version, acquisition route, and source
  policy. Display titles are chosen independently from the preferred file.
- Automatic import retries now stay within server-validated language, volume,
  abridgement, adaptation, derivative, and textual-version groups.
- Search version disclosure now reports versions and sources without merge or
  rights-status badges. Operators retain a temporary exact-grouping escape hatch
  and opt-in local resolution diagnostics.
- Restored Anna search with the current `annas-mcp book-search` command, automatic mirror discovery, and user-local CLI discovery for restricted service environments.
- Restored Z-Library search through its working `go-to-library.sk` EAPI access domain while retaining validated fallback domains.
- Removed repetitive rights-status tags from search results, source pills, and provider rows; the instance-level Settings checkbox remains the enablement control.
- New instances acknowledge the operator notice without automatically enabling sources whose rights status is unverified; default searches begin with Standard Ebooks and Project Gutenberg.
- Anna browser search is disabled by default, requires `ANNAS_BROWSER_SEARCH_MODE=permitted`, and runs only after the primary search returns no results.
- Anna failures no longer contact Z-Library silently; cross-provider retries remain explicit and retain the selected provider's provenance.
- File-managed Anna keys can be replaced locally with redacted status and update time; environment-managed keys must be changed in the deployment environment.
- Security and conduct reporting now use `xandrio.xyz` addresses; monitoring and delivery verification remain release gates.

### Security

- Removed private search terms and opaque upstream Anna errors from logs and responses.
- Documented the non-rotatable historical Anna credential and blocked publication of the legacy private Git history.

## [1.1.0] — 2026-07-12

### Added

- Self-hosted instance authentication with signed `HttpOnly` sessions, bearer-token clients, CORS allowlists, security headers, and rate limits.
- Multi-provider search and import for Standard Ebooks, Project Gutenberg, Internet Archive, Anna's Archive, Z-Library, generic OPDS catalogs, and operator uploads.
- Provider rights-status labels, persisted operator acknowledgement, import provenance, and voice-reference authority confirmation without removing any provider or narration engine.
- EPUB, MOBI, PRC, AZW, AZW3, and PDF normalization with compact XBook artifacts for extracted formats.
- Edge, local Kokoro, and local Chatterbox narration; custom Chatterbox voice references; calibrated audio checks; pronunciation repair; premium preparation; and durable generation recovery.
- Multi-user positions, bookmarks, device pairing, client preferences, listening statistics, offline playback, and single-file iOS audio.
- Native, Docker Compose, optional local-engine, and digest-pinned Umbrel packaging.
- Public-project legal, privacy, threat-model, security, support, contribution, governance, asset-provenance, and release-approval documentation.
- Signed-tag release automation with full-history secret scanning, dependency audit, SBOM, third-party notices, multi-architecture execution, persistence and rollback checks, container scanning, signing, checksums, and owner-approved promotion.

### Changed

- Standardized the supported runtime on Node.js 24 and upgraded production dependencies, including the EPUB parser, to remove known production audit findings.
- Reworked search into work-first grouping with selectable editions, safer cover handling, provider failure isolation, and bounded fallbacks.
- Reworked playback around a shared orchestration layer, durable variant-scoped caches, measured timelines, improved mobile controls, and atomic offline shell updates.
- Hardened stored JSON, provider sessions, voice references, upload/import cleanup, errors, remote fetches, and container build context.
- Made native configuration load `.env`, defaulted native servers to loopback, honored custom data/cache paths, and added opt-out control for import-time narration warming.
- Added source-built optional-engine image validation and an architecture-specific container smoke test that imports a synthetic EPUB, generates playable Edge narration, and verifies byte ranges.

### Security

- Private API reads and writes now share one optional instance-auth boundary; trusted-LAN mode remains explicit when no token is configured.
- Remote provider and cover fetches reject private/reserved destinations, validate redirects, enforce time and size limits, and redact upstream failures.
- Publication fails closed until historical credentials, bundled-asset provenance, owner approvals, counsel review, public contacts, and release infrastructure are resolved.

## [0.2.0] — 2026-02-05

### Added

#### Chunked TTS System (fully integrated)
- **TTSQueue** (`lib/tts-queue.js`): Priority-based TTS generation queue with concurrency control (max 2 simultaneous). Three priority levels: `immediate` (playing now), `next` (upcoming chunks), `background` (look-ahead chapters). Emits events for progress tracking.
- **ChunkedTTS** (`lib/chunked-tts.js`): Smart text splitting at ~4,000-character chunks with sentence-boundary awareness. Splits by paragraph first, then by sentence if a paragraph exceeds the limit — never breaks mid-sentence. Per-chapter in-memory manifests track chunk status lifecycle (`pending` → `queued` → `generating` → `ready`/`error`).
- **ChunkPlayer** (`public/js/chunk-player.js`): Double-buffered gapless audio playback using two alternating `<audio>` elements. Preloads the next chunk in the standby player and swaps on chunk end for seamless transitions. Supports cross-chunk seeking with cumulative duration tracking, percentage-based seeking, and waiting state with manifest polling when chunks aren't ready yet.

#### Chunk API Endpoints
- `GET /api/chunks/:bookId/:chapterIndex/manifest` — Returns chunk manifest with generation status; triggers generation if needed; auto-queues next chapter at background priority (look-ahead).
- `GET /api/chunks/:bookId/:chapterIndex/status` — Returns chunk generation progress (`ready`/`generating`/`error` with counts).
- `GET /api/chunks/:bookId/:chapterIndex/:chunkIndex` — Serves individual chunk MP3 with range request support; returns 202 if chunk is still generating.
- `GET /api/queue/status` — Returns TTS queue status (`active`, `queued`, `completed` counts).

#### Anna's Archive browser fallback
- New `lib/annas-scraper.js`: Uses the configured Playwright browser integration to search Anna's Archive when `annas-mcp` CLI fails or returns no results.
- Uses an operator-controlled browser fallback (headless Chromium with configured browser integration); upstream defenses can make it unavailable and the fallback does not determine whether access is permitted.
- Browser instance is pooled and reused across requests; auto-closes after 5 minutes of idle time.
- Search falls back transparently: `annas-mcp` CLI (15s timeout) → Playwright browser fallback.

### Changed

#### Search Improvements
- **Improved relevance scoring** with normalized title matching: strips subtitles, parentheticals, and punctuation before comparison. Scoring now ranges up to +200 for exact normalized matches (previously max was +100 for raw title match).
- **Work grouping**: Search results are grouped into works and expose the recommended version plus compatible alternate versions.
- **Search UI overhaul**: Top results displayed as cards with Best Match badge, edition count, format badges, and individual download buttons — no longer hidden behind a toggle.

#### Audio Playback
- `GET /api/audio/:bookId/:chapterIndex` now uses chunked generation under the hood. Resolution order: legacy monolithic MP3 → concatenated chapter MP3 → chunk concatenation → fresh chunk generation. Fully backward compatible.
- Frontend playback fully migrated to `ChunkPlayer`. The old `<audio id="audio-player">` element is retained in the DOM but no longer used for playback.
- Pre-generation on book download now uses the chunked TTS system (`TTSQueue` + `ChunkedTTS`).

#### Chapter Parsing Fixes
- **TOC fallback titles**: When a chapter has no spine title, the system now looks up the TOC by matching `href` to find the correct title before falling back to content-based title extraction.
- **HTML entity cleanup**: `stripHTML()` now handles `&nbsp;`, `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, and generic `&entity;` patterns.
- **Styled text handling**: `stripHTML()` now detects and fixes spaced-out styled text (e.g., `W INNIE-THE- P OOH` → `WINNIE-THE-POOH`) by collapsing single-letter uppercase sequences.

### Fixed
- **Delete button** for book titles containing quotes: properly escaped in `onclick` attributes using `&quot;` encoding.
- **Codebase cleanup**: 68 dead/unused files archived to reduce project noise.

---

## [0.1.0] — 2026-02-05

Initial documented release. This captures the full feature set as of the first formal documentation pass.

### Added

#### Core Playback
- EPUB chapter extraction with intelligent chapter identification (cover, copyright, toc, frontmatter, author, chapter, divider, content types).
- Edge TTS integration via `node-edge-tts` for text-to-speech conversion.
- Multi-language TTS support: English, German, Spanish, French, Italian, Portuguese, Russian, Chinese, Japanese — each with a dedicated neural voice.
- Audio caching: generated MP3 files are cached per chapter for instant replay.
- HTTP Range request support for audio seeking without re-downloading.
- Background pre-generation of chapters 0 through Chapter 1 after book download for near-instant first playback.
- Playback speed control with 6 speed options (0.75×, 1.0×, 1.25×, 1.5×, 1.75×, 2.0×), persisted via `localStorage`.
- Sleep timer with 5 presets (5, 10, 15, 30, 60 minutes), volume fade-out in the last 30 seconds, persisted across page reloads.
- Automatic position saving every 30 seconds and on page unload.
- Position restore on book reopen (chapter + timestamp).
- Auto-advance to next chapter when current chapter ends.

#### Book Search & Download
- Anna's Archive integration via `annas-mcp` CLI for book search and download.
- Relevance scoring: exact title match, partial match, word-level match, and author match.
- Quality scoring (5-star system): format preference (EPUB > MOBI > PDF), file size, metadata completeness, edition recency.
- Language filtering on search results (9 languages + "any").
- Recommended edition with alternatives UI — hero card for best result, expandable list for others.
- Minimum book size filter (100 KB) to exclude broken/fake files.

#### EPUB Upload
- Direct EPUB file upload via multipart form (max 50 MB).
- Duplicate detection by title + author match.
- Upload progress UI with filename display and status messages.

#### EPUB Validation
- 7-stage validation pipeline for all downloaded and uploaded EPUBs:
  1. File existence
  2. Minimum file size (10 KB)
  3. ZIP integrity (`unzip -t`)
  4. EPUB parsability
  5. Table of contents presence
  6. Readable content flow
  7. Audiobook suitability analysis (≥50K chars, ≥60% substantial chapters)
- Automatic cleanup of corrupted downloads.
- Validation warnings surfaced to the user.
- Diagnostic validation endpoint for existing books (`POST /api/validate/:bookId`).

#### Library Management
- JSON-file-based library (books.json) with full CRUD operations.
- Book cover extraction from EPUB files.
- Open Library API fallback for cover images and metadata enrichment.
- Library search (filter by title or author).
- Library sorting (recently added, title A-Z/Z-A, author A-Z/Z-A).
- List/grid view toggle.
- Book deletion with confirmation modal.
- Swipe-to-delete on touch devices.
- Delete removes: EPUB file, cover image, all cached audio, library entry, saved position.
- Metadata refresh endpoint to re-extract and re-enrich book metadata.

#### Chunked TTS System (`lib/`)
- `ChunkedTTS` class: splits chapter text into ~4,000-character chunks at paragraph/sentence boundaries.
- Per-chapter manifest tracking with chunk status lifecycle (pending → queued → generating → ready/error).
- `TTSQueue` class: priority-based job queue with configurable concurrency (default 2).
- Three priority levels: immediate, next, background.
- ffmpeg-based chunk concatenation into single chapter files.
- Chunked audio API endpoint (`GET /api/audio-chunked/:bookId/:chapterIndex`).
- Secure chunk serving with regex-validated filenames.

#### Frontend
- Mobile-first single-page application (vanilla JS, no framework).
- Three-view navigation: Library → Search → Player.
- PWA meta tags (`apple-mobile-web-app-capable`).
- Touch-optimised controls with platform detection.
- Accessible UI: ARIA labels, roles, screen-reader announcements.
- Audio loading indicator with status messages.
- Error display with suggestions for resolution.
- Toast notifications for actions (delete, timer expiry).
- Chapter type display in chapter selector dropdown.
- Book details panel (description, publisher, year, language) in expandable section.

### Known Issues

- Background chapter pre-generation disabled due to server crash risk (needs rate limiting).
- The `src/` refactored service layer exists but is not integrated into `server.js`.
- Shell command execution for `annas-mcp` uses string interpolation rather than parameterised execution.
- No authentication or rate limiting on the API.
- No client-side service worker for offline playback.
- Chapter filtering heuristics may misclassify unusual EPUB structures.
