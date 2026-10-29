# Performance Notes

This document records measured optimization decisions for the TTS and book normalization pipeline. Re-run with:

```bash
npm run benchmark:pipeline
npm run benchmark:pdf -- --input cache/<book-id>.xbook.json
TTS_BENCH_ITERATIONS=2 npm run benchmark:tts
npm test
```

## Current Recommendations

- Default to Edge TTS for speed. On this machine, Edge remains faster in raw synthesis latency.
- Kokoro is the higher-quality local path. Keep one shared model, warmed voices, and one queued synthesis worker; request WAV by default so shared mastering performs the only MP3 encode.
- Kokoro `quality`, `balanced`, and `fast` profiles tune chunk sizing and cache variants; current benchmarks do not show a reliable audible quality difference between those profiles.
- Cache parsed book artifacts aggressively in memory, but validate with source/cache mtime and file size.
- Coalesce in-flight cache/extraction requests so simultaneous playback requests share one backend parse.
- Use stable mastering calibration rather than per-chunk loudness normalization. Defaults measured from the checked-in July 2026 references are Edge Andrew `+3 dB`, Kokoro `af_heart` `+9.5 dB`, and Chatterbox Original `+2.5 dB`, followed by a `-2.5 dBFS` sample-peak limiter to preserve headroom through MP3 encoding. `scripts/audio-calibration-fixtures.json` records the exact source hashes, voices, gains, and Edge calibration passage; `npm run verify:audio:ci` rejects missing or changed fixtures and verifies every mastered result against the acoustic policy. Override with `EDGE_MASTERING_GAIN_DB`, `KOKORO_MASTERING_GAIN_DB`, or `CHATTERBOX_MASTERING_GAIN_DB` only after measuring a replacement corpus and updating that manifest.

## Measured Results

Latest representative run:

| Path | Baseline | Optimized |
| --- | ---: | ---: |
| 150-chunk manifest cache probing | ~697ms | ~3ms |
| Settings reads, 5000 lookups | ~51ms | ~0ms |
| Chapter cache JSON parse, 1000 reads | ~533ms | ~0ms |
| XBook artifact JSON parse, 1000 reads | ~462ms | ~0ms |
| Repeated extraction reuse, 5 uses | ~605ms | ~121ms |
| File identity checks, 5000 reads | ~8ms | ~0ms |
| In-flight CPU/parse duplicate work, 8 requests | ~16ms / 56 backend calls | ~2ms / 7 backend calls |

Live TTS benchmark from the first optimization pass:

| Provider | Avg ms | P95 ms | Avg RTF |
| --- | ---: | ---: | ---: |
| Kokoro `am_michael` | ~5965 | ~7870 | 0.338 |
| Edge `en-US-AndrewMultilingualNeural` | ~577 | ~749 | 0.038 |

Kokoro-specific follow-up benchmark, warm server, 1 iteration per sample:

| Kokoro path | Avg ms | P95 ms | Avg RTF | Notes |
| --- | ---: | ---: | ---: | --- |
| Existing server, WAV to Node ffmpeg | 3459 | 5354 | 0.163 | Baseline before this pass |
| Shared model + warmed voices, WAV fallback | 3159 | 4848 | 0.143 | Isolates server/model changes |
| Shared model + warmed voices + direct MP3 | 2952 | 4344 | 0.138 | Avoids Node-side WAV conversion |
| Direct MP3 + 8 torch threads | 2778 | 4470 | 0.124 | Best average on this machine; long sample varied slightly |

## Rejected Optimizations

- Removing ffmpeg `-ar 24000 -ac 1` from Kokoro WAV-to-MP3 conversion was not measurable: both tested variants averaged ~78ms for a 30s synthetic WAV.
- Parallel EPUB spine extraction did not improve the local cached EPUB corpus, so it was not retained.

## Implemented Optimizations

- Parallel manifest file probing in `ChunkedTTS`.
- Per-job TTS voice snapshots to avoid reading mutable settings during queue execution.
- Short-TTL settings cache for server hot paths.
- In-memory chapter cache for `.chapters.json`.
- Compact `.xbook.json` artifacts for non-EPUB sources.
- In-memory XBook cache keyed by path, mtime, and size.
- Source extraction cache keyed by path, mtime, and size.
- Short-TTL file identity cache for repeated stat-heavy cache validation.
- In-flight coalescing for XBook reads, chapter cache reads, and source chapter extraction.
- Shared one Kokoro `KModel` across language pipelines instead of loading one model per pipeline.
- Preloaded common Kokoro voices at server startup to reduce first-use voice switching delay.
- Direct Kokoro MP3 responses with WAV fallback for older servers.
- Configurable Kokoro server host/port, response format, preloaded voices, and torch thread count.
- Queue-level output-path deduplication so repeated prepare/playback calls do not regenerate the same chunk.

## Playback and app responsiveness (2026-10-29)

The playback changes keep the continuous online transport, native iOS HLS,
single audio element, scoped offline storage, and existing worker activation
rules. They target waiting and repeated work in the current implementation.

### Implemented behavior

- The service worker serves an installed shell from its own complete versioned
  cache immediately. Ordinary requests do not overwrite individual cached
  modules. A warm boot checks for an already waiting worker locally, activates
  only during the idle boot window when no other client blocks it, and reloads
  after activation. Otherwise the update check runs in the background.
- Deployment and authentication reads overlap and have three-second foreground
  budgets. Local client settings are available before the background profile
  refresh finishes. These are explicit read budgets; uploads and generation
  requests keep their existing behavior.
