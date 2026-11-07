const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { __test } = require('../server');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

const sha = bytes => `sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}`;

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-offline-source-'));
  try {
    const bytes = Buffer.from('preserved stitched narration');
    const sourcePath = path.join(dir, 'book_voice_ch0.mp3');
    const fingerprint = crypto.createHash('sha256').update('recipe').digest('hex');
    const missingChunk = path.join(dir, 'reclaimed-chunk.mp3');
    const calls = [];
    const recipe = {
      fingerprint,
      sourceFingerprint: `sha256-${fingerprint}`,
      book: { id: 'book', language: 'en' },
      chapter: { text: 'chapter text' },
      chapterIndex: 0,
      plan: { artifacts: [{ outputPath: missingChunk, fingerprint: 'missing-fingerprint' }] },
      worker: {
        reconstructChapterManifest: async () => calls.push('reconstruct'),
        concatenateChunks: async () => calls.push('concatenate')
      }
    };

    await test('uses a verified stitched source after its chunks were reclaimed', async () => {
      await fs.writeFile(sourcePath, bytes);
      await fs.writeFile(`${sourcePath}.narration-artifact.json`, JSON.stringify({
        version: 2,
        fingerprint,
        bytes: bytes.length,
        contentHash: sha(bytes),
        provenance: 'verified'
      }));
      const identity = await __test.resolveStitchedOfflineSource(sourcePath, recipe);
      assert.strictEqual(identity.provenance, 'verified');
      assert.strictEqual(identity.contentHash, sha(bytes));
      assert.deepStrictEqual(calls, []);
    });

    await test('keeps a legacy stitched source when old chunks no longer exist', async () => {
      await fs.unlink(`${sourcePath}.narration-artifact.json`);
      const identity = await __test.resolveStitchedOfflineSource(sourcePath, recipe);
      assert.strictEqual(identity.provenance, 'legacy-unverified');
      assert.strictEqual(identity.bytes, bytes.length);
      assert.deepStrictEqual(calls, []);
    });

    await test('rejects a present v2 marker whose content hash is false', async () => {
      await fs.writeFile(`${sourcePath}.narration-artifact.json`, JSON.stringify({
        version: 2,
        fingerprint,
        bytes: bytes.length,
        contentHash: `sha256-${'0'.repeat(64)}`,
        provenance: 'verified'
      }));
      await assert.rejects(
        __test.resolveStitchedOfflineSource(sourcePath, recipe),
        /failed provenance verification/
      );
    });

    await test('rejects an unknown stitched marker version instead of downgrading its proof', async () => {
      await fs.writeFile(`${sourcePath}.narration-artifact.json`, JSON.stringify({
        version: 3,
        fingerprint,
        bytes: bytes.length,
        contentHash: sha(bytes),
        provenance: 'verified'
      }));
      await assert.rejects(
        __test.resolveStitchedOfflineSource(sourcePath, recipe),
        /failed provenance verification/
      );
    });

    await test('aborts source inspection before marker publication work', async () => {
      const controller = new AbortController();
      controller.abort(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      await assert.rejects(
        __test.inspectOfflineSourceMarker(sourcePath, fingerprint, controller.signal),
        error => error.name === 'AbortError'
      );
    });

    await test('single-pass offline encodes use verified chunks in manifest order', async () => {
      const chunkFingerprints = ['1', '2'].map(digit => digit.repeat(64));
      const chunkPaths = chunkFingerprints.map((_, index) => path.join(dir, `chunked_ch0_chunk${index}.mp3`));
      for (const [index, chunkPath] of chunkPaths.entries()) {
        const chunkBytes = Buffer.from(`chunk ${index}`);
        await fs.writeFile(chunkPath, chunkBytes);
        await fs.writeFile(`${chunkPath}.narration-artifact.json`, JSON.stringify({
          version: 2,
          fingerprint: chunkFingerprints[index],
          bytes: chunkBytes.length,
          contentHash: sha(chunkBytes),
          provenance: 'verified'
        }));
      }
      let manifest = {
        chunks: chunkPaths.map((chunkPath, index) => ({ index, status: 'ready', path: chunkPath }))
      };
      const reconstructed = [];
      const chunkRecipe = {
        ...recipe,
        plan: {
          artifacts: chunkPaths.map((outputPath, index) => ({ outputPath, fingerprint: chunkFingerprints[index] }))
        },
        worker: {
          getChapterManifest: () => manifest,
          reconstructChapterManifest: async () => {
            reconstructed.push('reconstruct');
            return manifest;
          },
          concatenateChunks: async () => { throw new Error('single-pass encode must not stitch'); }
        }
      };
      assert.deepStrictEqual(await __test.verifiedOfflineChunkSources(chunkRecipe), chunkPaths);
      assert.deepStrictEqual(reconstructed, []);

      // A plan that dropped a chunk would encode a truncated chapter.
      manifest = { chunks: [...manifest.chunks, { index: 2, status: 'ready', path: path.join(dir, 'extra.mp3') }] };
      assert.strictEqual(await __test.verifiedOfflineChunkSources(chunkRecipe), null);
      manifest = { chunks: manifest.chunks.slice(0, 2).map(chunk => ({ ...chunk })) };
      manifest.chunks[1].status = 'pending';
      assert.strictEqual(await __test.verifiedOfflineChunkSources(chunkRecipe), null);

      // Without a live manifest the chapter is reconstructed from disk.
      manifest = { chunks: chunkPaths.map((chunkPath, index) => ({ index, status: 'ready', path: chunkPath })) };
      const live = chunkRecipe.worker.getChapterManifest;
      chunkRecipe.worker.getChapterManifest = () => null;
      assert.deepStrictEqual(await __test.verifiedOfflineChunkSources(chunkRecipe), chunkPaths);
      assert.deepStrictEqual(reconstructed, ['reconstruct']);
      chunkRecipe.worker.getChapterManifest = live;

      // Legacy or tampered chunks fall back to the stitched source path.
      await fs.unlink(`${chunkPaths[1]}.narration-artifact.json`);
      assert.strictEqual(await __test.verifiedOfflineChunkSources(chunkRecipe), null);
      await fs.writeFile(`${chunkPaths[1]}.narration-artifact.json`, JSON.stringify({
        version: 2,
        fingerprint: chunkFingerprints[1],
        bytes: 7,
        contentHash: sha(Buffer.from('changed')),
        provenance: 'verified'
      }));
      assert.strictEqual(await __test.verifiedOfflineChunkSources(chunkRecipe), null);
      assert.strictEqual(await __test.verifiedOfflineChunkSources({ ...chunkRecipe, plan: null }), null);
    });

    await test('a chunk-sourced package restores the stitched playback file with verified provenance', async () => {
      const chunkFingerprints = ['3', '4'].map(digit => digit.repeat(64));
      const chunkPaths = chunkFingerprints.map((_, index) => path.join(dir, `stitch_ch0_chunk${index}.mp3`));
      for (const [index, chunkPath] of chunkPaths.entries()) {
        const chunkBytes = Buffer.from(`stitch chunk ${index}`);
        await fs.writeFile(chunkPath, chunkBytes);
        await fs.writeFile(`${chunkPath}.narration-artifact.json`, JSON.stringify({
          version: 2, fingerprint: chunkFingerprints[index], bytes: chunkBytes.length,
          contentHash: sha(chunkBytes), provenance: 'verified'
        }));
      }
      const stitchedPath = path.join(dir, 'stitch_ch0.mp3');
      const concatenations = [];
      const stitchRecipe = {
        ...recipe,
        plan: { artifacts: chunkPaths.map((outputPath, index) => ({ outputPath, fingerprint: chunkFingerprints[index] })) },
        worker: {
          chapterPath: () => stitchedPath,
          getChapterManifest: () => ({
            chunks: chunkPaths.map((chunkPath, index) => ({ index, status: 'ready', path: chunkPath }))
          }),
          reconstructChapterManifest: async () => { throw new Error('a live manifest exists'); },
          concatenateChunks: async (_bookId, _chapterIndex, options) => {
            concatenations.push(options?.signal ? 'signal' : 'none');
            await fs.writeFile(stitchedPath, 'stitched playback master');
            return stitchedPath;
          }
        }
      };
      assert.strictEqual(await __test.stitchOfflinePlaybackChapter(stitchRecipe), stitchedPath);
      assert.deepStrictEqual(concatenations, ['none']);
      // The marker makes the file independent proof once its chunks are reclaimed.
      const identity = await __test.resolveStitchedOfflineSource(stitchedPath, stitchRecipe);
      assert.strictEqual(identity.provenance, 'verified');
      assert.strictEqual(concatenations.length, 1);

      // An existing playback file is never rebuilt.
      assert.strictEqual(await __test.stitchOfflinePlaybackChapter(stitchRecipe), null);
      assert.strictEqual(concatenations.length, 1);

      // Unverified chunks are left alone: stitching is optional and never narrates.
      await fs.unlink(stitchedPath);
      await fs.unlink(`${chunkPaths[0]}.narration-artifact.json`);
      assert.strictEqual(await __test.stitchOfflinePlaybackChapter(stitchRecipe), null);
      assert.strictEqual(concatenations.length, 1);
    });

    await test('one cancelled consumer does not abort shared chapter preparation', async () => {
      const sharedController = new AbortController();
      let resolveShared;
      const shared = new Promise(resolve => { resolveShared = resolve; });
      const record = {
        controller: sharedController,
        consumers: new Set(),
        settled: false,
        promise: null
      };
      record.promise = shared.finally(() => { record.settled = true; });
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = __test.consumeChapterPreparation(record, firstController.signal);
      const second = __test.consumeChapterPreparation(record, secondController.signal);
      firstController.abort(new Error('first caller left'));
      await assert.rejects(first, error => error.name === 'AbortError');
      assert.strictEqual(sharedController.signal.aborted, false);
      resolveShared('stitched.mp3');
      assert.strictEqual(await second, 'stitched.mp3');

      const soleController = new AbortController();
      const soleRecord = {
        controller: new AbortController(),
        consumers: new Set(),
        settled: false,
        promise: new Promise(() => {})
      };
      const sole = __test.consumeChapterPreparation(soleRecord, soleController.signal);
      soleController.abort(new Error('only caller left'));
      await assert.rejects(sole, error => error.name === 'AbortError');
      assert.strictEqual(soleRecord.controller.signal.aborted, true);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
