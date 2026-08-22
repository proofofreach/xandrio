#!/usr/bin/env node
/**
 * Regression for lib/network-guard.js: proves that https.request, http.get/
 * https.get, and global fetch() — the three independent HTTP entry points a
 * server-side code path can use — are all rewritten to the local stub for
 * any non-loopback destination, and that a fetch() call the guard cannot
 * safely rewrite (a non-HTTP(S) scheme) fails closed instead of falling
 * through to the real network.
 *
 * This exists because a prior version of the guard only patched
 * http.request/https.request: http.get/https.get call Node's own internal,
 * unexported `request()` rather than `module.exports.request` and were never
 * touched by that patch, and global fetch() is implemented by undici, which
 * opens its own sockets and is invisible to http/https patches entirely. A
 * fresh critic observed exactly this: an ESTABLISHED TLS socket to
 * gutendex.com's real IP while /api/search-cover ran (lib/search-cover-service.js's
 * writeRemoteCover uses global fetch() directly), and an isolated repro
 * showed https.request redirected correctly while fetch() to a non-routable
 * test address (192.0.2.1) escaped and hung until timeout.
 *
 * Every target address/hostname used below is either an RFC 5737 TEST-NET
 * address (guaranteed non-routable, never dialed for real even with a live
 * connection) or a real-looking public hostname (gutendex.com, archive.org).
 * If this regression's own request/get/fetch calls are ever actually sent
 * out — because the guard regressed — they will hang until the probe's own
 * timeout and this check fails loudly rather than silently passing.
 */
const assert = require('assert');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const NETWORK_GUARD_PATH = path.join(__dirname, 'lib', 'network-guard.js');
const PROBE_PATH = path.join(__dirname, 'lib', 'network-guard-probe.js');
const { buildDatasetServerEnvironment } = require('./lib/environment');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function startCatcher() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const entry = {
        host: req.headers['x-scenario-target-host'] || null,
        protocol: req.headers['x-scenario-target-protocol'] || null,
        hostHeader: req.headers.host || null,
        path: req.url,
        method: req.method,
        body: rawBody ? JSON.parse(rawBody) : null
      };
      requests.push(entry);
      const payload = Buffer.from(JSON.stringify(entry));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
      res.end(payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      requests,
      close: () => new Promise(r => server.close(r))
    }));
  });
}

