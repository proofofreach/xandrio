// Per-user shelves over the shared library.
//
// Every book in books.json is visible to everyone ("All books"); a shelf is
// a user's personal subset. Stored in data/shelves.json as
// { users: { <userId>: { books: { <bookId>: { addedAt } } } } } and written
// through lib/json-store.js like every other user-scoped store.

function normalizeShelvesStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  if (!store.users || typeof store.users !== 'object') store.users = {};
  return store;
}

function shelfForUser(rawStore, userId) {
  const store = normalizeShelvesStore(rawStore);
  const shelf = store.users[userId];
  return shelf && typeof shelf.books === 'object' ? Object.keys(shelf.books) : [];
}

function addToShelf(rawStore, userId, bookId, { now = Date.now } = {}) {
  const store = normalizeShelvesStore(rawStore);
  if (!store.users[userId] || typeof store.users[userId].books !== 'object') {
    store.users[userId] = { books: {} };
  }
  if (!store.users[userId].books[bookId]) {
    store.users[userId].books[bookId] = { addedAt: new Date(now()).toISOString() };
  }
  return store;
}

function removeFromShelf(rawStore, userId, bookId) {
  const store = normalizeShelvesStore(rawStore);
  const books = store.users[userId]?.books;
  if (!books || !books[bookId]) return false;
  delete books[bookId];
  return true;
}

function removeBookFromAllShelves(rawStore, bookId) {
  const store = normalizeShelvesStore(rawStore);
  for (const shelf of Object.values(store.users)) {
    if (shelf?.books && typeof shelf.books === 'object') delete shelf.books[bookId];
  }
  return store;
}

// One-time seeding: a user's shelf starts with every book they have reading
// progress in.
function seedShelfFromPositions(rawStore, userId, userPositions, { now = Date.now } = {}) {
  for (const bookId of Object.keys(userPositions || {})) {
    addToShelf(rawStore, userId, bookId, { now });
  }
  return normalizeShelvesStore(rawStore);
}

module.exports = {
  normalizeShelvesStore,
  shelfForUser,
  addToShelf,
  removeFromShelf,
  removeBookFromAllShelves,
  seedShelfFromPositions
};
