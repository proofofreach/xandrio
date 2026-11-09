'use strict';

// Device-local playback checkpoints are partitioned by account. A checkpoint
// one account left on a shared device must never be restored, or force-saved
// backward, as another account's progress.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let passed = 0;
let failed = 0;

async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

function installStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  globalThis.localStorage = {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  return values;
}

const checkpoint = (bookId, timestamp) => ({ bookId, chapterIndex: 2, timestamp, chunkTime: 0, updatedAt: 1000 });

(async () => {
  console.log('\n━━━ Playback checkpoints ━━━');
  const checkpoints = await import(pathToFileURL(path.join(root, 'public/js/playback-checkpoints.mjs')).href);

  await test('a checkpoint written by one account is invisible to another', () => {
    const values = installStorage();
    assert.equal(checkpoints.writePlaybackCheckpoint('alice', checkpoint('book-1', 500)), true);
    assert.equal(checkpoints.readPlaybackCheckpoint('bob', 'book-1', { claimLegacy: true }), null);
    assert.deepEqual(checkpoints.readPlaybackCheckpoint('alice', 'book-1'), checkpoint('book-1', 500));
    const stored = JSON.parse(values.get(checkpoints.playbackCheckpointKey('alice', 'book-1')));
    assert.equal(stored.userId, 'alice', 'the stored record names its account');
  });

  await test('a record under the scope key that names another account is rejected', () => {
    const values = installStorage();
    values.set(checkpoints.playbackCheckpointKey('bob', 'book-1'), JSON.stringify({ ...checkpoint('book-1', 500), userId: 'alice' }));
    assert.equal(checkpoints.readPlaybackCheckpoint('bob', 'book-1'), null);
    assert.equal(values.has(checkpoints.playbackCheckpointKey('bob', 'book-1')), false);
  });

  await test('no read or write is possible without a valid scope', () => {
    installStorage();
    assert.equal(checkpoints.writePlaybackCheckpoint('', checkpoint('book-1', 1)), false);
    assert.equal(checkpoints.writePlaybackCheckpoint('bad scope!', checkpoint('book-1', 1)), false);
    assert.equal(checkpoints.readPlaybackCheckpoint(null, 'book-1', { claimLegacy: true }), null);
  });

  await test('a legacy checkpoint is adopted once when only this account has used the device', () => {
    const values = installStorage({
      'xandrio_playback_checkpoint:book-1': JSON.stringify(checkpoint('book-1', 700)),
      'xandrio_offline_books:alice': '{}'
    });
    assert.equal(checkpoints.readPlaybackCheckpoint('alice', 'book-1'), null, 'not adopted unless claimable');
    assert.equal(values.has('xandrio_playback_checkpoint:book-1'), true);
    assert.deepEqual(checkpoints.readPlaybackCheckpoint('alice', 'book-1', { claimLegacy: true }), checkpoint('book-1', 700));
    assert.equal(values.has('xandrio_playback_checkpoint:book-1'), false, 'the legacy key is moved, not copied');
    assert.deepEqual(checkpoints.readPlaybackCheckpoint('alice', 'book-1'), checkpoint('book-1', 700));
  });

  await test('a legacy checkpoint is dropped when the device shows a second account', () => {
    for (const evidence of [
      { [checkpoints.playbackCheckpointKey('bob', 'book-9')]: JSON.stringify({ ...checkpoint('book-9', 1), userId: 'bob' }) },
      { 'xandrio_pending_positions:bob': '[]' },
      { 'xandrio_offline_books:bob': '{}' },
      { xandrio_offline_legacy_cache_owner: 'bob' },
      { xandrio_pending_positions: JSON.stringify([{ bookId: 'book-1', userId: 'bob' }]) }
    ]) {
      const values = installStorage({
        'xandrio_playback_checkpoint:book-1': JSON.stringify(checkpoint('book-1', 700)),
        ...evidence
      });
      assert.equal(checkpoints.readPlaybackCheckpoint('alice', 'book-1', { claimLegacy: true }), null, JSON.stringify(evidence));
      assert.equal(values.has('xandrio_playback_checkpoint:book-1'), false);
      assert.equal(values.has(checkpoints.playbackCheckpointKey('alice', 'book-1')), false);
    }
  });

  await test('sign-out clears that account and legacy checkpoints but keeps other accounts', () => {
    const values = installStorage({ 'xandrio_playback_checkpoint:book-3': JSON.stringify(checkpoint('book-3', 1)) });
    checkpoints.writePlaybackCheckpoint('alice', checkpoint('book-1', 1));
    checkpoints.writePlaybackCheckpoint('alice', checkpoint('book-2', 1));
    checkpoints.writePlaybackCheckpoint('bob', checkpoint('book-1', 9));
    checkpoints.clearPlaybackCheckpoints('alice');
    assert.deepEqual([...values.keys()], [checkpoints.playbackCheckpointKey('bob', 'book-1')]);
  });

  await test('removing a title removes its scoped and legacy checkpoints', () => {
    const values = installStorage({ 'xandrio_playback_checkpoint:book-1': '{}' });
    checkpoints.writePlaybackCheckpoint('alice', checkpoint('book-1', 1));
    checkpoints.removePlaybackCheckpoint('alice', 'book-1');
    assert.equal(values.size, 0);
  });

  await test('logout announces the signed-out scope after the identity fence', async () => {
    const values = new Map();
    const events = [];
    const context = {
      window: { location: { origin: 'https://books.test' }, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) },
      document: { cookie: '', dispatchEvent() {} },
      localStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
      },
      navigator: { userAgent: 'test' },
      AbortController, setTimeout, clearTimeout, console,
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
    };
    context.dispatchEvent = event => {
      events.push({ type: event.type, scope: event.detail?.scope ?? event.detail?.fromScope, user: context.api?.getCurrentUser() });
      return true;
    };
    vm.createContext(context);
    vm.runInContext(read('public/js/api.js').replace(/export /g, '') +
      '\nthis.api = { logout, setCurrentUser, getCurrentUser };', context);
    await context.api.setCurrentUser({ id: 'alice' });
    events.length = 0;
    await context.api.logout();
    const signedOut = events.find(event => event.type === 'xandrio:signedout');
    assert.ok(signedOut, 'logout dispatches xandrio:signedout');
    assert.equal(signedOut.scope, 'alice');
    assert.equal(signedOut.user, null, 'the old identity is gone before the clear runs');
  });

  await test('every client checkpoint access goes through the scoped module', () => {
    const app = read('public/app.js');
    assert.match(app, /window\.addEventListener\('xandrio:signedout', event => \{\n  clearPlaybackCheckpoints\(event\.detail\?\.scope\);/);
    assert.match(app, /writePlaybackCheckpoint\(getOfflineStorageScopeId\(\), checkpoint\)/);
    assert.match(app, /readPlaybackCheckpoint\(getOfflineStorageScopeId\(\), bookId,/);
    const offenders = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(m?js|html)$/.test(entry.name) && !file.endsWith('playback-checkpoints.mjs') &&
          /xandrio_playback_checkpoint|xandrio_account_checkpoint/.test(fs.readFileSync(file, 'utf8'))) {
          offenders.push(path.relative(root, file));
        }
      }
    })(path.join(root, 'public'));
    assert.deepEqual(offenders, [], 'no module reads or writes checkpoint keys directly');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
