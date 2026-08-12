const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createChapterAudioReconciler } = require('../lib/chapter-audio-reconcile');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-audio-reconcile-'));
  try {
    const files = {
      movedChunk: 'book_ch0_chunk0.mp3',
      movedMarker: 'book_ch0_chunk0.mp3.narration-artifact.json',
      movedHash: 'book_ch0.texthash',
      movedOffline: 'book_offline_0123456789abcdef_ch0.mp3',
      staleTarget: 'book_ch1_chunk0.mp3',
      unchanged: 'book_ch2_chunk0.mp3'
    };
    await Promise.all(Object.entries(files).map(([label, name]) => fs.writeFile(
      path.join(dir, name),
      label === 'movedMarker'
        ? JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64) })
        : label
    )));

    const quiesced = [];
    const invalidated = [];
    const removedClaims = [];
    const indexed = [];
    const reconciler = createChapterAudioReconciler({
      cacheDir: dir,
      workers: () => [{
        quiesceChapterAllVariants: async (bookId, chapterIndex) => quiesced.push([bookId, chapterIndex]),
        chapterArtifactReusePlan: async () => ({
          artifacts: [{ outputPath: path.join(dir, 'book_ch1_chunk0.mp3'), fingerprint: 'a'.repeat(64) }],
          hashPath: path.join(dir, 'book_ch1.texthash'),
          textHash: 'current-hash'
        }),
        indexChapterArtifacts: async (bookId, chapterIndex) => indexed.push([bookId, chapterIndex])
      }],
      invalidateCache: async affected => {
        invalidated.push(...affected);
        for (const item of affected) {
          const entries = await fs.readdir(dir);
          await Promise.all(entries
            .filter(name => new RegExp(`^book(?:_tts[a-f0-9]{10})?_ch${item.chapterIndex}(?:_|\\.)`).test(name))
            .map(name => fs.unlink(path.join(dir, name))));
        }
      },
      removeGenerationClaims: async (_bookId, indexes) => removedClaims.push(...indexes)
    });

    const result = await reconciler.reconcile({
      bookId: 'book',
      transition: {
        safe: true,
        previousRanges: [{ index: 0 }, { index: 1 }, { index: 2 }],
        nextRanges: [{ index: 0 }, { index: 1 }, { index: 2 }],
        reusableAudio: { 0: 1, 2: 2 }
      },
      nextChapters: [{ text: 'changed' }, { text: 'moved' }, { text: 'same' }],
      language: 'en'
    });

    assert.deepStrictEqual(result.moved, [{ from: 0, to: 1 }]);
    assert.deepStrictEqual(result.affectedIndexes, [0, 1]);
    assert.deepStrictEqual(quiesced, [['book', 0], ['book', 1]]);
    assert.deepStrictEqual(removedClaims, [0, 1]);
    assert.deepStrictEqual(indexed, [['book', 1]]);
    assert.strictEqual(await fs.readFile(path.join(dir, 'book_ch1_chunk0.mp3'), 'utf8'), 'movedChunk');
    assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(dir, 'book_ch1_chunk0.mp3.narration-artifact.json'), 'utf8')),
      { version: 1, fingerprint: 'a'.repeat(64) });
    assert.strictEqual(await fs.readFile(path.join(dir, 'book_ch1.texthash'), 'utf8'), 'current-hash');
    await assert.rejects(fs.access(path.join(dir, 'book_offline_0123456789abcdef_ch1.mp3')), { code: 'ENOENT' });
    assert.strictEqual(await fs.readFile(path.join(dir, files.unchanged), 'utf8'), 'unchanged');

    const failureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-audio-reconcile-failure-'));
    try {
      await fs.writeFile(path.join(failureDir, 'book_ch0_chunk0.mp3'), 'source');
      await fs.writeFile(path.join(failureDir, 'book_ch1_chunk0.mp3'), 'stale');
      await fs.writeFile(path.join(failureDir, 'book_ch2_chunk0.mp3'), 'unchanged');
      const failing = createChapterAudioReconciler({
        cacheDir: failureDir,
        workers: () => [{
          quiesceChapterAllVariants: async () => {},
          chapterArtifactReusePlan: async () => ({
            artifacts: [{ outputPath: path.join(failureDir, 'book_ch1_chunk0.mp3'), fingerprint: 'c'.repeat(64) }],
            hashPath: path.join(failureDir, 'book_ch1.texthash'),
            textHash: 'failure-hash'
          }),
          indexChapterArtifacts: async () => { throw new Error('index failed'); },
          cancelBook() {}
        }],
        invalidateCache: async () => {},
        removeGenerationClaims: async () => {}
      });
      await assert.rejects(failing.reconcile({
        bookId: 'book',
        transition: {
          safe: true,
          previousRanges: [{ index: 0 }, { index: 1 }, { index: 2 }],
          nextRanges: [{ index: 0 }, { index: 1 }, { index: 2 }],
          reusableAudio: { 0: 1, 2: 2 }
        },
        nextChapters: [{ text: 'changed' }, { text: 'moved' }, { text: 'same' }]
      }), /index failed/);
      const remaining = await fs.readdir(failureDir);
      assert.deepStrictEqual(remaining, ['book_ch2_chunk0.mp3']);
    } finally {
      await fs.rm(failureDir, { recursive: true, force: true });
    }

    const crashDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-audio-reconcile-crash-'));
    try {
      await fs.writeFile(path.join(crashDir, 'book_ch0_chunk0.mp3'), 'recoverable');
      await fs.writeFile(path.join(crashDir, 'book_ch0_chunk0.mp3.narration-artifact.json'),
        JSON.stringify({ version: 1, fingerprint: 'b'.repeat(64) }));
      let crashOnce = true;
      const crashingFs = Object.create(fs);
      crashingFs.rename = async (source, target) => {
        if (crashOnce && /\.rebuild-audio-[a-f0-9]+-0$/.test(source) && /book_ch1_chunk0\.mp3$/.test(target)) {
          crashOnce = false;
          const error = new Error('simulated audio promotion crash');
          error.simulateCrash = true;
          throw error;
        }
        return fs.rename(source, target);
      };
      const transition = {
        safe: true,
        previousHash: 'old',
        nextHash: 'new',
        previousRanges: [{ index: 0 }, { index: 1 }],
        nextRanges: [{ index: 0 }, { index: 1 }],
        reusableAudio: { 0: 1 }
      };
      const crashing = createChapterAudioReconciler({
        cacheDir: crashDir,
        fs: crashingFs,
        workers: () => [{
          chapterArtifactReusePlan: async () => ({
            artifacts: [{ outputPath: path.join(crashDir, 'book_ch1_chunk0.mp3'), fingerprint: 'b'.repeat(64) }],
            hashPath: path.join(crashDir, 'book_ch1.texthash'),
            textHash: 'crash-hash'
          })
        }],
        invalidateCache: async () => {},
        removeGenerationClaims: async () => {}
      });
      await assert.rejects(crashing.reconcile({
        bookId: 'book', transition, nextChapters: [{ text: 'changed' }, { text: 'moved' }]
      }), /simulated audio promotion crash/);
      const recovered = createChapterAudioReconciler({
        cacheDir: crashDir,
        workers: () => [{
          chapterArtifactReusePlan: async () => ({
            artifacts: [{ outputPath: path.join(crashDir, 'book_ch1_chunk0.mp3'), fingerprint: 'b'.repeat(64) }],
            hashPath: path.join(crashDir, 'book_ch1.texthash'),
            textHash: 'crash-hash'
          })
        }],
        invalidateCache: async () => {},
        removeGenerationClaims: async () => {}
      });
      await recovered.reconcile({
        bookId: 'book', transition, nextChapters: [{ text: 'changed' }, { text: 'moved' }]
      });
      assert.strictEqual(await fs.readFile(path.join(crashDir, 'book_ch1_chunk0.mp3'), 'utf8'), 'recoverable');
      assert(!(await fs.readdir(crashDir)).some(name => name.startsWith('.rebuild-audio-')),
        'audio reconciliation resumes its manifest after a process crash');
    } finally {
      await fs.rm(crashDir, { recursive: true, force: true });
    }

    console.log('13 passed, 0 failed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
