#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const ChunkedTTS = require('../lib/chunked-tts');

const ITERATIONS = Number(process.env.PIPELINE_BENCH_ITERATIONS || 7);
const STAT_DELAY_MS = Number(process.env.PIPELINE_BENCH_STAT_DELAY_MS || 2);
const SETTINGS_READS = Number(process.env.PIPELINE_BENCH_SETTINGS_READS || 5000);
const CHAPTER_CACHE_READS = Number(process.env.PIPELINE_BENCH_CHAPTER_READS || 1000);
const EXTRACTION_REUSES = Number(process.env.PIPELINE_BENCH_EXTRACTION_REUSES || 5);
const STAT_READS = Number(process.env.PIPELINE_BENCH_STAT_READS || 5000);
const INFLIGHT_REQUESTS = Number(process.env.PIPELINE_BENCH_INFLIGHT_REQUESTS || 8);

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function summary(name, values, extra = {}) {
  return {
    name,
    iterations: values.length,
    avgMs: Math.round(mean(values)),
    p50Ms: Math.round(percentile(values, 50)),
    p95Ms: Math.round(percentile(values, 95)),
    minMs: Math.round(Math.min(...values)),
    maxMs: Math.round(Math.max(...values)),
    ...extra
  };
}

function textForChunks(chunks, charsPerChunk = 620) {
  return Array.from(
    { length: chunks },
    (_, i) => `Paragraph ${i}. ${'x'.repeat(charsPerChunk)}.`
  ).join('\n\n');
}

async function benchManifest({ chunks, parallel }) {
  const queue = { on() {}, async enqueue() { return Math.random().toString(16).slice(2); } };
  const tts = new ChunkedTTS(os.tmpdir(), queue, { chunkSize: 600 });
  tts._fileExists = async () => new Promise(resolve => {
    setTimeout(() => resolve(false), STAT_DELAY_MS);
  });

  if (!parallel) {
    tts._buildManifest = async function buildManifestSequential(bookId, chapterIndex, chunkTexts) {
      const key = this._manifestKey(bookId, chapterIndex);
      const textLength = chunkTexts.reduce((sum, t) => sum + t.length, 0);
      const manifestChunks = [];
      for (let i = 0; i < chunkTexts.length; i++) {
        const p = this.chunkPath(bookId, chapterIndex, i);
        const exists = await this._fileExists(p);
        manifestChunks.push({
          index: i,
          status: exists ? 'ready' : 'pending',
          path: exists ? p : null,
          textLength: chunkTexts[i].length,
          duration: null,
          jobId: null
        });
      }
      const manifest = {
        bookId,
        chapterIndex,
        totalChunks: chunkTexts.length,
        chunks: manifestChunks,
        textLength,
        estimatedTotalDuration: null
      };
      this.manifests.set(key, manifest);
      return manifest;
    };
  }

  const text = textForChunks(chunks);
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await tts.generateChapter('benchbook', i, text, 'en', 'immediate', {
      priorityForChunk: () => 'background',
      voice: 'kokoro:am_michael'
    });
    times.push(performance.now() - start);
  }

  return summary(parallel ? 'manifest-parallel' : 'manifest-sequential', times, {
    chunks,
    statDelayMs: STAT_DELAY_MS
  });
}

function benchSettingsRead() {
  const settingsPath = path.join(os.tmpdir(), `xandrio-settings-bench-${process.pid}.json`);
  fs.writeFileSync(settingsPath, JSON.stringify({ voice: 'kokoro:am_michael' }));
  try {
    const readTimes = [];
    const snapshotTimes = [];
    for (let i = 0; i < ITERATIONS; i++) {
      let voice;
      let start = performance.now();
      for (let j = 0; j < SETTINGS_READS; j++) {
        voice = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).voice;
      }
      readTimes.push(performance.now() - start);

      start = performance.now();
      const snapshot = voice;
      for (let j = 0; j < SETTINGS_READS; j++) {
        voice = snapshot;
      }
      snapshotTimes.push(performance.now() - start);
    }

    return [
      summary('settings-read-per-job', readTimes, { reads: SETTINGS_READS }),
      summary('settings-snapshot', snapshotTimes, { reads: SETTINGS_READS })
    ];
  } finally {
    fs.unlinkSync(settingsPath);
  }
}

function makeChapterCache(chapters = 250, charsPerChapter = 2200) {
  return {
    _cacheVersion: 3,
    chapters: Array.from({ length: chapters }, (_, index) => ({
      index,
      originalIndex: index,
      title: `Chapter ${index + 1}`,
      text: `Chapter ${index + 1}\n\n${'x'.repeat(charsPerChapter)}`,
      estimatedDuration: 120,
      type: 'content'
    }))
  };
}

