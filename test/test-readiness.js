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

  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
