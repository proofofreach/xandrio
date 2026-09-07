const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, webkit } = require('playwright');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'offline-store.js'));
const BLOCK_SIZE = 1024 * 1024;
const artifactA = `sha256-${'a'.repeat(64)}`;
const artifactB = `sha256-${'b'.repeat(64)}`;
const artifactC = `sha256-${'c'.repeat(64)}`;
let passed = 0;
let failed = 0;

function descriptor(artifactId, size = 4, index = 0) {
  return {
    index,
    state: 'ready',
    artifactId,
    contentHash: artifactId,
    etag: `"${artifactId}"`,
    size,
    blockSize: BLOCK_SIZE,
    blockHashes: Array.from({ length: Math.ceil(size / BLOCK_SIZE) }, (_, block) =>
      `sha256-${String(block + 1).padStart(64, '0')}`
    ),
    url: `/api/offline/audio/book/${index}`,
    contentType: 'audio/mpeg'
  };
}

async function test(browserName, name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ [${browserName}] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ [${browserName}] ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

async function main() {
  const server = http.createServer((request, response) => {
    if (request.url !== '/offline-store.js') return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end(source);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const requested = String(process.env.OFFLINE_STORE_BROWSER || 'all').toLowerCase();
  const engines = requested === 'all'
    ? [['chromium', chromium], ['webkit', webkit]]
    : [[requested, { chromium, webkit }[requested]]];

  for (const [browserName, browserType] of engines) {
    if (!browserType) throw new Error(`Unknown OFFLINE_STORE_BROWSER: ${requested}`);
    let browser;
    try {
      browser = await browserType.launch({ headless: true });
    } catch (error) {
      if (requested !== 'all') throw error;
      console.log(`  - [${browserName}] skipped: ${error.message.split('\n')[0]}`);
      continue;
    }

    async function pageForTest() {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(origin);
      await page.addScriptTag({ url: `${origin}/offline-store.js` });
      return { page, context };
    }

    await test(browserName, 'commits pending bytes only after readback verification', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async ({ descriptor, artifact }) => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');
          const fence = await store.captureFence(token, 'scope', 'book');
          await store.saveTitle('scope', { bookId: 'book', revision: 'r1' }, fence);
          await store.putChapter('scope', 'book', 'r1', descriptor, fence);
          await store.putPendingBlock('scope', artifact, 0, new Uint8Array([1, 2, 3, 4]), fence);
          let prematureReady = false;
          try { await store.markChapterReady('scope', artifact, fence); } catch { prematureReady = true; }
          const pending = await XandrioOfflineStore.createAudioResponse(
            new Request(`http://reader.test/__xandrio_offline__/audio/scope/${artifact}`),
            { store, workerVersion: 'sw' }
          );
          const readback = await store.getBlock('scope', artifact, 0);
          await store.markBlockVerified('scope', artifact, 0, readback.writeId, fence);
          await store.markChapterReady('scope', artifact, fence);
          const hit = await XandrioOfflineStore.createAudioResponse(
            new Request(`http://reader.test/__xandrio_offline__/audio/scope/${artifact}`),
            { store, workerVersion: 'sw' }
          );
          return {
            prematureReady,
            pending: pending.status,
            readback: [...new Uint8Array(readback.bytes)],
            state: readback.state,
            hit: hit.status,
            bytes: [...new Uint8Array(await hit.arrayBuffer())]
          };
        }, { descriptor: descriptor(artifactA), artifact: artifactA });
        assert.deepStrictEqual(result, {
          prematureReady: true, pending: 504, readback: [1, 2, 3, 4],
          state: 'pending', hit: 200, bytes: [1, 2, 3, 4]
        });
      } finally { await context.close(); }
    });

    await test(browserName, 'rolls back rejected block writes and fences expired leases', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async ({ descriptor, artifact }) => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const tokenA = await store.acquireLease('writer-a');
          const fenceA = await store.captureFence(tokenA, 'scope', 'book');
          await store.saveTitle('scope', { bookId: 'book', revision: 'r1' }, fenceA);
          await store.putChapter('scope', 'book', 'r1', descriptor, fenceA);
          let badSize = false;
          try { await store.putPendingBlock('scope', artifact, 0, new Uint8Array(3), fenceA); } catch { badSize = true; }
          const afterBadSize = await store.getBlock('scope', artifact, 0);
          globalThis.__clock += 15_001;
          const tokenB = await store.acquireLease('writer-b');
          let expired = false;
          try { await store.putPendingBlock('scope', artifact, 0, new Uint8Array(4), fenceA); } catch { expired = true; }
          return { badSize, absent: afterBadSize === null, expired, newEpoch: tokenB.epoch, oldEpoch: tokenA.epoch };
        }, { descriptor: descriptor(artifactA), artifact: artifactA });
        assert.deepStrictEqual(result, { badSize: true, absent: true, expired: true, newEpoch: 2, oldEpoch: 1 });
      } finally { await context.close(); }
    });

    await test(browserName, 'uses write generations for verification and conditional deletion', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async ({ descriptor, artifact }) => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');
          const fence = await store.captureFence(token, 'scope', 'book');
          await store.saveTitle('scope', { bookId: 'book', revision: 'r1' }, fence);
          await store.putChapter('scope', 'book', 'r1', descriptor, fence);
          const first = await store.putPendingBlock('scope', artifact, 0, new Uint8Array(4).fill(1), fence);
          const firstRead = await store.getBlock('scope', artifact, 0);
          const second = await store.putPendingBlock('scope', artifact, 0, new Uint8Array(4).fill(2), fence);
          const staleMark = await store.markBlockVerified('scope', artifact, 0, firstRead.writeId, fence);
          const staleDelete = await store.deleteBlock('scope', artifact, 0, fence, firstRead.writeId);
          const current = await store.getBlock('scope', artifact, 0);
          const currentMark = await store.markBlockVerified('scope', artifact, 0, second, fence);
          const verified = await store.getBlock('scope', artifact, 0);
          return {
            distinct: first !== second,
            staleMark,
            staleDelete,
            currentWriteId: current.writeId,
            currentBytes: [...new Uint8Array(current.bytes)],
            currentMark,
            verifiedState: verified.state
          };
        }, { descriptor: descriptor(artifactA), artifact: artifactA });
        const { currentWriteId, ...state } = result;
        assert.deepStrictEqual(state, {
          distinct: true,
          staleMark: false,
          staleDelete: false,
          currentBytes: [2, 2, 2, 2],
          currentMark: true,
          verifiedState: 'verified'
        });
        assert.ok(currentWriteId);
      } finally { await context.close(); }
    });

    await test(browserName, 'enumerates block metadata without opening stored values', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async ({ descriptor, artifact }) => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');
          const fence = await store.captureFence(token, 'scope', 'book');
          await store.saveTitle('scope', { bookId: 'book', revision: 'r1' }, fence);
          await store.putChapter('scope', 'book', 'r1', descriptor, fence);
          await store.putPendingBlock('scope', artifact, 0, new Uint8Array(4), fence);
          const original = IDBIndex.prototype.openCursor;
          IDBIndex.prototype.openCursor = function forbiddenValueCursor() {
            throw new Error('listBlocks opened block values');
          };
          try {
            return await store.listBlocks('scope', artifact);
          } finally {
            IDBIndex.prototype.openCursor = original;
          }
        }, { descriptor: descriptor(artifactA), artifact: artifactA });
        assert.deepStrictEqual(result, [{ index: 0, state: 'pending', size: 4 }]);
      } finally { await context.close(); }
    });

    await test(browserName, 'uses a durable lease epoch across tabs and release/reacquire', async () => {
      const context = await browser.newContext();
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      try {
        for (const page of [pageA, pageB]) {
          await page.goto(origin);
          await page.addScriptTag({ url: `${origin}/offline-store.js` });
          await page.evaluate(() => {
            globalThis.__clock = 1_000;
            globalThis.__store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          });
        }
        const tokenA = await pageA.evaluate(() => __store.acquireLease('tab-a'));
        const blocked = await pageB.evaluate(() => __store.acquireLease('tab-b'));
        await pageA.evaluate(async ({ token, descriptor }) => {
          globalThis.__token = token;
          globalThis.__fence = await __store.captureFence(token, 'scope', 'book');
          await __store.saveTitle('scope', { bookId: 'book', revision: 'r1' }, __fence);
          await __store.putChapter('scope', 'book', 'r1', descriptor, __fence);
          await __store.releaseLease(token);
        }, { token: tokenA, descriptor: descriptor(artifactA) });
        const tokenB = await pageB.evaluate(() => __store.acquireLease('tab-b'));
        const stale = await pageA.evaluate(async artifact => {
          let rejected = false;
          try { await __store.putPendingBlock('scope', artifact, 0, new Uint8Array(4), __fence); } catch { rejected = true; }
          return rejected;
        }, artifactA);
        assert.strictEqual(blocked, null);
        assert.strictEqual(tokenB.epoch, tokenA.epoch + 1);
        assert.strictEqual(stale, true);
      } finally { await context.close(); }
    });

    await test(browserName, 'tombstones deletions and blocks legacy resurrection', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async ({ descriptor, artifact }) => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');
          const fence = await store.captureFence(token, 'scope', 'book');
          await store.saveTitle('scope', { bookId: 'book', revision: 'r1', title: 'Saved' }, fence);
          await store.putChapter('scope', 'book', 'r1', descriptor, fence);
          await store.putPendingBlock('scope', artifact, 0, new Uint8Array(4), fence);
          await store.deleteTitle('scope', 'book');
          let staleWrite = false;
          try { await store.putPendingBlock('scope', artifact, 0, new Uint8Array(4), fence); } catch { staleWrite = true; }
          await store.importLegacy('scope', { book: { bookId: 'book', title: 'Legacy', manifestVersion: 3 } });
          return {
            staleWrite,
            titles: await store.listTitles('scope'),
            block: await store.getBlock('scope', artifact, 0),
            chapter: await store.getChapter('scope', artifact)
          };
        }, { descriptor: descriptor(artifactA), artifact: artifactA });
        assert.strictEqual(result.staleWrite, true);
        assert.deepStrictEqual(result.titles, {});
        assert.strictEqual(result.block, null);
        assert.strictEqual(result.chapter, null);
      } finally { await context.close(); }
    });

    await test(browserName, 'requires explicit user intent to revive a tombstoned title', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async () => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');
          const firstFence = await store.captureFence(token, 'scope', 'book');
          await store.saveTitle('scope', { bookId: 'book', revision: 'r1', title: 'First' }, firstFence);
          await store.deleteTitle('scope', 'book');
          const freshFence = await store.captureFence(token, 'scope', 'book');
          let rejected = false;
          try {
            await store.saveTitle('scope', { bookId: 'book', revision: 'r2', title: 'Accidental' }, freshFence);
          } catch { rejected = true; }
          await store.reviveTitle('scope', 'book', freshFence);
          await store.saveTitle('scope', { bookId: 'book', revision: 'r2', title: 'Explicit' }, freshFence);
          return { rejected, titles: await store.listTitles('scope') };
        });
        assert.strictEqual(result.rejected, true);
        assert.strictEqual(result.titles.book.title, 'Explicit');
        assert.strictEqual(result.titles.book.revision, 'r2');
      } finally { await context.close(); }
    });

    await test(browserName, 'advances non-ready revisions so pause survives a cold reopen', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async () => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');
          const pendingFence = await store.captureFence(token, 'scope', 'book');
          await store.saveTitle('scope', {
            bookId: 'book', revision: 'pending-1000', mode: 'full', state: 'preparing', autoResume: true
          }, pendingFence);
          await store.saveTitle('scope', {
            bookId: 'book', revision: 'source-r2', mode: 'full', state: 'paused', autoResume: false
          }, pendingFence);
          const reopened = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const titles = await reopened.listTitles('scope');
          return titles.book;
        });
        assert.strictEqual(result.revision, 'source-r2');
        assert.strictEqual(result.state, 'paused');
        assert.strictEqual(result.autoResume, false);
      } finally { await context.close(); }
    });

    await test(browserName, 'atomically finalizes a replacement and retains shared rolling artifacts', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async ({ oldOnly, shared, replacement, descriptors }) => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');
          const oldFence = await store.captureFence(token, 'scope', 'book');
          const sharedFence = await store.captureFence(token, 'scope', 'shared-book');
          await store.saveTitle('scope', {
            bookId: 'book', revision: 'old', mode: 'full', state: 'ready', title: 'Old'
          }, oldFence);
          await store.saveTitle('scope', {
            bookId: 'shared-book', revision: 'shared-r1', mode: 'rolling', state: 'partial'
          }, sharedFence);
          await store.putChapter('scope', 'book', 'old', descriptors.oldOnly, oldFence, 'full');
          await store.putChapter('scope', 'book', 'old', descriptors.shared, oldFence, 'full');
          await store.putChapter('scope', 'shared-book', 'shared-r1', descriptors.shared, sharedFence, 'rolling');
          for (const [artifact, fence, value] of [[oldOnly, oldFence, 1], [shared, oldFence, 2]]) {
            const writeId = await store.putPendingBlock('scope', artifact, 0, new Uint8Array(4).fill(value), fence);
            await store.markBlockVerified('scope', artifact, 0, writeId, fence);
            await store.markChapterReady('scope', artifact, fence);
          }

          await store.saveTitle('scope', {
            bookId: 'book', revision: 'new', mode: 'full', state: 'ready', title: 'New'
          }, oldFence);
          await store.putChapter('scope', 'book', 'new', descriptors.replacement, oldFence, 'full');
          const replacementWrite = await store.putPendingBlock(
            'scope', replacement, 0, new Uint8Array(4).fill(3), oldFence
          );
          await store.markBlockVerified('scope', replacement, 0, replacementWrite, oldFence);
          await store.markChapterReady('scope', replacement, oldFence);
          const before = await store.listTitles('scope');
          const finalized = await store.finalizeTitle('scope', 'book', 'new', oldFence);
          const after = await store.listTitles('scope');

          const db = await store.open();
          const tx = db.transaction(['titles', 'chapters', 'artifactRefs'], 'readonly');
          const collect = objectStore => new Promise((resolve, reject) => {
            const values = [];
            const request = objectStore.openCursor();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) return resolve(values);
              values.push(cursor.value);
              cursor.continue();
            };
          });
          const [titles, chapters, refs] = await Promise.all([
            collect(tx.objectStore('titles')),
            collect(tx.objectStore('chapters')),
            collect(tx.objectStore('artifactRefs'))
          ]);
          return {
            before: before.book,
            finalized,
            after: after.book,
            oldOnlyBlock: await store.getBlock('scope', oldOnly, 0),
            sharedBlock: await store.getBlock('scope', shared, 0),
            replacementBlock: await store.getBlock('scope', replacement, 0),
            bookTitles: titles.filter(row => row.bookId === 'book').map(row => row.revision),
            bookChapters: chapters.filter(row => row.bookId === 'book').map(row => row.revision),
            oldBookRefs: refs.filter(row => row.ownerId === 'book').map(row => [row.artifactId, row.ownerKind]),
            sharedRefs: refs.filter(row => row.ownerId === 'shared-book').map(row => [row.artifactId, row.ownerKind])
          };
        }, {
          oldOnly: artifactA,
          shared: artifactC,
          replacement: artifactB,
          descriptors: {
            oldOnly: descriptor(artifactA, 4, 0),
            shared: descriptor(artifactC, 4, 1),
            replacement: descriptor(artifactB, 4, 0)
          }
        });
        assert.strictEqual(result.before.revision, 'old');
        assert.strictEqual(result.before.title, 'Old');
        assert.strictEqual(result.finalized.revision, 'new');
        assert.strictEqual(result.after.revision, 'new');
        assert.strictEqual(result.oldOnlyBlock, null);
        assert.strictEqual(result.sharedBlock.state, 'verified');
        assert.strictEqual(result.replacementBlock.state, 'verified');
        assert.deepStrictEqual(result.bookTitles, ['new']);
        assert.deepStrictEqual(result.bookChapters, ['new']);
        assert.deepStrictEqual(result.oldBookRefs, [[artifactB, 'full']]);
        assert.deepStrictEqual(result.sharedRefs, [[artifactC, 'rolling']]);
      } finally { await context.close(); }
    });

    await test(browserName, 'preserves full ownership through finalize and prune in either registration order', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async ({ artifacts, descriptors }) => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');

          async function register(bookId, artifactId, descriptor, ownerKinds) {
            const fence = await store.captureFence(token, 'scope', bookId);
            await store.saveTitle('scope', {
              bookId,
              revision: 'r1',
              mode: 'full',
              state: 'ready',
              autoResume: false,
              chapterEntries: [{ artifactId }]
            }, fence);
            for (const ownerKind of ownerKinds) {
              await store.putChapter('scope', bookId, 'r1', descriptor, fence, ownerKind);
            }
            const writeId = await store.putPendingBlock(
              'scope', artifactId, 0, new Uint8Array(4).fill(ownerKinds[0] === 'full' ? 1 : 2), fence
            );
            await store.markBlockVerified('scope', artifactId, 0, writeId, fence);
            await store.markChapterReady('scope', artifactId, fence);
            await store.finalizeTitle('scope', bookId, 'r1', fence);
            await store.pruneRolling('scope', bookId, [], fence);
            return {
              block: await store.getBlock('scope', artifactId, 0),
              chapter: await store.getChapter('scope', artifactId)
            };
          }

          return {
            fullThenRolling: await register(
              'full-then-rolling', artifacts.fullThenRolling,
              descriptors.fullThenRolling, ['full', 'rolling']
            ),
            rollingThenFull: await register(
              'rolling-then-full', artifacts.rollingThenFull,
              descriptors.rollingThenFull, ['rolling', 'full']
            )
          };
        }, {
          artifacts: { fullThenRolling: artifactA, rollingThenFull: artifactB },
          descriptors: {
            fullThenRolling: descriptor(artifactA),
            rollingThenFull: descriptor(artifactB)
          }
        });
        for (const value of Object.values(result)) {
          assert.strictEqual(value.block.state, 'verified');
          assert.deepStrictEqual(value.chapter.ownerKinds, ['full']);
          assert.strictEqual(value.chapter.ownerKind, 'full');
        }
      } finally { await context.close(); }
    });

    await test(browserName, 'keeps shared and full references during rolling prune', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async ({ descriptor, artifact }) => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');
          const a = await store.captureFence(token, 'scope', 'book-a');
          const b = await store.captureFence(token, 'scope', 'book-b');
          await store.saveTitle('scope', { bookId: 'book-a', revision: 'r1' }, a);
          await store.saveTitle('scope', { bookId: 'book-b', revision: 'r1' }, b);
          await store.putChapter('scope', 'book-a', 'r1', descriptor, a, 'rolling');
          await store.putChapter('scope', 'book-a', 'r1', descriptor, a, 'full');
          await store.putChapter('scope', 'book-b', 'r1', descriptor, b, 'rolling');
          const writeId = await store.putPendingBlock('scope', artifact, 0, new Uint8Array([1, 2, 3, 4]), a);
          await store.markBlockVerified('scope', artifact, 0, writeId, a);
          await store.pruneRolling('scope', 'book-a', [], a);
          const afterA = await store.getBlock('scope', artifact, 0);
          await store.deleteTitle('scope', 'book-b');
          const afterB = await store.getBlock('scope', artifact, 0);
          return { afterA: afterA?.state, afterB: afterB?.state };
        }, { descriptor: descriptor(artifactA), artifact: artifactA });
        assert.deepStrictEqual(result, { afterA: 'verified', afterB: 'verified' });
      } finally { await context.close(); }
    });

    await test(browserName, 'rejects cross-account fences and fences both account scopes', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async ({ descriptor, artifact }) => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');
          const a = await store.captureFence(token, 'account-a', 'book');
          const b = await store.captureFence(token, 'account-b', 'book');
          await store.saveTitle('account-a', { bookId: 'book', revision: 'r1' }, a);
          await store.putChapter('account-a', 'book', 'r1', descriptor, a);
          let crossed = false;
          try { await store.putPendingBlock('account-a', artifact, 0, new Uint8Array(4), b); } catch { crossed = true; }
          await store.fenceScopes('account-a', 'account-b');
          let oldA = false;
          let oldB = false;
          try { await store.putPendingBlock('account-a', artifact, 0, new Uint8Array(4), a); } catch { oldA = true; }
          try { await store.saveTitle('account-b', { bookId: 'book', revision: 'r1' }, b); } catch { oldB = true; }
          return { crossed, oldA, oldB, block: await store.getBlock('account-a', artifact, 0) };
        }, { descriptor: descriptor(artifactA), artifact: artifactA });
        assert.deepStrictEqual(result, { crossed: true, oldA: true, oldB: true, block: null });
      } finally { await context.close(); }
    });

    await test(browserName, 'serves HEAD, If-Range, 416, and a bounded near-end range', async () => {
      const { page, context } = await pageForTest();
      try {
        const size = (2 * BLOCK_SIZE) + 2;
        const result = await page.evaluate(async ({ descriptor, artifact, blockSize }) => {
          globalThis.__clock = 1_000;
          const store = XandrioOfflineStore.createStore({ now: () => globalThis.__clock });
          const token = await store.acquireLease('writer');
          const fence = await store.captureFence(token, 'scope', 'book');
          await store.saveTitle('scope', { bookId: 'book', revision: 'r1' }, fence);
          await store.putChapter('scope', 'book', 'r1', descriptor, fence);
          for (const [index, value, length] of [[0, 1, blockSize], [1, 2, blockSize], [2, 3, 2]]) {
            const writeId = await store.putPendingBlock('scope', artifact, index, new Uint8Array(length).fill(value), fence);
            await store.markBlockVerified('scope', artifact, index, writeId, fence);
          }
          await store.markChapterReady('scope', artifact, fence);
          let reads = 0;
          const measured = {
            getChapter: (...args) => store.getChapter(...args),
            getBlock: (...args) => { reads += 1; return store.getBlock(...args); },
            listBlocks: () => { throw new Error('near-end response enumerated the artifact'); }
          };
          const url = `http://reader.test/__xandrio_offline__/audio/scope/${artifact}`;
          const tail = await XandrioOfflineStore.createAudioResponse(
            new Request(url, { headers: { Range: `bytes=${descriptor.size - 2}-` } }),
            { store: measured, workerVersion: 'sw' }
          );
          const tailBytes = [...new Uint8Array(await tail.arrayBuffer())];
          const readsAfterTail = reads;
          const head = await XandrioOfflineStore.createAudioResponse(
            new Request(url, { method: 'HEAD', headers: { Range: 'bytes=2-3', 'If-Range': descriptor.etag } }),
            { store: measured, workerVersion: 'sw' }
          );
          const malformed = await XandrioOfflineStore.createAudioResponse(
            new Request(url, { headers: { Range: 'bytes=4-2' } }),
            { store: measured, workerVersion: 'sw' }
          );
          const mismatch = await XandrioOfflineStore.createAudioResponse(
            new Request(url, { method: 'HEAD', headers: { Range: 'bytes=999999999-', 'If-Range': '"other"' } }),
            { store: measured, workerVersion: 'sw' }
          );
          return {
            tail: {
              status: tail.status,
              range: tail.headers.get('Content-Range'),
              bytes: tailBytes,
              wholeHash: tail.headers.get('X-Xandrio-Content-SHA256'),
              artifactHash: tail.headers.get('X-Xandrio-Artifact-SHA256'),
              cacheControl: tail.headers.get('Cache-Control')
            },
            readsAfterTail,
            readsAfterHead: reads,
            head: { status: head.status, length: head.headers.get('Content-Length'), body: (await head.arrayBuffer()).byteLength },
            malformed: { status: malformed.status, range: malformed.headers.get('Content-Range') },
            mismatch: { status: mismatch.status, length: mismatch.headers.get('Content-Length') }
          };
        }, { descriptor: descriptor(artifactA, size), artifact: artifactA, blockSize: BLOCK_SIZE });
        assert.deepStrictEqual(result.tail, {
          status: 206,
          range: `bytes ${size - 2}-${size - 1}/${size}`,
          bytes: [3, 3],
          wholeHash: null,
          artifactHash: artifactA,
          cacheControl: 'no-store'
        });
        assert.strictEqual(result.readsAfterTail, 1);
        assert.strictEqual(result.readsAfterHead, 1);
        assert.deepStrictEqual(result.head, { status: 206, length: '2', body: 0 });
        assert.deepStrictEqual(result.malformed, { status: 416, range: `bytes */${size}` });
        assert.deepStrictEqual(result.mismatch, { status: 200, length: String(size) });
      } finally { await context.close(); }
    });

    await test(browserName, 'imports legacy metadata and distinguishes miss from indeterminate', async () => {
      const { page, context } = await pageForTest();
      try {
        const result = await page.evaluate(async ({ artifactA, artifactB }) => {
          const store = XandrioOfflineStore.createStore();
          await store.importLegacy('scope', {
            legacy: { bookId: 'legacy', title: 'Old download', chapterEntries: [{ contentHash: artifactA }], manifestVersion: 3 }
          });
          const legacyTitles = await store.listTitles('scope');
          const legacyChapter = await store.getChapter('scope', artifactA);
          const request = new Request(`http://reader.test/__xandrio_offline__/audio/scope/${artifactB}`);
          const miss = await XandrioOfflineStore.createAudioResponse(request, {
            store: { getChapter: async () => null }, workerVersion: 'sw'
          });
          const indeterminate = await XandrioOfflineStore.createAudioResponse(request, {
            store: { getChapter: async () => { throw new Error('IDB failed'); } }, workerVersion: 'sw'
          });
          return {
            title: legacyTitles.legacy?.title,
            legacyChapter,
            miss: [miss.status, miss.headers.get('X-Xandrio-Offline-Cache')],
            indeterminate: [indeterminate.status, indeterminate.headers.get('X-Xandrio-Offline-Cache')]
          };
        }, { artifactA, artifactB });
        assert.deepStrictEqual(result, {
          title: 'Old download', legacyChapter: null,
          miss: [504, 'miss'], indeterminate: [503, 'indeterminate']
        });
      } finally { await context.close(); }
    });

    await browser.close();
  }

  await new Promise(resolve => server.close(resolve));
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
