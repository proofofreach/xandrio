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
