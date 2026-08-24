/**
 * Test suite for lib/json-store — atomic writes, per-file locking,
 * and update() mutator semantics.
 */

const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const { HANG_GUARD_MS, rejectAfter } = require('./timing-helper');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const jsonStore = require('../lib/json-store');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'json-store-test-'));
  const file = (name) => path.join(dir, name);

  await test('load returns default for missing file', async () => {
    const data = await jsonStore.load(file('missing.json'), { fresh: true });
    assert.deepStrictEqual(data, { fresh: true });
  });

  await test('save then load round-trips', async () => {
    await jsonStore.save(file('a.json'), { x: 1, nested: { y: [1, 2] } });
    const data = await jsonStore.load(file('a.json'));
    assert.deepStrictEqual(data, { x: 1, nested: { y: [1, 2] } });
  });

  await test('saved instance JSON is owner-readable and owner-writable only', async () => {
    const target = file('private.json');
    await jsonStore.save(target, { credential: 'not-world-readable' });
    assert.strictEqual((await fsp.stat(target)).mode & 0o777, 0o600);
  });

  await test('save leaves no temp files behind', async () => {
    await jsonStore.save(file('b.json'), { ok: true });
    const entries = await fsp.readdir(dir);
    assert(!entries.some(e => e.includes('.tmp')), `found temp files: ${entries}`);
  });

  await test('a failed atomic save removes its temporary file', async () => {
    const target = file('rename-blocked');
    await fsp.mkdir(target);
    await assert.rejects(jsonStore.save(target, { will: 'fail' }));
    const entries = await fsp.readdir(dir);
    assert(
      !entries.some(name => name.startsWith('rename-blocked.') && name.endsWith('.tmp')),
      `failed save leaked a temp file: ${entries}`
    );
  });

  await test('an unreadable store aborts update instead of replacing it with defaults', async () => {
    const target = file('unreadable.json');
    const original = '{"accounts":{"owner":true}}';
    await fsp.writeFile(target, original);
    await fsp.chmod(target, 0o000);
    try {
      await assert.rejects(
        jsonStore.update(target, data => { data.accounts = {}; }, {}),
        error => error.code === 'EACCES'
      );
    } finally {
      await fsp.chmod(target, 0o600).catch(() => {});
    }
    assert.strictEqual(await fsp.readFile(target, 'utf8'), original);
  });

  await test('load returns default for corrupt JSON', async () => {
    await fsp.writeFile(file('corrupt.json'), '{ not json');
    const data = await jsonStore.load(file('corrupt.json'), { fallback: 1 });
    assert.deepStrictEqual(data, { fallback: 1 });
  });

  await test('corrupt JSON is preserved before the defaults can overwrite it', async () => {
    await fsp.writeFile(file('salvage.json'), '{ "books": truncated');
    await jsonStore.load(file('salvage.json'), {});

    const quarantined = (await fsp.readdir(dir))
      .filter(name => name.startsWith('salvage.json.corrupt-'));
    assert.strictEqual(quarantined.length, 1, `expected one quarantine copy, got: ${quarantined}`);
    assert.strictEqual(
      await fsp.readFile(path.join(dir, quarantined[0]), 'utf8'),
      '{ "books": truncated',
      'quarantine copy must hold the original bytes'
    );

    // The recovery path stays usable: writing defaults over the original is
    // still allowed, but the operator now has the damaged file to inspect.
    await jsonStore.save(file('salvage.json'), { books: {} });
    assert.deepStrictEqual(await jsonStore.load(file('salvage.json')), { books: {} });
  });

  await test('repeatedly loading the same corrupt file makes one quarantine copy', async () => {
    await fsp.writeFile(file('repeat.json'), 'still not json');
    await jsonStore.load(file('repeat.json'), {});
    await jsonStore.load(file('repeat.json'), {});
    await jsonStore.load(file('repeat.json'), {});

    const quarantined = (await fsp.readdir(dir))
      .filter(name => name.startsWith('repeat.json.corrupt-'));
    assert.strictEqual(quarantined.length, 1, `quarantine copies must not accumulate: ${quarantined}`);
  });

  await test('a failed quarantine aborts before corrupt data can be overwritten', async () => {
    const target = file('blocked-salvage.json');
    const raw = '{ "accounts": truncated';
    await fsp.writeFile(target, raw);
    const digest = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
    await fsp.mkdir(`${target}.corrupt-${digest}`);

    await assert.rejects(
      jsonStore.update(target, data => { data.accounts = {}; }, {}),
      error => error.code === 'JSON_STORE_QUARANTINE_FAILED'
    );
    assert.strictEqual(await fsp.readFile(target, 'utf8'), raw);
  });

  await test('update mutates in place and persists', async () => {
    await jsonStore.save(file('c.json'), { count: 1 });
    const result = await jsonStore.update(file('c.json'), (data) => {
      data.count += 1;
      return data.count;
    });
    assert.strictEqual(result, 2);
    const data = await jsonStore.load(file('c.json'));
    assert.strictEqual(data.count, 2);
  });

  await test('update with SKIP_SAVE does not write', async () => {
    await jsonStore.save(file('d.json'), { keep: 'original' });
    const result = await jsonStore.update(file('d.json'), (data) => {
      data.keep = 'mutated';
      return jsonStore.SKIP_SAVE;
    });
    assert.strictEqual(result, jsonStore.SKIP_SAVE);
    const data = await jsonStore.load(file('d.json'));
    assert.strictEqual(data.keep, 'original');
  });

  await test('throwing mutator skips the write and propagates', async () => {
    await jsonStore.save(file('e.json'), { v: 1 });
    await assert.rejects(
      jsonStore.update(file('e.json'), () => { throw new Error('boom'); }),
      /boom/
    );
    const data = await jsonStore.load(file('e.json'));
    assert.strictEqual(data.v, 1);
  });

  await test('a failed update does not block later writes to the same file', async () => {
    const p = file('recover.json');
    await jsonStore.save(p, { v: 1 });
    await jsonStore.update(p, () => { throw new Error('first fails'); }).catch(() => {});
    await jsonStore.update(p, (data) => { data.v = 2; });
    const data = await jsonStore.load(p);
    assert.strictEqual(data.v, 2);
  });

  await test('concurrent updates serialize (no lost increments)', async () => {
    const p = file('counter.json');
    await jsonStore.save(p, { count: 0 });
    await Promise.all(
      Array.from({ length: 25 }, () =>
        jsonStore.update(p, async (data) => {
          const current = data.count;
          await sleep(Math.random() * 5); // widen the race window
          data.count = current + 1;
        })
      )
    );
    const data = await jsonStore.load(p);
    assert.strictEqual(data.count, 25, `expected 25, got ${data.count}`);
  });

  await test('updates to different files do not serialize against each other', async () => {
    // Observe the overlap rather than timing it. Each mutator parks inside its
    // own update until all three have arrived, so the barrier can only clear if
    // three updates hold their locks at once. A wall clock cannot say this: a
    // loaded machine makes parallel work look serial, which is how this test
    // used to fail on CI while the lock behaviour was perfectly correct.
    const FILES = ['p1.json', 'p2.json', 'p3.json'];
    let inside = 0;
    let peak = 0;
    let openBarrier;
    const barrier = new Promise(resolve => { openBarrier = resolve; });
    // Only a hang guard. It never decides whether the test passes: if the locks
    // serialize, the barrier can never clear and this reports why.
    const guard = rejectAfter(HANG_GUARD_MS, `only ${inside} of 3 updates held their locks at once`);

    try {
      await Promise.all(FILES.map(name => jsonStore.update(file(name), async (data) => {
        inside += 1;
        peak = Math.max(peak, inside);
        if (inside === FILES.length) openBarrier();
        try {
          await Promise.race([barrier, guard.promise]);
        } finally {
          inside -= 1;
        }
        data.done = 1;
      })));
    } finally {
      guard.cancel();
    }

    assert.strictEqual(peak, FILES.length, 'each file should lock independently');
    for (const name of FILES) {
      assert.strictEqual((await jsonStore.load(file(name))).done, 1, `${name} was not written`);
    }
  });

  await test('withLock serializes with update on the same file', async () => {
    const p = file('lock.json');
    const order = [];
    await Promise.all([
      jsonStore.withLock(p, async () => { order.push('lock-start'); await sleep(40); order.push('lock-end'); }),
      jsonStore.update(p, (d) => { order.push('update'); d.x = 1; })
    ]);
    assert.deepStrictEqual(order, ['lock-start', 'lock-end', 'update']);
  });

  await test('settled lock tails are removed without deleting a newer lock', async () => {
    const p = file('lock-cleanup.json');
    const baseline = jsonStore.pendingLockCount();
    let releaseFirst;
    let releaseSecond;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise(resolve => { releaseSecond = resolve; });
    const first = jsonStore.withLock(p, () => firstGate);
    const second = jsonStore.withLock(p, () => secondGate);
    assert.strictEqual(jsonStore.pendingLockCount(), baseline + 1);
    releaseFirst();
    await first;
    // The first completion must not remove the newer queued tail.
    assert.strictEqual(jsonStore.pendingLockCount(), baseline + 1);
    releaseSecond();
    await second;
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(jsonStore.pendingLockCount(), baseline);
  });

  await test('validation rejects an invalid top-level shape without replacing it', async () => {
    const target = file('validated.json');
    const raw = JSON.stringify(['not', 'an', 'object']);
    await fsp.writeFile(target, raw);
    const validate = value => value && typeof value === 'object' && !Array.isArray(value);
    await assert.rejects(
      jsonStore.load(target, {}, { validate }),
      error => error.code === 'JSON_STORE_VALIDATION_FAILED'
    );
    assert.strictEqual(await fsp.readFile(target, 'utf8'), raw);
  });

  await test('ordinary stores do not create backups implicitly', async () => {
    const target = file('ordinary.json');
    await jsonStore.save(target, { version: 1 });
    await jsonStore.save(target, { version: 2 });
    await assert.rejects(fsp.access(`${target}.backups`), error => error.code === 'ENOENT');
  });

  await test('critical stores validate and retain only the configured number of backups', async () => {
    const target = file('critical.json');
    const store = jsonStore.createCriticalStore({
      filePath: target,
      defaultValue: { version: 0 },
      validate: value => (
        value && typeof value === 'object' && !Array.isArray(value) &&
        Number.isInteger(value.version)
      ),
      maxBackups: 2
    });
    await store.save({ version: 1 });
    await store.save({ version: 2 });
    await store.save({ version: 3 });
    await store.save({ version: 4 });

    const candidates = await store.listRecoveryCandidates();
    const backups = candidates.filter(candidate => candidate.kind === 'backup');
    assert.strictEqual(backups.length, 2);
    assert(backups.every(candidate => candidate.valid));
    const versions = [];
    for (const backup of backups) {
      versions.push(JSON.parse(await fsp.readFile(backup.path, 'utf8')).version);
    }
    assert.deepStrictEqual(versions.sort(), [2, 3]);
    assert.deepStrictEqual(await store.load(), { version: 4 });
  });

  await test('critical updates refuse corrupt current state after quarantining it', async () => {
    const target = file('critical-corrupt.json');
    const raw = '{"version":';
    await fsp.writeFile(target, raw);
    const store = jsonStore.createCriticalStore({
      filePath: target,
      validate: value => value && Number.isInteger(value.version)
    });
    await assert.rejects(
      store.update(data => { data.version = 2; }),
      error => error.code === 'JSON_STORE_CORRUPT'
    );
    assert.strictEqual(await fsp.readFile(target, 'utf8'), raw);
    const candidates = await store.listRecoveryCandidates();
    assert.strictEqual(candidates.filter(candidate => candidate.kind === 'quarantine').length, 1);
  });

  await test('restore validates the candidate and preserves displaced current bytes', async () => {
    const target = file('restore.json');
    const validate = value => value && Number.isInteger(value.version);
    const store = jsonStore.createCriticalStore({
      filePath: target,
      validate,
      maxBackups: 4
    });
    await store.save({ version: 1 });
    await store.save({ version: 2 });
    const candidate = (await store.listRecoveryCandidates())
      .find(item => item.valid && item.kind === 'backup');
    assert(candidate, 'expected a recovery backup');

    await store.restore(candidate.path);
    assert.deepStrictEqual(await store.load(), { version: 1 });
    const restoredCandidates = await store.listRecoveryCandidates();
    const preservedVersions = [];
    for (const item of restoredCandidates.filter(entry => entry.kind === 'backup')) {
      preservedVersions.push(JSON.parse(await fsp.readFile(item.path, 'utf8')).version);
    }
    assert(preservedVersions.includes(2), 'restore must preserve the displaced store');

    const unrelated = file('unrelated.json');
    await fsp.writeFile(unrelated, '{"version":3}');
    await assert.rejects(
      jsonStore.restoreRecoveryCandidate(target, unrelated, { validate }),
      error => error.code === 'JSON_STORE_UNSAFE_RECOVERY_PATH'
    );
  });

  await test('recovery CLI lists candidates and requires explicit confirmation to restore', async () => {
    const target = file('cli-restore.json');
    const store = jsonStore.createCriticalStore({
      filePath: target,
      validate: value => value && Number.isInteger(value.version)
    });
    await store.save({ version: 1 });
    await store.save({ version: 2 });
    const candidate = (await store.listRecoveryCandidates()).find(item => item.valid);
    const cli = path.join(__dirname, '..', 'scripts', 'recover-json-store.js');

    const dryRun = spawnSync(process.execPath, [
      cli, 'restore', target, candidate.path, '--required-key', 'version'
    ], { encoding: 'utf8' });
    assert.strictEqual(dryRun.status, 2);
    assert.match(dryRun.stderr, /No changes made/);
    assert.deepStrictEqual(await store.load(), { version: 2 });

    const restore = spawnSync(process.execPath, [
      cli, 'restore', target, candidate.path, '--required-key', 'version', '--yes'
    ], { encoding: 'utf8' });
    assert.strictEqual(restore.status, 0, restore.stderr);
    assert.deepStrictEqual(await store.load(), { version: 1 });
  });

  await test('update holds an OS lockfile that other processes cannot steal', async () => {
    const target = file('os-lock.json');
    await jsonStore.save(target, { n: 0 });
    await jsonStore.withLock(target, async () => {
      await fsp.access(`${target}.lock`);
      const child = spawnSync(process.execPath, ['-e', `
        const fs = require('fs');
        try {
          fs.openSync(${JSON.stringify(`${target}.lock`)}, 'wx');
          process.exit(2);
        } catch (error) {
          process.exit(error.code === 'EEXIST' ? 0 : 1);
        }
      `], { encoding: 'utf8' });
      assert.strictEqual(child.status, 0, child.stderr);
    });
  });

  await test('a dead lockfile pid is stolen instead of blocking forever', async () => {
    const target = file('stale-lock.json');
    await jsonStore.save(target, { ok: true });
    await fsp.writeFile(`${target}.lock`, '99999999');
    await jsonStore.update(target, data => { data.ok = 'after-stale'; });
    assert.strictEqual((await jsonStore.load(target)).ok, 'after-stale');
  });

  await fsp.rm(dir, { recursive: true, force: true });

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`json-store tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
