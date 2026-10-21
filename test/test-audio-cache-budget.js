const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAudioCacheBudget, TOP_LEVEL_AUDIO } = require('../lib/audio-cache-budget');
const jsonStore = require('../lib/json-store');

let passed = 0;
let failed = 0;

async function test(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-audio-budget-'));
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir);
  return { root, cacheDir };
}

function write(cacheDir, name, bytes, ageDays) {
  const filePath = path.join(cacheDir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
  const time = new Date(NOW - ageDays * DAY_MS);
  fs.utimesSync(filePath, time, time);
  return filePath;
}

// statfs reports whatever free space the test sets; every unlink adds the
// removed bytes back, as on a real filesystem.
function fakeFs(initialFree, total = 100 * GIB) {
  let free = initialFree;
  const real = fs.promises;
  return {
    get free() { return free; },
    set free(value) { free = value; },
    readdir: real.readdir,
    lstat: real.lstat,
    async statfs() { return { blocks: total / 4096, bsize: 4096, bavail: Math.floor(free / 4096) }; },
    async unlink(filePath) {
      const stat = await real.lstat(filePath);
      await real.unlink(filePath);
      if (stat.nlink === 1) free += stat.size;
    },
    async rm(target, options) {
      await real.rm(target, options);
    }
  };
}

function worker(manifests = new Map()) {
  return {
    released: [],
    getChapterManifest(bookId, chapterIndex) { return manifests.get(`${bookId}:${chapterIndex}`) || null; },
    async releaseEvictedChapter(bookId, chapterIndex) { this.released.push(`${bookId}:${chapterIndex}`); },
    variantWorkers() { return [this]; }
  };
}

const quiet = { log() {}, warn() {} };

(async () => {
  await test('the audio pattern accepts generated narration and rejects other cache files', () => {
    for (const name of [
      'book_ch3_chunk0.mp3',
      'book_tts0123456789_ch3_chunk12.mp3',
      'book_tts0123456789_ch3_chunk12.mp3.narration-artifact.json',
      'book_tts0123456789_ch3.mp3',
      'book_ch3.m4a',
      'book_tts0123456789_ch3.texthash',
      'book_tts0123456789_ch3_concat_clean.txt'
    ]) assert.ok(TOP_LEVEL_AUDIO.test(name), name);
    for (const name of [
      'book.epub',
      'book.xbook.json',
      'book.chapters.json',
      'book_cover.jpg',
      'book_tts0123456789_ch3_chunk1.mp3.123.abc.4.part.mp3',
      'book_tts0123456789_ch3_concat.txt.1.ab.tmp'
    ]) assert.ok(!TOP_LEVEL_AUDIO.test(name), name);
  });

  await test('does nothing while free space is above the floor', async () => {
    const { root, cacheDir } = fixture();
    try {
      write(cacheDir, 'old_ch0_chunk0.mp3', 1000, 90);
      const fsp = fakeFs(50 * GIB);
      const budget = createAudioCacheBudget({ cacheDir, fsp, now: () => NOW, log: quiet });
      const result = await budget.sweep();
      assert.equal(result.evictedChapters, 0);
      assert.ok(fs.existsSync(path.join(cacheDir, 'old_ch0_chunk0.mp3')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('evicts least recently used chapters until the high-water mark and spares the rest', async () => {
    const { root, cacheDir } = fixture();
    try {
      const big = 2 * 1024 * 1024;
      write(cacheDir, 'a_tts0123456789_ch0_chunk0.mp3', big, 60);
      write(cacheDir, 'a_tts0123456789_ch0_chunk0.mp3.narration-artifact.json', 10, 60);
      write(cacheDir, 'a_tts0123456789_ch0.mp3', big, 60);
      write(cacheDir, 'a_tts0123456789_ch0.texthash', 12, 60);
      write(cacheDir, 'a_narration_artifacts_v1/ch0/' + 'f'.repeat(64) + '.mp3', big, 60);
      write(cacheDir, 'b_ch1_chunk0.mp3', big, 30);
      write(cacheDir, 'c_ch2_chunk0.mp3', big, 10);
      write(cacheDir, 'a.epub', big, 365);
      write(cacheDir, 'a_offline_0123456789abcdef_ch0.mp3', big, 365);
      // Far below the 10 GiB floor: every eligible chapter is evicted.
      const fsp = fakeFs(1);
      const budget = createAudioCacheBudget({ cacheDir, fsp, now: () => NOW, minFreeBytes: 1, log: quiet });
      const result = await budget.sweep();
      assert.equal(result.evictedChapters, 3);
      for (const name of fs.readdirSync(cacheDir)) {
        assert.ok(['a.epub', 'a_offline_0123456789abcdef_ch0.mp3', 'a_narration_artifacts_v1'].includes(name), name);
      }
      assert.deepEqual(fs.readdirSync(path.join(cacheDir, 'a_narration_artifacts_v1')), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('stops once enough space is reclaimed, oldest chapter first', async () => {
    const { root, cacheDir } = fixture();
    try {
      const size = 1024 * 1024;
      write(cacheDir, 'old_ch0_chunk0.mp3', size, 90);
      write(cacheDir, 'mid_ch0_chunk0.mp3', size, 60);
      write(cacheDir, 'new_ch0_chunk0.mp3', size, 30);
      // 10 MiB disk with a 10% floor: low water 1 MiB, high water 1.5 MiB.
      const fsp = fakeFs(1.2 * size, 10 * size);
      const budget = createAudioCacheBudget({ cacheDir, fsp, now: () => NOW, minFreeBytes: 1, log: quiet });
      assert.equal((await budget.sweep()).evictedChapters, 0);
      fsp.free = 0.9 * size;
      const result = await budget.sweep();
      assert.equal(result.evictedChapters, 1);
      assert.deepEqual(fs.readdirSync(cacheDir).sort(), ['mid_ch0_chunk0.mp3', 'new_ch0_chunk0.mp3']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('honours the protection window, recorded use and loaded manifests', async () => {
    const { root, cacheDir } = fixture();
    try {
      write(cacheDir, 'recent_ch0_chunk0.mp3', 1000, 1);
      write(cacheDir, 'played_ch4_chunk0.mp3', 1000, 90);
      write(cacheDir, 'loaded_ch2_chunk0.mp3', 1000, 90);
      write(cacheDir, 'stale_ch1_chunk0.mp3', 1000, 90);
      const fsp = fakeFs(1);
      const manifests = new Map([['loaded:2', { chunks: [] }]]);
      const ttsWorker = worker(manifests);
      const budget = createAudioCacheBudget({
        cacheDir, fsp, now: () => NOW, workers: () => [ttsWorker], log: quiet
      });
      budget.recordUse('played', 4);
      const result = await budget.sweep();
      assert.equal(result.evictedChapters, 1);
      assert.deepEqual(fs.readdirSync(cacheDir).sort(), [
        'loaded_ch2_chunk0.mp3',
        'played_ch4_chunk0.mp3',
        'recent_ch0_chunk0.mp3'
      ]);
      assert.deepEqual(ttsWorker.released, ['stale:1']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('counts hard-linked audio once and only when every link is evicted', async () => {
    const { root, cacheDir } = fixture();
    try {
      const output = write(cacheDir, 'a_ch0_chunk0.mp3', 4096, 90);
      const artifact = path.join(cacheDir, 'a_narration_artifacts_v1', 'ch0', `${'e'.repeat(64)}.mp3`);
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.linkSync(output, artifact);
      const outside = path.join(root, 'outside.mp3');
      write(cacheDir, 'b_ch0_chunk0.mp3', 4096, 90);
      fs.linkSync(path.join(cacheDir, 'b_ch0_chunk0.mp3'), outside);
      const budget = createAudioCacheBudget({ cacheDir, fsp: fakeFs(50 * GIB), log: quiet });
      const groups = await budget.scan();
      const bytes = Object.fromEntries(groups.map(group => [group.bookId, budget.reclaimableBytes(group)]));
      assert.equal(bytes.a, 4096);
      assert.equal(bytes.b, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('persists recorded use across restarts', async () => {
    const { root, cacheDir } = fixture();
    try {
      const usageFile = path.join(root, 'audio-cache-usage.json');
      write(cacheDir, 'kept_ch0_chunk0.mp3', 1000, 90);
      write(cacheDir, 'gone_ch0_chunk0.mp3', 1000, 90);
      const first = createAudioCacheBudget({ cacheDir, usageFile, jsonStore, fsp: fakeFs(50 * GIB), now: () => NOW, log: quiet });
      first.recordUse('kept', 0);
      await first.flushUsage();
      const second = createAudioCacheBudget({ cacheDir, usageFile, jsonStore, fsp: fakeFs(1), now: () => NOW, log: quiet });
      const result = await second.sweep();
      assert.equal(result.evictedChapters, 1);
      assert.ok(fs.existsSync(path.join(cacheDir, 'kept_ch0_chunk0.mp3')));
      assert.ok(!fs.existsSync(path.join(cacheDir, 'gone_ch0_chunk0.mp3')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('admission sweeps first and refuses writes only below the hard floor', async () => {
    const { root, cacheDir } = fixture();
    try {
      write(cacheDir, 'old_ch0_chunk0.mp3', 1000, 90);
      const fsp = fakeFs(GIB / 2);
      const budget = createAudioCacheBudget({ cacheDir, fsp, now: () => NOW, log: quiet });
      await assert.rejects(budget.ensureWritableSpace(), error => error.code === 'INSUFFICIENT_STORAGE' && error.status === 507);
      assert.ok(!fs.existsSync(path.join(cacheDir, 'old_ch0_chunk0.mp3')));
      fsp.free = 2 * GIB;
      const space = await budget.ensureWritableSpace();
      assert.equal(space.available, 2 * GIB);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
