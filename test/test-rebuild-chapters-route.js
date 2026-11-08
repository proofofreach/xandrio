const assert = require('node:assert/strict');
const { registerLibraryBookRoutes } = require('../lib/routes/library-book-routes');

let passed = 0;
let failed = 0;

async function test(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

function harness(rebuildResult) {
  const routes = new Map();
  const app = new Proxy({}, {
    get: (_target, method) => (path, ...handlers) => routes.set(`${String(method).toUpperCase()} ${path}`, handlers.at(-1))
  });
  const books = { book_1: { id: 'book_1', path: '/cache/book_1.xbook.json' } };
  registerLibraryBookRoutes(app, {
    booksFile: 'books.json',
    loadJSON: async () => structuredClone(books),
    jsonStore: { SKIP_SAVE: Symbol('skip') },
    bookMutationLocks: { withBookMutationLock: (_id, task) => task() },
    chapterRebuildService: { rebuild: async () => rebuildResult },
    getChaptersCached: async () => [{ index: 0, title: 'One' }],
    normalizeChapterTitleForDisplay: title => title,
    publicBookRecord: book => ({ id: book.id }),
    sendServerError: (res, error) => res.status(500).json({ error: error.message })
  });
  return async () => {
    const res = {
      statusCode: 200,
      headers: {},
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      setHeader(name, value) { this.headers[name] = value; }
    };
    await routes.get('POST /api/book/:bookId/rebuild-chapters')(
      { params: { bookId: 'book_1' }, query: {}, user: { role: 'admin' } }, res);
    return res;
  };
}

(async () => {
  await test('a rebuild that is already running is reported as busy, not as up to date', async () => {
    const response = await harness({ changed: false, reason: 'rebuild-in-progress' })();
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'REBUILD_IN_PROGRESS');
  });

  await test('a pending rebuild recovery is reported as busy, not as up to date', async () => {
    const response = await harness({ changed: false, reason: 'recovery-pending' })();
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'REBUILD_RECOVERY_PENDING');
  });

  await test('equivalent chapters still answer success with changed:false', async () => {
    const response = await harness({ changed: false, reason: 'equivalent-current-output' })();
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.changed, false);
  });

  console.log(`rebuild-chapters route tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