function makeXBookArtifact(chapters = 250, charsPerChapter = 2200) {
  return {
    _xbookVersion: 1,
    id: 'bench-xbook',
    sourceFormat: 'PDF',
    sourceFilename: 'bench.pdf',
    sourceSize: 5 * 1024 * 1024,
    sourceDeleted: true,
    extractedAt: new Date(0).toISOString(),
    metadata: {
      title: 'Benchmark Book',
      author: 'Benchmark Author',
      language: 'en'
    },
    chapters: makeChapterCache(chapters, charsPerChapter).chapters
  };
}

function benchChapterCacheRead() {
  const cachePath = path.join(os.tmpdir(), `xandrio-chapters-bench-${process.pid}.json`);
  fs.writeFileSync(cachePath, JSON.stringify(makeChapterCache()));
  try {
    const diskTimes = [];
    const memoryTimes = [];
    let cachedChapters;

    for (let i = 0; i < ITERATIONS; i++) {
      let chapters;
      let start = performance.now();
      for (let j = 0; j < CHAPTER_CACHE_READS; j++) {
        chapters = JSON.parse(fs.readFileSync(cachePath, 'utf-8')).chapters;
      }
      diskTimes.push(performance.now() - start);
      cachedChapters = chapters;

      start = performance.now();
      for (let j = 0; j < CHAPTER_CACHE_READS; j++) {
        chapters = cachedChapters;
      }
      memoryTimes.push(performance.now() - start);
    }

    return [
      summary('chapter-cache-disk-parse', diskTimes, {
        reads: CHAPTER_CACHE_READS,
        bytes: fs.statSync(cachePath).size
      }),
      summary('chapter-cache-memory-hit', memoryTimes, {
        reads: CHAPTER_CACHE_READS,
        bytes: fs.statSync(cachePath).size
      })
    ];
  } finally {
    fs.unlinkSync(cachePath);
  }
}

function benchXBookRead() {
  const xbookPath = path.join(os.tmpdir(), `xandrio-xbook-bench-${process.pid}.xbook.json`);
  fs.writeFileSync(xbookPath, JSON.stringify(makeXBookArtifact()));
  try {
    const diskTimes = [];
    const memoryTimes = [];
    let cachedArtifact;

    for (let i = 0; i < ITERATIONS; i++) {
      let artifact;
      let start = performance.now();
      for (let j = 0; j < CHAPTER_CACHE_READS; j++) {
        artifact = JSON.parse(fs.readFileSync(xbookPath, 'utf-8'));
      }
      diskTimes.push(performance.now() - start);
      cachedArtifact = artifact;

      start = performance.now();
      for (let j = 0; j < CHAPTER_CACHE_READS; j++) {
        artifact = cachedArtifact;
      }
      memoryTimes.push(performance.now() - start);
    }

    return [
      summary('xbook-disk-parse', diskTimes, {
        reads: CHAPTER_CACHE_READS,
        bytes: fs.statSync(xbookPath).size
      }),
      summary('xbook-memory-hit', memoryTimes, {
        reads: CHAPTER_CACHE_READS,
        bytes: fs.statSync(xbookPath).size
      })
    ];
  } finally {
    fs.unlinkSync(xbookPath);
  }
}

async function benchRepeatedExtractionReuse() {
  const fakeExtractMs = Number(process.env.PIPELINE_BENCH_FAKE_EXTRACT_MS || 120);
  const timesWithoutCache = [];
  const timesWithCache = [];

  async function fakeExtract() {
    await new Promise(resolve => setTimeout(resolve, fakeExtractMs));
    return makeChapterCache(80, 1800).chapters;
  }

  for (let i = 0; i < ITERATIONS; i++) {
    let start = performance.now();
    for (let j = 0; j < EXTRACTION_REUSES; j++) {
      await fakeExtract();
    }
    timesWithoutCache.push(performance.now() - start);

    start = performance.now();
    let cached = null;
    for (let j = 0; j < EXTRACTION_REUSES; j++) {
      if (!cached) cached = await fakeExtract();
      void cached;
    }
    timesWithCache.push(performance.now() - start);
  }

  return [
    summary('repeated-extraction-no-cache', timesWithoutCache, {
      reuses: EXTRACTION_REUSES,
      fakeExtractMs
    }),
    summary('repeated-extraction-memory-cache', timesWithCache, {
      reuses: EXTRACTION_REUSES,
      fakeExtractMs
    })
  ];
}

