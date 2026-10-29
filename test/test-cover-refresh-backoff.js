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

const SKIP_SAVE = Symbol('skip');

function harness({ book, cachedCover = null, fetched = null }) {
  const routes = new Map();
  const app = new Proxy({}, {
    get: (_target, method) => (path, ...handlers) => routes.set(`${String(method).toUpperCase()} ${path}`, handlers.at(-1))
  });
  const books = { book_1: { ...book } };
  const calls = { ensure: 0 };
  registerLibraryBookRoutes(app, {
    booksFile: 'books.json',
    loadJSON: async () => structuredClone(books),
    updateJSON: async (_file, mutate) => {
      const draft = structuredClone(books);
      if (mutate(draft) === SKIP_SAVE) return;
      Object.assign(books, draft);
    },
    jsonStore: { SKIP_SAVE },
    bookMutationLocks: { withBookStateLock: (_id, operation) => operation() },
    canonicalBookCoverPath: id => `/cache/${id}_cover.jpg`,
    readValidatedLibraryCover: async () => cachedCover,
    shouldRefreshCachedCover: () => true,
    coverRecentlyChecked: current => Boolean(current?.coverCheckedAt),
    removeFileIfExists: async () => {},
    ensureBookCover: async () => { calls.ensure += 1; return fetched; },
    persistCanonicalCoverPath: async () => {},
    coverRefreshGate: { tryAcquire: () => () => {} },
    coverRefreshRateLimit: (_req, _res, next) => next(),
    sendServerError: (res, error) => res.status(500).json({ error: error.message })
  });
  const request = async () => {
    const res = {
      statusCode: 200,
      headers: {},
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      type() { return this; },
      send(body) { this.body = body; return this; },
      setHeader(name, value) { this.headers[name] = value; }
    };
    await routes.get('GET /api/cover/:bookId')({ params: { bookId: 'book_1' }, query: {}, user: {} }, res);
    return res;
  };
  return { books, calls, request };
}

(async () => {
  await test('an automatic cover search records when it ran, even when it finds nothing', async () => {
    const h = harness({ book: { title: 'T', author: 'A' } });
    const response = await h.request();
    assert.equal(response.statusCode, 404);
    assert.equal(h.calls.ensure, 1);
    assert.ok(Number.isFinite(Date.parse(h.books.book_1.coverCheckedAt)));
  });

  await test('a book without a cover is not searched again on every view', async () => {
    const h = harness({ book: { title: 'T', author: 'A', coverCheckedAt: new Date().toISOString() } });
    const response = await h.request();
    assert.equal(response.statusCode, 404);
    assert.equal(h.calls.ensure, 0, 'no network search within the recheck interval');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
