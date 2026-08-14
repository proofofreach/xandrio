'use strict';

const assert = require('node:assert');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const jsonStore = require('../lib/json-store');
const { createBookGuideJournal } = require('../lib/book-guide-journal');
const { createBookGuideStore } = require('../lib/book-guide-store');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack || error.message}`); }
}

async function run() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'book-guide-store-'));
  try {
    const certificationFile = path.join(temp, 'guide-certification.json');
    const store = createBookGuideStore({
      artifactDir: path.join(temp, 'guides'),
      configFile: path.join(temp, 'guide-config.json'),
      certificationFile,
      credentialsFile: path.join(temp, 'guide-provider.json'),
      jsonStore,
      validateArtifact: artifact => {
        if (artifact.valid !== true) throw new Error('invalid artifact');
      }
    });
    const journal = createBookGuideJournal({ filePath: path.join(temp, 'guide-jobs.json'), jsonStore });

    await test('publishes and reads an artifact atomically', async () => {
      await store.publish('book_1', { bookId: 'book_1', valid: true, revision: 1 });
      assert.strictEqual((await store.read('book_1')).revision, 1);
    });

    await test('keeps the prior artifact when candidate validation fails', async () => {
      await assert.rejects(store.publish('book_1', { bookId: 'book_1', valid: false, revision: 2 }), /invalid artifact/);
      assert.strictEqual((await store.read('book_1')).revision, 1);
    });

    await test('stores provider configuration without the write-only API key', async () => {
      const config = await store.saveConfig({
        enabled: true,
        allowUncertified: true,
        externalProcessingAcknowledgedAt: '2026-08-14T00:00:00.000Z',
        baseUrl: 'http://127.0.0.1:11434',
        generator: { name: 'g:1', digest: 'digest-g' },
        verifier: { name: 'v:1', digest: 'digest-v' }
      });
      assert.strictEqual(config.enabled, true);
      assert.strictEqual(config.allowUncertified, true);
      assert.strictEqual(config.externalProcessingAcknowledgedAt, '2026-08-14T00:00:00.000Z');
      assert.strictEqual((await store.loadConfig()).generator.name, 'g:1');
      assert.strictEqual(JSON.stringify(await store.loadConfig()).includes('apiKey'), false);
    });

    await test('stores and clears the provider API key separately', async () => {
      await store.saveCredentials({ apiKey: 'test-secret', updatedAt: '2026-08-14T00:00:00.000Z' });
      assert.strictEqual((await store.loadCredentials()).apiKey, 'test-secret');
      assert.strictEqual(await store.clearCredentials(), true);
      assert.strictEqual((await store.loadCredentials()).apiKey, '');
    });

    await test('loads the local aggregate benchmark certificate from its dedicated file', async () => {
      await jsonStore.save(certificationFile, { schemaVersion: 1, passed: true, provenance: { recipeHash: 'abc' } });
      assert.strictEqual((await store.loadCertification()).passed, true);
    });

    await test('journal rejects content-bearing job fields', async () => {
      await assert.rejects(journal.put({ id: 'job_1', bookId: 'book_1', text: 'source prose' }), /content field text/);
    });

    await test('journal persists only operational job state', async () => {
      await journal.put({
        id: 'job_1', bookId: 'book_1', status: 'pending', sourceFingerprint: 'sha256:x',
        nonfictionConfirmedAt: '2026-08-13T00:00:00.000Z'
      });
      const raw = await fs.readFile(path.join(temp, 'guide-jobs.json'), 'utf8');
      assert(!raw.includes('source prose'));
      assert.strictEqual((await journal.get('book_1')).status, 'pending');
    });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
