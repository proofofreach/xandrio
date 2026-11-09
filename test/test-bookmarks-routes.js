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

    for (const body of [
      { chapterIndex: 1, timestamp: 0 },
      { chapterIndex: '1e300', timestamp: 0 },
      { chapterIndex: 0, timestamp: 1e12 }
    ]) {
      const outside = response();
      await handler({ body: { bookId: 'book', chapterStructureKey: 'new-key', ...body }, headers: {}, query: {} }, outside);
      assert.strictEqual(outside.statusCode, 400, `${JSON.stringify(body)} is outside the book`);
    }
    assert.strictEqual((await jsonStore.load(files.bookmarks)).users.default.book.length, 2,
      'an out-of-book bookmark is not stored');

    // A rebuild leaves an unmappable bookmark under its old structure key.
    await jsonStore.update(files.bookmarks, data => {
      data.users.default.book.push({ id: 'bm_old', chapterIndex: 4, timestamp: 70, chapterStructureKey: 'older-key', createdAtMs: 1 });
    });
    const listed = response();
    await routes.get('GET /api/bookmarks/:bookId')({ params: { bookId: 'book' }, headers: {}, query: {} }, listed);
    const staleBookmark = listed.body.bookmarks.find(bookmark => bookmark.id === 'bm_old');
    assert.strictEqual(staleBookmark.stale, true, 'a bookmark from an earlier structure is returned flagged, not lost');
    assert(listed.body.bookmarks.filter(bookmark => bookmark.id !== 'bm_old').every(bookmark => !bookmark.stale),
      'current-structure bookmarks are not flagged');
    const all = response();
    await routes.get('GET /api/bookmarks')({ headers: {}, query: {} }, all);
    assert.strictEqual(all.body.bookmarks.book.find(bookmark => bookmark.id === 'bm_old').stale, true);
    assert.strictEqual((await jsonStore.load(files.bookmarks)).users.default.book.find(bookmark => bookmark.id === 'bm_old').stale,
      undefined, 'the flag is derived on read, never stored');

    // The client lists a stale bookmark but never offers it as a seek target.
    const container = {
      innerHTML: '',
      querySelectorAll: () => [],
      querySelector: () => null
    };
    global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    global.document = { cookie: '', getElementById: id => (id === 'bookmarks' ? container : null), addEventListener() {}, dispatchEvent() {} };
    Object.defineProperty(global, 'navigator', { value: { userAgent: 'Test', onLine: true }, configurable: true });
    global.window = {
      location: { origin: 'https://reader.test' },
      fetch: async () => new Response(JSON.stringify({ bookmarks: listed.body.bookmarks }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    };
    global.fetch = global.window.fetch;
    const client = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'features', 'bookmarks.js')).href);
    client.initBookmarks({ containerId: 'bookmarks', getCurrentBook: () => ({ id: 'book' }), getChapterTitle: index => `Chapter ${index + 1}` });
    await client.renderBookmarksSection();
    assert(container.innerHTML.includes('Saved before the chapter list changed'), 'the stale bookmark is listed');
    assert(!container.innerHTML.includes('data-bookmark-jump="bm_old"'), 'the stale bookmark is not a jump target');
    assert(container.innerHTML.includes('data-bookmark-delete="bm_old"'), 'the stale bookmark can still be deleted');
    assert(!container.innerHTML.includes('Chapter 5'), 'the stale index is not shown as a current chapter');

    console.log('11 passed, 0 failed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
