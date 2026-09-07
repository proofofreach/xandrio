const assert = require('node:assert/strict');
const express = require('express');
const { recoverOfflinePackage } = require('../lib/offline-package-recovery');
const { registerOfflineRecoveryRoutes } = require('../lib/routes/offline-recovery-routes');
const { createBookMutationLocks } = require('../lib/book-mutation-lock');
const { requireAdmin } = require('../lib/auth');

let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`  ✓ ${name}`); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const options = {
  bookId: 'napoleon', sourceVoice: 'kokoro:am_onyx',
  sourceVariantKey: 'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep8:audio6:br160k:pause350',
  acceptLegacy: true
};
function fixture() {
  const writes = [];
  const chapters = [{ text: 'First' }, { empty: true, text: '' }, { text: 'Last' }];
  return {
    writes,
    loadInput: async () => ({ book: { title: 'Napoleon', path: '/book.epub', addedAt: 'original' }, chapters, rules: [] }),
    audioPackage: {
      inspectChapter: async () => ({ ready: false, legacySize: 100 }),
      ensureChapter: async request => { assert.equal(request.sourcePath, undefined); await request.beforePublish(); return { size: 100 }; }
    },
    readyPackages: { remember: async request => { await request.beforePublish(); writes.push(request); } }
  };
}
async function withServer(f, run) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { role: req.headers['x-test-role'] || 'user' }; next(); });
  const locks = createBookMutationLocks();
  const service = registerOfflineRecoveryRoutes(app, { ...f, bookMutationLocks: locks,
    requireAdmin, afterRecovery: async () => ({ state: 'ready' }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/offline/preparation/napoleon/recover`;
  try { await run({ url, locks, service }); }
  finally { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const post = (url, init = {}) => fetch(url, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Test-Role': 'admin' },
  body: JSON.stringify({ ...options, acceptUnverifiedSourceAssociation: true }), ...init });

(async () => {
  await test('recovery requires an explicit assertion and preserves legacy provenance', async () => {
    const f = fixture();
    await assert.rejects(recoverOfflinePackage({ ...options, ...f, acceptLegacy: false }), /cannot verify/);
    assert.equal(f.writes.length, 0);
    const result = await recoverOfflinePackage({ ...options, ...f });
    assert.equal(result.chapters, 2);
    assert.equal(result.bytes, 200);
    assert.equal(result.provenance, 'legacy-unverified');
    assert.equal(f.writes[0].associationSource, 'operator');
    assert.match(result.packageVariantKey, /prep8:audio6/);
  });
  await test('a missing chapter prevents any package publication', async () => {
    const f = fixture(); let ensured = 0;
    f.audioPackage.inspectChapter = async request => ({ legacySize: request.chapterIndex === 2 ? 0 : 100 });
    f.audioPackage.ensureChapter = async () => { ensured++; };
    await assert.rejects(recoverOfflinePackage({ ...options, ...f }), /missing chapter 3/);
    assert.equal(ensured, 0);
    assert.equal(f.writes.length, 0);
  });
  await test('failed validation aborts and awaits its sibling before returning', async () => {
    const f = fixture(); let reaped = false;
    const started = deferred();
    f.audioPackage.ensureChapter = async request => {
      if (request.chapterIndex === 0) { await started.promise; throw new Error('decode failure'); }
      started.resolve();
      await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
      await delay(15); reaped = true;
      request.signal.throwIfAborted();
    };
    await assert.rejects(recoverOfflinePackage({ ...options, ...f }), /decode failure/);
    assert.equal(reaped, true);
    assert.equal(f.writes.length, 0);
  });
  await test('the recovery endpoint rejects non-admin callers before touching audio', async () => {
    const f = fixture(); let inspected = false;
    f.audioPackage.inspectChapter = async () => { inspected = true; return { legacySize: 100 }; };
    await withServer(f, async ({ url }) => {
      const response = await post(url, { headers: { 'Content-Type': 'application/json' } });
      assert.equal(response.status, 403); await response.arrayBuffer();
      assert.equal(inspected, false);
    });
  });
  await test('recovery and deletion share the same book lifecycle lock', async () => {
    const f = fixture(); const started = deferred(); const release = deferred();
    const ensure = f.audioPackage.ensureChapter;
    f.audioPackage.ensureChapter = async request => { started.resolve(); await release.promise; return ensure(request); };
    await withServer(f, async ({ url, locks }) => {
      const responsePromise = post(url);
      await started.promise;
      let deleted = false;
      const deletion = locks.withBookMutationLock('napoleon', async () => { deleted = true; });
      await delay(15); assert.equal(deleted, false);
      release.resolve();
      const response = await responsePromise;
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      assert.equal(events.at(-1).result.preparation.state, 'ready');
      assert.equal(f.writes.length, 1);
      await deletion; assert.equal(deleted, true);
    });
  });
  await test('shutdown aborts recovery and awaits all validation work', async () => {
    const f = fixture(); const started = deferred(); let active = 0;
    f.audioPackage.ensureChapter = async request => {
      active++; started.resolve();
      try {
        await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
        await delay(15); request.signal.throwIfAborted();
      } finally { active--; }
    };
    await withServer(f, async ({ url, service }) => {
      const controller = new AbortController();
      const response = post(url, { signal: controller.signal }).catch(() => null);
      await started.promise;
      await service.close();
      assert.equal(active, 0); assert.equal(f.writes.length, 0);
      controller.abort(); await response;
    });
  });
  console.log(`\n${passed} passed, 0 failed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
