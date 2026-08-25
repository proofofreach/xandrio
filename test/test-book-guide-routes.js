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
    headers: {},
    status(value) { this.statusCode = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

async function run() {
  const app = fakeApp();
  const requireAdmin = (_req, _res, next) => next();
  const providerStatusRateLimit = (_req, _res, next) => next();
  const providerLoginRateLimit = (_req, _res, next) => next();
  const guideGenerateRateLimit = (_req, _res, next) => next();
  const guideDailyRateLimit = (_req, _res, next) => next();
  const guideReadRateLimit = (_req, _res, next) => next();
  const calls = [];
  const service = {
    get: async bookId => (calls.push(['get', bookId]), { status: 'ready' }),
    start: async (bookId, options) => (calls.push(['start', bookId, options]), { status: 'pending' }),
    cancel: async bookId => (calls.push(['cancel', bookId]), { status: 'cancelled' }),
    removeBook: async bookId => (calls.push(['remove', bookId]), { artifactRemoved: true }),
    getAnchorContext: async (bookId, anchorId) => (calls.push(['context', bookId, anchorId]), { text: 'context' }),
    getConfig: async () => ({ enabled: false }),
    configure: async body => (calls.push(['configure', body]), { enabled: body.enabled }),
    testConnection: async () => (calls.push(['test']), { ok: true }),
    clearConfig: async () => ({ enabled: false }),
    providerLoginStatus: async () => (calls.push(['provider-status']), { state: 'disconnected' }),
    beginProviderLogin: async () => (calls.push(['provider-login']), { state: 'waiting' }),
    disconnectProvider: async () => (calls.push(['provider-disconnect']), { connection: { state: 'disconnected' } })
  };
  const setBookCategory = async (bookId, category) => (calls.push(['category', bookId, category]), { bookId, category });
  const prepareNarrationAudio = async (bookId, sectionId) => (
    calls.push(['narration', bookId, sectionId]), { path: '/cache/guide.mp3', sectionId }
  );
  const narrationStatus = async bookId => (
    calls.push(['narration-status', bookId]), {
      readySections: 1,
      totalSections: 2,
      sections: [{ id: 'overview', status: 'preparing', readyParts: 1, totalParts: 3 }]
    }
  );
  const serveAudioFile = async (_req, res, filePath) => {
    calls.push(['serve-audio', filePath]);
    res.body = { filePath };
  };
  registerBookGuideRoutes(app, {
    service,
    requireAdmin,
    setBookCategory,
    prepareNarrationAudio,
    narrationStatus,
    narrationVariant: () => '_ttsvoice123',
    serveAudioFile,
    providerStatusRateLimit,
    providerLoginRateLimit,
    guideGenerateRateLimit,
    guideDailyRateLimit,
    guideReadRateLimit,
    isSafeBookId: value => /^book_/.test(value),
    log: { error() {} }
  });

  await test('registers the complete route contract', () => {
    assert.deepStrictEqual(app.map(route => `${route.method.toUpperCase()} ${route.path}`), [
      'GET /api/book/:bookId/guide/anchors/:anchorId/context',
      'GET /api/book/:bookId/guide/narration/status',
      'GET /api/book/:bookId/guide/narration/:sectionId/audio',
      'GET /api/book/:bookId/guide',
      'POST /api/book/:bookId/guide',
      'PUT /api/book/:bookId/guide/category',
      'POST /api/book/:bookId/guide/cancel',
      'DELETE /api/book/:bookId/guide',
      'GET /api/book-guides/config',
      'PUT /api/book-guides/config',
      'POST /api/book-guides/config/test',
      'DELETE /api/book-guides/config',
      'GET /api/book-guides/provider/connection',
      'POST /api/book-guides/provider/login',
      'DELETE /api/book-guides/provider/connection'
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

  await test('applies both global hourly and daily spend budgets to generation', () => {
    const route = app.find(item => item.method === 'post' && item.path === '/api/book/:bookId/guide');
    assert.deepStrictEqual(route.handlers.slice(0, 3), [
      requireAdmin,
      guideDailyRateLimit,
      guideGenerateRateLimit
    ]);
  });

  await test('starts generation from the persisted title tag rather than request assertions', async () => {
    const route = app.find(item => item.method === 'post' && item.path === '/api/book/:bookId/guide');
    const req = { params: { bookId: 'book_1' }, body: {} };
    const res = response();
    await route.handlers.at(-1)(req, res);
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(calls.at(-1), ['start', 'book_1', undefined]);
  });

  await test('persists title classification only through an admin mutation', async () => {
    const route = app.find(item => item.method === 'put' && item.path === '/api/book/:bookId/guide/category');
    const res = response();
    await route.handlers.at(-1)({ params: { bookId: 'book_1' }, body: { category: 'nonfiction' } }, res);
    assert.deepStrictEqual(res.body, { bookId: 'book_1', category: 'nonfiction' });
    assert.deepStrictEqual(calls.at(-1), ['category', 'book_1', 'nonfiction']);
  });

  await test('prepares and streams a shared guide narration section', async () => {
    const route = app.find(item => item.method === 'get' && item.path.endsWith('/narration/:sectionId/audio'));
    const res = response();
    await route.handlers.at(-1)({ params: { bookId: 'book_1', sectionId: 'overview' }, headers: {} }, res);
    assert.deepStrictEqual(calls.slice(-2), [
      ['narration', 'book_1', 'overview'],
      ['serve-audio', '/cache/guide.mp3']
    ]);
    assert.strictEqual(res.headers['X-Study-Guide-Section'], 'overview');
  });

  await test('reports real narration preparation progress without caching it', async () => {
    const route = app.find(item => item.method === 'get' && item.path.endsWith('/narration/status'));
    const res = response();
    await route.handlers.at(-1)({ params: { bookId: 'book_1' } }, res);
    assert.deepStrictEqual(calls.at(-1), ['narration-status', 'book_1']);
    assert.strictEqual(res.headers['Cache-Control'], 'private, no-store');
    assert.deepStrictEqual(res.body.sections[0], {
      id: 'overview', status: 'preparing', readyParts: 1, totalParts: 3
    });
  });

  await test('derives management and generation capability from the authenticated role', async () => {
    const route = app.find(item => item.method === 'get' && item.path === '/api/book/:bookId/guide');
    const generation = {
      destination: 'https://api.ppq.ai/private-route',
      generatorModel: `generator@sha256:${'a'.repeat(64)}`,
      verifierModel: `verifier@sha256:${'b'.repeat(64)}`
    };
    service.get = async () => ({ status: 'not-generated', canGenerate: true, canManage: true, generation });
    const memberResponse = response();
    await route.handlers.at(-1)({ params: { bookId: 'book_1' }, user: { role: 'member' } }, memberResponse);
    assert.strictEqual(memberResponse.body.canManage, false);
    assert.strictEqual(memberResponse.body.canGenerate, false);
    assert.strictEqual(memberResponse.body.generation, undefined);
    const adminResponse = response();
    await route.handlers.at(-1)({ params: { bookId: 'book_1' }, user: { role: 'admin' } }, adminResponse);
    assert.strictEqual(adminResponse.body.canManage, true);
    assert.strictEqual(adminResponse.body.canGenerate, true);
    assert.deepStrictEqual(adminResponse.body.generation, generation,
      'full operational diagnostics remain available to an administrator');
  });

  await test('versions narration URLs by guide artifact and active voice', async () => {
    const route = app.find(item => item.method === 'get' && item.path === '/api/book/:bookId/guide');
    service.get = async () => ({
      status: 'ready',
      artifact: { createdAt: '2026-08-14T12:00:00.000Z', guide: { orientation: { thesis: 'A grounded thesis.' } } }
    });
    const res = response();
    await route.handlers.at(-1)({ params: { bookId: 'book_1' }, user: { role: 'member' } }, res);
    assert.strictEqual(res.body.narration.available, true);
    assert.match(res.body.narration.version, /^[a-f0-9]{12}-_ttsvoice123$/);
  });

  await test('rejects an unsafe book id before calling the service', async () => {
    const route = app.find(item => item.method === 'get' && item.path === '/api/book/:bookId/guide');
    const before = calls.length;
    const res = response();
    await route.handlers.at(-1)({ params: { bookId: '../bad' } }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.length, before);
  });

  await test('keeps provider device authorization admin-only and non-cacheable', async () => {
    const login = app.find(item => item.method === 'post' && item.path === '/api/book-guides/provider/login');
    const status = app.find(item => item.method === 'get' && item.path === '/api/book-guides/provider/connection');
    const loginResponse = response();
    assert.strictEqual(login.handlers[1], providerLoginRateLimit);
    await login.handlers.at(-1)({}, loginResponse);
    assert.strictEqual(loginResponse.statusCode, 202);
    assert.strictEqual(loginResponse.headers['Cache-Control'], 'private, no-store');
    const statusResponse = response();
    assert.strictEqual(status.handlers[1], providerStatusRateLimit);
    await status.handlers.at(-1)({}, statusResponse);
    assert.strictEqual(statusResponse.headers['Cache-Control'], 'private, no-store');
    assert.deepStrictEqual(calls.slice(-2), [['provider-login'], ['provider-status']]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