async function benchFileIdentityCache() {
  const statTimes = [];
  const cachedTimes = [];
  const filePath = __filename;
  let cachedIdentity = null;

  for (let i = 0; i < ITERATIONS; i++) {
    let start = performance.now();
    for (let j = 0; j < STAT_READS; j++) {
      fs.statSync(filePath);
    }
    statTimes.push(performance.now() - start);

    cachedIdentity = fs.statSync(filePath);
    start = performance.now();
    for (let j = 0; j < STAT_READS; j++) {
      void cachedIdentity;
    }
    cachedTimes.push(performance.now() - start);
  }

  return [
    summary('file-identity-stat', statTimes, { reads: STAT_READS }),
    summary('file-identity-cache-hit', cachedTimes, { reads: STAT_READS })
  ];
}

async function benchInflightCoalescing() {
  const fakeExtractMs = Number(process.env.PIPELINE_BENCH_FAKE_EXTRACT_MS || 120);
  const withoutCoalescing = [];
  const withCoalescing = [];
  const cpuWithoutCoalescing = [];
  const cpuWithCoalescing = [];
  let duplicateCalls = 0;
  let coalescedCalls = 0;
  let duplicateCpuCalls = 0;
  let coalescedCpuCalls = 0;

  async function fakeExtract() {
    await new Promise(resolve => setTimeout(resolve, fakeExtractMs));
    return makeChapterCache(80, 1800).chapters;
  }

  async function fakeCpuExtract() {
    const payload = JSON.stringify(makeXBookArtifact(120, 1600));
    for (let i = 0; i < 5; i++) {
      JSON.parse(payload);
    }
    return makeChapterCache(80, 1800).chapters;
  }

  for (let i = 0; i < ITERATIONS; i++) {
    let calls = 0;
    let start = performance.now();
    await Promise.all(Array.from({ length: INFLIGHT_REQUESTS }, async () => {
      calls++;
      return fakeExtract();
    }));
    withoutCoalescing.push(performance.now() - start);
    duplicateCalls += calls;

    let inflight = null;
    calls = 0;
    start = performance.now();
    await Promise.all(Array.from({ length: INFLIGHT_REQUESTS }, async () => {
      if (!inflight) {
        calls++;
        inflight = fakeExtract().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    }));
    withCoalescing.push(performance.now() - start);
    coalescedCalls += calls;

    calls = 0;
    start = performance.now();
    await Promise.all(Array.from({ length: INFLIGHT_REQUESTS }, async () => {
      calls++;
      return fakeCpuExtract();
    }));
    cpuWithoutCoalescing.push(performance.now() - start);
    duplicateCpuCalls += calls;

    inflight = null;
    calls = 0;
    start = performance.now();
    await Promise.all(Array.from({ length: INFLIGHT_REQUESTS }, async () => {
      if (!inflight) {
        calls++;
        inflight = fakeCpuExtract().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    }));
    cpuWithCoalescing.push(performance.now() - start);
    coalescedCpuCalls += calls;
  }

  return [
    summary('inflight-extraction-no-coalesce', withoutCoalescing, {
      requests: INFLIGHT_REQUESTS,
      fakeExtractMs,
      backendCalls: duplicateCalls
    }),
    summary('inflight-extraction-coalesced', withCoalescing, {
      requests: INFLIGHT_REQUESTS,
      fakeExtractMs,
      backendCalls: coalescedCalls
    }),
    summary('inflight-cpu-extraction-no-coalesce', cpuWithoutCoalescing, {
      requests: INFLIGHT_REQUESTS,
      backendCalls: duplicateCpuCalls
    }),
    summary('inflight-cpu-extraction-coalesced', cpuWithCoalescing, {
      requests: INFLIGHT_REQUESTS,
      backendCalls: coalescedCpuCalls
    })
  ];
}

async function main() {
  console.log(`Pipeline benchmark: ${ITERATIONS} iteration(s)`);
  for (const chunks of [25, 75, 150]) {
    console.log(JSON.stringify(await benchManifest({ chunks, parallel: false })));
    console.log(JSON.stringify(await benchManifest({ chunks, parallel: true })));
  }
  for (const result of benchSettingsRead()) {
    console.log(JSON.stringify(result));
  }
  for (const result of benchChapterCacheRead()) {
    console.log(JSON.stringify(result));
  }
  for (const result of benchXBookRead()) {
    console.log(JSON.stringify(result));
  }
  for (const result of await benchRepeatedExtractionReuse()) {
    console.log(JSON.stringify(result));
  }
  for (const result of await benchFileIdentityCache()) {
    console.log(JSON.stringify(result));
  }
  for (const result of await benchInflightCoalescing()) {
    console.log(JSON.stringify(result));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
