#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'public', 'js');
const lib = fs.readFileSync(path.join(root, 'views/library.js'), 'utf8');
const offline = fs.readFileSync(path.join(root, 'features/offline.js'), 'utf8');
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, `Missing source section: ${start}`);
  return source.slice(a, b).replaceAll('export ', '');
}
const code = [
  between(offline, 'function readLegacyOfflineManifest(', 'function saveOfflineManifest('),
  between(offline, 'function availableDownloadStatus(', 'export function isBookDownloadedForOffline('),
  between(offline, 'function offlineChapterSnapshot(', 'function offlineTitleData('),
  between(lib, 'function bookModel(', 'function stateHTML('),
  between(lib, 'function renderBookCard(', 'function skeletonCardsHTML('),
  between(lib, 'export async function loadLibrary(', '// Re-describe rows and the strip'),
  between(lib, 'function onAudioActivity(', '// ---- Init')
].join('\n');

(async () => {
  let scope = 'a';
  let reads = 0;
  let rowRefreshes = 0;
  const manifests = {
    a: { 'book-0': { mode: 'full', state: 'ready', chapters: 1, chapterEntries: [{}] } },
    b: { 'book-1': { mode: 'full', state: 'ready', chapters: 1, chapterEntries: [{}] } }
  };
  const books = Array.from({ length: 500 }, (_, i) => ({ id: `book-${i}`, title: `Book ${i}` }));
  const cards = books.map(book => ({
    dataset: { bookId: book.id }, classList: { toggle() {} },
    querySelector() { return null; }, querySelectorAll() { return []; }
  }));
  const list = { innerHTML: '', classList: { toggle() {}, remove() {} },
    querySelector() { return {}; }, setAttribute() {} };
  const noop = () => {};
  const context = {
    console, navigator: { maxTouchPoints: 0, onLine: true },
    window: {}, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    document: { body: { classList: { add() {} } }, activeElement: null,
      getElementById(id) { return id === 'library-list' ? list : null; },
      querySelectorAll(selector) { return selector.startsWith('#library-list') ? cards : []; },
      querySelector(selector) { rowRefreshes++; const id = /data-book-id=\"([^\"]+)/.exec(selector)?.[1]; return cards.find(card => card.dataset.bookId === id); },
      dispatchEvent() {} },
    offlineScopeId: () => scope, offlineManifestKey: id => id,
    readJSON(key) { reads++; return structuredClone(manifests[key]); },
    canClaimLegacyOfflineStorage: () => false, offlineDeviceSnapshotScope: '', offlineDeviceSnapshot: {},
    offlineDownloadsSupported: () => true, offlineState: entry => entry.state,
    isCompletedOfflineEntry: entry => entry.state === 'ready', isHydratableOfflineEntry: () => false,
    positionFor: () => null, bookProgressInfo: () => null, effectiveSpeedForBook: () => 1,
    getReferencePlaybackSpeed: () => 1, deviceState: status => status, narrationState: () => ({}),
    bookTimeLeft: () => null, livePositionFor: () => null, primaryState: () => null,
    pendingBookDownloads: new Set(), audioActivity: new Map(), audioActivityKey: '', cssEscape: String, scheduleFit: noop, isAvailableOnDevice: status => status.downloaded,
    safeAttr: String, escapeHTML: String, coverImageHTML: () => '', progressBarHTML: () => '',
    bookBylineHTML: () => '', statusLineHTML: () => '', gridLinesHTML: () => '',
    tableColumnsHTML: () => '', offlineStatusHTML: () => '', GLYPH: { more: '' }, DELETE_GLYPH: '',
    apiGet: async url => url === '/api/library' ? { books, shelf: [] } : { positions: {} },
    getVerifiedOfflineLibraryBooks: async () => [], setLibraryShape: noop, filterLibrary: noop,
    skeletonCardsHTML: () => '', readText: () => 'shelf', libraryTabStorageKey: () => '', SCOPES: ['shelf'],
    syncLibraryTabs: noop, renderContinueRail: noop, firstRunHTML: () => '', getRecentInProgress: () => [],
    continueEntries: () => [], syncSpeedNote: noop, sortLibrary: noop, setupSwipeDelete: noop,
    loadResumeChapterStructures: noop, syncBookActionsHeader: noop,
    libraryLoadGeneration: 0, libraryContentState: '', librarySnapshot: {}, booksById: new Map(),
    currentShelf: new Set(), currentTab: '', bookActionsBookId: null
  };
  vm.createContext(context);
  vm.runInContext(code + '\nthis.load = loadLibrary; this.refresh = refreshOfflineIndicators; this.chapterSnapshot = offlineChapterSnapshot; this.audioUpdate = onAudioActivity;', context);
  await context.load();
  assert.equal(reads, 1, '500 rendered rows share one manifest read');
  assert.match(list.innerHTML, /data-book-id="book-0"[\s\S]*?data-downloaded="1"/);
  reads = 0;
  context.refresh();
  assert.equal(reads, 1, '500 refreshed rows share one manifest read');
  assert.equal(cards[0].dataset.downloaded, '1');
  assert.equal(cards[1].dataset.downloaded, '0');
  delete manifests.a['book-0'];
  reads = 0;
  context.refresh();
  assert.equal(reads, 1);
  assert.equal(cards[0].dataset.downloaded, '0', 'a deleted entry is absent on next refresh');
  scope = 'b';
  context.offlineDeviceSnapshotScope = 'b';
  context.offlineDeviceSnapshot = { 'book-2': { storageBackend: 'idb', mode: 'full', state: 'ready', chapters: 1, chapterEntries: [{}] } };
  reads = 0;
  context.refresh();
  assert.equal(reads, 1);
  assert.equal(cards[0].dataset.downloaded, '0');
  assert.equal(cards[1].dataset.downloaded, '1', 'account switch reads the new scope');
  assert.equal(cards[2].dataset.downloaded, '1', 'current-account IndexedDB entries overlay the legacy manifest');
  scope = 'a';
  context.refresh();
  assert.equal(cards[2].dataset.downloaded, '0', 'IndexedDB snapshot from another account is excluded');
  const activity = { id: 'book-0', preparationStatus: 'paused', readyAudioSeconds: 120, durationEstimated: true };
  context.audioUpdate({ detail: { books: [activity] } });
  const beforeExact = rowRefreshes;
  context.audioUpdate({ detail: { books: [{ ...activity, durationEstimated: false }] } });
  assert.equal(rowRefreshes, beforeExact + 1, 'estimate-to-exact transition refreshes the library row');
  const truncated = context.chapterSnapshot({ text: 'x'.repeat(257), textLength: 257 }, 0);
  assert.equal(truncated.text.length, 256);
  assert.equal(truncated.textTruncated, true);
  assert.equal(context.chapterSnapshot({ text: 'preview', textTruncated: true }, 0).textTruncated, true);
  assert.equal(context.chapterSnapshot({ text: 'short' }, 0).textTruncated, false);
  // Execute the production availability predicate without allowing any deep
  // clone. A partially cached full title remains playable for its saved parts.
  const partial = id => ({ bookId: id, mode: 'full', manifestVersion: 3, state: 'incomplete',
    chapters: 2, chapterEntries: [{ url: 'cached' }, null],
    titleData: { book: { id, title: 'A'.repeat(100000) }, chapters: [{}, {}] } });
  const accountEntries = { a: { one: partial('one') }, b: { two: partial('two') } };
  let account = 'a';
  const availability = {
    offlineScopeId: () => account, offlineManifestKey: id => id,
    readJSON: key => accountEntries[key] || {}, canClaimLegacyOfflineStorage: () => false,
    offlineDeviceSnapshotScope: '', offlineDeviceSnapshot: {}, OFFLINE_MANIFEST_VERSION: 3,
    structuredClone() { throw new Error('availability must not clone title metadata'); }
  };
  vm.createContext(availability);
  vm.runInContext([
    between(offline, 'function readLegacyOfflineManifest(', 'function saveOfflineManifest('),
    between(offline, 'export function offlineEntryForBook(', 'export function getOfflineLibraryBooks('),
    between(offline, 'function offlineState(entry)', 'function offlineStateLabel('),
    'this.has = hasOfflineBookData;'
  ].join('\n'), availability);
  assert.equal(availability.has('one'), true, 'a partial full download is available');
  assert.equal(availability.has('two'), false, 'another account is excluded');
  accountEntries.a.one.chapterEntries = [null, null];
  assert.equal(availability.has('one'), false, 'metadata without audio is unavailable');
  accountEntries.a.one.chapterEntries = [{ url: 'cached' }, null];
  accountEntries.a.one.titleData.chapters = [{}];
  assert.equal(availability.has('one'), false, 'invalid title metadata is unavailable');
  account = 'b';
  assert.equal(availability.has('one'), false);
  assert.equal(availability.has('two'), true, 'account switch uses current manifest');
  delete accountEntries.b.two;
  assert.equal(availability.has('two'), false, 'deletion is visible on next check');
  console.log('Library manifest snapshot and offline availability regressions passed\n2 passed, 0 failed');
})().catch(error => { console.error(error); process.exitCode = 1; });
