const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const storageSource = serverSource.match(/const storage = multer\.diskStorage\(\{[\s\S]*?\n\}\);\n\nconst upload = multer\(/);

assert(storageSource, 'Could not locate Multer storage configuration');

function loadStorage({ mkdir, now = () => 0, randomUUID = require('crypto').randomUUID, getBookFormat = () => 'epub' }) {
  let storage;
  vm.runInNewContext(
    storageSource[0].replace(/\n\nconst upload = multer\($/, ''),
    {
      CACHE_DIR: '/tmp/xandrio-cache',
      Date: { now },
      crypto: { randomUUID },
      fs: { mkdir },
      getBookFormat,
      multer: { diskStorage: config => {
        storage = config;
        return config;
      } },
      path
    },
    { filename: 'server.js' }
  );
  return storage;
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

(async () => {
  await test('cleanup only removes server-named uploads directly in the cache', async () => {
    const removed = [];
    const cleanupSource = serverSource.match(/async function removeUploadedFile\(filePath\) \{[\s\S]*?\n\}/)[0];
    const cleanup = vm.runInNewContext(`${cleanupSource}; removeUploadedFile`, {
      path, CACHE_DIR: '/tmp/xandrio-cache',
      removeFileIfExists: async filePath => removed.push(filePath)
    });
    const name = 'upload_12345678-1234-1234-1234-123456789abc.epub';
    assert.equal(await cleanup(`/tmp/xandrio-cache/${name}`), true);
    assert.equal(await cleanup(`/tmp/outside/${name}`), false);
    assert.equal(await cleanup(`/tmp/xandrio-cache/../outside/${name}`), false);
    assert.equal(await cleanup('/tmp/xandrio-cache/books.json'), false);
    assert.deepStrictEqual(removed, [`/tmp/xandrio-cache/${name}`]);
  });
  await test('destination reports mkdir failure exactly once', async () => {
    const failure = new Error('mkdir failed');
    const storage = loadStorage({ mkdir: () => Promise.reject(failure) });
    const calls = [];

    await new Promise(resolve => {
      storage.destination({}, {}, (...args) => {
        calls.push(args);
        resolve();
      });
    });

    await Promise.resolve();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], failure);
    assert.strictEqual(calls[0].length, 1);
  });

  await test('filename is unique for identical names in the same millisecond', () => {
    const storage = loadStorage({ mkdir: () => Promise.resolve(), now: () => 1723593600000 });
    const file = { originalname: 'same-book.epub' };
    const filenames = [];

    storage.filename({}, file, (error, filename) => {
      assert.strictEqual(error, null);
      filenames.push(filename);
    });
    storage.filename({}, file, (error, filename) => {
      assert.strictEqual(error, null);
      filenames.push(filename);
    });

    assert.strictEqual(filenames.length, 2);
    assert.notStrictEqual(filenames[0], filenames[1]);
    assert.match(filenames[0], /^upload_[0-9a-f-]{36}\.epub$/i);
    assert.match(filenames[1], /^upload_[0-9a-f-]{36}\.epub$/i);
  });

  await test('extension derives from validated format, not the client filename', () => {
    const storage = loadStorage({
      // Mirror production getBookFormat: known book extensions from the
      // filename, otherwise the MIME-type table.
      getBookFormat: file =>
        ({ epub: 'epub', mobi: 'mobi', azw3: 'azw3', pdf: 'pdf' })
          [(file.originalname.match(/\.([a-z0-9]+)$/i) || [])[1]] ||
        ({ 'application/pdf': 'pdf' })[file.mimetype] ||
        ''
    });
    // A client can name a PDF upload anything; the MIME filter already
    // accepted it as pdf, so storing it under the original .bin extension
    // would make import fail as unsupported.
    let stored;
    storage.filename({}, { originalname: 'book.bin', mimetype: 'application/pdf' }, (error, filename) => {
      assert.strictEqual(error, null);
      stored = filename;
    });
    assert.match(stored, /\.pdf$/i);
    assert.doesNotMatch(stored, /\.bin$/i);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
