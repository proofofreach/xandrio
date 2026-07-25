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
  const log = createBookDeletionLog({
    filePath: 'book-deletions.json',
    loadJSON,
    updateJSON,
    now: () => currentTime,
    createToken: () => `token-${++token}`
  });
  return {
    log,
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
    const { log, setTime } = harness();
    await log.begin('missing-book');
    await log.begin('restored-book');
    setTime('2026-07-25T13:00:00.000Z');

    await log.reconcile({ 'restored-book': { id: 'restored-book' } });
    const result = await log.listSince(0);
    assert.strictEqual(result.revision, 1);
    assert.deepStrictEqual(result.deletions.map(item => item.bookId), ['missing-book']);
    assert.strictEqual(result.deletions[0].deletedAt, '2026-07-25T12:00:00.000Z');
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
