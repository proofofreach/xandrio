'use strict';

const assert = require('node:assert');
const express = require('express');
const http = require('http');
const { createCsrfMiddleware, normalizeOrigin } = require('../lib/csrf');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}`); console.error(`    ${error.stack || error.message}`); }
}

function server(middleware) {
  const app = express();
  app.use(middleware);
  app.all('/api/thing', (_req, res) => res.status(200).json({ ok: true }));
  app.all('/health', (_req, res) => res.status(200).json({ ok: true }));
  return http.createServer(app);
}

async function withServer(middleware, run) {
  const instance = server(middleware);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const { port } = instance.address();
  try {
    return await run(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise(resolve => instance.close(resolve));
  }
}

(async () => {
  await test('a cross-site POST from a hostile page is refused', async () => {
    await withServer(createCsrfMiddleware(), async base => {
      const response = await fetch(`${base}/api/thing`, {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' }
      });
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await response.json()).code, 'CSRF_BLOCKED');
    });
  });

  await test('a mismatched Origin is refused even without Sec-Fetch-Site', async () => {
    await withServer(createCsrfMiddleware(), async base => {
      const response = await fetch(`${base}/api/thing`, {
        method: 'POST',
        headers: { origin: 'https://evil.test' }
      });
      assert.strictEqual(response.status, 403);
    });
  });

  await test('the opaque "null" origin of a sandboxed frame is refused', async () => {
    await withServer(createCsrfMiddleware(), async base => {
      const response = await fetch(`${base}/api/thing`, {
        method: 'POST',
        headers: { origin: 'null' }
      });
      assert.strictEqual(response.status, 403);
    });
  });

  await test('the app\'s own origin passes', async () => {
    await withServer(createCsrfMiddleware(), async (base, port) => {
      const response = await fetch(`${base}/api/thing`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }
      });
      assert.strictEqual(response.status, 200);
    });
  });

  await test('a non-browser client sending no Origin still works', async () => {
    await withServer(createCsrfMiddleware(), async base => {
      const response = await fetch(`${base}/api/thing`, { method: 'POST' });
      assert.strictEqual(response.status, 200);
    });
  });

  await test('an operator-configured extra origin is allowed', async () => {
    const middleware = createCsrfMiddleware({ allowedOrigins: 'https://reader.example.test' });
    await withServer(middleware, async base => {
      const allowed = await fetch(`${base}/api/thing`, {
        method: 'POST',
        headers: { origin: 'https://reader.example.test' }
      });
      assert.strictEqual(allowed.status, 200);
      const other = await fetch(`${base}/api/thing`, {
        method: 'POST',
        headers: { origin: 'https://reader.example.test.evil.test' }
      });
      assert.strictEqual(other.status, 403);
    });
  });

  await test('safe methods and non-API paths are never gated', async () => {
    await withServer(createCsrfMiddleware(), async base => {
      const read = await fetch(`${base}/api/thing`, { headers: { origin: 'https://evil.test' } });
      assert.strictEqual(read.status, 200);
      const asset = await fetch(`${base}/health`, {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' }
      });
      assert.strictEqual(asset.status, 200);
    });
  });

  await test('origins are compared by parsed origin, not by string prefix', () => {
    assert.strictEqual(normalizeOrigin('https://example.test:443/path?q=1'), 'https://example.test');
    assert.strictEqual(normalizeOrigin('https://example.test:8443'), 'https://example.test:8443');
    assert.strictEqual(normalizeOrigin('javascript:alert(1)'), null);
    assert.strictEqual(normalizeOrigin('null'), null);
    assert.strictEqual(normalizeOrigin(''), null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