// Deliberately async (spawn), not spawnSync: the loopback catcher the probe
// child talks to lives in *this* process and needs its own event loop
// running to accept and answer connections. spawnSync blocks the parent's
// event loop for the child's entire lifetime, which would starve the
// catcher and deadlock every probe until each one times out.
function runProbe(stubPort) {
  const env = { ...process.env, NODE_OPTIONS: `--require ${NETWORK_GUARD_PATH}` };
  if (stubPort === undefined) delete env.XANDRIO_SCENARIO_STUB_PORT;
  else env.XANDRIO_SCENARIO_STUB_PORT = String(stubPort);
  const child = spawn(process.execPath, [PROBE_PATH], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => {
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function readChildEnvironment(env) {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    env,
    encoding: 'utf8'
  });
  assert.strictEqual(child.status, 0, `environment probe failed: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

async function main() {
  const datasetEnvironment = buildDatasetServerEnvironment({
    port: 41001,
    dataDir: '/tmp/xandrio-scenario-data',
    cacheDir: '/tmp/xandrio-scenario-cache',
    kokoroPort: 41002,
    chatterboxPort: 41003,
    guardPort: 41004
  });
  const datasetChildEnvironment = readChildEnvironment(datasetEnvironment);

  test('dataset child environment contains the required scenario runtime values', () => {
    const expected = {
      PORT: '41001',
      HOST: '127.0.0.1',
      DATA_DIR: '/tmp/xandrio-scenario-data',
      CACHE_DIR: '/tmp/xandrio-scenario-cache',
      PATH: process.env.PATH || '',
      NODE_OPTIONS: `--require ${NETWORK_GUARD_PATH}`,
      XANDRIO_SCENARIO_STUB_PORT: '41004',
      KOKORO_TTS_URL: 'http://127.0.0.1:41002',
      CHATTERBOX_TTS_URL: 'http://127.0.0.1:41003',
      KOKORO_AUTO_START: 'false',
      CHATTERBOX_AUTO_START: 'false',
      XANDRIO_VOICE_PROVIDERS: 'kokoro,chatterbox',
      XANDRIO_DEFAULT_VOICE: 'kokoro:am_onyx',
      XANDRIO_PREGENERATE_ON_IMPORT: 'false',
      OPDS_FEED_URL: 'https://example.com/opds-feed',
      OPDS_LABEL: 'Scenario OPDS',
      XANDRIO_TOKEN: '',
      ANNAS_SECRET_KEY: '',
      XANDRIO_TRUST_PROXY: 'false'
    };
    assert.deepStrictEqual(
      Object.fromEntries(Object.keys(expected).map(name => [name, datasetChildEnvironment[name]])),
      expected
    );
    // macOS injects this locale bridge after Node receives an explicit env;
    // it is not inherited from the parent and carries no operator secret.
    const platformInjected = new Set(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []);
    const unexpected = Object.keys(datasetChildEnvironment)
      .filter(name => !(name in expected) && !platformInjected.has(name));
    assert.deepStrictEqual(unexpected, [], `unexpected dataset child variables: ${unexpected.join(', ')}`);
  });

  test('dataset child environment excludes operator credentials and private-mode flags', () => {
    const blocked = [
      'PPQ_API_KEY',
      'OPDS_USER',
      'OPDS_PASSWORD',
      'STANDARD_EBOOKS_OPDS_USER',
      'STANDARD_EBOOKS_OPDS_PASSWORD',
      'WEB_PUSH_VAPID_PRIVATE_KEY',
      'XANDRIO_PRIVATE_CODEX_GUIDES'
    ];
    for (const name of blocked) {
      assert.ok(!(name in datasetChildEnvironment), `${name} must not enter a scenario dataset child`);
    }
  });

  const catcher = await startCatcher();
  try {
    const run = await runProbe(catcher.port);

    test('probe child process exits 0', () => {
      assert.strictEqual(run.status, 0, `stderr: ${run.stderr}`);
    });

    let results = [];
    test('probe child prints one parseable JSON result line', () => {
      const line = run.stdout.trim().split('\n').filter(Boolean).pop();
      results = JSON.parse(line);
      assert.ok(Array.isArray(results) && results.length === 6, `expected 6 probe results, got: ${run.stdout}`);
    });

    const byName = Object.fromEntries(results.map(entry => [entry.name, entry]));

    test('https.request to a non-loopback host is redirected to the stub, not the real host', () => {
      const entry = byName['https.request'];
      assert.ok(entry && entry.ok, `probe failed: ${entry && entry.error}`);
      assert.strictEqual(entry.body.host, '198.51.100.7');
      assert.strictEqual(entry.body.protocol, 'https:');
      assert.strictEqual(entry.body.path, '/probe/https-request');
      assert.ok(entry.body.hostHeader.startsWith('127.0.0.1:'), `Host header leaked target: ${entry.body.hostHeader}`);
    });

    test('http.get to a non-loopback host is redirected to the stub (not just http.request)', () => {
      const entry = byName['http.get'];
      assert.ok(entry && entry.ok, `probe failed: ${entry && entry.error}`);
      assert.strictEqual(entry.body.host, 'gutendex.example.net');
      assert.strictEqual(entry.body.protocol, 'http:');
      assert.strictEqual(entry.body.path, '/probe/http-get');
    });

    test('https.get to a non-loopback host is redirected to the stub (not just https.request)', () => {
      const entry = byName['https.get'];
      assert.ok(entry && entry.ok, `probe failed: ${entry && entry.error}`);
      assert.strictEqual(entry.body.host, '203.0.113.9');
      assert.strictEqual(entry.body.protocol, 'https:');
      assert.strictEqual(entry.body.path, '/probe/https-get');
    });

    test('global fetch() to a non-loopback host is redirected to the stub (the undici gap)', () => {
      const entry = byName['fetch'];
      assert.ok(entry && entry.ok, `probe failed: ${entry && entry.error}`);
      assert.strictEqual(entry.body.host, 'gutendex.com');
      assert.strictEqual(entry.body.protocol, 'https:');
      assert.strictEqual(entry.body.path, '/probe/fetch');
    });

    test('fetch() with a request body is redirected to the stub with the body intact', () => {
      const entry = byName['fetch-post-body'];
      assert.ok(entry && entry.ok, `probe failed: ${entry && entry.error}`);
      assert.strictEqual(entry.body.host, 'archive.org');
      assert.strictEqual(entry.body.method, 'POST');
      assert.deepStrictEqual(entry.body.body, { marker: 'fetch-post-body' });
    });

    test('fetch() to a non-HTTP(S) scheme fails closed instead of passing through', () => {
      const entry = byName['fetch-non-http-scheme'];
      assert.ok(entry && entry.ok, `probe failed: ${entry && entry.error}`);
      assert.strictEqual(entry.rejected, true);
      assert.ok(/non-HTTP\(S\)/.test(entry.message), `expected a fail-closed rejection message, got: ${entry.message}`);
    });

    test('no probe request ever reached the catcher without the guard-attached target headers', () => {
      const untagged = catcher.requests.filter(entry => !entry.host);
      assert.strictEqual(untagged.length, 0, `stub received request(s) with no x-scenario-target-host: ${JSON.stringify(untagged)}`);
    });

    const missingStub = await runProbe(undefined);
    test('the guard fails closed at startup when XANDRIO_SCENARIO_STUB_PORT is unset', () => {
      assert.notStrictEqual(missingStub.status, 0, 'expected the probe child to fail to start without a stub port configured');
      assert.ok(
        /XANDRIO_SCENARIO_STUB_PORT/.test(missingStub.stderr),
        `expected the guard's own startup error, got: ${missingStub.stderr}`
      );
    });
  } finally {
    await catcher.close();
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`network-guard regression: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`failed checks: ${failures.join(', ')}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
