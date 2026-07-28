const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {
  OFFLINE_AUDIO_BITRATE_KBPS,
  createOfflineAudioPackage
} = require('../lib/offline-audio-package');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

(async () => {
  await test('creates a variant-scoped 48 kbps MP3 derivative atomically', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-audio-package-'));
    const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
    await fs.writeFile(sourcePath, 'playback master');
    const calls = [];
    const audioPackage = createOfflineAudioPackage({
      cacheDir,
      execFile: async (command, args) => {
        calls.push({ command, args });
        await fs.writeFile(args.at(-1), 'compact audio');
      }
    });

    const result = await audioPackage.ensureChapter({
      bookId: 'book-1',
      chapterIndex: 0,
      sourcePath,
      sourceVariantKey: 'voice-a:br160k'
    });

    assert.strictEqual(OFFLINE_AUDIO_BITRATE_KBPS, 48);
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.bitrateKbps, 48);
    assert.match(result.variantKey, /offline-mp3-v1:br48k$/);
    assert.match(path.basename(result.path), /^book-1_offline_[a-f0-9]{16}_ch0\.mp3$/);
    assert.deepStrictEqual(calls[0].args.slice(-14), [
      '-map_metadata', '-1',
      '-vn',
      '-ac', '1',
      '-ar', '24000',
      '-c:a', 'libmp3lame',
      '-b:a', '48k',
      '-f', 'mp3',
      result.path + '.part'
    ]);
    assert.strictEqual(await fs.readFile(result.path, 'utf8'), 'compact audio');
  });

  await test('reuses an existing derivative without transcoding again', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-audio-reuse-'));
    const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
    await fs.writeFile(sourcePath, 'playback master');
    let transcodes = 0;
    const audioPackage = createOfflineAudioPackage({
      cacheDir,
      execFile: async (_command, args) => {
        transcodes += 1;
        await fs.writeFile(args.at(-1), 'compact audio');
      }
    });
    const request = {
      bookId: 'book-1',
      chapterIndex: 0,
      sourcePath,
      sourceVariantKey: 'voice-a:br160k'
    };

    await audioPackage.ensureChapter(request);
    const result = await audioPackage.ensureChapter(request);

    assert.strictEqual(transcodes, 1);
    assert.strictEqual(result.ready, true);
  });

  await test('does not reuse a derivative from a different narration variant', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-audio-variant-'));
    const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
    await fs.writeFile(sourcePath, 'playback master');
    const audioPackage = createOfflineAudioPackage({
      cacheDir,
      execFile: async (_command, args) => fs.writeFile(args.at(-1), 'compact audio')
    });

    const first = await audioPackage.ensureChapter({
      bookId: 'book-1',
      chapterIndex: 0,
      sourcePath,
      sourceVariantKey: 'voice-a:br160k'
    });
    const second = await audioPackage.inspectChapter({
      bookId: 'book-1',
      chapterIndex: 0,
      sourceVariantKey: 'voice-b:br160k'
    });

    assert.strictEqual(second.ready, false);
    assert.notStrictEqual(first.path, second.path);
  });

  await test('recovers the pinned narration identity from an offline package key', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-audio-identity-'));
    const audioPackage = createOfflineAudioPackage({ cacheDir });
    const packageKey = audioPackage.packageVariantKey('voice-a:chunk4000:br160k');

    assert.strictEqual(
      audioPackage.sourceVariantKey(packageKey),
      'voice-a:chunk4000:br160k'
    );
    assert.throws(
      () => audioPackage.sourceVariantKey('voice-a:offline-mp3-v9:br32k'),
      /Invalid offline audio package identity/
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