- Book metadata, saved position, and per-book settings reads begin together.
  Superseding an open aborts its reads. Metadata can fall back to a valid,
  account-scoped offline snapshot after 1.5 seconds; a network-only book gets
  six seconds. Position and settings reads have 1.5-second budgets. An observed
  401, 403, or 404 remains authoritative. A late response cannot seek a newer
  playback session.
- `GET /api/book/:id?playback=1` returns short chapter previews plus full text
  lengths. The default response still includes full chapter text. Pronunciation
  repair fetches a bounded excerpt on demand and requires both stored and
  extracted chapter structure identities to match the request.
- Finalized local chapter inputs seek before decoding, with one second of
  decoder preroll. Logical skipped PCM remains included in chapter duration
  accounting. Offsets at or beyond EOF use the conservative decode path when
  needed so they cannot consume the following chapter's audio.
- Continuous streams skip empty or unspeakable structural entries, preserving
  canonical chapter indexes and zero durations for those entries. Trailing
  structural entries no longer leave a timeline unfinished.
- HLS playlist refreshes retain identity/access checks and reuse the admitted
  session. The expensive readiness/seek gate runs for a new or replacement
  session. Session retention during request-silent iOS playback is unchanged.
- Completed, fully mapped timelines stop polling. Incomplete paused timelines
  back off and refresh on play. Downloaded/finite next-chapter prewarming uses
  remaining wall-clock time at the selected playback rate.
- Each library render or row refresh reads one current offline manifest
  snapshot. The next refresh reads a new snapshot so deletions and account
  changes remain visible.
- Queue status requests cannot overlap, abort on disposal, have a ten-second
  deadline, and use a thirty-second cadence when idle, failed, or paused.
  Queue-only preparation status returns marked estimates while duration probes
  are unresolved; exact callers still await the shared measurements. Cache keys
  retain audio path, file size, and modification time.
- The existing browser playback ledger records a per-intent attempt ID and
  elapsed time from explicit Play/Resume through metadata, source assignment,
  native `playing`, and first advancing playhead. The last milestone stays in
  memory; it does not add synchronous storage writes to `timeupdate`. These
  events describe browser progress, not verified speaker audibility.

### Measured seek result

On the development Linux environment with Node 24 and ffmpeg, seeking to 1,700
seconds in a synthetic 30-minute, 24 kHz mono, 160 kbps MP3 produced these
first-useful-PCM times across three trials:

| Decode path | Trials | Median |
| --- | --- | ---: |
| Decode and discard the full prefix | 3,375 / 3,492 / 3,640 ms | 3,492 ms |
| Input seek with one-second preroll | 85 / 79 / 94 ms | 85 ms |

Both paths emitted 4,800,000 PCM bytes and accounted for 81,600,000 skipped
bytes. This is an isolated decoder result, not a measured 41x improvement in
end-to-end app startup. The regression suite also compares decoded PCM content
for MP3 and WAV at fractional, middle, near-end, EOF, and beyond-EOF positions.

### Focused verification

```bash
node test/test-finalized-audio-seek.js
node test/test-playback-orchestrator.js
node test/test-progressive-audio-stream.js
node test/test-foreground-read-bounds.js
node test/test-book-open-commit.js
node test/test-playback-book-metadata.js
node test/test-library-offline-snapshot.js
node test/test-preparation-status-cached-duration.js
node test/test-single-file-player.js
node test/test-queue-status.js
node test/test-service-worker-media-routing.js
node test/test-app-shell-versions.js
```

Device-level acceptance still needs installed iOS testing: cold/warm launch,
slow or interrupted connectivity, downloaded playback, 1x/2x/3x transitions,
locked-screen continuation, and a waiting worker update with another window
open. Use the intent ledger to compare first-playing and first-playhead times
separately from server encoding timings.

Optional-view bundling, smaller logo assets, shared encoded transport
derivatives, delivery bitrate changes, GPU/CPU scheduler separation, and
speculative production limits remain separate measured follow-ups. They are
not prerequisites for these waiting, correctness, and polling fixes.

## PDF extraction benchmark

Run PDF quality checks before spending TTS time:

```bash
npm run benchmark:pdf -- --input cache/<book-id>.xbook.json --output /tmp/pdf-report.json
npm run benchmark:pdf -- --input cache/source.pdf --golden fixtures/source-golden.json
npm run benchmark:pdf -- --input cache/scanned.pdf --ocr --output /tmp/scanned-pdf-report.json
```

The PDF benchmark scores extracted text/chunk candidates, not audio. That is intentional:
PDF failures usually come from reading order, headers/footers, OCR artifacts, bad metadata,
or unsafe chapter inference before TTS starts.

Scanned PDFs are detected by low extracted characters per page. Runtime imports can retry
those files through OCRmyPDF when `XANDRIO_PDF_OCR=true`; benchmark runs can add OCR
candidates with `--ocr` so OCR output can be checked before TTS generation.

## Kindle extraction benchmark

Run MOBI/AZW/AZW3 quality checks before spending TTS time:

```bash
npm run benchmark:kindle -- --input cache/source.mobi --output /tmp/kindle-report.json
npm run benchmark:kindle -- --input cache/source.azw3 --output /tmp/kindle-report.json
```

The Kindle benchmark reports parser candidate status, TOC/spine counts, text length,
quality score, malformed/DRM status, and section previews.

Optional golden files can include:

```json
{
  "mustInclude": ["phrase that must appear"],
  "mustNotInclude": ["repeated header"],
  "orderedPhrases": ["first phrase", "later phrase"],
  "chapterTitles": ["Chapter 1"]
}
```

Use TTS spot checks only after the text/chunk benchmark passes.
