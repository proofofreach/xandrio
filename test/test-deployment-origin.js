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
    console.error(`    ${error.message}`);
  }
}

(async () => {
  const {
    normalizeCanonicalOrigin,
    registerDeploymentRoute
  } = require('../lib/deployment-origin');
  const clientSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'deployment-origin.js'),
    'utf8'
  );
  const clientUrl = `data:text/javascript;base64,${Buffer.from(clientSource).toString('base64')}`;
  const { deploymentGuard, initDeploymentGuard } = await import(clientUrl);

  await test('accepts one HTTPS canonical origin and rejects paths or insecure remote origins', () => {
    assert.strictEqual(
      normalizeCanonicalOrigin('https://reader.example.com/'),
      'https://reader.example.com'
    );
    assert.strictEqual(normalizeCanonicalOrigin('http://localhost:8181'), 'http://localhost:8181');
    assert.throws(() => normalizeCanonicalOrigin('https://reader.example.com/app'));
    assert.throws(() => normalizeCanonicalOrigin('http://reader.example.com'));
  });

  await test('publishes canonical deployment metadata without authentication', () => {
    let route = null;
    const app = {
      get(pathname, handler) {
        route = { pathname, handler };
      }
    };
    registerDeploymentRoute(app, { canonicalOrigin: 'https://reader.example.com' });
    assert.strictEqual(route.pathname, '/api/deployment');
    const headers = new Map();
    let payload = null;
    route.handler({}, {
      setHeader(name, value) { headers.set(name, value); },
      json(value) { payload = value; }
    });
    assert.strictEqual(headers.get('Cache-Control'), 'no-store');
    assert.deepStrictEqual(payload, {
      canonicalOrigin: 'https://reader.example.com',
      pwaRequiresSecureContext: true
    });
  });

  await test('blocks service-worker registration on an alternate origin', () => {
    const result = deploymentGuard({
      currentUrl: 'https://192.0.2.10/library?tab=downloaded#top',
      isSecureContext: true,
      canonicalOrigin: 'https://reader.example.com'
    });
    assert.strictEqual(result.serviceWorkerAllowed, false);
    assert.strictEqual(
      result.href,
      'https://reader.example.com/library?tab=downloaded#top'
    );
    assert.match(result.message, /separate offline downloads/i);
  });

  await test('blocks PWA features on insecure remote HTTP but permits local development', () => {
    const remote = deploymentGuard({
      currentUrl: 'http://192.0.2.10:8181/',
      isSecureContext: false
    });
    assert.strictEqual(remote.serviceWorkerAllowed, false);
    assert.match(remote.message, /require HTTPS/i);

    const local = deploymentGuard({
      currentUrl: 'http://localhost:8181/',
      isSecureContext: true
    });
    assert.strictEqual(local.serviceWorkerAllowed, true);
    assert.strictEqual(local.message, '');
  });

  await test('marks offline storage unavailable when the current origin is not canonical', async () => {
    const dataset = {};
    global.document = {
      documentElement: { dataset },
      getElementById() { return null; }
    };
    try {
      const result = await initDeploymentGuard({
        currentUrl: 'https://alternate.example.com/',
        isSecureContext: true,
        fetchImpl: async () => Response.json({
          canonicalOrigin: 'https://reader.example.com',
          pwaRequiresSecureContext: true
        })
      });
      assert.strictEqual(result.serviceWorkerAllowed, false);
      assert.strictEqual(dataset.pwaStorageAllowed, 'false');
    } finally {
      delete global.document;
    }
  });

  await test('cold offline boot reuses verified origin metadata and rechecks it online', async () => {
    const values = new Map([[
      'xandrio_deployment_origin',
      JSON.stringify({ canonicalOrigin: '' })
    ]]);
    const storage = {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, String(value)); }
    };
    const dataset = {};
    const deploymentChanges = [];
    let onlineHandler = null;
    let fetchCount = 0;
    const changes = [];
    global.document = {
      documentElement: { dataset },
      getElementById() { return null; },
      dispatchEvent(event) {
        deploymentChanges.push(event.detail);
        return true;
      }
    };
    global.CustomEvent = class CustomEvent extends Event {
      constructor(type, options = {}) {
        super(type);
        this.detail = options.detail;
      }
    };
    global.addEventListener = (type, handler) => {
      if (type === 'online') onlineHandler = handler;
    };
    try {
      const initial = await initDeploymentGuard({
        currentUrl: 'https://alternate.example.com/library',
        isSecureContext: true,
        storage,
        onChange: result => changes.push(result),
        fetchImpl: async () => {
          fetchCount += 1;
          if (fetchCount === 1) throw new Error('offline');
          return Response.json({ canonicalOrigin: 'https://reader.example.com' });
        }
      });
      assert.strictEqual(initial.serviceWorkerAllowed, true);
      assert(onlineHandler);

      await onlineHandler();
      assert.strictEqual(changes.at(-1).serviceWorkerAllowed, false);
      assert.strictEqual(dataset.pwaStorageAllowed, 'false');
      assert.strictEqual(deploymentChanges.at(-1).serviceWorkerAllowed, false);
      assert.strictEqual(
        changes.at(-1).href,
        'https://reader.example.com/library'
      );
    } finally {
      delete global.document;
      delete global.addEventListener;
      delete global.CustomEvent;
    }
  });

  await test('reconnect stays fail-closed when fresh deployment metadata is unavailable', async () => {
    const values = new Map([[
      'xandrio_deployment_origin',
      JSON.stringify({ canonicalOrigin: '' })
    ]]);
    const storage = {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, String(value)); }
    };
    const dataset = {};
    let onlineHandler = null;
    const changes = [];
    global.document = {
      documentElement: { dataset },
      getElementById() { return null; }
    };
    global.addEventListener = (type, handler) => {
      if (type === 'online') onlineHandler = handler;
    };
    try {
      const initial = await initDeploymentGuard({
        currentUrl: 'https://reader.example.com/',
        isSecureContext: true,
        storage,
        onChange: result => changes.push(result),
        fetchImpl: async () => new Response(null, { status: 503 })
      });
      assert.strictEqual(initial.serviceWorkerAllowed, true);

      await onlineHandler();
      assert.strictEqual(changes.at(-1).serviceWorkerAllowed, false);
      assert.strictEqual(dataset.pwaStorageAllowed, 'false');
      assert.match(changes.at(-1).message, /Reconnect to verify/i);
    } finally {
      delete global.document;
      delete global.addEventListener;
    }
  });

  const {
    MIN_CLIENT_BUILD,
    createClientBuildGate
  } = require('../lib/deployment-origin');
  function runGate(gate, { path: requestPath, build }) {
    const headers = new Map();
    const result = { nextCalled: false, status: 200, body: null, headers };
    gate({
      path: requestPath,
      get: name => (name.toLowerCase() === 'x-xandrio-build' ? build : undefined)
    }, {
      setHeader(name, value) { headers.set(name, value); },
      status(code) { result.status = code; return this; },
      json(value) { result.body = value; return this; }
    }, () => { result.nextCalled = true; });
    return result;
  }

  await test('a build older than the server minimum receives 409 CLIENT_STALE', () => {
    const gate = createClientBuildGate({ minClientBuild: 'xandrio-v230' });
    const refused = runGate(gate, { path: '/api/library', build: 'xandrio-v229' });
    assert.strictEqual(refused.nextCalled, false);
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(refused.body.code, 'CLIENT_STALE');
    assert.strictEqual(refused.headers.get('X-Xandrio-Client-Stale'), '1');
    assert.strictEqual(refused.headers.get('Cache-Control'), 'no-store');
    assert.strictEqual(runGate(gate, { path: '/api/library', build: 'xandrio-v230' }).nextCalled, true);
    assert.strictEqual(runGate(gate, { path: '/api/library', build: 'xandrio-v231' }).nextCalled, true);
  });

  await test('an absent or unrecognised build header is always accepted', () => {
    const gate = createClientBuildGate({ minClientBuild: 'xandrio-v999' });
    for (const build of [undefined, '', 'calibre-plugin/2.1', 'xandrio-vNaN', 'v1']) {
      assert.strictEqual(runGate(gate, { path: '/api/library', build }).nextCalled, true, String(build));
    }
  });

  await test('a stale client can still learn the build, sign in or out, and save progress', () => {
    const gate = createClientBuildGate({ minClientBuild: 'xandrio-v999' });
    for (const requestPath of [
      '/api/deployment', '/api/auth/status', '/api/auth/logout', '/api/position',
      '/api/position/book-1', '/api/positions', '/api/positions/batch', '/api/playback-health',
      '/app.js', '/sw.js'
    ]) {
      assert.strictEqual(runGate(gate, { path: requestPath, build: 'xandrio-v1' }).nextCalled, true, requestPath);
    }
    assert.strictEqual(runGate(gate, { path: '/api/positionsx', build: 'xandrio-v1' }).nextCalled, false);
  });

  await test('the shipped minimum admits the shipped client build', () => {
    const api = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');
    const clientBuild = api.match(/export const CLIENT_BUILD = '([^']+)';/)?.[1];
    const swBuild = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8')
      .match(/const CACHE_VERSION = '([^']+)';/)?.[1];
    assert.strictEqual(clientBuild, swBuild, 'api.js CLIENT_BUILD matches sw.js CACHE_VERSION');
    assert.strictEqual(runGate(createClientBuildGate(), { path: '/api/library', build: clientBuild }).nextCalled, true);
    assert.match(MIN_CLIENT_BUILD, /^xandrio-v\d+$/);
    assert.match(api, /'X-Xandrio-Build': CLIENT_BUILD/, 'API requests carry the client build');
    assert.match(api, /response\.status === 409 && response\.headers\?\.get\?\.\('X-Xandrio-Client-Stale'\) === '1'\) handleClientStale\(\)/);
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const deploymentAt = server.indexOf('registerDeploymentRoute(app,');
    const gateAt = server.indexOf('app.use(createClientBuildGate());');
    assert.ok(deploymentAt > 0 && gateAt > deploymentAt, 'the gate runs after /api/deployment');
    assert.ok(gateAt < server.indexOf('app.use(createCsrfMiddleware());'), 'the gate runs before routes');
  });

  const { pathToFileURL } = require('url');
  const { createClientStalenessMonitor } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'client-staleness.mjs')).href
  );
  function monitorHarness({ playing = false, serverBuild = 'xandrio-v300', updateOk = true } = {}) {
    const calls = { prompts: [], updates: 0, fetches: 0 };
    const values = new Map();
    let clock = 1_000_000;
    const monitor = createClientStalenessMonitor({
      clientBuild: 'xandrio-v300',
      fetchDeployment: async () => { calls.fetches++; return { appBuild: harness.serverBuild }; },
      isPlaying: () => harness.playing,
      applyUpdate: async () => { calls.updates++; return { ok: updateOk }; },
      promptUpdate: reason => calls.prompts.push(reason),
      storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
      now: () => clock
    });
    const harness = { monitor, calls, playing, serverBuild, advance(ms) { clock += ms; } };
    return harness;
  }

  await test('a refused build updates at once while nothing plays', async () => {
    const harness = monitorHarness();
    assert.deepStrictEqual(await harness.monitor.handleClientStale(), { updated: true });
    assert.strictEqual(harness.calls.updates, 1);
    assert.deepStrictEqual(harness.calls.prompts, []);
  });

  await test('a refused build asks first while audio plays', async () => {
    const harness = monitorHarness({ playing: true });
    await harness.monitor.handleClientStale();
    assert.strictEqual(harness.calls.updates, 0);
    assert.deepStrictEqual(harness.calls.prompts, ['stale']);
  });

  await test('a refusal that survives an automatic update asks instead of reloading again', async () => {
    const harness = monitorHarness({ updateOk: true });
    await harness.monitor.handleClientStale();
    const reloaded = createClientStalenessMonitor({
      clientBuild: 'xandrio-v300',
      fetchDeployment: async () => ({}),
      applyUpdate: async () => { harness.calls.updates++; return { ok: true }; },
      promptUpdate: reason => harness.calls.prompts.push(reason),
      storage: { getItem: () => String(1_000_000), setItem() {} },
      now: () => 1_000_000 + 5_000
    });
    await reloaded.handleClientStale();
    assert.strictEqual(harness.calls.updates, 1);
    assert.deepStrictEqual(harness.calls.prompts, ['stale']);
  });

  await test('returning to the foreground rechecks the server build, throttled', async () => {
    const harness = monitorHarness();
    assert.deepStrictEqual(await harness.monitor.handleVisibilityChange('hidden'), { checked: false });
    assert.strictEqual(harness.calls.fetches, 0);
    assert.strictEqual((await harness.monitor.handleVisibilityChange('visible')).moved, false);
    assert.deepStrictEqual(harness.calls.prompts, []);
    harness.serverBuild = 'xandrio-v301';
    assert.deepStrictEqual(await harness.monitor.handleVisibilityChange('visible'), { checked: false }, 'throttled');
    assert.strictEqual(harness.calls.fetches, 1);
    harness.advance(5 * 60 * 1000);
    const moved = await harness.monitor.handleVisibilityChange('visible');
    assert.strictEqual(moved.moved, true);
    assert.deepStrictEqual(harness.calls.prompts, ['moved'], 'a moved build is offered, never forced');
    assert.strictEqual(harness.calls.updates, 0);
  });

  await test('the app wires refusals and foreground rechecks to the monitor', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(app, /document\.addEventListener\('xandrio:clientstale', \(\) => \{ void monitor\.handleClientStale\(\); \}\);/);
    assert.match(app, /void monitor\.handleVisibilityChange\(document\.visibilityState\);/);
    assert.ok(app.indexOf('initClientStaleness();') < app.indexOf('authStatus = await fetchAuthStatus('), 'wired before the first API call');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
