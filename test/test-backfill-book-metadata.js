const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { main, inferDownloadSource } = require('../scripts/backfill-book-metadata');

(async () => {
  // inferDownloadSource keeps its original contract.
  assert.strictEqual(inferDownloadSource({}), 'annas');
  assert.strictEqual(inferDownloadSource({ uploadedFile: 'x.epub' }), 'upload');
  assert.strictEqual(inferDownloadSource({ id: 'pg-123' }), 'gutenberg');
  assert.strictEqual(inferDownloadSource({ zlibId: '7' }), 'zlibrary');
  assert.strictEqual(inferDownloadSource({ downloadSource: 'upload' }), 'upload');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'backfill-test-'));
  const dataDir = path.join(tmp, 'data');
  const cacheDir = path.join(tmp, 'cache');
  await fs.mkdir(dataDir);
  await fs.mkdir(cacheDir);
  process.env.DATA_DIR = dataDir;
  process.env.CACHE_DIR = cacheDir;
  // Re-resolve module constants against the temp dirs.
  delete require.cache[require.resolve('../scripts/backfill-book-metadata')];
  const script = require('../scripts/backfill-book-metadata');

  // Unreadable catalog: update() must fail closed and write nothing.
  const hooks = {
    inferGutenbergIdFromBook: async () => undefined,
    ensureBookCover: async () => undefined
  };
  await fs.writeFile(path.join(dataDir, 'books.json'), '{corrupt', 'utf8');
  let failed = false;
  try {
    await script.main(hooks);
  } catch {
    failed = true;
  }
  assert.ok(failed, 'corrupt catalog aborts instead of being replaced with {}');
  const afterFailure = await fs.readFile(path.join(dataDir, 'books.json'), 'utf8');
  assert.strictEqual(afterFailure, '{corrupt', 'failed run must not overwrite the catalog');
  await assert.rejects(() => fs.access(path.join(dataDir, 'books.json.backfill.lock')),
    'lockfile is released even after failure');

  const resolvedCacheDir = await fs.realpath(cacheDir);
  const book = { id: 'b1', title: 'T', path: '/nowhere.epub' };
  await fs.writeFile(path.join(dataDir, 'books.json'), JSON.stringify({ b1: book }), 'utf8');
  await fs.writeFile(path.join(resolvedCacheDir, "b1_cover.jpg"), 'jpg', 'utf8');
  const outcome = await script.main(hooks);
  assert.strictEqual(outcome.updated, 1, 'the record lacking coverPath is updated');
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'books.json'), 'utf8'));
  const expectedCover = path.join(resolvedCacheDir, "b1_cover.jpg");
  assert.strictEqual(saved.b1.coverPath, expectedCover,
    'existing local cover is linked into the record');
  assert.strictEqual(saved.b1.downloadSource, 'annas', 'download source inferred');

  // Legacy records omit redundant ids; catalog keys must drive distinct covers.
  const coverPaths = [];
  await fs.writeFile(path.join(dataDir, 'books.json'), JSON.stringify({
    first: { title: 'First' },
    second: { title: 'Second' }
  }), 'utf8');
  await script.main({
    ...hooks,
    ensureBookCover: async (_book, { coverPath }) => {
      coverPaths.push(coverPath);
      return true;
    }
  });
  const legacySaved = JSON.parse(await fs.readFile(path.join(dataDir, 'books.json'), 'utf8'));
  assert.strictEqual(legacySaved.first.id, 'first', 'first legacy record receives its catalog key');
  assert.strictEqual(legacySaved.second.id, 'second', 'second legacy record receives its catalog key');
  assert.deepStrictEqual(coverPaths.sort(), [
    path.join(resolvedCacheDir, 'first_cover.jpg'),
    path.join(resolvedCacheDir, 'second_cover.jpg')
  ], 'id-less records use their distinct catalog keys for cover paths');

  // Concurrent runs exclude each other via the O_EXCL lockfile.
  const lockHandle = await fs.open(path.join(dataDir, 'books.json.backfill.lock'), 'wx');
  try {
    await assert.rejects(() => script.main(hooks), /Another backfill/,
      'second concurrent run refuses to start');
  } finally {
    await lockHandle.close();
    await fs.unlink(path.join(dataDir, 'books.json.backfill.lock')).catch(() => {});
  }

  await fs.rm(tmp, { recursive: true, force: true });
  console.log('12 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
