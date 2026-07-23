# Xandrio — API Reference

**Base URL:** `http://<host>:8181`  
**Content-Type:** `application/json` (unless noted)  
**Version:** 1.1.0

Xandrio is an operator-hosted instance API. It does not make rights determinations for provider results. Provider and narration network behavior is documented in [PRIVACY.md](PRIVACY.md).

---

## Authentication

When `XANDRIO_TOKEN` is set, every `/api` route requires authorization except `/api/auth/login`, `/api/auth/logout`, and `/api/auth/status`. A browser posts `{ "token": "…" }` to `/api/auth/login` and receives a signed `HttpOnly` session cookie. Non-browser clients send `Authorization: Bearer <token>`. Static assets and `/health` remain public. Without `XANDRIO_TOKEN`, Xandrio runs in trusted-LAN mode and anyone who can reach the server can access its API.

The examples below omit authorization headers for readability.

---

## Table of Contents

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | [/api/search](#post-apisearch) | Search configured book sources for books |
| GET | `/api/search/sources` | List source availability, enablement, and rights-status labels |
| POST | [/api/download](#post-apidownload) | Import a selected provider version |
| POST | [/api/upload](#post-apiupload) | Upload a supported book file |
| GET | [/api/library](#get-apilibrary) | List all books in library |
| DELETE | [/api/book/:bookId](#delete-apibookbookid) | Delete a book and its files |
| GET | [/api/book/:bookId](#get-apibookbookid) | Get book details and chapters |
| GET | [/api/cover/:bookId](#get-apicoverbookid) | Get book cover image |
| GET | [/api/audio/:bookId/:chapterIndex](#get-apiaudiobookidchapterindex) | Get or generate chapter audio |
| GET | [/api/audio-chunked/:bookId/:chapterIndex](#get-apiaudio-chunkedbookidchapterindex) | Get chunked chapter audio (legacy) |
| GET | [/api/serve-chunk/:filename](#get-apiserve-chunkfilename) | Redirect a legacy chunk filename to canonical playback access |
| GET | [/api/chunks/:bookId/:chapterIndex/manifest](#get-apichunksbookidchapterindexmanifest) | Get chunk manifest for a chapter |
| GET | [/api/chunks/:bookId/:chapterIndex/status](#get-apichunksbookidchapterindexstatus) | Get chunk generation status |
| GET | [/api/chunks/:bookId/:chapterIndex/:chunkIndex](#get-apichunksbookidchapterindexchunkindex) | Serve individual chunk MP3 |
| GET | [/api/queue/status](#get-apiqueuestatus) | Get TTS queue status |
| GET | `/api/pronunciations` | List global, book, and effective pronunciation rules |
| POST | `/api/pronunciations` | Create a pronunciation rule and invalidate affected audio |
| PUT | `/api/pronunciations/:id` | Update a pronunciation rule |
| DELETE | `/api/pronunciations/:id` | Delete a pronunciation rule |
| POST | [/api/position](#post-apiposition) | Save playback position |
| GET | [/api/position/:bookId](#get-apipositionbookid) | Get saved playback position |
| POST | [/api/refresh-metadata/:bookId](#post-apirefresh-metadatabookid) | Re-extract and enrich book metadata |
| POST | [/api/validate/:bookId](#post-apivalidatebookid) | Run validation on existing book |

---

## Current Endpoint Inventory

Regenerated from `server.js` and `lib/routes/*.js` on 2026-07-12.

| Method | Endpoint |
| --- | --- |
| POST | `/api/auth/login` |
| POST | `/api/auth/logout` |
| GET | `/api/auth/status` |
| POST | `/api/search` |
| GET | `/api/search/sources` |
| GET | `/api/search-cover/:key` |
| POST | `/api/download` |
| GET | `/api/download/:jobId/status` |
| GET | `/api/download/:jobId/events` |
| POST | `/api/upload` |
| GET | `/api/library` |
| DELETE | `/api/book/:bookId` |
| GET | `/api/book/:bookId` |
| POST | `/api/refresh-metadata/:bookId` |
| GET | `/api/cover/:bookId` |
| GET | `/api/audio/:bookId/:chapterIndex` |
| GET | `/api/audio-ios/:bookId/:chapterIndex` |
| GET | `/api/audio-chunked/:bookId/:chapterIndex` |
| GET | `/api/serve-chunk/:filename` |
| GET | `/api/chunks/:bookId/:chapterIndex/manifest` |
| GET | `/api/chunks/:bookId/:chapterIndex/chapter-audio-status` |
| POST | `/api/chunks/:bookId/:chapterIndex/prepare-chapter-audio` |
| POST | `/api/chunks/:bookId/:chapterIndex/prepare` |
| POST | `/api/chunks/:bookId/:chapterIndex/retry` |
| GET | `/api/chunks/:bookId/:chapterIndex/status` |
| GET | `/api/premium-prep/:bookId/status` |
| POST | `/api/premium-prep/:bookId/start` |
| GET | `/api/premium-prep/settings` |
| POST | `/api/premium-prep/settings` |
| POST | `/api/chunks/:bookId/:chapterIndex/:chunkIndex/prioritize` |
| GET | `/api/chunks/:bookId/:chapterIndex/:chunkIndex` |
| GET | `/api/voice-cache/:bookId/:chapterIndex` |
| GET | `/api/queue/status` |
| GET | `/api/sync/profile` |
| POST | `/api/sync/profile` |
| POST | `/api/sync/device` |
| POST | `/api/sync/pairing-code` |
| POST | `/api/sync/claim-code` |
| POST | `/api/position` |
| GET | `/api/position/:bookId` |
| GET | `/api/positions` |
| GET | `/api/stats` |
| POST | `/api/positions/batch` |
| POST | `/api/bookmarks` |
| GET | `/api/bookmarks` |
| GET | `/api/bookmarks/:bookId` |
| DELETE | `/api/bookmarks/:id` |
| GET | `/api/settings/client` |
| PUT | `/api/settings/client` |
| GET | `/api/voices` |
| GET | `/api/voice-sample/:voiceId` |
| POST | `/api/voice` |
| GET | `/api/engines/status` |
| POST | `/api/voices/clone` |
| DELETE | `/api/voices/clone/:id` |
| POST | `/api/annas/configure` |
| GET | `/api/annas/status` |
| DELETE | `/api/annas/configure` |
| POST | `/api/zlibrary/configure` |
| DELETE | `/api/zlibrary/configure` |
| GET | `/api/zlibrary/status` |
| GET | `/api/gutenberg/status` |
| POST | `/api/gutenberg/configure` |
| GET | `/api/legal/operator-policy` |
| PUT | `/api/legal/operator-policy` |
| GET | `/api/pronunciations` |
| POST | `/api/pronunciations` |
| PUT | `/api/pronunciations/:id` |
| DELETE | `/api/pronunciations/:id` |
| POST | `/api/validate/:bookId` |

---

## Additional Current Endpoints

These endpoints are part of the current server surface but are newer than some of the long-form sections below.

### Download Jobs

- `GET /api/download/:jobId/status`: returns the current import job snapshot, including `status`, progress step fields, and the final `result` or `error`.
- `GET /api/download/:jobId/events`: Server-Sent Events stream for the same job. Event names include `snapshot`, `progress`, `complete`, and `failed`.

### Sync And Positions

- `GET /api/sync/profile`: returns the current sync profile from `X-Xandrio-User-Id` / device headers.
- `POST /api/sync/profile`: creates or migrates a profile. Body: `name`, `deviceId`, `deviceName`, optional `migrateFromUserId`.
- `POST /api/sync/device`: registers or updates a sync device.
- `POST /api/sync/pairing-code`: creates a short-lived pairing code for another device.
- `POST /api/sync/claim-code`: claims a pairing code and joins the profile.
- `GET /api/positions`: returns all saved positions for the current sync user.
- `POST /api/positions/batch`: saves multiple positions for the current sync user.

### Bookmarks And Client Settings

- `POST /api/bookmarks`: creates a bookmark for a book/chapter/time.
- `GET /api/bookmarks`: returns all bookmarks for the current sync user.
- `GET /api/bookmarks/:bookId`: returns bookmarks for one book.
- `DELETE /api/bookmarks/:id`: deletes one bookmark.
- `GET /api/settings/client`: returns synced client preferences.
- `PUT /api/settings/client`: updates synced client preferences.

### Voices And Chapter Audio

- `GET /api/voices`: returns available TTS voices and the active voice.
- `GET /api/voice-sample/:voiceId`: streams a short voice preview.
- `POST /api/voice`: sets the active TTS voice. Body: `voiceId`.
- `GET /api/voice-cache/:bookId/:chapterIndex`: returns cache status for available voices for the chapter.
- `GET /api/audio-ios/:bookId/:chapterIndex`: serves the single-file chapter-audio path used for iOS reliability.
- `GET /api/chunks/:bookId/:chapterIndex/chapter-audio-status`: returns clean single-file chapter-audio status.
- `POST /api/chunks/:bookId/:chapterIndex/prepare-chapter-audio`: starts clean single-file chapter-audio generation.
- `POST /api/chunks/:bookId/:chapterIndex/prepare`: prepares chunked audio, optionally with `targetChunk`.
- `POST /api/chunks/:bookId/:chapterIndex/:chunkIndex/prioritize`: prioritizes one chunk.
- `POST /api/chunks/:bookId/:chapterIndex/retry`: explicit user retry that clears the selected variant's bounded-failure quarantine and restarts generation. Automatic startup recovery never clears quarantine.

### Source Configuration

- `GET /api/search/sources`: returns provider descriptors for the current instance. Each descriptor includes `id`, `label`, `configured`, `enabled`, `acknowledged`, `rightsStatus` (`unverified`, `provider-metadata`, `operator-supplied`, or `operator-configured`), and `requiresOperatorAcknowledgement`. The descriptor is informational; it does not determine whether a work may be used.
- `GET /api/legal/operator-policy`: returns the persisted instance acknowledgement and whether unverified-rights providers are enabled.
- `PUT /api/legal/operator-policy`: stores the instance decision. The JSON body must be `{ "acknowledged": true, "unverifiedSourcesEnabled": true|false }`. Setting the second field to `false` disables those providers without removing their configuration or capability.

Configure a generic OPDS catalog with `OPDS_FEED_URL`, optional `OPDS_LABEL`, `OPDS_USER`, and `OPDS_PASSWORD`, and `OPDS_REQUIRE_AUTH`. Standard Ebooks uses its public OPDS feed by default; the `STANDARD_EBOOKS_OPDS_*` variables support a mirror or authenticated deployment. See `.env.template` for the complete set.

- `GET /api/annas/status`, `POST /api/annas/configure`, `DELETE /api/annas/configure`: inspect, atomically save or replace, and remove file-managed Anna's Archive configuration. An `ANNAS_SECRET_KEY` environment key must be changed or removed in the deployment environment followed by a restart. These operations do not rotate or revoke a provider-side key.
- `GET /api/zlibrary/status`, `POST /api/zlibrary/configure`, `DELETE /api/zlibrary/configure`: inspect, connect, and disconnect Z-Library.
- `GET /api/gutenberg/status`, `POST /api/gutenberg/configure`: inspect and update Project Gutenberg source settings.

Z-Library account status is authoritative: `connected` means a live profile request succeeded. The account state is one of `disconnected`, `connected`, `auth-expired`, or `unavailable`. Anonymous search does not require an account, so `searchAvailable` is independent from the account state and `downloadAvailable`.

```json
{
  "configured": true,
  "state": "connected",
  "reachable": true,
  "authenticated": true,
  "searchAvailable": true,
  "downloadAvailable": true,
  "downloadsToday": 2,
  "dailyLimit": 10,
  "downloadsRemaining": 8,
  "lastVerifiedAt": "2026-07-11T18:00:00.000Z"
}
```

A disconnected account still permits search:

```json
{
  "configured": false,
  "state": "disconnected",
  "reachable": true,
  "authenticated": false,
  "searchAvailable": true,
  "downloadAvailable": false
}
```

Only `connected` responses include quota fields. Other states may include the safe diagnostic fields `errorCode` and `message`; they never include upstream response bodies, tokens, or cookies. `POST /api/zlibrary/configure` accepts `email` and `password`, validates the session, and returns the connected status. It returns the following stable error codes where applicable:

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `ZLIB_NOT_CONFIGURED` | 409 | A download was requested without a saved session; connect Z-Library in Settings. |
| `ZLIB_AUTH_INVALID` | 401 | The supplied credentials were rejected. |
| `ZLIB_AUTH_EXPIRED` | 401 | The saved session must be reconnected. |
| `ZLIB_TIMEOUT` | 504 | The upstream request exceeded its deadline. |
| `ZLIB_UNAVAILABLE` | 503 | The service or its current domain is unavailable. |
| `ZLIB_RATE_LIMITED` / `ZLIB_DAILY_LIMIT` | 429 | The service or account cannot accept the request now. |
| `ZLIB_PROTOCOL` / `ZLIB_DOWNLOAD_INVALID` | 502 | The upstream response was unsafe or unexpected. |

`POST /api/download` performs the Z-Library account/quota preflight before accepting an import job, so disconnected, expired, unavailable, and exhausted-account states return the mapped HTTP response instead of `202`. A failure that occurs after a job is accepted is delivered through the job status/SSE error payload with the same stable `code`.

### Pronunciation Repair

- `GET /api/pronunciations?bookId=:bookId`: returns `global`, book-scoped, and effective rules.
- `POST /api/pronunciations`: creates a rule. Body: `scope` (`global` or `book`), optional `bookId`, `source`, `replacement`, `caseSensitive`, and `wholeWord`. The response includes affected chapters and removed cache files.
- `PUT /api/pronunciations/:id`: updates a rule using the same scope fields.
- `DELETE /api/pronunciations/:id`: removes a rule. Supply `scope` and optional `bookId` in the query or body.

Rule changes quiesce affected generation work, invalidate changed and subsequent chunks across voice variants, and remove stitched chapter outputs. New generation applies the effective rule set before narration planning.

---

## POST /api/search

Search selected provider sources for books. Provider status and individual results expose source and rights-status information where available. The Anna integration uses its primary configured path first and may use an automated browser fallback when the primary path cannot return results. That fallback is an upstream-dependent, operator-controlled integration; it can break when the provider changes its defenses and does not determine whether access is permitted. Results are resolved into works, ranked by relevance and quality, with the best downloadable version highlighted as the recommendation.

If every healthy selected source returns zero results, the server may request a
spelling suggestion from the English Wikipedia search endpoint, accept only one
bounded token edit, validate the candidate against Open Library, and retry the
same selected sources once. Successful correction is disclosed in
`searchCorrection`; provider outages never trigger this path.

### Request

```json
{
  "query": "The Hitchhiker's Guide to the Galaxy",
  "language": "en"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Search query (title, author, or both) |
| `language` | string | No | Language filter: `"en"`, `"de"`, `"es"`, `"fr"`, `"it"`, `"pt"`, `"ru"`, `"zh"`, `"ja"`, `"all"`. Default: no filter |
| `sources` | string[] | No | Source IDs to search. Omit to use the server defaults. |

### Search Strategy

1. **`annas-mcp` CLI** — Primary. Executes the CLI tool with a 15-second timeout.
2. **Playwright browser fallback** — Disabled by default. When the operator explicitly sets `ANNAS_BROWSER_SEARCH_MODE=permitted`, it is used only after the primary Anna path returns no results or fails. It launches headless Chromium with automation-fingerprint compatibility measures, does not solve interactive challenges, and auto-closes after five minutes of idle time. Upstream defenses and page changes can make it unavailable; operators must confirm automated access is permitted before enabling it.

### Response — Success (200)

Results are resolved by trusted Open Library work identity, exact canonical
metadata, official subtitle aliases, bounded cross-source typo evidence, or a
corroborated publisher/imprint alias. Each work preserves all selectable
provider versions. Known language, creator, volume, collection-scope,
derivative, and adaptation conflicts prevent merging.

```json
{
  "recommended": {
    "title": "The Hitchhiker's Guide to the Galaxy",
    "author": "Douglas Adams",
    "format": "EPUB",
    "size": "2.3 MB",
    "hash": "abc123def456",
    "publisher": "Pan Books",
    "language": "en",
    "url": "https://...",
    "qualityScore": 5,
    "relevanceScore": 200,
    "bestRelevance": 200,
    "editionCount": 3,
    "otherEditions": [
      {
        "title": "The Hitchhiker's Guide to the Galaxy",
        "format": "EPUB",
        "size": "1.8 MB",
        "hash": "789abc012def",
        "publisher": "Penguin, 2020"
      }
    ]
  },
  "alternatives": [
    {
      "title": "The Hitchhiker's Guide to the Galaxy (Illustrated)",
      "author": "Douglas Adams",
      "format": "EPUB",
      "size": "15.2 MB",
      "hash": "def789abc012",
      "publisher": "Del Rey",
      "language": "en",
      "url": "https://...",
      "qualityScore": 5,
      "relevanceScore": 150,
      "bestRelevance": 150,
      "editionCount": 1,
      "otherEditions": []
    }
  ],
  "results": [ /* all scored results for backwards compatibility */ ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `versionCount` | integer | Number of selectable provider versions resolved into this work |
| `sourceCount` / `sources` | integer / string[] | Distinct acquisition sources represented by the work |
| `resolution` | object | Named resolution confidence and method; no opaque percentage |
| `fallbackGroupId` | string | Opaque per-version group used to bound automatic fallback; the server recomputes compatibility |
| `editionCount` | integer | Compatibility alias of `versionCount` |
| `otherEditions` | array | Compatibility field containing alternate versions |
| `bestRelevance` | number | Highest relevance score among all versions of this work |
| `relevanceScore` | number | Relevance score for the recommended version |
| `qualityScore` | number | Quality score (1–5 star system) |
| `requestedQuery` / `effectiveQuery` | string / string | Original user query and the query used for ranking/provider retry |
| `searchCorrection` | object | Present only after a validated corrected retry succeeds; includes `originalQuery`, `correctedQuery`, `kind`, `source`, `confidence`, and named evidence |

The work `id`/`workId` and `workIdentity` identify a deterministic resolved
search group. They are not a permanent or globally authoritative bibliographic
record.

### Response — No Results (200)

```json
{
  "recommended": null,
  "alternatives": [],
  "error": "No results found"
}
```

`sourceStatus` is returned on every successful search. A provider failure sets that provider's `ok` to `false` and supplies a stable `errorCode` plus a safe `error` message, while successful providers still return results. An empty result set therefore represents a successful empty search only when the selected source status is healthy.

### Response — No Quality Results (200)

```json
{
  "recommended": null,
  "alternatives": [],
  "results": [],
  "error": "No quality versions found, try different search"
}
```

### Response — Request Error (400)

```json
{
  "error": "Search query is required"
}
```

Provider failures are represented in `sourceStatus` on a successful search response when another selected provider can respond. The server does not expose raw upstream search errors.

### Relevance Scoring

| Signal | Points | Description |
|--------|--------|-------------|
| Exact normalized title match | +200 | Query matches title after stripping subtitles, parentheticals, punctuation |
| Normalized title contains query | +150 | Normalized title includes full normalized query |
| Raw title contains query | +100 | Original title includes query string |
| Bounded title typo | +175 | One meaningful token differs by one accepted edit |
| Bounded author typo | +90 | One author token differs by one accepted edit |
| Word-level match | Up to +80 | Proportion of query words found in title (partial matches counted) |
| Author match | +40 | Any query word matches an author word |
| Title length penalty | −10 | If title is >3× longer than query (penalizes noisy titles) |

### Quality Score (1–5 stars)

| Score | Meaning |
|-------|---------|
| 5.0 | EPUB with complete metadata |
| 4.0–4.5 | EPUB with minor gaps, or MOBI/AZW3 |
| 3.0–3.5 | Acceptable but not ideal |
| 2.0–2.5 | Small file or PDF format |
| 1.0 | Unknown format or very small file |

### Work Grouping

Work resolution uses deterministic named rules plus narrowly bounded typo
evidence rather than general similarity thresholds:

1. A shared trusted Open Library work key with no semantic conflict.
2. Exact canonical title plus the same known primary creator.
3. An official subtitle alias with the same creator and no semantic conflict.
4. Across different sources only, one title token may have a one-edit typo when
   the primary creator matches exactly or through an established alias. An
   exact title may similarly tolerate a missing character or adjacent
   transposition in one creator token. Short-title changes, author
   substitutions, two-field fuzzy matches, and ambiguous author matches are
   rejected.
5. A bounded publisher/imprint title alias with the same creator, language and
   publisher plus independent cross-source corroboration. A single publisher
   head word additionally requires an overlapping checksum-valid ISBN.

ISBN never determines a work by itself; providers can reuse a collection ISBN
on constituent volumes. Missing covers, matching covers, year, format, and size
do not affect work identity. Conflicting languages and numbered volumes remain
separate. Contextual one-deletion signatures generate candidates only; a bounded
Damerau-Levenshtein decision and hard bibliographic conflicts determine whether
records merge.

Within each work, the best downloadable version is selected by:

1. Format priority: EPUB > MOBI/AZW3 > PDF
2. Most recent publication year
3. Largest file size

The clean display title is selected independently from the downloadable version.
Automatic import fallback is further divided by language, volume, abridgement,
adaptation, derivative status, collection scope, and textual version. Unknown,
explicitly unabridged, and abridged states remain distinct for automatic retry.
The server revalidates every client-supplied alternative. Works with all versions
scoring below quality 2 are filtered out.

Operators can temporarily restore the previous narrow behavior with
`SEARCH_WORK_GROUPING_MODE=exact`, which disables typo and publisher-alias
resolution. `SEARCH_GROUP_DEBUG=1` writes local structured resolution decisions
without sending telemetry.

---

## POST /api/download

Import a selected provider version, validate it, extract metadata, and add it to
the library. Providers with unverified rights status require the persisted
operator acknowledgement. A successful request creates an asynchronous import
job and returns HTTP 202.

### Request

```json
{
  "hash": "abc123def456",
  "source": "annas",
  "filename": "hitchhikers_guide.epub",
  "title": "The Hitchhiker's Guide to the Galaxy",
  "author": "Douglas Adams",
  "language": "en",
  "publisher": "Pan Books",
  "isbn": ["9780330508117"],
  "openLibraryWorkKey": "works/OL262758W",
  "sourceUrl": "https://provider.example/item/abc123def456",
  "rightsStatus": "unverified"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hash` | string | Yes | Safe provider item identifier |
| `source` | string | No | Provider ID; defaults to `annas` for compatibility |
| `filename` | string | Yes | Desired filename for the imported version |
| `title` | string | No | Book title (fallback if EPUB metadata is missing) |
| `author` | string | No | Author name (fallback) |
| `language` | string | No | Selected version language and fallback constraint |
| `publisher` | string | No | Publisher/imprint evidence used for safe fallback validation |
| `isbn` | string[] | No | Checksum-valid identifiers used only as corroborating evidence |
| `openLibraryWorkKey` | string | No | Trusted work identity when returned by search |
| `sourceUrl` | string | No | Provider item URL; stored without query or fragment |
| `rightsStatus` | string | No | Rights-status label reported with the search result |
| `reportedRights` / `reportedLicense` | string | No | Provider-reported metadata, when present |
| `alternatives` | array | No | Other versions eligible for bounded validation fallback; each carries its own identity metadata |

### Response — Accepted (202)

```json
{
  "jobId": "generated-job-id"
}
```

Poll `GET /api/download/:jobId/status` or subscribe to `GET /api/download/:jobId/events`. The completed job contains `success`, `bookId`, the public book record, provenance, validation, and whether an alternative version was used.

### Response — Validation Failed (400)

```json
{
  "error": "Downloaded file is corrupted or invalid",
  "details": ["Insufficient content for audiobook: only 5000 chars total"],
  "warnings": [],
  "suggestion": "Try downloading a different version from the search results"
}
```

### Response — Missing Parameters (400)

```json
{
  "error": "Hash and filename required"
}
```

### Side Effects

- Imported source or compact playback artifact saved to `cache/`
- Book metadata saved to `data/books.json`
- Corrupted files automatically cleaned up on validation failure

---

## POST /api/upload

Upload a book file from the user's device. EPUB, MOBI/Kindle, and PDF are parsed inside Xandrio with bundled Node dependencies; Calibre is not required. By default, MOBI/Kindle/PDF sources are extracted to compact `.xbook.json` playback artifacts and the original source file is deleted after validation.

### Request

**Content-Type:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `epub` | file | Yes | Book file, max 250 MB source upload |

### Example (curl)

```bash
curl -X POST http://localhost:8181/api/upload \
  -F "epub=@/path/to/book.mobi"
```

### Response — Success (200)

```json
{
  "success": true,
  "bookId": "a1b2c3d4e5f6...",
  "book": {
    "id": "a1b2c3d4e5f6...",
    "title": "My Book",
    "author": "Author Name",
    "language": "en",
    "filename": "a1b2c3d4e5f6.xbook.json",
    "path": "/home/user/audiobook-player/cache/a1b2c3d4e5f6.xbook.json",
    "uploadedFile": "My Book.mobi",
    "sourceFormat": "MOBI",
    "sourceDeletedAfterExtract": true,
    "originalFilename": "My Book.mobi",
    "addedAt": "2026-02-05T12:00:00.000Z"
  },
  "validation": {
    "valid": true,
    "warnings": []
  }
}
```

### Response — Duplicate (400)

```json
{
  "error": "Book already exists in library",
  "existingBookId": "existing_id_here"
}
```

### Response — Validation Failed (400)

```json
{
  "error": "Book validation failed",
  "details": "No readable content - book is empty or unsupported",
  "warnings": [],
  "suggestion": "Please check your book file and try again"
}
```

### Response — File Too Large (400)

```json
{
  "error": "File too large",
  "details": "Maximum upload size is 250MB"
}
```

### Constraints

- Accepted uploads: `.epub`, `.mobi`, `.prc`, `.azw`, `.azw3`, `.pdf`
- Maximum 250 MB source upload
- EPUB storage keeps the source file
- MOBI/Kindle/PDF storage defaults to compact `.xbook.json`; set `XBOOK_DELETE_SOURCE_AFTER_EXTRACT=false` to retain original source files
- Scanned/image-only PDFs require OCR; set `XANDRIO_PDF_OCR=true` with OCRmyPDF/Tesseract installed to retry them during import
- Duplicate detection by title + author match

---

## GET /api/library

List all books in the library.

### Response (200)

```json
{
  "books": [
    {
      "id": "abc123",
      "title": "The Hitchhiker's Guide to the Galaxy",
      "author": "Douglas Adams",
      "publisher": "Pan Books",
      "publishedDate": 1979,
      "description": "A wholly remarkable book",
      "subjects": ["Science fiction"],
      "language": "en",
      "filename": "hitchhikers_guide.epub",
      "path": "/home/user/audiobook-player/cache/hitchhikers_guide.epub",
      "addedAt": "2026-02-05T12:00:00.000Z",
      "chapter1Ready": true,
      "preloadedThrough": 2
    }
  ]
}
```

---

## DELETE /api/book/:bookId

Delete a book, its EPUB file, cached cover, all cached audio chapters, and playback position.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier (URL path parameter) |

### Response — Success (200)

```json
{
  "success": true,
  "message": "Book deleted successfully"
}
```

### Response — Not Found (404)

```json
{
  "error": "Book not found"
}
```

### What Gets Deleted

1. EPUB file at `book.path`
2. Cover image: `cache/{bookId}_cover.jpg`
3. All audio files matching `cache/{bookId}_chapter*.mp3`
4. Entry in `data/books.json`
5. Entry in `data/positions.json`

---

## GET /api/book/:bookId

Get book details and extracted chapter list.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier |

### Response (200)

```json
{
  "book": {
    "id": "abc123",
    "title": "The Hitchhiker's Guide to the Galaxy",
    "author": "Douglas Adams",
    "language": "en"
  },
  "chapters": [
    {
      "index": 0,
      "title": "Cover",
      "text": "The Hitchhiker's Guide...",
      "type": "cover",
      "originalIndex": 0
    },
    {
      "index": 1,
      "title": "Chapter 1",
      "text": "Far out in the uncharted backwaters...",
      "type": "chapter",
      "originalIndex": 1
    }
  ],
  "hasCover": false
}
```

### Chapter Types

| Type | Description |
|------|-------------|
| `cover` | Book cover page |
| `copyright` | Copyright/publisher information |
| `toc` | Table of contents |
| `frontmatter` | Preface, foreword, introduction, prologue |
| `author` | About the author section |
| `chapter` | Numbered chapter (e.g., "Chapter 1") |
| `divider` | Short divider section (< 300 chars) |
| `content` | Default type — everything else |

---

## GET /api/cover/:bookId

Get the cover image for a book. Extracts from EPUB on first request and caches
the validated image. Generic lookup falls back to Open Library before Google
Books.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier |

### Response — Success (200)

**Content-Type:** `image/jpeg` or `image/png`

Returns a structurally validated cover image. The response type is determined
from the JPEG/PNG bytes, not the `.jpg` cache filename; invalid or truncated
cached files are deleted and re-resolved rather than served.

### Response — No Cover (404)

```json
{
  "error": "No cover found"
}
```

### Cover Resolution Order

1. Check cache: `cache/{bookId}_cover.jpg`
2. Extract from EPUB metadata cover image
3. Search Open Library API by title (then title + author)
4. Search Open Library, then use Google Books only as a last-resort fallback
5. Return 404 if all fail

---

## GET /api/search-cover/:key

Resolve a server-registered search-result cover. `key` is an opaque 32-hex
descriptor key returned in a search result's same-origin `coverUrl`.

| Query parameter | Description |
|---|---|
| `retry=1` | Bypass a transient negative result for this request. Clients make at most one delayed retry. |

Successful image responses are cacheable. Misses return `404` with
`Cache-Control: private, no-store` and `Retry-After: 3`; unexpected resolution
errors return `503` with the same failure headers.

---

## GET /api/audio/:bookId/:chapterIndex

Get or generate audio for a specific chapter. Serves a complete chapter MP3 with HTTP range request support. This endpoint is backward-compatible: under the hood, it now uses the chunked TTS system for generation.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier |
| `chapterIndex` | integer | Zero-based chapter index |

### Response — Success (200 or 206)

**Content-Type:** `audio/mpeg`

Returns MP3 audio data. Supports HTTP Range requests for seeking:

- **200** — Full file response (no Range header sent)
- **206** — Partial content (Range header sent)

### Response Headers (Range)

```
Content-Range: bytes 0-1023/512000
Accept-Ranges: bytes
Content-Length: 1024
Content-Type: audio/mpeg
```

### Response — Not Found (404)

```json
{
  "error": "Book not found"
}
```
or
```json
{
  "error": "Chapter not found"
}
```

### Audio Resolution Order

The endpoint checks for audio in this order:

1. **Legacy monolithic MP3** — `cache/{bookId}_chapter{N}.mp3` (backward compat with pre-chunked audio)
2. **Concatenated chapter MP3** — `cache/{bookId}_ch{N}.mp3` (from chunked system)
3. **All chunks ready** — if a manifest exists with all chunks complete, concatenates them via ffmpeg and serves the result
4. **Generate from scratch** — triggers chunked TTS generation, waits for all chunks to complete, concatenates, and serves

### Notes

- First request for a chapter triggers chunked TTS generation (may take 10–60 seconds depending on chapter length).
- Subsequent requests are served from cache instantly.
- The voice is automatically selected based on the book's `language` field.
- TTS timeout is 120 seconds per chunk (not per chapter).
- For faster first-audio playback, use the [chunk manifest API](#get-apichunksbookidchapterindexmanifest) instead — it returns chunks progressively as they're generated.

---

## GET /api/audio-chunked/:bookId/:chapterIndex

Generate or serve chapter audio using the chunked TTS system. Splits text into ~4,000-character chunks and generates them individually for faster first-audio time.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier |
| `chapterIndex` | integer | Zero-based chapter index |

### Response — Success (200)

```json
{
  "ready": true,
  "firstChunk": "/api/serve-chunk/abc123_ch0_chunk0.mp3",
  "totalChunks": 7,
  "generationTime": 3542
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ready` | boolean | Always `true` on success |
| `firstChunk` | string | URL path to the first audio chunk |
| `totalChunks` | integer | Total number of chunks for this chapter |
| `generationTime` | integer | Milliseconds to generate first chunk (only on fresh generation) |

### Response — Not Found (404)

```json
{
  "error": "Book not found"
}
```

---

## GET /api/serve-chunk/:filename

Validate a legacy chunk filename and redirect it to the canonical orchestrated chunk route. The legacy hash cannot identify its historical tier, so current playback policy safely re-resolves tier and readiness instead of serving a possibly stale cache file directly.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `filename` | string | Chunk filename matching `{bookId}[_tts{variantHash}]_ch{N}_chunk{M}.mp3` |

### Response — Valid Filename (307)

Redirects to `/api/chunks/:bookId/:chapterIndex/:chunkIndex`, which applies current tier, status, and cache policy.

### Response — Invalid Filename (403)

```json
{
  "error": "Invalid chunk filename"
}
```

### Filename Validation

Only filenames matching this exact regex are accepted:

```
/^([A-Za-z0-9][A-Za-z0-9_-]{0,127}?)(?:_tts[a-f0-9]{10})?_ch\d+_chunk\d+\.mp3$/
```

Examples:
- ✅ `book_one_tts0123456789_ch0_chunk0.mp3`
- ✅ `deadbeef01_ch12_chunk99.mp3`
- ❌ `../etc/passwd`
- ❌ `book.mp3`

---

## GET /api/chunks/:bookId/:chapterIndex/manifest

Get the chunk manifest for a chapter. Triggers chunked TTS generation if no manifest exists yet. This is the primary endpoint used by the `ChunkPlayer` frontend for progressive audio playback.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier |
| `chapterIndex` | integer | Zero-based chapter index |

### Response — Success (200)

```json
{
  "bookId": "abc123def456",
  "chapterIndex": 3,
  "totalChunks": 7,
  "textLength": 25432,
  "chunks": [
    {
      "index": 0,
      "status": "ready",
      "textLength": 3998,
      "duration": null,
      "url": "/api/chunks/abc123def456/3/0"
    },
    {
      "index": 1,
      "status": "generating",
      "textLength": 3872,
      "duration": null,
      "url": "/api/chunks/abc123def456/3/1"
    },
    {
      "index": 2,
      "status": "queued",
      "textLength": 4001,
      "duration": null,
      "url": "/api/chunks/abc123def456/3/2"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `totalChunks` | integer | Total number of chunks for this chapter |
| `textLength` | integer | Total text length in characters |
| `chunks[].status` | string | One of: `pending`, `queued`, `generating`, `ready`, `error` |
| `chunks[].url` | string | URL path to fetch this chunk's MP3 |
| `chunks[].textLength` | integer | Character count for this chunk |
| `chunks[].duration` | number\|null | Duration in seconds (populated after generation) |

### Response — Not Found (404)

```json
{
  "error": "Book not found"
}
```
or
```json
{
  "error": "Chapter not found"
}
```

### Side Effects

- If no manifest exists, triggers chunked generation for the chapter at `immediate` priority.
- **Look-ahead:** Automatically pre-queues the next chapter at `background` priority for seamless chapter transitions.

---

## GET /api/chunks/:bookId/:chapterIndex/status

Get the generation status for a chapter's chunks. If the in-memory manifest is absent, the server reconstructs it from the chapter text and compatible durable chunk artifacts. This inspection does not enqueue new generation work.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier |
| `chapterIndex` | integer | Zero-based chapter index |

### Response — Success (200)

```json
{
  "totalChunks": 7,
  "readyChunks": 4,
  "errorChunks": 0,
  "status": "generating",
  "servedTier": "instant",
  "premiumReady": false,
  "recovery": { "quarantined": false }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `totalChunks` | integer | Total chunks for this chapter |
| `readyChunks` | integer | Number of chunks that have finished generating |
| `errorChunks` | integer | Number of chunks that failed |
| `status` | string | Overall status: `ready` (all done), `generating` (in progress), or `error` (at least one failed) |
| `servedTier` | string\|omitted | Resolved playback tier when tiered playback is active |
| `premiumReady` | boolean\|omitted | Whether premium audio is complete when a premium voice is active |
| `recovery.quarantined` | boolean | Whether automatic recovery paused after repeated failures |
| `recovery.attempts` | integer\|omitted | Failed recovery attempts for a quarantined variant |
| `recovery.message` | string\|omitted | User-safe recovery guidance |

---

## GET /api/chunks/:bookId/:chapterIndex/:chunkIndex

Serve an individual chunk MP3 file. Supports HTTP Range requests for seeking within a chunk.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier |
| `chapterIndex` | integer | Zero-based chapter index |
| `chunkIndex` | integer | Zero-based chunk index within the chapter |

### Response — Success (200 or 206)

**Content-Type:** `audio/mpeg`

Returns the chunk MP3 data. Supports HTTP Range requests:

- **200** — Full chunk file
- **206** — Partial content (Range header sent)

### Response — Generating (202)

Returned when the chunk exists in the manifest but hasn't finished generating yet:

```json
{
  "status": "generating"
}
```

### Response — Error (500)

Returned when chunk generation failed:

```json
{
  "status": "error",
  "error": "Chunk generation failed"
}
```

### Response — Not Found (404)

```json
{
  "error": "Chunk not found"
}
```

---

## GET /api/queue/status

Get the current status of the TTS generation queue.

### Response (200)

```json
{
  "active": 2,
  "queued": 5,
  "completed": 42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `active` | integer | Number of TTS jobs currently generating |
| `queued` | integer | Number of jobs waiting in the queue |
| `completed` | integer | Total jobs completed since server start |

---

## POST /api/position

Save the current playback position for a book.

### Request

```json
{
  "bookId": "abc123",
  "chapterIndex": 5,
  "timestamp": 142.7
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bookId` | string | Yes | Book identifier |
| `chapterIndex` | integer | Yes | Current chapter index |
| `timestamp` | number | Yes | Playback position in seconds |

### Response — Success (200)

```json
{
  "success": true,
  "position": {
    "userId": "default",
    "bookId": "abc123",
    "chapterIndex": 5,
    "timestamp": 142.7,
    "wasPlaying": false,
    "finished": false,
    "updatedAt": "2026-02-05T12:30:00.000Z",
    "updatedAtMs": 1770294600000
  }
}
```

### Storage

Positions are stored in `data/positions.json`:

```json
{
  "users": {
    "default": {
      "abc123": {
        "chapterIndex": 5,
        "timestamp": 142.7,
        "wasPlaying": false,
        "finished": false,
        "updatedAt": "2026-02-05T12:30:00.000Z",
        "updatedAtMs": 1770294600000
      }
    }
  }
}
```

Positions are scoped by sync user. Legacy flat position files are migrated
under the `default` user when loaded.

---

## GET /api/position/:bookId

Get the saved playback position for a book.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier |

### Response — Position Found (200)

```json
{
  "position": {
    "chapterIndex": 5,
    "timestamp": 142.7,
    "updatedAt": "2026-02-05T12:30:00.000Z"
  }
}
```

### Response — No Position Saved (200)

```json
{
  "position": null
}
```

---

## POST /api/refresh-metadata/:bookId

Re-extract metadata from the EPUB file and re-enrich from Open Library. Useful if metadata was incomplete on initial download.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier |

### Response — Success (200)

```json
{
  "success": true,
  "book": {
    "id": "abc123",
    "title": "The Hitchhiker's Guide to the Galaxy",
    "author": "Douglas Adams",
    "publisher": "Pan Books",
    "publishedDate": 1979,
    "description": "Updated description from Open Library",
    "subjects": ["Science fiction", "Humor"],
    "language": "en",
    "metadataRefreshed": "2026-02-05T14:00:00.000Z"
  }
}
```

### Response — Not Found (404)

```json
{
  "error": "Book not found"
}
```

### Metadata Priority

1. EPUB embedded metadata (highest priority)
2. Open Library API data (fills gaps)
3. Existing stored values (preserved if neither source provides data)

---

## POST /api/validate/:bookId

Run the full EPUB validation pipeline on an existing book in the library. Useful for diagnosing issues with books that were added before validation was implemented.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | string | Book identifier |

### Response — Success (200)

```json
{
  "bookId": "abc123",
  "title": "The Hitchhiker's Guide to the Galaxy",
  "validation": {
    "valid": true,
    "errors": [],
    "warnings": [
      "Found 4 consecutive empty/short chapters. Audio playback may have noticeable gaps."
    ]
  }
}
```

### Validation Checks

1. File exists on disk
2. File size ≥ 10 KB
3. Valid ZIP structure
4. EPUB parseable by `epub` library
5. Has table of contents
6. Has readable flow (chapters)
7. Content depth:
   - Total text ≥ 50,000 characters
   - ≥ 60% of chapters have ≥ 500 characters of content
   - Warns on ≥ 3 consecutive empty/short chapters

### Response — Not Found (404)

```json
{
  "error": "Book not found"
}
```

---

## Error Handling

All endpoints return errors in a consistent format:

```json
{
  "error": "Human-readable error message"
}
```

Some endpoints include additional fields:

```json
{
  "error": "Main error message",
  "details": "More specific information or array of issues",
  "suggestion": "What the user can do to resolve it",
  "warnings": ["Non-fatal issues to be aware of"]
}
```

### Common HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 206 | Partial Content (audio range requests) |
| 400 | Bad request (missing parameters, validation failure) |
| 403 | Forbidden (invalid chunk filename) |
| 404 | Resource not found |
| 500 | Server error |
