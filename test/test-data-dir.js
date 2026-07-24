const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

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
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-data-dir-'));
  process.env.DATA_DIR = dataDir;
  try {
    await fsp.writeFile(path.join(dataDir, 'zlibrary-auth.json'), JSON.stringify({
      version: 2,
      userId: 'fixture-user',
      userKey: 'fixture-key',
      baseUrl: 'https://z-library.sk',
      verifiedAt: '2026-07-12T00:00:00.000Z'
    }));
    await fsp.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ voice: 'en-GB-RyanNeural' }));

    const zlibrary = require('../lib/zlibrary');
    const gutenberg = require('../lib/gutenberg');
    const TTSQueue = require('../lib/tts-queue');

    await test('Z-Library defaults session storage to DATA_DIR', async () => {
      assert.strictEqual(zlibrary.isConfigured(), true);
    });
    await test('Gutenberg defaults settings storage to DATA_DIR', async () => {
      await gutenberg.setEnabled(false);
      const stored = JSON.parse(await fsp.readFile(path.join(dataDir, 'gutenberg-settings.json'), 'utf8'));
      assert.strictEqual(stored.enabled, false);
    });
    await test('TTS voice settings are read from DATA_DIR', async () => {
      assert.strictEqual(TTSQueue.__test.getSettings().voice, 'en-GB-RyanNeural');
    });
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
