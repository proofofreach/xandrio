const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const gutenberg = require('../lib/gutenberg');
const internetArchive = require('../lib/search-providers/internet-archive');

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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-fetch-safety-'));
  try {
    await test('Gutenberg rejects a private download URL before creating a file', async () => {
      const destination = path.join(directory, 'gutenberg.epub');
      await assert.rejects(gutenberg.downloadBook('1', 'https://127.0.0.1/book.epub', destination), /safe public HTTPS URL/);
      await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
      await assert.rejects(fs.stat(`${destination}.part`), { code: 'ENOENT' });
    });

    await test('Internet Archive rejects a link-local download URL before creating a file', async () => {
      const destination = path.join(directory, 'archive.epub');
      await assert.rejects(internetArchive.download({ downloadUrl: 'https://169.254.169.254/book.epub' }, destination), /safe public HTTPS URL/);
      await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
      await assert.rejects(fs.stat(`${destination}.part`), { code: 'ENOENT' });
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
