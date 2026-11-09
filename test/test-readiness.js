#!/usr/bin/env node
const assert = require('node:assert/strict');
const { createReadinessProbe } = require('../lib/readiness');

let passed = 0;
let failed = 0;

async function check(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

(async () => {
  await check('reports ready when state directories and JSON stores are usable', async () => {
    const accesses = [];
    const reads = [];
    const probe = createReadinessProbe({
      dataDir: '/state/data',
      cacheDir: '/state/cache',
      criticalJsonFiles: ['/state/data/books.json', '/state/data/accounts.json'],
      access: async (path, mode) => accesses.push({ path, mode }),
      readFile: async path => {
        reads.push(path);
        return '{}';
      }
    });

    assert.deepEqual(await probe.check(), { ready: true });
    assert.deepEqual(accesses.map(item => item.path), ['/state/data', '/state/cache']);
    assert.deepEqual(reads, ['/state/data/books.json', '/state/data/accounts.json']);
  });

  await check('allows an optional JSON store that does not exist yet', async () => {
    const probe = createReadinessProbe({
      dataDir: '/state/data',
      cacheDir: '/state/cache',
      criticalJsonFiles: ['/state/data/new-store.json'],
      access: async () => {},
      readFile: async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
    });
    assert.deepEqual(await probe.check(), { ready: true });
  });

  await check('fails closed on malformed state without exposing filesystem details', async () => {
    const probe = createReadinessProbe({
      dataDir: '/state/data',
      cacheDir: '/state/cache',
      criticalJsonFiles: ['/state/data/books.json'],
      access: async () => {},
      readFile: async () => '{broken'
    });
    assert.deepEqual(await probe.check(), {
      ready: false,
      reason: 'SyntaxError'
    });
  });

  await check('fails closed when persistent storage is not writable', async () => {
    const probe = createReadinessProbe({
      dataDir: '/state/data',
      cacheDir: '/state/cache',
      access: async path => {
        if (path.endsWith('/cache')) {
          const error = new Error('denied');
          error.code = 'EACCES';
          throw error;
        }
      }
    });
    assert.deepEqual(await probe.check(), {
      ready: false,
      reason: 'EACCES'
    });
  });

  await check('fails closed when an initialized store has gone missing', async () => {
    const probe = createReadinessProbe({
      dataDir: '/state/data',
      cacheDir: '/state/cache',
      criticalJsonFiles: ['/state/data/books.json'],
      access: async () => {},
      readFile: async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      exists: async path => path === '/state/data/books.json.initialized'
    });
    assert.deepEqual(await probe.check(), { ready: false, reason: 'JSON_STORE_MISSING_AFTER_INIT' });
  });

  await check('in production an uninitialized data directory is not ready; any initialized store is', async () => {
    const missing = async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    };
    const base = {
      dataDir: '/state/data',
      cacheDir: '/state/cache',
      criticalJsonFiles: ['/state/data/books.json', '/state/data/accounts.json'],
      access: async () => {},
      requireInitialized: true
    };
    assert.deepEqual(
      await createReadinessProbe({ ...base, readFile: missing, exists: async () => false }).check(),
      { ready: false, reason: 'DATA_DIR_NOT_INITIALIZED' }
    );
    assert.deepEqual(
      await createReadinessProbe({ ...base, readFile: async path => path.endsWith('books.json') ? '{}' : missing(), exists: async () => false }).check(),
      { ready: true },
      'a readable store counts as initialized'
    );
    assert.deepEqual(
      await createReadinessProbe({ ...base, readFile: missing, exists: async path => path === '/state/data/accounts.json.initialized' }).check(),
      { ready: false, reason: 'JSON_STORE_MISSING_AFTER_INIT' },
      'a marker without its file is the missing-after-init failure, not a fresh directory'
    );
    assert.deepEqual(
      await createReadinessProbe({ ...base, requireInitialized: false, readFile: missing, exists: async () => false }).check(),
      { ready: true },
      'outside production a fresh directory is still allowed to come up'
    );
  });

  await check('gates on the cached runtime dependency verdict', async () => {
    const base = {
      dataDir: '/state/data',
      cacheDir: '/state/cache',
      criticalJsonFiles: ['/state/data/books.json'],
      access: async () => {},
      readFile: async () => '{}'
    };
    assert.deepEqual(
      await createReadinessProbe({ ...base, dependencies: async () => ({ ok: false, failures: ['ffmpeg is not installed'] }) }).check(),
      { ready: false, reason: 'RUNTIME_DEPENDENCY_MISSING' }
    );
    assert.deepEqual(await createReadinessProbe({ ...base, dependencies: async () => ({ ok: true }) }).check(), { ready: true });
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
