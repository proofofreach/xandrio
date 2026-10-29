'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compactPlaybackChapter, chapterPronunciationContext } = require('../lib/playback-book-metadata');
const { registerLibraryBookRoutes } = require('../lib/routes/library-book-routes');
const { chapterStructureKey } = require('../lib/chapter-structure');

function routeHarness() {
  const handlers = new Map();
  const chapters = [{ index: 0, title: 'Chapter One', type: 'chapter', text: 'Opening '.repeat(1000) + 'A distinctive final phrase.', estimatedDuration: 600 }];
  const book = { id: 'book1', path: '/private/book.epub', chapterStructureKey: chapterStructureKey(chapters), totalDuration: 600, chapterCount: 1 };
  let chapterReads = 0;
  registerLibraryBookRoutes({
    get(route, handler) { handlers.set(route, handler); }, post() {}, delete() {}
  }, {
    booksFile: 'books',
    loadJSON: async () => ({ book1: book }),
    updateJSON: async () => { throw new Error('Unexpected metadata mutation'); },
    bookMutationLocks: { withBookMutationLock: async (_id, fn) => fn() },
    bookMetadataRefreshService: { reconcileChapterStructure: async () => null },
    chapterRebuildService: { recoverBook: async () => {}, canRebuild: async () => false },
    getChaptersCached: async () => { chapterReads++; return chapters; },
    normalizeChapterTitleForDisplay: value => value,
    publicBookRecordWithCoverArtifact: async ({ path: _privatePath, ...visible }) => visible,
    sendServerError: (res, error) => { throw error; }
  });
  return {
    chapters, book,
    get chapterReads() { return chapterReads; },
    async request(route, params, query = {}) {
      const response = { statusCode: 200, body: null, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
      await handlers.get(route)({ params, query }, response);
      return response;
    }
  };
}

test('compact metadata preserves identity, preview and both full-text length conventions', () => {
  const text = `  \uFB01rst\n\t words ${'body '.repeat(400)}  `;
  const original = { index: 4, title: 'Four', type: 'chapter', empty: false, text, estimatedDuration: 55 };
  const compact = compactPlaybackChapter(original);
  assert.equal(compact.text, text.slice(0, 256));
  assert.equal(compact.textLength, text.trim().length);
  assert.equal(compact.normalizedTextLength, text.normalize('NFKC').replace(/\s+/gu, ' ').trim().length);
  assert.equal(compact.textTruncated, true);
  assert.equal(compact.index, 4);
  assert.equal(compact.estimatedDuration, 55);
  assert.equal(original.text, text, 'cached chapter objects must stay intact');
});

test('empty structural chapters stay empty in compact metadata', () => {
  const compact = compactPlaybackChapter({ index: 1, empty: true, type: 'divider', text: '' });
  assert.equal(compact.textLength, 0);
  assert.equal(compact.normalizedTextLength, 0);
  assert.equal(compact.textTruncated, false);
  assert.equal(compact.empty, true);
});

test('playback query reduces the actual route payload while the default API retains full text', async () => {
  const harness = routeHarness();
  const full = await harness.request('/api/book/:bookId', { bookId: 'book1' });
  const compact = await harness.request('/api/book/:bookId', { bookId: 'book1' }, { playback: '1' });
  assert.equal(full.body.chapters[0].text, harness.chapters[0].text);
  assert.equal(compact.body.chapters[0].text.length, 256);
  assert.equal(compact.body.chapters[0].textLength, harness.chapters[0].text.length);
  assert.equal(compact.body.book.chapterStructureKey, harness.book.chapterStructureKey);
  assert.deepEqual(compact.body.book, full.body.book);
  assert(JSON.stringify(compact.body).length < JSON.stringify(full.body).length / 10);
});

test('context route returns the requested bounded excerpt from the full chapter', async () => {
  const harness = routeHarness();
  const response = await harness.request('/api/book/:bookId/chapters/:chapterIndex/context', { bookId: 'book1', chapterIndex: '0' }, { ratio: '1', structureKey: harness.book.chapterStructureKey });
  assert.equal(response.statusCode, 200);
  assert(response.body.context.endsWith('A distinctive final phrase.'));
  assert(response.body.context.length <= 242);
  assert.equal(response.body.chapterStructureKey, harness.book.chapterStructureKey);
  assert(!JSON.stringify(response.body).includes('/private'));
});

test('context route refuses stale structure before reading narration', async () => {
  const harness = routeHarness();
  const response = await harness.request('/api/book/:bookId/chapters/:chapterIndex/context', { bookId: 'book1', chapterIndex: '0' }, { ratio: '0.5', structureKey: 'stale' });
  assert.equal(response.statusCode, 409);
  assert.equal(harness.chapterReads, 0);
  assert.equal(response.body.context, undefined);
});

test('context route checks extracted structure even when stored metadata has not caught up', async () => {
  const harness = routeHarness();
  harness.chapters[0].title = 'A newly extracted chapter';
  const response = await harness.request('/api/book/:bookId/chapters/:chapterIndex/context', { bookId: 'book1', chapterIndex: '0' }, { structureKey: harness.book.chapterStructureKey });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.context, undefined);
});

