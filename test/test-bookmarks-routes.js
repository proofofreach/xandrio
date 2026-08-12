const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const jsonStore = require('../lib/json-store');
const { createBookMutationLocks } = require('../lib/book-mutation-lock');
const { buildChapterTransition } = require('../lib/chapter-reprocess');
const { registerBookmarksRoutes } = require('../lib/routes/bookmarks-routes');

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-bookmarks-route-'));
  try {
    const files = {
      bookmarks: path.join(dir, 'bookmarks.json'),
      books: path.join(dir, 'books.json'),
      settings: path.join(dir, 'settings.json'),
      transitions: path.join(dir, 'transitions.json')
    };
    const first = 'First section. '.repeat(80);
    const second = 'Second section. '.repeat(80);
    const transition = buildChapterTransition(
      [{ text: first, estimatedDuration: 100 }, { text: second, estimatedDuration: 100 }],
      [{ text: `${first} ${second}`, estimatedDuration: 200 }]
    );
    await Promise.all([
      jsonStore.save(files.bookmarks, {}),
      jsonStore.save(files.books, { book: { id: 'book', chapterStructureKey: 'new-key', chapterCount: 1 } }),
      jsonStore.save(files.transitions, {
        book: { previousStructureKey: 'old-key', nextStructureKey: 'new-key', transition }
      })
    ]);
    const routes = new Map();
    const app = {
      post(route, handler) { routes.set(`POST ${route}`, handler); },
      get(route, handler) { routes.set(`GET ${route}`, handler); },
      put(route, handler) { routes.set(`PUT ${route}`, handler); },
      delete(route, handler) { routes.set(`DELETE ${route}`, handler); }
    };
    const locks = createBookMutationLocks();
    registerBookmarksRoutes(app, {
      bookmarksFile: files.bookmarks,
      booksFile: files.books,
      clientSettingsFile: files.settings,
      transitionsFile: files.transitions,
      jsonStore,
      loadJSON: jsonStore.load,
      updateJSON: jsonStore.update,
      withBookStateLock: locks.withBookStateLock
    });
    const handler = routes.get('POST /api/bookmarks');

    const mappedResponse = response();
    await handler({
      body: {
        bookId: 'book',
        chapterIndex: 1,
        timestamp: 50,
        characterOffset: 100,
        positionApproximate: true,
        chapterStructureKey: 'old-key'
      },
      headers: {}, query: {}
    }, mappedResponse);
    assert.strictEqual(mappedResponse.statusCode, 200);
    assert.strictEqual(mappedResponse.body.bookmark.chapterIndex, 0);
    assert.strictEqual(mappedResponse.body.bookmark.chapterStructureKey, 'new-key');
    assert.strictEqual(mappedResponse.body.bookmark.positionApproximate, true);

    const staleResponse = response();
    await handler({
      body: { bookId: 'book', chapterIndex: 1, timestamp: 50, chapterStructureKey: 'too-old-key' },
      headers: {}, query: {}
    }, staleResponse);
    assert.strictEqual(staleResponse.statusCode, 200);
    assert.strictEqual(staleResponse.body.bookmark.chapterIndex, 0);
    assert.strictEqual(staleResponse.body.bookmark.timestamp, 0);
    assert.strictEqual(staleResponse.body.bookmark.positionApproximate, true);
    const stored = await jsonStore.load(files.bookmarks);
    assert.strictEqual(stored.users.default.book.length, 2);

    console.log('8 passed, 0 failed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
