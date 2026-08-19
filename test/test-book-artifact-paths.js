const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  canonicalArtifactPath,
  canonicalStorageDirectory,
  isManagedArtifactName,
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

  await test('does not treat a sibling book id as an artifact prefix', () => {
    // "abc" is a proper prefix of "abc_2"; a bare startsWith test would let
    // book "abc" claim book "abc_2"'s artifacts (and vice versa).
    assert.equal(isManagedArtifactName('abc', 'abc_2.epub'), false);
    assert.equal(isManagedArtifactName('abc', 'abc_2_cover.jpg'), false);
    assert.equal(isManagedArtifactName('abc', 'abc_2_ch0.mp3'), false);
    assert.equal(isManagedArtifactName('abc', 'abc_2_ch0_chunk0.mp3'), false);
    assert.equal(isManagedArtifactName('abc_2', 'abc.epub'), false);
  });

  await test('recognizes every generated artifact suffix for the owning id only', () => {
    const owned = [
      'abc.epub',
      'abc.pdf',
      'abc.xbook.json',
      'abc_cover.jpg',
      'abc_ch0.mp3',
      'abc_ch12.m4a',
      'abc_ch0_chunk3.mp3',
      'abc_ch0_chunk3.mp3.narration-artifact.json',
      'abc_ch0_concat.txt',
      'abc_ch0_concat_clean.txt',
      'abc_ch0.texthash',
      'abc_tts0123456789_ch0.mp3',
      'abc_tts0123456789_ch0_chunk1.mp3',
      'abc_offline_0123456789abcdef_ch0.mp3'
    ];
    for (const filename of owned) {
      assert.equal(isManagedArtifactName('abc', filename), true, filename);
    }
    assert.equal(isManagedArtifactName('abc', 'abcdef.epub'), false);
    assert.equal(isManagedArtifactName('abc', 'unrelated.epub'), false);
    assert.equal(isManagedArtifactName('', 'abc.epub'), false);
  });

  await test('canonicalArtifactPath only rebinds a book onto its own artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-owner-'));
    try {
      const cacheDir = path.join(root, 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      // Both books share a cache directory; "abc_2"'s epub is a real file
      // that "abc" must never be rebound onto.
      fs.writeFileSync(path.join(cacheDir, 'abc_2.epub'), 'sibling');

      const staleStoredPath = path.join('/old-release/cache', 'abc_2.epub');
      const result = canonicalArtifactPath('abc', staleStoredPath, cacheDir);
      assert.equal(result, staleStoredPath, 'must not rebind onto a sibling book\'s file');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
