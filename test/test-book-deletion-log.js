const assert = require('assert');
const { createBookDeletionLog } = require('../lib/book-deletion-log');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}

function harness() {
  let store;
  let token = 0;
  let currentTime = '2026-07-25T12:00:00.000Z';
  const updateJSON = async (_file, mutator, fallback) => {
    const working = structuredClone(store ?? fallback);
    const result = await mutator(working);
    store = working;
    return result;
  };
  const loadJSON = async (_file, fallback) => structuredClone(store ?? fallback);
  const open = () => createBookDeletionLog({
    filePath: 'book-deletions.json',
    loadJSON,
    updateJSON,
    now: () => currentTime,
    createToken: () => `token-${++token}`
  });
  const log = open();
  return {
    log,
    // A fresh instance over the same file models a restarted process.
    reopen: open,
    getStore: () => structuredClone(store),
    setTime: value => { currentTime = value; }
  };
}

(async () => {
  await test('publishes only committed deletions after a caller cursor', async () => {
    const { log } = harness();
    const token = await log.begin('book-1');
    assert.deepStrictEqual(await log.listSince(0), { revision: 0, deletions: [] });

    await log.commit(token);
    assert.deepStrictEqual(await log.listSince(0), {
      revision: 1,
      deletions: [{
        bookId: 'book-1',
        revision: 1,
        deletedAt: '2026-07-25T12:00:00.000Z'
      }]
    });
    assert.deepStrictEqual(await log.listSince(1), { revision: 1, deletions: [] });
  });

  await test('reconciles interrupted deletion transactions against the catalog', async () => {
    const { log, reopen, setTime } = harness();
    await log.begin('missing-book');
    await log.begin('restored-book');
    setTime('2026-07-25T13:00:00.000Z');

    const restarted = reopen();
    await restarted.reconcile({ 'restored-book': { id: 'restored-book' } });
    const result = await restarted.listSince(0);
    assert.strictEqual(result.revision, 1);
    assert.deepStrictEqual(result.deletions.map(item => item.bookId), ['missing-book']);
    assert.strictEqual(result.deletions[0].deletedAt, '2026-07-25T12:00:00.000Z');
  });

  await test('a feed read during a live deletion does not lose its entry', async () => {
    const { log } = harness();
    const token = await log.begin('book-1');
    // GET /api/offline/deletions reconciles while the book is still in the
    // catalog, before the deletion removes it and commits.
    await log.reconcile({ 'book-1': { id: 'book-1' } });
    await log.commit(token);
    const result = await log.listSince(0);
    assert.deepStrictEqual(result.deletions.map(item => item.bookId), ['book-1']);
    assert.strictEqual(result.deletions[0].deletedAt, '2026-07-25T12:00:00.000Z');
  });

  await test('commit records the deletion even if another writer cleared its pending entry', async () => {
    const { log, reopen, getStore } = harness();
    const token = await log.begin('book-1');
    await reopen().reconcile({ 'book-1': { id: 'book-1' } });
    assert.strictEqual(getStore().pending[token], undefined);
    await log.commit(token);
    assert.deepStrictEqual((await log.listSince(0)).deletions.map(item => item.bookId), ['book-1']);
  });

  await test('reconcile leaves a live deletion alone and an aborted one publishes nothing', async () => {
    const { log, getStore } = harness();
    const token = await log.begin('book-1');
    await log.reconcile({});
    assert.ok(getStore().pending[token], 'reconcile skips the live transaction');
    await log.abort(token);
    await log.reconcile({});
    assert.deepStrictEqual(await log.listSince(0), { revision: 0, deletions: [] });
  });

  await test('repeated deletion of the same id advances the revision', async () => {
    const { log } = harness();
    await log.commit(await log.begin('book-1'));
    await log.commit(await log.begin('book-1'));
    assert.deepStrictEqual(await log.listSince(1), {
      revision: 2,
      deletions: [{
        bookId: 'book-1',
        revision: 2,
        deletedAt: '2026-07-25T12:00:00.000Z'
      }]
    });
  });

  await test('a re-import after the deletion supersedes it in the feed', async () => {
    // A client with an old cursor must not delete the copy it downloads of
    // the re-imported book. Both stamps come from the server clock.
    const { log } = harness();
    await log.commit(await log.begin('book-1'));
    await log.commit(await log.begin('book-2'));
    const books = {
      'book-1': { id: 'book-1', addedAt: '2026-07-25T12:05:00.000Z' }
    };
    assert.deepStrictEqual(await log.listSince(0, { books }), {
      revision: 2,
      deletions: [{
        bookId: 'book-2',
        revision: 2,
        deletedAt: '2026-07-25T12:00:00.000Z'
      }]
    });
  });

  await test('a catalog record older than the deletion does not hide it', async () => {
    // A catalog snapshot read before a second deletion still shows the
    // re-imported record; the newer deletion must stay in the feed.
    const { log, setTime } = harness();
    setTime('2026-07-25T12:10:00.000Z');
    await log.commit(await log.begin('book-1'));
    const listed = await log.listSince(0, {
      books: { 'book-1': { id: 'book-1', addedAt: '2026-07-25T12:05:00.000Z' } }
    });
    assert.deepStrictEqual(listed.deletions.map(item => item.bookId), ['book-1']);
    const legacy = await log.listSince(0, { books: { 'book-1': { id: 'book-1' } } });
    assert.deepStrictEqual(legacy.deletions.map(item => item.bookId), ['book-1'],
      'a record without an import time cannot be ordered and keeps the deletion');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
