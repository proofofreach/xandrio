const MAX_QUEUE_LENGTH = 100;

function cleanBookIds(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_QUEUE_LENGTH) break;
  }
  return result;
}

function sanitizeBookPlaybackSettings(source = {}) {
  const settings = {};
  const speed = Number(source.playbackSpeed);
  if (Number.isFinite(speed) && speed >= 0.5 && speed <= 3) settings.playbackSpeed = speed;
  if (typeof source.smartRewindEnabled === 'boolean') settings.smartRewindEnabled = source.smartRewindEnabled;
  if (typeof source.rollingOfflineEnabled === 'boolean') settings.rollingOfflineEnabled = source.rollingOfflineEnabled;
  return settings;
}

function normalizeUserQueue(source = {}) {
  const bookSettings = {};
  if (source.bookSettings && typeof source.bookSettings === 'object') {
    for (const [bookId, settings] of Object.entries(source.bookSettings)) {
      if (!bookId) continue;
      const clean = sanitizeBookPlaybackSettings(settings);
      if (Object.keys(clean).length) bookSettings[bookId] = clean;
    }
  }
  return {
    bookIds: cleanBookIds(source.bookIds),
    autoContinue: source.autoContinue !== false,
    bookSettings
  };
}

function addToQueue(source, bookId, position = 'last') {
  const queue = normalizeUserQueue(source);
  const id = typeof bookId === 'string' ? bookId.trim() : '';
  if (!id || queue.bookIds.includes(id) || queue.bookIds.length >= MAX_QUEUE_LENGTH) return queue;
  if (position === 'next' && queue.bookIds.length > 0) queue.bookIds.splice(1, 0, id);
  else queue.bookIds.push(id);
  return queue;
}

function removeBookFromAllQueues(rawStore, bookId) {
  const store = rawStore && typeof rawStore === 'object' ? rawStore : {};
  if (!store.users || typeof store.users !== 'object') store.users = {};
  for (const [userId, source] of Object.entries(store.users)) {
    const queue = removeFromQueue(source, bookId);
    delete queue.bookSettings[bookId];
    store.users[userId] = queue;
  }
  return store;
}

function removeFromQueue(source, bookId) {
  const queue = normalizeUserQueue(source);
  queue.bookIds = queue.bookIds.filter(id => id !== bookId);
  return queue;
}

function moveQueueItem(source, bookId, toIndex) {
  const queue = normalizeUserQueue(source);
  const fromIndex = queue.bookIds.indexOf(bookId);
  if (fromIndex < 0) return queue;
  const [item] = queue.bookIds.splice(fromIndex, 1);
  const target = Math.max(0, Math.min(queue.bookIds.length, Number(toIndex) || 0));
  queue.bookIds.splice(target, 0, item);
  return queue;
}

function advanceQueue(source, finishedBookId) {
  const queue = removeFromQueue(source, finishedBookId);
  return {
    queue,
    nextBookId: queue.autoContinue ? (queue.bookIds[0] || null) : null
  };
}

function seriesDescriptor(book) {
  if (!book || typeof book !== 'object') return null;
  const explicitName = typeof book.series === 'string'
    ? book.series.trim()
    : (typeof book.series?.name === 'string' ? book.series.name.trim() : '');
  const explicitIndex = Number(book.seriesIndex ?? book.series?.index);
  if (explicitName && Number.isFinite(explicitIndex)) {
    return { key: explicitName.toLowerCase(), index: explicitIndex };
  }
  const match = String(book.title || '').trim().match(/^(.+?)(?:\s*[,:\-]\s*|\s+)(?:book|volume|vol\.?|#)\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  return { key: match[1].trim().toLowerCase(), index: Number(match[2]) };
}

function suggestNextSeriesBook(currentBook, books, positions = {}) {
  const current = seriesDescriptor(currentBook);
  if (!current) return null;
  const author = String(currentBook.author || '').trim().toLowerCase();
  return Object.values(books || {})
    .filter(book => book?.id && book.id !== currentBook.id)
    .filter(book => String(book.author || '').trim().toLowerCase() === author)
    .map(book => ({ book, series: seriesDescriptor(book) }))
    .filter(candidate => candidate.series?.key === current.key && candidate.series.index > current.index)
    .filter(candidate => positions[candidate.book.id]?.finished !== true)
    .sort((a, b) => a.series.index - b.series.index)[0]?.book.id || null;
}

module.exports = {
  MAX_QUEUE_LENGTH,
  normalizeUserQueue,
  addToQueue,
  removeFromQueue,
  moveQueueItem,
  advanceQueue,
  sanitizeBookPlaybackSettings,
  suggestNextSeriesBook,
  removeBookFromAllQueues
};
