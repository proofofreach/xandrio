const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createImportClaims, sweepAbandonedImportClaims } = require('../lib/import-claims');
const { createBookImporter } = require('../lib/book-importer');

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

// A PID that belonged to a process which has already exited.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-import-claims-'));
  const cacheDir = path.join(root, 'cache');
  const claimsDir = path.join(root, 'import-claims');
  fs.mkdirSync(cacheDir);
  fs.mkdirSync(claimsDir);
  const write = name => {
    const filePath = path.join(cacheDir, name);
    fs.writeFileSync(filePath, 'x');
    return filePath;
  };
  const marker = (name, pid, entries, startedAt = 1) => fs.writeFileSync(
    path.join(claimsDir, name),
    JSON.stringify({ pid, startedAt, entries })
  );
  return { root, cacheDir, claimsDir, write, marker, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const exists = filePath => fs.existsSync(filePath);

(async () => {
  await test('a crashed import\'s claimed files are swept and its marker removed', async () => {
    const f = fixture();
    try {
      const dead = deadPid();
      const download = f.write('crash_Title.epub');
      const source = f.write('crash.epub');
      const xbook = f.write('crash.xbook.json');
      const unclaimed = f.write('crash_cover.jpg');
      f.marker(`${dead}.0011223344556677.json`, dead, [
        { bookId: 'crash', path: download },
        { bookId: 'crash', path: source },
        { bookId: 'crash', path: xbook },
        { bookId: 'crash', path: path.join(f.cacheDir, 'crash.pdf') }
      ]);
      const result = await sweepAbandonedImportClaims({
        directory: f.claimsDir, cacheDir: f.cacheDir, loadBooks: async () => ({})
      });
      assert.equal(result.removed, 3);
      assert.ok(!exists(download) && !exists(source) && !exists(xbook));
      assert.ok(exists(unclaimed), 'a file no marker lists is never deleted');
      assert.deepEqual(fs.readdirSync(f.claimsDir), []);
    } finally {
      f.cleanup();
    }
  });

  await test('a dead marker never deletes a path that a books.json record owns', async () => {
    const f = fixture();
    try {
      const dead = deadPid();
      const committed = f.write('done.epub');
      const committedXbook = f.write('done.xbook.json');
      const referenced = f.write('other_Title.epub');
      f.marker(`${dead}.8899aabbccddeeff.json`, dead, [
        // The import committed, then crashed before removing its marker.
        { bookId: 'done', path: committed },
        { bookId: 'done', path: committedXbook },
        // Another record stores this path.
        { bookId: 'lost', path: referenced }
      ]);
      const books = {
        done: { id: 'done', path: committed },
        other: { id: 'other', path: path.join('/old/cache', 'other_Title.epub') }
      };
      const result = await sweepAbandonedImportClaims({
        directory: f.claimsDir, cacheDir: f.cacheDir, loadBooks: async () => books
      });
      assert.equal(result.removed, 0);
      assert.ok(exists(committed) && exists(committedXbook) && exists(referenced));
    } finally {
      f.cleanup();
    }
  });

  await test('a live owner\'s marker and the paths it lists are kept', async () => {
    const f = fixture();
    try {
      const dead = deadPid();
      const live = f.write('live.epub');
      const shared = f.write('shared.epub');
      // A second process (a release cutover) is importing and has no record yet.
      f.marker(`${process.ppid}.0123456789abcdef.json`, process.ppid, [
        { bookId: 'live', path: live },
        { bookId: 'shared', path: shared }
      ]);
      f.marker(`${dead}.fedcba9876543210.json`, dead, [{ bookId: 'shared', path: shared }]);
      await sweepAbandonedImportClaims({
        directory: f.claimsDir, cacheDir: f.cacheDir, loadBooks: async () => ({})
      });
      assert.ok(exists(live) && exists(shared));
      assert.ok(exists(path.join(f.claimsDir, `${process.ppid}.0123456789abcdef.json`)));
    } finally {
      f.cleanup();
    }
  });

  await test('this process\'s own open claim is live', async () => {
    const f = fixture();
    try {
      const claims = createImportClaims({ directory: f.claimsDir });
      const claim = claims.begin();
      const own = path.join(f.cacheDir, 'mine.epub');
      await claim.claim('mine', [own]);
      fs.writeFileSync(own, 'x');
      await sweepAbandonedImportClaims({
        directory: f.claimsDir, cacheDir: f.cacheDir, loadBooks: async () => ({})
      });
      assert.ok(exists(own));
      await claim.close();
      assert.deepEqual(fs.readdirSync(f.claimsDir), []);
    } finally {
      f.cleanup();
    }
  });

  await test('an unreadable books.json removes nothing', async () => {
    const f = fixture();
    try {
      const dead = deadPid();
      const orphan = f.write('orphan.epub');
      f.marker(`${dead}.0a0a0a0a0a0a0a0a.json`, dead, [{ bookId: 'orphan', path: orphan }]);
      for (const loadBooks of [
        async () => { throw Object.assign(new Error('missing after init'), { code: 'JSON_STORE_MISSING_AFTER_INIT' }); },
        async () => null
      ]) {
        const result = await sweepAbandonedImportClaims({
          directory: f.claimsDir, cacheDir: f.cacheDir, loadBooks, log: { warn() {} }
        });
        assert.equal(result.removed, 0);
        assert.ok(exists(orphan));
        assert.equal(fs.readdirSync(f.claimsDir).length, 1, 'the marker stays for the next start');
      }
    } finally {
      f.cleanup();
    }
  });

  await test('a dead marker never deletes outside the cache directory', async () => {
    const f = fixture();
    try {
      const dead = deadPid();
      const outside = path.join(f.root, 'outside.epub');
      fs.writeFileSync(outside, 'x');
      f.marker(`${dead}.1b1b1b1b1b1b1b1b.json`, dead, [{ bookId: 'x', path: outside }]);
      await sweepAbandonedImportClaims({
        directory: f.claimsDir, cacheDir: f.cacheDir, loadBooks: async () => ({})
      });
      assert.ok(exists(outside));
    } finally {
      f.cleanup();
    }
  });

  await test('the importer claims paths before its first write and removes the claim at commit or cleanup', async () => {
    const f = fixture();
    try {
      const claims = createImportClaims({ directory: f.claimsDir });
      const events = [];
      const markerEntries = () => fs.readdirSync(f.claimsDir)
        .filter(name => name.endsWith('.json'))
        .flatMap(name => JSON.parse(fs.readFileSync(path.join(f.claimsDir, name), 'utf8')).entries.map(entry => entry.path));
      const build = overrides => createBookImporter({
        importClaims: claims,
        importPaths: ({ id, acquirePath }) => [acquirePath, path.join(f.cacheDir, `${id}.epub`)].filter(Boolean),
        normalizeBook: async ({ sourcePath, id }) => {
          events.push(`normalize:${markerEntries().includes(path.join(f.cacheDir, `${id}.epub`))}`);
          const finalPath = path.join(f.cacheDir, `${id}.epub`);
          fs.renameSync(sourcePath, finalPath);
          return { finalPath, filename: `${id}.epub`, originalFormat: 'EPUB', originalSize: 1, finalSize: 1 };
        },
        document: {
          validateBook: async () => ({ valid: true, errors: [], warnings: [] }),
          extractMetadata: async () => ({ title: 'T', author: 'A' }),
          extractChapters: async () => [{ title: 'One', text: 'Prose. '.repeat(100) }]
        },
        checkChapterQuality: async () => ({ isGoodStructure: true }),
        shouldDiscardSourceAfterExtract: () => false,
        assessExtractedContent: () => ({ valid: true, errors: [], warnings: [] }),
        metadata: {
          resolveSeed: m => ({ title: m.title, author: m.author, filenameMetadata: {} }),
          enrich: async () => ({}),
          trustedTitle: () => '',
          isGarbageTitle: () => false,
          isGarbageAuthor: () => false,
          resolveIdentity: async () => ({}),
          assessConfidence: () => ({}),
          buildValidation: () => ({ valid: true, warnings: [] }),
          canonicalWorkKey: () => undefined,
          openLibraryFields: () => ({}),
          cleanDescription: value => value || '',
          publishedYear: () => undefined
        },
        persistBook: async () => {
          events.push(`persist:${markerEntries().length}`);
          return {};
        },
        removeFile: async filePath => fs.rmSync(filePath, { force: true }),
        log: { log() {}, warn() {}, error() {} },
        ...overrides
      });
      const acquirePath = path.join(f.cacheDir, 'ok_Title.epub');
      await build().import({
        kind: 'download', id: 'ok', originalName: 'ok.epub', acquirePath,
        acquire: async () => {
          events.push(`acquire:${markerEntries().includes(acquirePath)}`);
          fs.writeFileSync(acquirePath, 'x');
          return acquirePath;
        }
      });
      assert.deepEqual(events, ['acquire:true', 'normalize:true', 'persist:2']);
      assert.deepEqual(fs.readdirSync(f.claimsDir), [], 'a committed import removes its marker');

      await build({ persistBook: async () => { throw new Error('disk full'); } }).import({
        kind: 'download', id: 'bad', originalName: 'bad.epub',
        acquirePath: path.join(f.cacheDir, 'bad_Title.epub'),
        acquire: async () => {
          fs.writeFileSync(path.join(f.cacheDir, 'bad_Title.epub'), 'x');
          return path.join(f.cacheDir, 'bad_Title.epub');
        }
      }).catch(() => undefined);
      assert.ok(!exists(path.join(f.cacheDir, 'bad.epub')));
      assert.deepEqual(fs.readdirSync(f.claimsDir), [], 'a cleaned-up import removes its marker');
    } finally {
      f.cleanup();
    }
  });

  console.log(`\nImport claim tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
