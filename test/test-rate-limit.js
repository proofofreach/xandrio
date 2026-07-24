const assert = require('assert');
const { createRateLimitMiddleware, defaultGroups } = require('../lib/rate-limit');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function run(middleware, path, ip = '127.0.0.1') {
  const res = {
    headers: {}, statusCode: null, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let nextCalled = false;
  middleware({ path, ip }, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('limits sensitive routes and emits standard retry metadata', () => {
  let now = 0;
  const limiter = createRateLimitMiddleware({
    windowMs: 1_000,
    max: 2,
    groups: [{ name: 'auth', max: 2, match: path => path === '/api/auth/login' }],
    now: () => now
  });
  assert(run(limiter, '/api/auth/login').nextCalled);
  assert(run(limiter, '/api/auth/login').nextCalled);
  const blocked = run(limiter, '/api/auth/login');
  assert.strictEqual(blocked.res.statusCode, 429);
  assert.strictEqual(blocked.res.headers['RateLimit-Limit'], '2');
  assert.strictEqual(blocked.res.headers['RateLimit-Remaining'], '0');
  assert.strictEqual(blocked.res.headers['Retry-After'], '1');
  assert.deepStrictEqual(blocked.res.body, { error: 'Too many requests. Try again shortly.' });
  now = 1_000;
  assert(run(limiter, '/api/auth/login').nextCalled);
});

test('does not rate limit unrelated API reads', () => {
  const limiter = createRateLimitMiddleware({ windowMs: 1_000, max: 1 });
  const result = run(limiter, '/api/library');
  assert(result.nextCalled);
  assert.strictEqual(result.res.statusCode, null);
});

test('default groups cover authentication, import, metadata, TTS, and voice upload', () => {
  const groups = defaultGroups(60);
  const covered = path => groups.some(group => group.match(path));
  for (const path of [
    '/api/auth/login', '/api/search', '/api/upload', '/api/download',
    '/api/refresh-metadata/book', '/api/audio/book/0',
    '/api/chunks/book/0/prepare', '/api/voices/clone'
  ]) assert(covered(path), `${path} should be rate limited`);
});

console.log(`\nrate-limit tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
