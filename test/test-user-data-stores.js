// Irreplaceable user data stores (lib/user-data-stores.js) registered with
// lib/json-store.js: any plain load/save/update of their paths fails closed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const jsonStore = require('../lib/json-store');
const { createReadinessProbe } = require('../lib/readiness');
const {
  registerUserDataStores,
  validateBookDeletionsStore,
  validatePronunciationsStore,
  validateUsersKeyedStore
} = require('../lib/user-data-stores');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

const STORE_NAMES = {
  positions: 'positions.json',
  shelves: 'shelves.json',
  bookmarks: 'bookmarks.json',
  listeningQueues: 'listening-queues.json',
  users: 'users.json',
  clientSettings: 'client-settings.json',
  settings: 'settings.json',
  pronunciations: 'pronunciations.json',
  bookDeletions: 'book-deletions.json',
  customVoices: 'custom-voices.json'
};

async function freshDataDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-user-stores-'));
  const files = Object.fromEntries(Object.entries(STORE_NAMES).map(([key, name]) => [key, path.join(dir, name)]));
  const stores = registerUserDataStores({ jsonStore, files });
  return {
    dir,
    files,
    stores,
    cleanup: async () => {
      for (const store of stores) jsonStore.unregisterCriticalStore(store.filePath);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };
}

function silenceErrors(fn) {
  const original = console.error;
  console.error = () => {};
  return Promise.resolve().then(fn).finally(() => { console.error = original; });
}

