const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const jsonStore = require('../lib/json-store');
const {
  createClientTelemetryStore,
  createServerTrail,
  normalizeSession,
  registerClientTelemetryRoutes,
  summarizeSession
} = require('../lib/client-telemetry');
const { createCoverDisplay, needsDisplayCopy } = require('../lib/cover-display');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.stack || error.message}`);
  }
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values
  };
}

function importPublic(relative) {
  return import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', relative)).href);
}

function session(overrides = {}) {
  return {
    v: 1,
    id: 'session-0001',
    startedAt: Date.UTC(2026, 10, 10, 20, 7, 18),
    build: 'xandrio-v233',
    platform: 'ios',
    standalone: true,
    userAgent: 'Mozilla/5.0 (iPhone)',
    events: [
      { t: 10, k: 'boot:script' },
      { t: 6100, k: 'boot:worker', ms: 6000, reason: 'registration-timeout' },
      { t: 7200, k: 'library:rendered', ms: 900 },
      { t: 7300, k: 'lag', ms: 1200 },
      { t: 7400, k: 'mem', imgMp: 140.5 },
      { t: 8000, k: 'boot:ready' },
      { t: 9000, k: 'error', msg: 'boom' }
    ],
    ...overrides
  };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  console.log('\nClient telemetry');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-telemetry-'));

  await test('normalizes a session and drops malformed events and fields', () => {
    const normalized = normalizeSession(session({
      events: [
        { t: 1, k: 'ok', good: 'x'.repeat(1000), 'bad key': 1, nested: { a: 1 } },
        { t: -1, k: 'negative' },
        { k: 'no-time' },
        'nope'
      ],
      exit: 'not-an-exit'
    }));
    assert.strictEqual(normalized.events.length, 1);
    assert.strictEqual(normalized.events[0].good.length, 400);
    assert.strictEqual(normalized.events[0]['bad key'], undefined);
    assert.strictEqual(normalized.events[0].nested, '{"a":1}');
    assert.strictEqual(normalized.exit, null);
    assert.strictEqual(normalizeSession({ ...session(), v: 2 }), null);
    assert.strictEqual(normalizeSession({ ...session(), id: '../x' }), null);
  });

  await test('summarizes boot, worker, library, stall and image figures', () => {
    const summary = summarizeSession({ ...normalizeSession(session()), receivedAt: 'now' });
    assert.strictEqual(summary.bootMs, 8000);
    assert.strictEqual(summary.workerMs, 6000);
    assert.strictEqual(summary.workerReason, 'registration-timeout');
    assert.strictEqual(summary.libraryMs, 7200);
    assert.strictEqual(summary.maxLagMs, 1200);
    assert.strictEqual(summary.maxImageMegapixels, 140.5);
    assert.strictEqual(summary.errors, 1);
  });

  await test('an upload replaces the trail but never erases a known crash exit', async () => {
    const store = createClientTelemetryStore({ file: path.join(dir, 'a.json'), jsonStore });
    assert.strictEqual(await store.record('admin-1', session({ exit: 'page-crash' })), true);
    // A later partial retry of the same session without the exit.
    assert.strictEqual(await store.record('admin-1', session({ events: [{ t: 1, k: 'boot:script' }] })), true);
    const stored = await store.get('session-0001');
    assert.strictEqual(stored.exit, 'page-crash');
    assert.strictEqual(stored.events.length, 7, 'a shorter stale upload keeps the longer trail');
    assert.strictEqual((await store.list()).length, 1);
  });

  await test('keeps only the most recent sessions', async () => {
    const store = createClientTelemetryStore({ file: path.join(dir, 'b.json'), jsonStore, maxSessions: 3 });
    for (let index = 0; index < 5; index++) {
      await store.record('admin-1', session({ id: `session-000${index}` }));
    }
    const listed = await store.list();
    assert.deepStrictEqual(listed.map(item => item.id), ['session-0004', 'session-0003', 'session-0002']);
  });

  await test('sessions older than the retention window are removed on the next write', async () => {
    let clock = Date.UTC(2026, 9, 1);
    const store = createClientTelemetryStore({ file: path.join(dir, 'r.json'), jsonStore, now: () => clock });
    await store.record('admin-1', session({ id: 'session-old1' }));
    clock += 31 * 24 * 60 * 60 * 1000;
    await store.record('admin-1', session({ id: 'session-new1' }));
    assert.deepStrictEqual((await store.list()).map(item => item.id), ['session-new1']);
  });

  await test('routes require an administrator', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = req.get('x-role') ? { id: 'u1', role: req.get('x-role') } : null;
      next();
    });
    const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'no' }));
    registerClientTelemetryRoutes(app, {
      store: createClientTelemetryStore({ file: path.join(dir, 'c.json'), jsonStore }),
      trail: createServerTrail(),
      requireAdmin
    });
    await withServer(app, async base => {
      const post = role => fetch(`${base}/api/admin/client-telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(role ? { 'x-role': role } : {}) },
        body: JSON.stringify(session())
      });
      assert.strictEqual((await post('user')).status, 403);
      assert.strictEqual((await post('admin')).status, 204);
      const bad = await fetch(`${base}/api/admin/client-telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-role': 'admin' },
        body: JSON.stringify({ v: 1 })
      });
      assert.strictEqual(bad.status, 400);
      const listed = await (await fetch(`${base}/api/admin/client-telemetry`, { headers: { 'x-role': 'admin' } })).json();
      assert.strictEqual(listed.sessions.length, 1);
      assert.ok(Array.isArray(listed.server.slowResponses));
      const one = await fetch(`${base}/api/admin/client-telemetry/session-0001`, { headers: { 'x-role': 'admin' } });
      assert.strictEqual((await one.json()).events.length, 7);
      assert.strictEqual((await fetch(`${base}/api/admin/client-telemetry`, { headers: { 'x-role': 'user' } })).status, 403);
    });
  });

  await test('the server trail records time to first byte of slow responses only', async () => {
    const trail = createServerTrail({ slowMs: 50 });
    const app = express();
    app.use(trail.middleware);
    app.get('/fast', (req, res) => res.send('ok'));
    app.get('/slow', (req, res) => setTimeout(() => res.send('ok'), 80));
    // Headers immediately, then a long body: a stream, not a slow response.
    app.get('/stream', (req, res) => {
      res.writeHead(200);
      res.write('a');
      setTimeout(() => res.end('b'), 80);
    });
    await withServer(app, async base => {
      await (await fetch(`${base}/fast`)).text();
      await (await fetch(`${base}/slow?x=1`)).text();
      await (await fetch(`${base}/stream`)).text();
    });
    const { slowResponses } = trail.snapshot();
    assert.deepStrictEqual(slowResponses.map(item => item.path), ['/slow?x=1']);
    assert.ok(slowResponses[0].ttfbMs >= 50);
    trail.noteStall({ maxMs: 300, p99Ms: 40 });
    trail.sampleMemory();
    assert.strictEqual(trail.snapshot().eventLoopStalls[0].maxMs, 300);
    assert.ok(trail.snapshot().memory[0].rssMb > 0);
  });

  await test('the event-loop monitor reports small stalls to the trail without logging them', async () => {
    const { startEventLoopMonitor } = require('../lib/event-loop-monitor');
    let tick = null;
    const logs = [];
    const stalls = [];
    let max = 300e6;
    startEventLoopMonitor({
      log: message => logs.push(message),
      onStall: stall => stalls.push(stall),
      createHistogram: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 10e6, get max() { return max; } }),
      setIntervalFn: fn => { tick = fn; return null; }
    });
    tick();
    max = 1500e6;
    tick();
    assert.deepStrictEqual(stalls.map(stall => stall.maxMs), [300, 1500]);
    assert.strictEqual(logs.length, 1);
  });

  console.log('\nClient recorder');
  const telemetryModule = await importPublic('admin-telemetry.mjs');

  await test('holds the trail in memory until the account is known to be an administrator', async () => {
    const storage = memoryStorage();
    const sent = [];
    const telemetry = telemetryModule.createAdminTelemetry({
      storage,
      send: async body => { sent.push(JSON.parse(body)); return true; },
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {}
    });
    telemetry.mark('boot:script', { urgent: true });
    assert.strictEqual(storage.getItem('xandrio_admin_telemetry'), null);
    telemetry.enable();
    const persisted = JSON.parse(storage.getItem('xandrio_admin_telemetry'));
    assert.deepStrictEqual(persisted.events.map(event => event.k), ['boot:script', 'telemetry:enabled']);
    assert.strictEqual(storage.getItem('xandrio_admin_telemetry_enabled'), '1');
    await telemetry.flush();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].events.length, 2);
  });

  await test('a remembered administrator persists from the first event', () => {
    const storage = memoryStorage({ xandrio_admin_telemetry_enabled: '1' });
    const telemetry = telemetryModule.createAdminTelemetry({ storage, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    telemetry.mark('boot:script', { urgent: true });
    assert.strictEqual(JSON.parse(storage.getItem('xandrio_admin_telemetry')).events[0].k, 'boot:script');
  });

  await test('the next launch uploads a killed session with its exit class', async () => {
    const now = Date.UTC(2026, 10, 10, 20, 7, 26);
    const dead = { v: 1, id: 'dead-session-1', startedAt: now - 9000, ended: false, events: [{ t: 1, k: 'offline:verify-book' }] };
    const storage = memoryStorage({
      xandrio_admin_telemetry_enabled: '1',
      xandrio_admin_telemetry: JSON.stringify(dead),
      // The page-exit heartbeat: visible, beat 2 s ago, never ended.
      xandrio_page_session: JSON.stringify({ beatAt: now - 2000, visible: true, offlineWork: true, ended: false })
    });
    const sent = [];
    const telemetry = telemetryModule.createAdminTelemetry({
      storage,
      wallNow: () => now,
      send: async body => { sent.push(JSON.parse(body)); return true; },
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {}
    });
    assert.strictEqual(telemetry.previousExit(), 'page-crash-offline-work');
    await telemetry.uploadPending();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].id, 'dead-session-1');
    assert.strictEqual(sent[0].exit, 'page-crash-offline-work');
    assert.strictEqual(storage.getItem('xandrio_admin_telemetry_pending'), null);
  });

  await test('a failed upload keeps the dead session for a later launch', async () => {
    const storage = memoryStorage({
      xandrio_admin_telemetry_enabled: '1',
      xandrio_admin_telemetry: JSON.stringify({ v: 1, id: 'dead-session-2', startedAt: 1, ended: false, events: [] })
    });
    const telemetry = telemetryModule.createAdminTelemetry({ storage, send: async () => false, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    await telemetry.uploadPending();
    assert.strictEqual(JSON.parse(storage.getItem('xandrio_admin_telemetry_pending'))[0].id, 'dead-session-2');
  });

  await test('a forbidden upload stops recording and forgets the trail', async () => {
    const storage = memoryStorage({ xandrio_admin_telemetry_enabled: '1' });
    const telemetry = telemetryModule.createAdminTelemetry({ storage, send: async () => 'forbidden', setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    telemetry.enable();
    telemetry.mark('x', { urgent: true });
    await telemetry.flush();
    assert.strictEqual(telemetry.isEnabled(), false);
    assert.strictEqual(storage.getItem('xandrio_admin_telemetry'), null);
    assert.strictEqual(storage.getItem('xandrio_admin_telemetry_enabled'), null);
    telemetry.mark('after');
    assert.strictEqual(telemetry.session().events.length, 0);
  });

  await test('the ring keeps the boot head and the newest tail, and uploads fit a keepalive body', async () => {
    const storage = memoryStorage({ xandrio_admin_telemetry_enabled: '1' });
    let body = '';
    const telemetry = telemetryModule.createAdminTelemetry({
      storage,
      send: async value => { body = value; return true; },
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {}
    });
    telemetry.mark('boot:first');
    for (let index = 0; index < 2000; index++) telemetry.mark('res', { p: `/api/x/${index}`, note: 'y'.repeat(200) });
    const events = telemetry.session().events;
    assert.ok(events.length <= 500);
    assert.strictEqual(events[0].k, 'boot:first');
    assert.strictEqual(events[events.length - 1].p, '/api/x/1999');
    await telemetry.flush();
    assert.ok(body.length <= 60000, `body ${body.length}`);
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.events[0].k, 'boot:first');
  });

  await test('a non-administrator disables recording', () => {
    const storage = memoryStorage({ xandrio_admin_telemetry_enabled: '1' });
    const telemetry = telemetryModule.createAdminTelemetry({ storage, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    telemetry.disable();
    telemetry.mark('x', { urgent: true });
    assert.strictEqual(storage.getItem('xandrio_admin_telemetry'), null);
    assert.strictEqual(telemetry.session().events.length, 0);
  });

  await test('resource labels keep the path and a short query only', () => {
    const label = telemetryModule.resourceLabel(`https://x.test/api/library/chapter-labels?bookIds=${'a'.repeat(500)}`, 'https://x.test');
    assert.ok(label.startsWith('/api/library/chapter-labels?bookIds='));
    assert.ok(label.length <= 140);
  });

  console.log('\nStreaming SHA-256');
  const { createSha256 } = await importPublic('util/sha256-stream.mjs');

  await test('matches Web Crypto across block boundaries and chunkings', () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70000]) {
      const bytes = crypto.randomBytes(size);
      const hash = createSha256();
      let offset = 0;
      while (offset < size) {
        const step = 1 + Math.floor(Math.random() * 777);
        hash.update(bytes.subarray(offset, offset + step));
        offset += step;
      }
      assert.strictEqual(hash.digestHex(), crypto.createHash('sha256').update(bytes).digest('hex'), `size ${size}`);
    }
  });

  console.log('\nDisplay covers');

  await test('only covers larger than the display size need a copy', () => {
    assert.strictEqual(needsDisplayCopy({ width: 1627, height: 2457 }), true);
    assert.strictEqual(needsDisplayCopy({ width: 600, height: 900 }), false);
    assert.strictEqual(needsDisplayCopy(null), false);
  });

  await test('makes the copy once and reuses it until the original changes', async () => {
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-cover-'));
    const sourcePath = path.join(cacheDir, 'bk_cover.jpg');
    await fsp.writeFile(sourcePath, Buffer.alloc(1000, 1));
    let runs = 0;
    const display = createCoverDisplay({
      cacheDir,
      run: async (command, args) => {
        runs++;
        assert.strictEqual(command, 'ffmpeg');
        await fsp.writeFile(args[args.length - 1], Buffer.from('small'));
      }
    });
    const cover = { buffer: Buffer.alloc(1000, 1), contentType: 'image/jpeg', dimensions: { width: 1600, height: 2400 } };
    const [first, second] = await Promise.all([
      display.displayCover({ bookId: 'bk', sourcePath, cover }),
      display.displayCover({ bookId: 'bk', sourcePath, cover })
    ]);
    assert.strictEqual(first.buffer.toString(), 'small');
    assert.strictEqual(second.buffer.toString(), 'small');
    assert.strictEqual(runs, 1, 'concurrent requests share one job');
    await display.displayCover({ bookId: 'bk', sourcePath, cover });
    assert.strictEqual(runs, 1, 'a fresh copy is reused');
    const later = new Date(Date.now() + 5000);
    await fsp.utimes(sourcePath, later, later);
    await display.displayCover({ bookId: 'bk', sourcePath, cover });
    assert.strictEqual(runs, 2, 'a changed original is copied again');
    const leftovers = (await fsp.readdir(cacheDir)).filter(name => name.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  });

  await test('serves the original when the copy cannot be made', async () => {
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-cover-'));
    const sourcePath = path.join(cacheDir, 'bk_cover.jpg');
    await fsp.writeFile(sourcePath, Buffer.alloc(10, 1));
    const display = createCoverDisplay({ cacheDir, run: async () => { throw new Error('no ffmpeg'); }, log: () => {} });
    const cover = { buffer: Buffer.from('original'), contentType: 'image/png', dimensions: { width: 2000, height: 3000 } };
    const served = await display.displayCover({ bookId: 'bk', sourcePath, cover });
    assert.strictEqual(served, cover);
  });

  await test('display copies are managed book artifacts, so book deletion removes them', () => {
    const { isManagedArtifactName: isManagedBookArtifact } = require('../lib/book-artifact-paths');
    assert.strictEqual(isManagedBookArtifact('bk', 'bk_cover_display.jpg'), true);
    assert.strictEqual(isManagedBookArtifact('bk', 'bk_cover_display.jpg.123.abcd1234.tmp'), true);
  });

  await fsp.rm(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
