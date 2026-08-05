const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  canonicalStorageDirectory,
  reconcileBookArtifactPaths
} = require('../lib/book-artifact-paths');

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

(async () => {
  await test('recovers a book whose release-specific cache symlink was pruned', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-artifacts-'));
    try {
      const sharedCache = path.join(root, 'cache');
      const releaseCache = path.join(root, 'releases', 'old', 'cache');
      fs.mkdirSync(sharedCache, { recursive: true });
      fs.mkdirSync(path.dirname(releaseCache), { recursive: true });
      fs.symlinkSync(sharedCache, releaseCache);

      const bookId = 'legacy_book';
      const filename = `${bookId}.epub`;
      fs.writeFileSync(path.join(sharedCache, filename), 'fixture');
      const stalePath = path.join(releaseCache, filename);
      assert.equal(fs.existsSync(stalePath), true);

      fs.rmSync(path.dirname(releaseCache), { recursive: true });
      assert.equal(fs.existsSync(stalePath), false);

      const books = {
        [bookId]: { id: bookId, filename, path: stalePath }
      };
      let saved;
      const result = await reconcileBookArtifactPaths({
        cacheDir: sharedCache,
        loadBooks: async () => books,
        saveBooks: async value => { saved = value; }
      });

      assert.equal(result.repairedBooks, 1);
      assert.equal(saved[bookId].path, path.join(sharedCache, filename));
      assert.equal(fs.readFileSync(saved[bookId].path, 'utf8'), 'fixture');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('resolves a cache symlink before durable paths are recorded', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-storage-'));
    try {
      const sharedCache = path.join(root, 'cache');
      const releaseCache = path.join(root, 'current', 'cache');
      fs.mkdirSync(sharedCache, { recursive: true });
      fs.mkdirSync(path.dirname(releaseCache), { recursive: true });
      fs.symlinkSync(sharedCache, releaseCache);
      assert.equal(canonicalStorageDirectory(releaseCache), fs.realpathSync.native(sharedCache));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
