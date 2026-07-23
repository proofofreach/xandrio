/** Runtime security checks against the configured application. */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-security-http-'));
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.CACHE_DIR = path.join(testRoot, 'cache');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.CACHE_DIR, { recursive: true });

// These must be set before server.js is required.
process.env.XANDRIO_TOKEN = 'security-test-token';
process.env.CORS_ORIGIN = 'https://reader.example.test';
process.env.RATE_LIMIT_WINDOW = '60000';
process.env.RATE_LIMIT_MAX = '60';
process.env.XANDRIO_TRUST_PROXY = '1';
process.env.ANNAS_SECRET_KEY = 'environment-test-secret';
process.env.XANDRIO_CONCURRENCY_AUTH = '3';
process.env.XANDRIO_CONCURRENCY_SEARCH = '2';
process.env.XANDRIO_CONCURRENCY_DOWNLOAD = '1';
process.env.XANDRIO_CONCURRENCY_UPLOAD = '1';
process.env.XANDRIO_CONCURRENCY_METADATA = '1';
process.env.XANDRIO_CONCURRENCY_TTS = '2';
process.env.XANDRIO_CONCURRENCY_VOICE = '1';

const { app, __test: serverTestHooks } = require('../server');

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

function request(server, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      host: '127.0.0.1', port: address.port, method, path, headers
    }, res => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function abortPartialUpload(server) {
  return new Promise(resolve => {
    const boundary = '----xandrio-aborted-upload';
    const partial = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="epub"; filename="partial.epub"',
      'Content-Type: application/epub+zip',
      '',
      'PK\u0003\u0004partial-file-that-never-finishes'
    ].join('\r\n');
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: '/api/upload',
      headers: {
        Authorization: 'Bearer security-test-token',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(partial) + 1024 * 1024
      }
    });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    req.once('error', done);
    req.once('close', done);
    req.write(partial);
    setTimeout(() => req.destroy(), 20);
  });
}

async function waitForUploadCleanup(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leftovers = fs.readdirSync(process.env.CACHE_DIR).filter(name => name.startsWith('upload_'));
    if (leftovers.length === 0) return leftovers;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return fs.readdirSync(process.env.CACHE_DIR).filter(name => name.startsWith('upload_'));
}

async function main() {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const health = await request(server, { path: '/health' });
    test('/health stays public', () => assert.strictEqual(health.status, 200));

    const staticAsset = await request(server, { path: '/js/api.js' });
    test('static application assets stay public', () => assert.strictEqual(staticAsset.status, 200));

    const library = await request(server, { path: '/api/library' });
    test('an unauthenticated client cannot list the library', () => {
      assert.strictEqual(library.status, 401);
      assert.strictEqual(library.body, '{"error":"Unauthorized"}');
    });

    const audio = await request(server, {
      path: '/api/audio/not-a-real-book/0', headers: { Range: 'bytes=0-99' }
    });
    test('an unauthenticated client cannot retrieve ranged audio', () => assert.strictEqual(audio.status, 401));

    const allowedCors = await request(server, {
      path: '/health', headers: { Origin: 'https://reader.example.test' }
    });
    test('configured CORS origin is allowed with credentials', () => {
      assert.strictEqual(allowedCors.headers['access-control-allow-origin'], 'https://reader.example.test');
      assert.strictEqual(allowedCors.headers['access-control-allow-credentials'], 'true');
    });

    const preflight = await request(server, {
      method: 'OPTIONS', path: '/api/library',
      headers: {
        Origin: 'https://reader.example.test',
        'Access-Control-Request-Method': 'GET'
      }
    });
    test('configured CORS preflight succeeds without exposing a private API', () => {
      assert.strictEqual(preflight.status, 204);
      assert.strictEqual(preflight.headers['access-control-allow-origin'], 'https://reader.example.test');
    });

    const deniedCors = await request(server, {
      path: '/health', headers: { Origin: 'https://untrusted.example.test' }
    });
    test('unconfigured CORS origin is denied', () => {
      assert.strictEqual(deniedCors.headers['access-control-allow-origin'], undefined);
    });

    test('baseline security headers are present', () => {
      assert.match(health.headers['content-security-policy'], /default-src 'self'/);
      assert.strictEqual(health.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(health.headers['x-frame-options'], 'DENY');
      assert.strictEqual(health.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    });

    test('documented concurrency environment controls are active', () => {
      assert.deepStrictEqual(serverTestHooks.concurrencyLimits, {
        auth: 3, search: 2, download: 1, upload: 1, metadata: 1, tts: 2, voice: 1
      });
    });

    const login = await request(server, {
      method: 'POST', path: '/api/auth/login',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ token: 'security-test-token' })
    });
    test('login sets a server-validated HttpOnly session instead of returning the token', () => {
      assert.strictEqual(login.status, 204);
      assert.strictEqual(login.body, '');
      const cookie = login.headers['set-cookie']?.[0] || '';
      assert.match(cookie, /^xandrio_session=/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      assert.match(cookie, /Secure/);
      assert(!cookie.includes('security-test-token'));
    });

    const cookie = (login.headers['set-cookie']?.[0] || '').split(';', 1)[0];
    const sessionLibrary = await request(server, { path: '/api/library', headers: { Cookie: cookie } });
    test('the authenticated session can reach a private route', () => assert.notStrictEqual(sessionLibrary.status, 401));

    const bearerLibrary = await request(server, {
      path: '/api/library', headers: { Authorization: 'Bearer security-test-token' }
    });
    test('bearer authentication remains supported for API clients', () => assert.notStrictEqual(bearerLibrary.status, 401));

    const annasStatus = await request(server, {
      path: '/api/annas/status', headers: { Authorization: 'Bearer security-test-token' }
    });
    test('documented Anna environment configuration is active but redacted', () => {
      assert.strictEqual(annasStatus.status, 200);
      const status = JSON.parse(annasStatus.body);
      assert.strictEqual(status.configured, true);
      assert.strictEqual(status.hasKey, true);
      assert(!annasStatus.body.includes('environment-test-secret'));
    });

    await abortPartialUpload(server);
    const uploadLeftovers = await waitForUploadCleanup();
    test('an interrupted multipart upload leaves no temporary file', () => {
      assert.deepStrictEqual(uploadLeftovers, []);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(testRoot, { recursive: true, force: true });
  }

  console.log(`\nsecurity HTTP tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
