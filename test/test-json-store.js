/**
 * Test suite for lib/json-store — atomic writes, per-file locking,
 * and update() mutator semantics.
 */

const assert = require('assert');
const fs = require('fs');
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

  await test('load returns default for corrupt JSON', async () => {
    await fsp.writeFile(file('corrupt.json'), '{ not json');
    const data = await jsonStore.load(file('corrupt.json'), { fallback: 1 });
    assert.deepStrictEqual(data, { fallback: 1 });
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
    const started = Date.now();
    await Promise.all([
      jsonStore.update(file('p1.json'), async (d) => { await sleep(80); d.done = 1; }),
      jsonStore.update(file('p2.json'), async (d) => { await sleep(80); d.done = 1; }),
      jsonStore.update(file('p3.json'), async (d) => { await sleep(80); d.done = 1; })
    ]);
    const elapsed = Date.now() - started;
    assert(elapsed < 200, `independent files should run in parallel (took ${elapsed}ms)`);
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

  await fsp.rm(dir, { recursive: true, force: true });

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`json-store tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
