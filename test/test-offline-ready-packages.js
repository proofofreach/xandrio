const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createOfflineReadyPackages, sourceTextRevision } = require('../lib/offline-ready-packages');
const { packageVariantKey } = require('../lib/offline-audio-package');
const { isManagedArtifactName } = require('../lib/book-artifact-paths');

let passed = 0;
let failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}\n${error.stack}`); }
}
const identity = (prep = 8, voice = 'am_onyx') => {
  const sourceVariantKey = `kokoro:${voice}:profilequality:chunk420:fmtwav:outmp3:prep${prep}:audio6:br160k:pause350`;
  return { sourceVoice: `kokoro:${voice}`, sourceVariantKey, sourceChunkSize: 420,
    packageVariantKey: packageVariantKey(sourceVariantKey), bitrateKbps: 48 };
};

(async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-ready-'));
  const target = { book: { id: 'napoleon', language: 'en', addedAt: '2026-08-01T00:00:00Z' },
    chapters: [{ text: 'First chapter' }, { text: '', empty: true }, { text: 'Last chapter' }] };
  const packages = new Map();
  const inspected = [];
  const audioPackage = { inspectChapter: async request => {
    inspected.push(request);
    return packages.get(`${request.sourceVariantKey}:${request.chapterIndex}`) || { ready: false };
  } };
  const old = identity();
  for (const index of [0, 2]) packages.set(`${old.sourceVariantKey}:${index}`, {
    ready: true, artifactId: `sha256-${String(index + 1).repeat(64)}`, size: 100 + index,
    variantKey: old.packageVariantKey, provenance: 'legacy-unverified'
  });
  const store = createOfflineReadyPackages({ cacheDir, audioPackage });
  const input = { bookId: 'napoleon', ...target, rules: [] };
  try {
    await test('retains a complete original package after a preprocessing version upgrade', async () => {
      const remembered = await store.remember({ ...input, identity: old });
      inspected.length = 0;
      const result = await store.select({ ...input, identity: identity(11) });
      assert.equal(result.packageVariantKey, old.packageVariantKey);
      assert.equal(result.retained, true);
      assert.equal(result.retainedPackageRevision, remembered.retainedPackageRevision);
      assert.notEqual(result.retainedPackageRevision, result.sourceTextRevision);
      assert.deepEqual(inspected.map(item => item.chapterIndex), [0, 2]);
      assert(inspected.every(item => !item.sourceFingerprint));
    });
    await test('does not retain a different voice or an explicitly changed audio profile', async () => {
      const differentVoice = identity(11, 'af_heart');
      assert.equal((await store.select({ ...input, identity: differentVoice })).packageVariantKey,
        differentVoice.packageVariantKey);
      const profile = identity(11);
      profile.sourceVariantKey = profile.sourceVariantKey.replace('pause350', 'pause700');
      profile.packageVariantKey = packageVariantKey(profile.sourceVariantKey);
      assert.equal((await store.select({ ...input, identity: profile })).packageVariantKey, profile.packageVariantKey);
    });
    await test('changed text, chapter layout, language, or pronunciation rules require a new package', async () => {
      const current = identity(11);
      for (const change of [
        { chapters: [{ text: 'Changed' }, ...target.chapters.slice(1)] },
        { chapters: target.chapters.slice().reverse() },
        { book: { ...target.book, language: 'fr' } },
        { book: { ...target.book, addedAt: '2026-09-07T00:00:00Z' } },
        { rules: [{ source: 'First', replacement: 'Initial', wholeWord: true }] }
      ]) assert.equal((await store.select({ ...input, ...change, identity: current })).retained, false);
      assert.equal(sourceTextRevision(target, [{ source: 'a', replacement: 'b', id: '1' }]),
        sourceTextRevision(target, [{ source: 'a', replacement: 'b', id: '2', updatedAt: 9 }]));
      assert.equal(sourceTextRevision(target, []),
        sourceTextRevision(target, [{ source: 'absent phrase', replacement: 'ignored' }]));
    });
    await test('a missing or replaced artifact invalidates retained readiness', async () => {
      const key = `${old.sourceVariantKey}:2`;
      const original = packages.get(key);
      packages.delete(key);
      assert.equal((await store.select({ ...input, identity: identity(11) })).retained, false);
      await assert.rejects(store.remember({ ...input, identity: old }), /not complete/);
      packages.set(key, { ...original, artifactId: `sha256-${'f'.repeat(64)}` });
      assert.equal((await store.select({ ...input, identity: identity(11) })).retained, false);
      packages.set(key, original);
    });
    await test('corrupt catalog data cannot authorize a retained package', async () => {
      const files = await fs.readdir(cacheDir);
      assert.equal(files.length, 1);
      assert.equal(isManagedArtifactName('napoleon', files[0]), true);
      assert.equal(isManagedArtifactName('nap', files[0]), false);
      await fs.writeFile(path.join(cacheDir, files[0]), '{broken');
      assert.equal((await store.select({ ...input, identity: identity(11) })).retained, false);
    });
    await test('a cancelled publication does not leave a ready catalog', async () => {
      const controller = new AbortController(); controller.abort();
      await assert.rejects(store.remember({ ...input, bookId: 'cancelled', identity: old,
        signal: controller.signal }), error => error.name === 'AbortError');
      assert(!(await fs.readdir(cacheDir)).some(file => file.startsWith('cancelled_')));
    });
  } finally { await fs.rm(cacheDir, { recursive: true, force: true }); }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
