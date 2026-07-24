/** Per-user shelf store tests. */

const assert = require('assert');
const {
  normalizeShelvesStore,
  shelfForUser,
  addToShelf,
  removeFromShelf,
  removeBookFromAllShelves,
  seedShelfFromPositions
} = require('../lib/shelves');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

test('normalizeShelvesStore repairs malformed input in place', () => {
  const store = {};
  assert.deepStrictEqual(normalizeShelvesStore(store), { users: {} });
  assert.deepStrictEqual(normalizeShelvesStore(null), { users: {} });
  assert.strictEqual(normalizeShelvesStore(store), store);
});

test('addToShelf and shelfForUser round-trip; duplicates keep addedAt', () => {
  const store = {};
  const now = () => 1_000;
  addToShelf(store, 'usr_a', 'book1', { now });
  addToShelf(store, 'usr_a', 'book2', { now });
  addToShelf(store, 'usr_a', 'book1', { now: () => 2_000 });
  assert.deepStrictEqual(shelfForUser(store, 'usr_a').sort(), ['book1', 'book2']);
  assert.strictEqual(store.users.usr_a.books.book1.addedAt, new Date(1_000).toISOString());
  assert.deepStrictEqual(shelfForUser(store, 'usr_other'), []);
});

test('removeFromShelf only touches the given user and reports absence', () => {
  const store = {};
  addToShelf(store, 'usr_a', 'book1');
  addToShelf(store, 'usr_b', 'book1');
  assert.strictEqual(removeFromShelf(store, 'usr_a', 'book1'), true);
  assert.strictEqual(removeFromShelf(store, 'usr_a', 'book1'), false);
  assert.deepStrictEqual(shelfForUser(store, 'usr_b'), ['book1']);
});

test('removeBookFromAllShelves clears every user', () => {
  const store = {};
  addToShelf(store, 'usr_a', 'book1');
  addToShelf(store, 'usr_a', 'book2');
  addToShelf(store, 'usr_b', 'book1');
  removeBookFromAllShelves(store, 'book1');
  assert.deepStrictEqual(shelfForUser(store, 'usr_a'), ['book2']);
  assert.deepStrictEqual(shelfForUser(store, 'usr_b'), []);
});

test('seedShelfFromPositions adds every book with progress', () => {
  const store = {};
  addToShelf(store, 'usr_a', 'book0');
  seedShelfFromPositions(store, 'usr_a', {
    book1: { chapterIndex: 3, timestamp: 12 },
    book2: { chapterIndex: 0, timestamp: 0 }
  });
  assert.deepStrictEqual(shelfForUser(store, 'usr_a').sort(), ['book0', 'book1', 'book2']);
  seedShelfFromPositions(store, 'usr_b', null);
  assert.deepStrictEqual(shelfForUser(store, 'usr_b'), []);
});

console.log(`\n${'═'.repeat(50)}`);
console.log(`shelves tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