(async () => {
  await test('a brand-new install reads the caller default and the first write initializes the store', async () => {
    const env = await freshDataDir();
    try {
      for (const filePath of Object.values(env.files)) {
        assert.deepEqual(await jsonStore.load(filePath, { users: {} }), { users: {} });
        assert.equal(fs.existsSync(`${filePath}.initialized`), false, 'reading defaults does not mark a store initialized');
      }
      await jsonStore.update(env.files.shelves, data => { data.users.alice = { books: {} }; }, { users: {} });
      assert.ok(fs.existsSync(`${env.files.shelves}.initialized`));
    } finally {
      await env.cleanup();
    }
  });

  await test('an existing valid file from before the markers loads and gets its marker backfilled', async () => {
    const env = await freshDataDir();
    try {
      // Legacy single-user positions: keyed by book id, no `users` wrapper.
      const legacy = { 'book-1': { chapterIndex: 3, position: 12.5 } };
      await fsp.writeFile(env.files.positions, JSON.stringify(legacy));
      assert.deepEqual(await jsonStore.load(env.files.positions, {}), legacy);
      assert.ok(fs.existsSync(`${env.files.positions}.initialized`));
    } finally {
      await env.cleanup();
    }
  });

  await test('a corrupt store makes every read and write throw and keeps its bytes', async () => {
    const env = await freshDataDir();
    try {
      for (const filePath of Object.values(env.files)) {
        const corrupt = '{"users": {"alice": ';
        await fsp.writeFile(filePath, corrupt);
        await silenceErrors(async () => {
          await assert.rejects(jsonStore.load(filePath, {}), { code: 'JSON_STORE_CORRUPT' });
          await assert.rejects(jsonStore.update(filePath, data => { data.reset = true; }, {}), { code: 'JSON_STORE_CORRUPT' });
        });
        assert.equal(await fsp.readFile(filePath, 'utf8'), corrupt, `${path.basename(filePath)} was overwritten`);
      }
    } finally {
      await env.cleanup();
    }
  });

  await test('a store missing after initialization fails closed instead of starting empty', async () => {
    const env = await freshDataDir();
    try {
      for (const filePath of Object.values(env.files)) {
        await jsonStore.save(filePath, { users: {} });
        await fsp.rm(filePath);
        await silenceErrors(async () => {
          await assert.rejects(jsonStore.load(filePath, {}), { code: 'JSON_STORE_MISSING_AFTER_INIT' });
          await assert.rejects(jsonStore.update(filePath, () => {}, {}), { code: 'JSON_STORE_MISSING_AFTER_INIT' });
        });
        assert.equal(fs.existsSync(filePath), false, `${path.basename(filePath)} was recreated empty`);
      }
    } finally {
      await env.cleanup();
    }
  });

  await test('a parseable file of the wrong shape is rejected, not normalized away', async () => {
    const env = await freshDataDir();
    try {
      await fsp.writeFile(env.files.shelves, '[]');
      await assert.rejects(jsonStore.update(env.files.shelves, () => {}, {}), { code: 'JSON_STORE_VALIDATION_FAILED' });
      assert.equal(await fsp.readFile(env.files.shelves, 'utf8'), '[]');
      await fsp.writeFile(env.files.bookDeletions, JSON.stringify({ revision: -1 }));
      await assert.rejects(jsonStore.load(env.files.bookDeletions, {}), { code: 'JSON_STORE_VALIDATION_FAILED' });
      await fsp.writeFile(env.files.customVoices, JSON.stringify({ voices: {} }));
      await assert.rejects(jsonStore.load(env.files.customVoices, {}), { code: 'JSON_STORE_VALIDATION_FAILED' });
    } finally {
      await env.cleanup();
    }
  });

  await test('validators accept the shapes real files have', async () => {
    assert.equal(validateUsersKeyedStore({ users: { default: { books: {} } } }), true);
    assert.equal(validateUsersKeyedStore({ 'book-1': { position: 1 } }), true);
    assert.equal(validateUsersKeyedStore({}), true);
    assert.equal(validatePronunciationsStore({ version: 1, global: [], books: { b: [{ source: 'a' }] } }), true);
    assert.equal(validateBookDeletionsStore({ version: 1, revision: 4, pending: {}, deletions: {} }), true);
    assert.equal(validateBookDeletionsStore({}), true);
    assert.notEqual(validateUsersKeyedStore(null), true);
    assert.notEqual(validateUsersKeyedStore({ users: [] }), true);
  });

  await test('position writes inside the backup interval skip the backup copy', async () => {
    const env = await freshDataDir();
    try {
      for (let i = 0; i < 5; i += 1) {
        await jsonStore.update(env.files.positions, data => { data.n = i; }, {});
      }
      const backups = await fsp.readdir(`${env.files.positions}.backups`);
      assert.equal(backups.length, 1, 'only the first pre-write state is copied');
      for (let i = 0; i < 3; i += 1) {
        await jsonStore.update(env.files.shelves, data => { data.n = i; }, {});
      }
      assert.equal((await fsp.readdir(`${env.files.shelves}.backups`)).length, 2, 'low-frequency stores back up every change');
    } finally {
      await env.cleanup();
    }
  });

  await test('readiness fails for a corrupt, misshapen, or missing-after-init user store', async () => {
    const env = await freshDataDir();
    try {
      const probe = createReadinessProbe({
        dataDir: env.dir,
        criticalJsonFiles: env.stores.map(store => ({ filePath: store.filePath, validate: store.validate }))
      });
      assert.deepEqual(await probe.check(), { ready: true });
      await jsonStore.save(env.files.users, { users: {} });
      await fsp.writeFile(env.files.settings, '[1]');
      assert.deepEqual(await probe.check(), { ready: false, reason: 'JSON_STORE_VALIDATION_FAILED' });
      await fsp.writeFile(env.files.settings, '{}');
      await fsp.rm(env.files.users);
      assert.deepEqual(await probe.check(), { ready: false, reason: 'JSON_STORE_MISSING_AFTER_INIT' });
    } finally {
      await env.cleanup();
    }
  });

  await test('unregistered paths keep the reconstructable-store behaviour', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-plain-store-'));
    try {
      const filePath = path.join(dir, 'cache.json');
      await fsp.writeFile(filePath, '{broken');
      await silenceErrors(async () => {
        assert.deepEqual(await jsonStore.load(filePath, { fresh: true }), { fresh: true });
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  console.log(`user data store tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
