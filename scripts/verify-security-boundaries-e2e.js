'use strict';

// Offline regression harness: loopback HTTP only; every outbound transport is inert.
// Run: node scripts/verify-security-boundaries-e2e.js /absolute/evidence-directory
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const jsonStore = require('../lib/json-store');
const { createCsrfMiddleware } = require('../lib/csrf');
const { registerPronunciationRoutes } = require('../lib/routes/pronunciation-routes');
const { createPronunciationService, createCacheInvalidator } = require('../lib/pronunciation-repair');
const { registerCalibreRoutes } = require('../lib/routes/calibre-routes');
const { stableCalibreBookId } = require('../lib/calibre-integration');
const { createSearchCoverService } = require('../lib/search-cover-service');
const results = [];
const evidenceDir = path.resolve(process.argv[2] || 'artifacts/security-boundaries');
let root;
async function check(name, fn) {
  try { await fn(); results.push({ name, status: 'passed' }); }
  catch (error) { results.push({ name, status: 'failed', error: error.stack }); }
  console.log(`${results.at(-1).status.toUpperCase()} ${name}`);
}
async function withHttp(app, fn) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: url,
      headers: { host: `localhost:${port}`, 'content-type': 'application/json', ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(JSON.stringify(body)) }), ...headers } }, res => {
      let text = '';
      res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try { await fn(request); } finally { await new Promise(resolve => server.close(resolve)); }
}
async function hostChecks() {
  const app = express();
  // Baseline lacks this module. Keep the original stack to demonstrate rejection failures.
  try {
    const { createHostGuard } = require('../lib/host-guard');
    app.use(rateLimit({ windowMs: 60_000, limit: 6000 }), createHostGuard({ allowedHosts: 'reader.example', canonicalOrigin: 'https://canonical.example',
      hostname: 'reading-host', interfaces: { fixture: [{ address: '192.168.10.20' }] } }));
  } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  app.use(express.json(), createCsrfMiddleware());
  app.get('/api/library', (_req, res) => res.json({ dummy: true }));
  app.post('/api/accounts', (_req, res) => res.json({ created: true }));
  await withHttp(app, async request => {
    for (const method of ['GET', 'POST']) await check(`host: reject attacker ${method} before protected handler`, async () => {
      const res = await request(method, method === 'GET' ? '/api/library' : '/api/accounts', {},
        { host: 'rebind.test:8181', origin: 'http://rebind.test:8181', 'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'reader.example' });
      assert.equal(res.status, 403);
    });
    for (const host of ['localhost:8181', '[::1]:8181', '192.168.10.20:8181', 'reading-host:8181', 'reader.example', 'canonical.example']) {
      await check(`host: accept trusted ${host}`, async () => assert.equal((await request('GET', '/api/library', undefined, { host })).status, 200));
    }
    await check('host: reject malformed authority', async () => assert.equal((await request('GET', '/api/library', undefined, { host: 'reader.example@rebind.test' })).status, 403));
    await check('csrf: retain mismatched and cross-site rejection', async () => {
      assert.equal((await request('POST', '/api/accounts', {}, { host: 'reader.example', origin: 'https://evil.example' })).status, 403);
      assert.equal((await request('POST', '/api/accounts', {}, { host: 'reader.example', origin: 'http://reader.example', 'sec-fetch-site': 'cross-site' })).status, 403);
    });
  });
}
async function pronunciationChecks() {
  const storeFile = path.join(root, 'pronunciations.json');
  const cacheDir = path.join(root, 'audio');
  await fs.mkdir(cacheDir);
  const cacheFile = path.join(cacheDir, 'other_ch0_chunk0.mp3');
  const books = { own: { addedBy: 'alice', chapters: [{ text: 'Quinn read.' }] }, other: { addedBy: 'bob', chapters: [{ text: 'Quinn read.' }] }, legacy: { chapters: [{ text: 'Quinn read.' }] } };
  let invalidations = 0;
  const service = createPronunciationService({ storeFile, jsonStore, loadBooks: async () => books,
    getChapters: async (_id, book) => book.chapters, splitIntoChunks: text => [text],
    beforeInvalidate: async () => { invalidations++; }, invalidateCache: createCacheInvalidator(cacheDir), onInvalidated: async () => {} });
  const globals = await service.create({ scope: 'global', input: { source: 'Quinn', replacement: 'Kwin' } });
  const foreign = await service.create({ scope: 'book', bookId: 'other', input: { source: 'Quinn', replacement: 'Kwen' } });
  await fs.writeFile(cacheFile, 'dummy cached audio');
  await fs.writeFile(path.join(cacheDir, 'own_ch0_chunk0.mp3'), 'dummy owner audio');
  const app = express();
  app.use(express.json(), (req, _res, next) => { req.user = req.headers['x-fixture-role'] === 'anonymous' ? null : { id: 'alice', role: req.headers['x-fixture-role'] || 'member' }; next(); });
  registerPronunciationRoutes(app, { pronunciationService: service, loadBooks: async () => books });
  await withHttp(app, async request => {
    for (const location of [{ scope: 'global' }, { scope: 'book', bookId: 'other' }, { scope: 'book', bookId: 'legacy' }]) {
      for (const method of ['POST', 'PUT', 'DELETE']) await check(`pronunciation: deny member ${method} ${location.bookId || location.scope}`, async () => {
        const before = await fs.readFile(storeFile, 'utf8'); const count = invalidations;
        const id = location.scope === 'global' ? globals.rule.id : foreign.rule.id;
        const res = await request(method, `/api/pronunciations${method === 'POST' ? '' : `/${id}`}`, { ...location, source: 'Quinn', replacement: 'Changed' });
        assert.equal(res.status, 403); assert.equal(await fs.readFile(storeFile, 'utf8'), before); assert.equal(invalidations, count);
        assert.equal(await fs.readFile(cacheFile, 'utf8'), 'dummy cached audio');
      });
    }
    await check('pronunciation: anonymous fails closed', async () => assert.equal((await request('POST', '/api/pronunciations', { scope: 'global', source: 'Q', replacement: 'K' }, { 'x-fixture-role': 'anonymous' })).status, 403));
    await check('pronunciation: owner retains book CRUD', async () => {
      const created = await request('POST', '/api/pronunciations', { scope: 'book', bookId: 'own', source: 'Quinn', replacement: 'Kwinn' }); assert.equal(created.status, 201);
      await assert.rejects(fs.stat(path.join(cacheDir, 'own_ch0_chunk0.mp3')), { code: 'ENOENT' });
      assert.equal((await request('PUT', `/api/pronunciations/${created.body.rule.id}`, { scope: 'book', bookId: 'own', replacement: 'Queen' })).status, 200);
      assert.equal((await request('DELETE', `/api/pronunciations/${created.body.rule.id}`, { scope: 'book', bookId: 'own' })).status, 200);
    });
    await check('pronunciation: admin retains global CRUD', async () => {
      const h = { 'x-fixture-role': 'admin' }; const created = await request('POST', '/api/pronunciations', { scope: 'global', source: 'Admin', replacement: 'Ad min' }, h); assert.equal(created.status, 201);
      await assert.rejects(fs.stat(path.join(cacheDir, 'own_ch0_chunk0.mp3')), { code: 'ENOENT' });
      assert.equal((await request('PUT', `/api/pronunciations/${created.body.rule.id}`, { scope: 'global', replacement: 'Adminn' }, h)).status, 200);
      assert.equal((await request('DELETE', `/api/pronunciations/${created.body.rule.id}`, { scope: 'global' }, h)).status, 200);
    });
    await check('pronunciation: missing book returns 404', async () => assert.equal((await request('POST', '/api/pronunciations', { scope: 'book', bookId: 'absent', source: 'Q', replacement: 'K' })).status, 404));
    await check('pronunciation: reads stay shared', async () => assert.equal((await request('GET', '/api/pronunciations?bookId=other')).status, 200));
  });
}
async function calibreChecks() {
  for (const branch of ['direct', 'duplicate']) for (const owner of [undefined, 'bob', 'alice']) {
    await check(`calibre: ${branch} ${owner || 'ownerless'} authorization and cleanup`, async () => {
      const metadata = { libraryUuid: 'fixture-library', bookUuid: 'fixture-book', title: 'Changed', author: 'Dummy' };
      const bookId = branch === 'direct' ? stableCalibreBookId(metadata.libraryUuid, metadata.bookUuid) : 'duplicate';
      const books = { [bookId]: { id: bookId, title: 'Original', addedBy: owner } };
      const before = JSON.stringify(books); let covers = 0; let shelves = 0;
      const upload = path.join(root, `upload-${branch}-${owner}`); const cover = `${upload}-cover`;
      await fs.writeFile(upload, 'dummy book'); await fs.writeFile(cover, 'dummy cover');
      const app = express(); app.use(express.json());
      registerCalibreRoutes(app, { access: { resolveToken: async () => ({ userId: 'alice' }) },
        uploadBook: (req, _res, next) => { req.file = { path: upload, originalname: 'dummy.epub' }; req.calibreCover = { path: cover }; next(); },
        loadBooks: async () => structuredClone(books), updateBooks: async fn => fn(books),
        importBook: async () => { const error = new Error('duplicate'); error.existingBookId = bookId; throw error; },
        persistCover: async () => { covers++; return true; }, addBookToShelf: async () => { shelves++; }, removeFile: file => fs.unlink(file) });
      await withHttp(app, async request => {
        const res = await request('POST', '/api/integrations/calibre/import', { metadata: JSON.stringify(metadata) }, { authorization: 'Bearer dummy' });
        assert.equal(res.status, owner === 'alice' ? 200 : 409);
        if (owner !== 'alice') { assert.equal(JSON.stringify(books), before); assert.equal(covers, 0); assert.equal(shelves, 0); await assert.rejects(fs.stat(cover), { code: 'ENOENT' }); }
        else { assert.equal(books[bookId].title, 'Changed'); assert.equal(covers, 1); assert.equal(shelves, 1); }
        await assert.rejects(fs.stat(upload), { code: 'ENOENT' });
      });
    });
  }
}
async function coverChecks() {
  for (const mode of ['public', 'private', 'mixed', 'redirect-private']) await check(`cover: ${mode} pinned transport`, async () => {
    let requests = 0; const addresses = [];
    const jpeg = Buffer.alloc(2200); jpeg[0] = 0xff; jpeg[1] = 0xd8;
    const service = createSearchCoverService({ cacheDir: path.join(root, `covers-${mode}`),
      getDimensions: () => ({ width: 320, height: 480 }),
      lookupImpl: async hostname => hostname === 'private.example' || mode === 'private' ? [{ address: '127.0.0.1', family: 4 }] : mode === 'mixed' ? [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] : [{ address: '8.8.8.8', family: 4 }],
      requestImpl: (url, options, callback) => {
        requests++; assert.equal(url.hostname, 'covers.example');
        options.lookup(url.hostname, {}, (error, address) => { assert.ifError(error); addresses.push(address); });
        const req = new EventEmitter(); req.end = () => {
          const response = Readable.from([jpeg]); response.statusCode = mode === 'redirect-private' ? 302 : 200;
          response.headers = mode === 'redirect-private' ? { location: 'https://private.example/secret' } : { 'content-type': 'image/jpeg' }; callback(response);
        }; return req;
      },
      // Baseline seam prevents its global fetch from contacting any real network.
      // Fixed implementation uses requestImpl in preference to this legacy seam.
      fetchImpl: async () => { throw new Error('Unpinned transport attempted'); }
    });
    const descriptor = service.register({ source: 'standardebooks', coverUrl: 'https://covers.example/book.jpg', title: 'Dummy' });
    const cover = await service.resolve(descriptor.key); await service.flush();
    if (mode === 'public') { assert.ok(cover); assert.deepEqual(addresses, ['8.8.8.8']); assert.equal(requests, 1); }
    else { assert.equal(cover, null); assert.equal(requests, mode === 'redirect-private' ? 1 : 0); }
  });
}
(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-security-e2e-'));
  try { await hostChecks(); await pronunciationChecks(); await calibreChecks(); await coverChecks(); }
  finally {
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, 'results.json'), JSON.stringify({ runtime: process.version, scope: 'offline dummy HTTP/routes/storage/transport; no browser or model exploit proof', results }, null, 2));
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log(`${results.filter(r => r.status === 'passed').length} passed, ${results.filter(r => r.status === 'failed').length} failed`);
  process.exitCode = results.some(r => r.status === 'failed') ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
