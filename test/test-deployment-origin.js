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
    let onlineHandler = null;
    let fetchCount = 0;
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
      assert.strictEqual(
        changes.at(-1).href,
        'https://reader.example.com/library'
      );
    } finally {
      delete global.document;
      delete global.addEventListener;
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
