/**
 * Redacted operator diagnostics and route authorization tests.
 *
 * Run: node test/test-operator-diagnostics.js
 */

const assert = require('assert');
const express = require('express');
const fs = require('fs').promises;
const http = require('http');
const os = require('os');
const path = require('path');
const { createOperatorDiagnostics } = require('../lib/operator-diagnostics');
const { registerDiagnosticsRoutes } = require('../lib/routes/diagnostics-routes');
const { createAuthMiddleware, requireAdmin, SESSION_COOKIE } = require('../lib/auth');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ❌ ${name}: ${error.message}`);
  }
}

async function request(base, route, headers = {}) {
  const url = new URL(route, base);
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: JSON.parse(body)
        });
      });
    });
    req.on('error', reject);
  });
}

async function withServer(collectDiagnostics, fn) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { role: req.headers['x-test-role'] || 'member' };
    next();
  });
  registerDiagnosticsRoutes(app, {
    collectDiagnostics,
    requireAdmin: (req, res, next) => (
      req.user.role === 'admin'
        ? next()
        : res.status(403).json({ error: 'Admin access required' })
    )
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function withAuthServer(authOptions, fn) {
  const app = express();
  app.use(createAuthMiddleware(authOptions));
  registerDiagnosticsRoutes(app, {
    collectDiagnostics: async () => ({ status: 'ok', issues: [] }),
    requireAdmin
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  console.log('\n━━━ Operator diagnostics ━━━');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-diagnostics-'));
  const dataDir = path.join(root, 'private-data');
  const cacheDir = path.join(root, 'private-cache');
  await fs.mkdir(dataDir);
  await fs.mkdir(cacheDir);
  await fs.writeFile(path.join(dataDir, 'books.json.corrupt-deadbeef'), '{"secret":"library title"}');
  await fs.writeFile(path.join(dataDir, 'ignore.corrupt-not-a-hash'), 'ignored');

  try {
    await check('collects fixed-schema state and counts quarantines without contents', async () => {
      const collect = createOperatorDiagnostics({
        dataDir,
        cacheDir,
        getQueueStatus: () => ({
          active: 2,
          queued: 3,
          completed: 4,
          byPriority: { immediate: 1, lookahead: 2, 'private-priority': 99 },
          byOrigin: { 'offline-download': 2, 'playback-lookahead': 1, 'private-origin': 99 },
          artifacts: { hits: 12, misses: 3, published: 8, bytesAvoided: 4567, path: '/private/cache' },
          oldestQueuedAgeMs: 12_345,
          title: 'Private Book Title',
          username: 'private-user',
          token: 'private-token'
        }),
        getEngineStatus: async () => ({
          engines: {
            edge: { up: true, token: 'engine-token' },
            kokoro: {
              up: true,
              device: '/private/device',
              voices: ['Custom Voice Name'],
              providerKey: 'provider-secret'
            },
            chatterbox: {
              up: false,
              status: 'starting',
              process: true,
              error: 'connect to /private/socket with secret'
            }
          }
        }),
        filesystem: {
          statfs: async () => ({ bsize: 4096, bavail: 10, blocks: 100 })
        },
        now: () => new Date('2026-07-24T12:00:00.000Z'),
        uptime: () => 42.4
      });
      const report = await collect();
      assert.strictEqual(report.quarantinedStoreCount, 1);
      assert.deepStrictEqual(report.queue, {
        active: 2,
        queued: 3,
        completed: 4,
        byPriority: { immediate: 1, lookahead: 2 },
        byOrigin: { 'offline-download': 2, 'playback-lookahead': 1 },
        artifacts: { hits: 12, misses: 3, published: 8, bytesAvoided: 4567 },
        oldestQueuedAgeMs: 12_345
      });
      assert.deepStrictEqual(report.engines.kokoro, {
        available: true,
        status: 'online',
        managedProcess: false
      });
      assert.strictEqual(report.engines.chatterbox.status, 'starting');
      assert.strictEqual(report.storage.cache.space.status, 'warning');
      assert.strictEqual(report.uptimeSeconds, 42);
      assert(report.issues.every(issue => typeof issue.action === 'string' && issue.action.length > 0));
      assert(report.issues.some(issue => issue.documentation === 'docs/JSON_STORE_RECOVERY.md'));

      const serialized = JSON.stringify(report);
      for (const forbidden of [
        'Private Book Title',
        'private-user',
        'private-token',
        'engine-token',
        '/private/device',
        'Custom Voice Name',
        'provider-secret',
        '/private/socket',
        dataDir,
        cacheDir,
        'library title'
      ]) {
        assert(!serialized.includes(forbidden), `report leaked ${forbidden}`);
      }
    });

    await check('refresh option reaches the existing engine status seam', async () => {
      let refresh = null;
      const collect = createOperatorDiagnostics({
        dataDir,
        cacheDir,
        getQueueStatus: () => ({}),
        getEngineStatus: async options => {
          refresh = options.refresh;
          return { engines: { edge: { up: true } } };
        }
      });
      await collect({ refreshEngines: true });
      assert.strictEqual(refresh, true);
    });

    await check('admin route rejects members and serves redacted reports without caching', async () => {
      let refreshEngines = false;
      await withServer(async options => {
        refreshEngines = options.refreshEngines;
        return { status: 'ok', issues: [] };
      }, async base => {
        const member = await request(base, '/api/admin/diagnostics', { 'x-test-role': 'member' });
        assert.strictEqual(member.status, 403);

        const admin = await request(base, '/api/admin/diagnostics?refresh=1', { 'x-test-role': 'admin' });
        assert.strictEqual(admin.status, 200);
        assert.strictEqual(admin.body.status, 'ok');
        assert.match(admin.headers['cache-control'], /no-store/);
        assert.strictEqual(refreshEngines, true);
      });
    });

    await check('actual auth middleware permits trusted-LAN operators and rejects account members', async () => {
      await withAuthServer({
        token: null,
        accounts: { count: async () => 0 },
        sessionStore: null
      }, async base => {
        const trustedLan = await request(base, '/api/admin/diagnostics');
        assert.strictEqual(trustedLan.status, 200);
      });

      const accounts = {
        count: async () => 2,
        findById: async id => ({
          id,
          username: 'redacted-test-user',
          displayName: 'Redacted Test User',
          role: id
        })
      };
      const sessionStore = {
        ttlMs: 30 * 24 * 60 * 60 * 1000,
        resolve: async token => ({
          userId: token,
          expiresAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000
        })
      };
      await withAuthServer({ token: null, accounts, sessionStore }, async base => {
        const member = await request(base, '/api/admin/diagnostics', {
          cookie: `${SESSION_COOKIE}=member`
        });
        assert.strictEqual(member.status, 403);

        const admin = await request(base, '/api/admin/diagnostics', {
          cookie: `${SESSION_COOKIE}=admin`
        });
        assert.strictEqual(admin.status, 200);
      });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