test('context route requires a structure identity', async () => {
  const harness = routeHarness();
  const response = await harness.request('/api/book/:bookId/chapters/:chapterIndex/context', { bookId: 'book1', chapterIndex: '0' });
  assert.equal(response.statusCode, 400);
  assert.equal(harness.chapterReads, 0);
});

test('context route validates identifiers, chapter bounds and fractional position', async () => {
  const harness = routeHarness();
  for (const [params, query, status] of [
    [{ bookId: '../private', chapterIndex: '0' }, {}, 400],
    [{ bookId: 'missing', chapterIndex: '0' }, {}, 404],
    [{ bookId: 'book1', chapterIndex: '-1' }, {}, 400],
    [{ bookId: 'book1', chapterIndex: '1' }, {}, 404],
    [{ bookId: 'book1', chapterIndex: '0' }, { ratio: 'NaN' }, 400],
    [{ bookId: 'book1', chapterIndex: '0' }, { ratio: '1.01' }, 400]
  ]) {
    assert.equal((await harness.request('/api/book/:bookId/chapters/:chapterIndex/context', params, { structureKey: harness.book.chapterStructureKey, ...query })).statusCode, status);
  }
});

test('context normalization matches the existing pronunciation UI', () => {
  assert.equal(chapterPronunciationContext({ text: '  one\n\t two  ' }, 0.5), 'one two');
  assert.equal(chapterPronunciationContext({ text: '' }, 0.5), '');
});

test('preferred chapter selection uses full text length despite a short preview', async () => {
  const { findPreferredStartChapterIndex } = await import('../public/js/util/chapter-labels.mjs');
  const chapters = [
    { title: 'Introduction', type: 'frontmatter', text: 'A short note.' },
    { title: 'Opening scene', type: 'chapter', text: 'Preview', textLength: 5000 }
  ];
  assert.equal(findPreferredStartChapterIndex(chapters), 1);
});

function pronunciationHarness() {
  const pending = [];
  const book = { id: 'book1', chapterStructureKey: 'structure1' };
  const state = { book, chapterIndex: 0 };
  const context = vm.createContext({
    AbortController, URLSearchParams,
    navigator: { onLine: true },
    apiGet: (url, options) => new Promise(resolve => pending.push({ url, options, resolve }))
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/js/features/pronunciations.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export function /g, 'function ');
  vm.runInContext(`${source}\nglobalThis.testApi = { refreshContext, cancelContextRequest, setDeps(value) { deps = value; } };`, context);
  context.testApi.setDeps({
    getChapters: () => [{ text: 'preview', textTruncated: true }],
    getCurrentBook: () => state.book,
    getCurrentChapter: () => state.chapterIndex,
    getProgressPercent: () => 75
  });
  return { pending, state, api: context.testApi, book };
}

test('pronunciation context is fetched on demand with the full chapter position and identity', async () => {
  const h = pronunciationHarness();
  const element = { textContent: 'Enter a phrase' };
  const task = h.api.refreshContext(h.book, 0, element, {});
  assert(h.pending[0].url.includes('ratio=0.75'));
  assert(h.pending[0].url.includes('structureKey=structure1'));
  h.pending[0].resolve({ context: 'context at three quarters' });
  await task;
  assert.equal(element.textContent, 'context at three quarters');
});

test('closing the sheet aborts a context request and prevents stale UI updates', async () => {
  const h = pronunciationHarness();
  const element = { textContent: 'Enter a phrase' };
  const task = h.api.refreshContext(h.book, 0, element, {});
  h.api.cancelContextRequest();
  assert(h.pending[0].options.signal.aborted);
  h.pending[0].resolve({ context: 'late excerpt' });
  await task;
  assert.equal(element.textContent, 'Enter a phrase');
});

test('a late context response cannot replace the new book or chapter context', async () => {
  const h = pronunciationHarness();
  const element = { textContent: 'Enter a phrase' };
  const task = h.api.refreshContext(h.book, 0, element, {});
  h.state.book = { id: 'book2' };
  h.pending[0].resolve({ context: 'old book excerpt' });
  await task;
  assert.equal(element.textContent, 'Enter a phrase');
});

test('older snapshots without structure identity keep manual context rather than fetch a mismatched chapter', async () => {
  const h = pronunciationHarness();
  delete h.book.chapterStructureKey;
  const element = { textContent: 'Enter a phrase' };
  await h.api.refreshContext(h.book, 0, element, {});
  assert.equal(h.pending.length, 0);
  assert.equal(element.textContent, 'Enter a phrase');
});
