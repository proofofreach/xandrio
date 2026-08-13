'use strict';

const assert = require('node:assert');
const { registerBookGuideRoutes } = require('../lib/routes/book-guide-routes');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function fakeApp() {
  const routes = [];
  for (const method of ['get', 'post', 'put', 'delete']) {
    routes[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  }
  return routes;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

async function run() {
  const app = fakeApp();
  const requireAdmin = (_req, _res, next) => next();
  const calls = [];
  const service = {
    get: async bookId => (calls.push(['get', bookId]), { status: 'ready' }),
    start: async (bookId, options) => (calls.push(['start', bookId, options]), { status: 'pending' }),
    cancel: async bookId => (calls.push(['cancel', bookId]), { status: 'cancelled' }),
    removeBook: async bookId => (calls.push(['remove', bookId]), { artifactRemoved: true }),
    getAnchorContext: async (bookId, anchorId) => (calls.push(['context', bookId, anchorId]), { text: 'context' }),
    getConfig: async () => ({ enabled: false }),
    configure: async body => (calls.push(['configure', body]), { enabled: body.enabled }),
    clearConfig: async () => ({ enabled: false })
  };
  registerBookGuideRoutes(app, {
    service,
    requireAdmin,
    isSafeBookId: value => /^book_/.test(value),
    log: { error() {} }
  });

  await test('registers the complete route contract', () => {
    assert.deepStrictEqual(app.map(route => `${route.method.toUpperCase()} ${route.path}`), [
      'GET /api/book/:bookId/guide/anchors/:anchorId/context',
      'GET /api/book/:bookId/guide',
      'POST /api/book/:bookId/guide',
      'POST /api/book/:bookId/guide/cancel',
      'DELETE /api/book/:bookId/guide',
      'GET /api/book-guides/config',
      'PUT /api/book-guides/config',
      'DELETE /api/book-guides/config'
    ]);
  });

  await test('keeps shared reads free of the admin guard', () => {
    const shared = app.filter(route => route.method === 'get' && route.path.startsWith('/api/book/:bookId/'));
    assert(shared.every(route => !route.handlers.includes(requireAdmin)));
  });

  await test('guards every mutation and configuration route as admin-only', () => {
    const protectedRoutes = app.filter(route =>
      route.method !== 'get' || route.path === '/api/book-guides/config'
    );
    assert(protectedRoutes.every(route => route.handlers[0] === requireAdmin));
  });

  await test('passes only an explicit boolean nonfiction confirmation', async () => {
    const route = app.find(item => item.method === 'post' && item.path === '/api/book/:bookId/guide');
    const req = { params: { bookId: 'book_1' }, body: { nonfictionConfirmed: 'true' } };
    const res = response();
    await route.handlers[1](req, res);
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(calls.at(-1), ['start', 'book_1', { nonfictionConfirmed: false }]);
  });

  await test('derives management and generation capability from the authenticated role', async () => {
    const route = app.find(item => item.method === 'get' && item.path === '/api/book/:bookId/guide');
    service.get = async () => ({ status: 'not-generated', canGenerate: true, canManage: true, generation: { destination: 'http://127.0.0.1:11434' } });
    const memberResponse = response();
    await route.handlers[0]({ params: { bookId: 'book_1' }, user: { role: 'member' } }, memberResponse);
    assert.strictEqual(memberResponse.body.canManage, false);
    assert.strictEqual(memberResponse.body.canGenerate, false);
    assert.strictEqual(memberResponse.body.generation, undefined);
    const adminResponse = response();
    await route.handlers[0]({ params: { bookId: 'book_1' }, user: { role: 'admin' } }, adminResponse);
    assert.strictEqual(adminResponse.body.canManage, true);
    assert.strictEqual(adminResponse.body.canGenerate, true);
    assert.deepStrictEqual(adminResponse.body.generation, { destination: 'http://127.0.0.1:11434' });
  });

  await test('rejects an unsafe book id before calling the service', async () => {
    const route = app.find(item => item.method === 'get' && item.path === '/api/book/:bookId/guide');
    const before = calls.length;
    const res = response();
    await route.handlers[0]({ params: { bookId: '../bad' } }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.length, before);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
