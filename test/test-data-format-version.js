const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  DATA_FORMAT_VERSION,
  ensureDataFormatVersion,
  formatVersionPath,
  parseFormatVersion
} = require('../lib/data-format-version');

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
  await test('writes the supported version on first start and accepts it afterwards', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-format-version-'));
    try {
      assert.deepEqual(await ensureDataFormatVersion({ dataDir }), { version: DATA_FORMAT_VERSION, created: true });
      assert.equal(fs.readFileSync(formatVersionPath(dataDir), 'utf8'), `${DATA_FORMAT_VERSION}\n`);
      assert.deepEqual(await ensureDataFormatVersion({ dataDir }), { version: DATA_FORMAT_VERSION });
      assert.equal(DATA_FORMAT_VERSION, 1, 'the initial format version is 1');
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  await test('refuses a data directory written by a newer release', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-format-version-'));
    try {
      fs.writeFileSync(formatVersionPath(dataDir), '7\n');
      await assert.rejects(
        ensureDataFormatVersion({ dataDir, supported: 6 }),
        error => error.code === 'DATA_FORMAT_VERSION_TOO_NEW' && error.version === 7 && error.supported === 6 &&
          /supports up to 6/.test(error.message) && /rolling back/.test(error.message)
      );
      assert.equal(fs.readFileSync(formatVersionPath(dataDir), 'utf8'), '7\n', 'the newer version is left untouched');
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  await test('raises an older version in place and refuses garbage', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-format-version-'));
    try {
      fs.writeFileSync(formatVersionPath(dataDir), '1\n');
      assert.deepEqual(await ensureDataFormatVersion({ dataDir, supported: 2 }), { version: 2, upgradedFrom: 1 });
      assert.equal(fs.readFileSync(formatVersionPath(dataDir), 'utf8'), '2\n');
      assert.deepEqual(fs.readdirSync(dataDir), ['format-version'], 'no temp file is left behind');
      fs.writeFileSync(formatVersionPath(dataDir), 'one\n');
      await assert.rejects(ensureDataFormatVersion({ dataDir }), { code: 'DATA_FORMAT_VERSION_INVALID' });
      assert.equal(parseFormatVersion(' 12 \n'), 12);
      assert.equal(parseFormatVersion('1.2'), null);
      assert.equal(parseFormatVersion(''), null);
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  console.log(`data-format-version tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
