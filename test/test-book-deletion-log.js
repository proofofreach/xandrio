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

// The epoch is a random lineage id; tests of feed content leave it out.
function withoutEpoch({ epoch, ...rest }) { return rest; }

function harness() {
  const LOG_FILE = 'book-deletions.json';
  const files = new Map();
  let token = 0;
  let currentTime = '2026-07-25T12:00:00.000Z';
  const updateJSON = async (file, mutator, fallback) => {
    const working = structuredClone(files.get(file) ?? fallback);
    const result = await mutator(working);
    files.set(file, working);
    return result;
  };
  const loadJSON = async (file, fallback) => structuredClone(files.get(file) ?? fallback);
  const open = () => createBookDeletionLog({
    filePath: LOG_FILE,
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
    getStore: () => structuredClone(files.get(LOG_FILE)),
    // Models an operator restoring an older copy of the log file only.
    setStore: value => { files.set(LOG_FILE, structuredClone(value)); },
    setTime: value => { currentTime = value; }
  };
}

(async () => {
  await test('publishes only committed deletions after a caller cursor', async () => {
    const { log } = harness();
    const token = await log.begin('book-1');
    assert.deepStrictEqual(withoutEpoch(await log.listSince(0)), { revision: 0, deletions: [] });

    await log.commit(token);
    assert.deepStrictEqual(withoutEpoch(await log.listSince(0)), {
      revision: 1,
      deletions: [{
        bookId: 'book-1',
        revision: 1,
        deletedAt: '2026-07-25T12:00:00.000Z'
      }]
    });
    assert.deepStrictEqual(withoutEpoch(await log.listSince(1)), { revision: 1, deletions: [] });
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
    assert.deepStrictEqual(withoutEpoch(await log.listSince(0)), { revision: 0, deletions: [] });
  });

  await test('repeated deletion of the same id advances the revision', async () => {
    const { log } = harness();
    await log.commit(await log.begin('book-1'));
    await log.commit(await log.begin('book-1'));
    assert.deepStrictEqual(withoutEpoch(await log.listSince(1)), {
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
    assert.deepStrictEqual(withoutEpoch(await log.listSince(0, { books })), {
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

  await test('restoring an older log never reissues a revision clients have seen', async () => {
    const { log, reopen, getStore, setStore } = harness();
    await log.commit(await log.begin('book-1'));
    const backup = getStore();
    await log.commit(await log.begin('book-2'));
    await log.commit(await log.begin('book-3'));
    const clientCursor = (await log.listSince(0)).revision;
    assert.strictEqual(clientCursor, 3);

    setStore(backup);
    const restarted = reopen();
    assert.strictEqual((await restarted.listSince(0)).revision, 3,
      'the reported revision does not move a client cursor backwards');
    await restarted.commit(await restarted.begin('book-4'));
    const after = await restarted.listSince(clientCursor);
    assert.deepStrictEqual(after.deletions.map(item => [item.bookId, item.revision]), [['book-4', 4]]);
  });

  await test('reconcile after a restore also allocates above the high-water mark', async () => {
    const { log, reopen, getStore, setStore } = harness();
    const backup = getStore() ?? { version: 1, revision: 0, pending: {}, deletions: {} };
    await log.commit(await log.begin('book-1'));
    await log.commit(await log.begin('book-2'));
    backup.pending = {
      orphanA: { bookId: 'book-a', requestedAt: '2026-07-25T12:00:00.000Z' },
      orphanB: { bookId: 'book-b', requestedAt: '2026-07-25T12:00:00.000Z' }
    };
    setStore(backup);
    await reopen().reconcile({});
    const revisions = (await reopen().listSince(2)).deletions.map(item => item.revision);
    assert.deepStrictEqual(revisions, [3, 4]);
  });

  await test('the feed names its lineage, so a log created afresh is told apart from the old one', async () => {
    const first = harness();
    await first.log.commit(await first.log.begin('book-1'));
    const before = await first.log.listSince(0);
    assert.strictEqual(typeof before.epoch, 'string');
    assert.ok(before.epoch.length > 0);
    await first.log.commit(await first.log.begin('book-2'));
    assert.strictEqual((await first.reopen().listSince(0)).epoch, before.epoch, 'the epoch is stable across writes and restarts');
    // A wiped DATA_DIR: a new log whose revision soon passes an old cursor.
    const fresh = harness();
    for (const id of ['a', 'b', 'c']) await fresh.log.commit(await fresh.log.begin(id));
    const after = await fresh.log.listSince(0);
    assert.ok(after.revision > before.revision);
    assert.notStrictEqual(after.epoch, before.epoch);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
