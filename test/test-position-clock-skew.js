// Regression: a device whose clock runs fast stamped its local playback
// checkpoints with that clock, and chooseFreshestPosition() compared them with
// server-ordered stamps. The device then preferred its own older copy over
// newer progress from other devices for as long as its clock was ahead. A
// slow device lost its own newer offline progress the same way. Checkpoints
// are now stamped on the server's clock, learned from API responses and kept
// for offline launches.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

const SERVER_NOW = Date.parse('2026-11-07T12:00:00.000Z');
const FAST = 4 * 60 * 1000;

function installBrowser(storage, fetchImpl) {
  global.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  global.document = { cookie: '', dispatchEvent() {} };
  global.CustomEvent = class CustomEvent {
    constructor(type) { this.type = type; }
  };
  global.window = { location: { origin: 'https://reader.test' }, fetch: fetchImpl };
  global.fetch = fetchImpl;
  global.navigator = { userAgent: 'Test Browser' };
}

async function loadApi(instance) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${instance}`);
}

function serverResponse(serverMs = SERVER_NOW) {
  return async () => new Response(JSON.stringify({ position: null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', Date: new Date(serverMs).toUTCString() }
  });
}

function appFunction(name) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} exists in app.js`);
  const end = source.indexOf('\n}\n', start) + 2;
  return source.slice(start, end);
}

(async () => {
  const realNow = Date.now;
  const deviceClock = offset => { Date.now = () => SERVER_NOW + offset; };

  await test('a fast device stamps checkpoints on the server clock and yields to newer server progress', async () => {
    try {
      const storage = new Map();
      deviceClock(FAST);
      installBrowser(storage, serverResponse());
      const api = await loadApi('fast');
      await api.apiGet('/api/position/book');
      assert(Math.abs(api.serverNow() - SERVER_NOW) <= 1000, `serverNow is ${api.serverNow() - SERVER_NOW} ms off`);

      // eslint-disable-next-line no-new-func
      const chooseFreshestPosition = new Function(
        `${appFunction('checkpointUpdatedAtMs')}\n${appFunction('chooseFreshestPosition')}\nreturn chooseFreshestPosition;`
      )();
      // This device saved its checkpoint one minute ago (playback-session
      // stamps with the injected now). Another device saved 10 s ago.
      deviceClock(FAST - 60 * 1000);
      const local = { chapterIndex: 2, timestamp: 100, updatedAt: api.serverNow() };
      deviceClock(FAST);
      const server = { chapterIndex: 3, timestamp: 20, updatedAt: SERVER_NOW - 10 * 1000 };
      assert.strictEqual(chooseFreshestPosition(local, server), server);
    } finally {
      Date.now = realNow;
    }
  });

  await test('a slow device keeps its newer offline checkpoint over older server progress', async () => {
    try {
      const storage = new Map();
      deviceClock(-FAST);
      installBrowser(storage, serverResponse());
      const online = await loadApi('slow-online');
      await online.apiGet('/api/position/book');

      // Offline relaunch: no response to learn from, the stored offset applies.
      installBrowser(storage, async () => { throw new TypeError('Failed to fetch'); });
      const offline = await loadApi('slow-offline');
      deviceClock(-FAST + 30 * 1000);
      const local = { updatedAt: offline.serverNow() };
      assert(Math.abs(local.updatedAt - (SERVER_NOW + 30 * 1000)) <= 1000);
      assert(local.updatedAt > SERVER_NOW + 20 * 1000, 'newer than progress the server stamped 20 s after the sync');
    } finally {
      Date.now = realNow;
    }
  });

  await test('the server clock ignores one-second Date noise, slow round trips and missing headers', async () => {
    try {
      const storage = new Map();
      deviceClock(700);
      installBrowser(storage, serverResponse());
      const api = await loadApi('noise');
      await api.apiGet('/api/position/book');
      assert.strictEqual(api.serverNow(), Date.now(), 'sub-resolution skew is not an offset');

      api.observeServerClock(new Date(SERVER_NOW - FAST).toUTCString(), Date.now() - 20000, Date.now());
      assert.strictEqual(api.serverNow(), Date.now(), 'a slow round trip cannot place the server time');
      api.observeServerClock(null, Date.now() - 10, Date.now());
      api.observeServerClock('not a date', Date.now() - 10, Date.now());
      assert.strictEqual(api.serverNow(), Date.now());
    } finally {
      Date.now = realNow;
    }
  });

  await test('app.js stamps playback checkpoints with the server clock', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const creation = source.slice(source.indexOf('const playbackSession = createPlaybackSession({'));
    assert.match(creation.slice(0, 400), /now: serverNow/);
    assert.match(source.split('\n')[2], /\bserverNow\b/, 'serverNow is imported from api.js');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
