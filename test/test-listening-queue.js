const assert = require('assert');
const {
  normalizeUserQueue,
  addToQueue,
  removeFromQueue,
  moveQueueItem,
  advanceQueue,
  sanitizeBookPlaybackSettings,
  suggestNextSeriesBook,
  removeBookFromAllQueues
} = require('../lib/listening-queue');

const initial = normalizeUserQueue({ bookIds: ['a', 'a', '', 'b'], autoContinue: false });
assert.deepStrictEqual(initial.bookIds, ['a', 'b']);
assert.strictEqual(initial.autoContinue, false);

assert.deepStrictEqual(addToQueue(initial, 'c', 'next').bookIds, ['a', 'c', 'b']);
assert.deepStrictEqual(addToQueue(initial, 'b', 'last').bookIds, ['a', 'b']);
assert.deepStrictEqual(removeFromQueue(initial, 'a').bookIds, ['b']);
assert.deepStrictEqual(moveQueueItem({ bookIds: ['a', 'b', 'c'] }, 'c', 0).bookIds, ['c', 'a', 'b']);

assert.deepStrictEqual(advanceQueue({ bookIds: ['a', 'b', 'c'], autoContinue: true }, 'a'), {
  queue: { bookIds: ['b', 'c'], autoContinue: true, bookSettings: {} },
  nextBookId: 'b'
});

assert.deepStrictEqual(sanitizeBookPlaybackSettings({
  playbackSpeed: 1.7,
  smartRewindEnabled: false,
  rollingOfflineEnabled: true,
  ignored: 'x'
}), {
  playbackSpeed: 1.7,
  smartRewindEnabled: false,
  rollingOfflineEnabled: true
});

const books = {
  first: { id: 'first', title: 'Harbor, Book 1', author: 'A. Writer' },
  second: { id: 'second', title: 'Harbor, Book 2', author: 'A. Writer' },
  third: { id: 'third', title: 'Harbor, Book 3', author: 'Another Writer' }
};
assert.strictEqual(suggestNextSeriesBook(books.first, books, {
  second: { finished: false }
}), 'second');
assert.strictEqual(suggestNextSeriesBook(books.first, books, {
  second: { finished: true }
}), null);

const explicit = {
  one: { id: 'one', title: 'Unnumbered', author: 'Author', series: 'North', seriesIndex: 1 },
  two: { id: 'two', title: 'Different title', author: 'Author', series: 'North', seriesIndex: 2 }
};
assert.strictEqual(suggestNextSeriesBook(explicit.one, explicit, {}), 'two');

const fullQueue = { bookIds: Array.from({ length: 100 }, (_, index) => `book-${index}`) };
assert.strictEqual(addToQueue(fullQueue, 'overflow').bookIds.length, 100);

const queueStore = {
  users: {
    one: { bookIds: ['keep', 'remove'], bookSettings: { remove: { playbackSpeed: 2 } } },
    two: { bookIds: ['remove'] }
  }
};
removeBookFromAllQueues(queueStore, 'remove');
assert.deepStrictEqual(queueStore.users, {
  one: { bookIds: ['keep'], autoContinue: true, bookSettings: {} },
  two: { bookIds: [], autoContinue: true, bookSettings: {} }
});

console.log('13 passed, 0 failed');
