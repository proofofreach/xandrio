const assert = require('assert');
const { EventEmitter } = require('events');
const {
  ConcurrencyGate,
  createConcurrencyLimitMiddleware,
  defaultConcurrencyGroups
} = require('../lib/concurrency-limit');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function run(middleware, path, method = 'POST') {
  const res = new EventEmitter();
  Object.assign(res, {
    headers: {}, statusCode: null, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; }
  });
  let nextCalled = false;
  middleware({ path, method }, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

async function main() {
  await test('disconnecting does not release a permit while backend work continues', () => {
    const middleware = createConcurrencyLimitMiddleware({
      groups: [{ name: 'search', max: 1, match: path => path === '/api/search' }]
    });
    const first = run(middleware, '/api/search');
    assert(first.nextCalled);

    const blocked = run(middleware, '/api/search');
    assert.strictEqual(blocked.res.statusCode, 503);
    assert.strictEqual(blocked.res.headers['Retry-After'], '1');
    assert.deepStrictEqual(blocked.res.body, {
      error: 'This operation is busy. Try again shortly.',
      code: 'CONCURRENCY_LIMIT'
    });

    first.res.emit('close');
    assert.strictEqual(run(middleware, '/api/search').res.statusCode, 503);
    first.res.end();
    first.res.emit('finish');
    assert(run(middleware, '/api/search').nextCalled);
  });

  await test('a permit has no elapsed-time bypass', async () => {
    const middleware = createConcurrencyLimitMiddleware({
      groups: [{ name: 'search', max: 1, match: path => path === '/api/search' }],
      // Older implementations accepted this option and force-released the
      // permit. It must not weaken the cap even if stale configuration passes it.
      maxHoldMs: 1
    });
    const first = run(middleware, '/api/search');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(run(middleware, '/api/search').res.statusCode, 503);
    first.res.end();
    assert(run(middleware, '/api/search').nextCalled);
  });

  await test('a task gate bounds active work and recovers after failure', async () => {
    const gate = new ConcurrencyGate(1);
    let releaseFirst;
    const first = gate.run(() => new Promise(resolve => { releaseFirst = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => gate.run(async () => {}), error => error.code === 'CONCURRENCY_LIMIT');
    releaseFirst();
    await first;
    await assert.rejects(
      () => gate.run(async () => { throw new Error('task failed'); }),
      /task failed/
    );
    await gate.run(async () => {});
    assert.strictEqual(gate.active, 0);
  });

  await test('default groups cover expensive request classes', () => {
    const groups = defaultConcurrencyGroups({
      auth: 8, search: 4, upload: 2, metadata: 2, tts: 8, voice: 1
    });
    const covered = (path, method = 'POST') => groups.some(group => group.match(path, { method }));
    for (const [path, method] of [
      ['/api/auth/login', 'POST'],
      ['/api/search', 'POST'],
      ['/api/upload', 'POST'],
      ['/api/refresh-metadata/book', 'POST'],
      ['/api/chunks/book/0/prepare', 'POST'],
      ['/api/audio/book/0', 'GET'],
      ['/api/voices/clone', 'POST']
    ]) assert(covered(path, method), `${method} ${path} should be concurrency limited`);
  });

  console.log(`\nconcurrency-limit tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
