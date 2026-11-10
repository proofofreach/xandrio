// Startup guards of server.js itself: the DATA_DIR instance lock, the data
// format version, the production trusted-LAN refusal, and /ready.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

let passed = 0;
let failed = 0;

async function test(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startServer({ dataDir, cacheDir, port, env = {} }) {
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      CACHE_DIR: cacheDir,
      XANDRIO_TOKEN: 'startup-guard-token',
      XANDRIO_PREGENERATE_ON_IMPORT: 'false',
      KOKORO_AUTO_START: 'false',
      CHATTERBOX_AUTO_START: 'false',
      NODE_ENV: 'test',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => output };
}

async function waitForHealth(origin, output, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become healthy:\n${output()}`);
}

async function stop(instance) {
  if (instance.child.exitCode === null && instance.child.signalCode === null) instance.child.kill('SIGTERM');
  const result = await Promise.race([
    instance.exited,
    new Promise(resolve => setTimeout(() => resolve(null), 20000))
  ]);
  if (!result) {
    instance.child.kill('SIGKILL');
    await instance.exited;
  }
  return result;
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-startup-guards-'));
  const dataDir = path.join(root, 'data');
  const cacheDir = path.join(root, 'cache');
  await fsp.mkdir(dataDir);
  await fsp.mkdir(cacheDir);
  const lockPath = path.join(dataDir, 'runtime', 'server.lock');

  try {
    await test('a running server holds the instance lock, writes format-version, and refuses a second instance', async () => {
      const port = await availablePort();
      const first = startServer({ dataDir, cacheDir, port });
      try {
        await waitForHealth(`http://127.0.0.1:${port}`, first.output);
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.equal(owner.pid, first.child.pid);
        assert.equal(fs.readFileSync(path.join(dataDir, 'format-version'), 'utf8').trim(), '1');
        const ready = await fetch(`http://127.0.0.1:${port}/ready`);
        assert.equal(ready.status, 200, await ready.text());

        const second = startServer({ dataDir, cacheDir, port: await availablePort(), env: { XANDRIO_INSTANCE_LOCK_WAIT_MS: '500' } });
        const exit = await Promise.race([second.exited, new Promise(resolve => setTimeout(() => resolve(null), 40000))]);
        if (!exit) { second.child.kill('SIGKILL'); await second.exited; }
        assert.ok(exit && exit.code === 1, `second instance must exit 1, got ${JSON.stringify(exit)}\n${second.output()}`);
        assert.match(second.output(), /Another Xandrio server holds .*server\.lock \(PID \d+/);
        assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, first.child.pid, 'the running server keeps its lock');
      } finally {
        const exit = await stop(first);
        assert.ok(exit, 'first server exits on SIGTERM');
      }
      assert.equal(fs.existsSync(lockPath), false, 'shutdown releases the lock');
    });

    await test('a restart takes over the lock after the previous process exits', async () => {
      const port = await availablePort();
      const again = startServer({ dataDir, cacheDir, port });
      try {
        await waitForHealth(`http://127.0.0.1:${port}`, again.output);
        assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, again.child.pid);
      } finally {
        await stop(again);
      }
    });

    await test('a data directory written by a newer release refuses to start', async () => {
      await fsp.writeFile(path.join(dataDir, 'format-version'), '999\n');
      try {
        const instance = startServer({ dataDir, cacheDir, port: await availablePort() });
        const exit = await instance.exited;
        assert.equal(exit.code, 1, instance.output());
        assert.match(instance.output(), /format version 999, but this release supports up to 1/);
        assert.equal(fs.existsSync(lockPath), false, 'the lock is released on the failed start');
      } finally {
        await fsp.writeFile(path.join(dataDir, 'format-version'), '1\n');
      }
    });

    await test('production with no token and no accounts refuses trusted-LAN mode unless opted in', async () => {
      const refused = startServer({ dataDir, cacheDir, port: await availablePort(), env: { XANDRIO_TOKEN: '', NODE_ENV: 'production' } });
      const exit = await refused.exited;
      assert.equal(exit.code, 1, refused.output());
      assert.match(refused.output(), /trusted-LAN mode is disabled for production deployments/);

      const port = await availablePort();
      const allowed = startServer({ dataDir, cacheDir, port, env: { XANDRIO_TOKEN: '', NODE_ENV: 'production', XANDRIO_ALLOW_TRUSTED_LAN: '1' } });
      try {
        await waitForHealth(`http://127.0.0.1:${port}`, allowed.output);
        const status = await (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).json();
        assert.equal(status.authenticationRequired, false, 'the opt-in restores trusted-LAN mode');
      } finally {
        await stop(allowed);
      }
    });

    await test('user data stores fail closed: legacy files load, corrupt or missing-after-init ones are never reset', async () => {
      const userDataDir = path.join(root, 'user-data');
      await fsp.mkdir(userDataDir);
      await fsp.writeFile(path.join(userDataDir, 'format-version'), '1\n');
      const file = name => path.join(userDataDir, name);
      // An existing install from before the markers: legacy single-user
      // positions, plus a guide journal with one malformed entry.
      await fsp.writeFile(file('positions.json'), JSON.stringify({ 'book-1': { chapterIndex: 2, position: 41 } }));
      await fsp.writeFile(file('shelves.json'), JSON.stringify({ users: { default: { books: { 'book-1': { addedAt: 1 } } } } }));
      await fsp.writeFile(file('book-guide-jobs.json'), JSON.stringify({
        version: 1,
        jobs: { broken: { status: 'running' }, ok: { id: 'ok', bookId: 'book-1', status: 'failed' } }
      }));

      let port = await availablePort();
      let instance = startServer({ dataDir: userDataDir, cacheDir, port });
      try {
        await waitForHealth(`http://127.0.0.1:${port}`, instance.output);
        const ready = await fetch(`http://127.0.0.1:${port}/ready`);
        assert.equal(ready.status, 200, await ready.text());
        const positions = await fetch(`http://127.0.0.1:${port}/api/positions`, { headers: { authorization: 'Bearer startup-guard-token' } });
        assert.equal(positions.status, 200, await positions.text());
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(file('shelves.json.initialized')) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(fs.existsSync(file('positions.json.initialized')), 'first clean read backfills the positions marker');
        assert.ok(fs.existsSync(file('shelves.json.initialized')), 'startup primes markers for unread stores');
      } finally {
        await stop(instance);
      }

      const corrupt = '{"users": {"default": {"book-1": ';
      await fsp.writeFile(file('positions.json'), corrupt);
      await fsp.rm(file('shelves.json'));
      port = await availablePort();
      instance = startServer({ dataDir: userDataDir, cacheDir, port });
      try {
        await waitForHealth(`http://127.0.0.1:${port}`, instance.output);
        const ready = await fetch(`http://127.0.0.1:${port}/ready`);
        assert.equal(ready.status, 503, await ready.text());
        const positions = await fetch(`http://127.0.0.1:${port}/api/positions`, { headers: { authorization: 'Bearer startup-guard-token' } });
        assert.ok(positions.status >= 500, `corrupt positions must not read as empty (got ${positions.status})`);
        const batch = await fetch(`http://127.0.0.1:${port}/api/positions/batch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer startup-guard-token' },
          body: JSON.stringify({ positions: { 'book-1': { chapterIndex: 0, position: 1 } } })
        });
        assert.ok(batch.status >= 400, `a write must not replace corrupt positions (got ${batch.status})`);
        assert.equal(fs.readFileSync(file('positions.json'), 'utf8'), corrupt, 'corrupt bytes are left for recovery');
        assert.equal(fs.existsSync(file('shelves.json')), false, 'a missing initialized store is not recreated empty');
      } finally {
        await stop(instance);
      }
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }

  console.log(`server startup tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
