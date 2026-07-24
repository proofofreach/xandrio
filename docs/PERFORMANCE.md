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
