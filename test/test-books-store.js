/** Critical library persistence tests. */

const assert = require('assert');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const jsonStore = require('../lib/json-store');
const { createBooksStore, validateBooksStore } = require('../lib/books-store');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'books-store-test-'));
  try {
    await test('validator accepts current and legitimate legacy catalog records', () => {
      assert.strictEqual(validateBooksStore({
        current: { id: 'current', title: 'Current', path: '/cache/current.epub' },
        legacy: { title: 'Legacy', path: '/cache/legacy.epub' }
      }), true);
    });

    await test('invalid catalogs are rejected without overwriting them', async () => {
      const cases = [
        ['array.json', '[]'],
        ['null-book.json', '{"book_a":null}'],
        ['mismatched-id.json', '{"book_a":{"id":"book_b","title":"Wrong"}}']
      ];
      for (const [name, raw] of cases) {
        const filePath = path.join(dir, name);
        await fsp.writeFile(filePath, raw);
        const store = createBooksStore({ filePath, jsonStore });
        await assert.rejects(
          store.update(books => { books.book_b = { id: 'book_b' }; }),
          error => error.code === 'JSON_STORE_VALIDATION_FAILED',
          name
        );
        assert.strictEqual(await fsp.readFile(filePath, 'utf8'), raw, name);
      }
    });

    await test('library mutation creates a restorable backup and preserves displaced state', async () => {
      const filePath = path.join(dir, 'books.json');
      const store = createBooksStore({ filePath, jsonStore, maxBackups: 5 });
      await store.save({
        book_a: { id: 'book_a', title: 'Before', path: '/cache/book-a.epub' }
      });
      await store.update(books => {
        books.book_a.title = 'After';
        books.book_b = { id: 'book_b', title: 'Added', path: '/cache/book-b.epub' };
      });

      const backup = (await store.listRecoveryCandidates())
        .find(candidate => candidate.kind === 'backup' && candidate.valid);
      assert(backup, 'expected a valid catalog backup');
      assert.deepStrictEqual(JSON.parse(await fsp.readFile(backup.path, 'utf8')), {
        book_a: { id: 'book_a', title: 'Before', path: '/cache/book-a.epub' }
      });

      await store.restore(backup.path);
      assert.deepStrictEqual(await store.load(), {
        book_a: { id: 'book_a', title: 'Before', path: '/cache/book-a.epub' }
      });
      const snapshots = await Promise.all(
        (await store.listRecoveryCandidates())
          .filter(candidate => candidate.kind === 'backup')
          .map(candidate => fsp.readFile(candidate.path, 'utf8').then(JSON.parse))
      );
      assert(snapshots.some(snapshot => snapshot.book_a?.title === 'After' && snapshot.book_b));
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`books-store tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
