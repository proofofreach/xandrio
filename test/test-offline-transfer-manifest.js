const assert = require('node:assert/strict');
const { createOfflineTransferManifest } = require('../lib/offline-transfer-manifest');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const hash = `sha256-${'a'.repeat(64)}`;
const ready = {
  ready: true, artifactId: hash, contentHash: hash, etag: `"${hash}"`,
  size: 8, blockSize: 1048576, blockHashes: [hash], variantKey: 'voice:offline',
  provenance: 'legacy-unverified'
};
function fixture(chapters) {
  let currentChapters = chapters;
  let variant = 'voice:offline';
  const states = chapters.map(() => ({ ready: false }));
  const expected = chapters.map((_, index) => `recipe-${index}`);
  const inspected = [];
  const manifest = createOfflineTransferManifest({
    getBookChapters: async () => ({ chapters: currentChapters }),
    preparationIdentity: async () => ({ packageVariantKey: variant, sourceVoice: 'voice' }),
    preparationStatus: async () => ({ state: 'preparing' }),
    chapterStatus: async (bookId, index, identity) => {
      inspected.push({ bookId, index, identity });
      return { expectedRecipeFingerprint: expected[index], ...states[index] };
    }
  });
  return {
    manifest, states, inspected,
    setChapters: value => { currentChapters = value; },
    setVariant: value => { variant = value; },
    setExpected: (index, value) => { expected[index] = value; }
  };
}
async function main() {
  await test('descriptor revision changes with readiness while source revision stays stable', async () => {
    const f = fixture([{ text: 'First' }, { text: 'Second' }]);
    const initial = await f.manifest('book');
    f.states[0] = ready;
    const partial = await f.manifest('book');
    assert.notEqual(partial.revision, initial.revision);
    assert.equal(partial.sourceRevision, initial.sourceRevision);
    assert.equal(partial.bytesPrepared, 8);
    assert.equal(partial.bytesTotal, null);
    assert.equal(partial.state, 'preparing');
    assert.equal(partial.chapters[0].provenance, 'legacy-unverified');
    assert.match(partial.chapters[0].url, /artifact=sha256-/);
    assert.equal((await f.manifest('book')).revision, partial.revision);
    f.states[1] = ready;
    const complete = await f.manifest('book');
    assert.equal(complete.state, 'ready');
    assert.equal(complete.bytesTotal, 16);
  });
  await test('text and voice changes invalidate the source revision independently', async () => {
    const f = fixture([{ text: 'Old text' }]);
    const old = await f.manifest('book');
    f.setChapters([{ text: 'New text' }]);
    const edited = await f.manifest('book');
    assert.notEqual(edited.sourceRevision, old.sourceRevision);
    f.setVariant('new-voice:offline');
    const changedVoice = await f.manifest('book');
    assert.notEqual(changedVoice.sourceRevision, edited.sourceRevision);
    assert.equal(f.inspected.at(-1).identity.packageVariantKey, 'new-voice:offline');
  });
  await test('expected narration recipes invalidate pending and ready source revisions', async () => {
    const f = fixture([{ text: 'Legacy audio' }]);
    const pending = await f.manifest('book');
    f.states[0] = { ...ready, sourceFingerprint: `sha256-${'b'.repeat(64)}` };
    const wrappedLegacy = await f.manifest('book');
    assert.equal(wrappedLegacy.sourceRevision, pending.sourceRevision);

    f.states[0] = { ready: false };
    f.setExpected(0, 'changed-recipe');
    const changedPending = await f.manifest('book');
    assert.notEqual(changedPending.sourceRevision, wrappedLegacy.sourceRevision);
  });
  await test('empty chapters skip inspection and uncommitted packages are never transferable', async () => {
    const f = fixture([{ text: '', empty: true }, { text: 'Legacy' }]);
    f.states[1] = { ready: true, size: 50, url: '/legacy.mp3' };
    const manifest = await f.manifest('book');
    assert.deepEqual(f.inspected.map(item => item.index), [1]);
    assert.deepEqual(manifest.chapters[0], { index: 0, state: 'empty' });
    assert.deepEqual(manifest.chapters[1], { index: 1, state: 'pending' });
    assert.equal(manifest.bytesPrepared, 0);
  });
  await test('bounds sidecar inspection to four concurrent reads and preserves chapter order', async () => {
    let active = 0;
    let maximum = 0;
    const chapters = Array.from({ length: 19 }, (_, index) => ({ text: String(index) }));
    const manifest = createOfflineTransferManifest({
      getBookChapters: async () => ({ chapters }),
      preparationIdentity: async () => ({ packageVariantKey: 'voice' }),
      preparationStatus: async () => ({ state: 'ready' }),
      chapterStatus: async (_bookId, index) => {
        maximum = Math.max(maximum, ++active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        return { ...ready, size: index + 1 };
      }
    });
    const result = await manifest('book');
    assert.equal(maximum, 4);
    assert.deepEqual(result.chapters.map(item => item.index), chapters.map((_, index) => index));
    assert.equal(result.bytesTotal, 190);
  });
  console.log(`offline-transfer-manifest tests: ${passed} passed, 0 failed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
