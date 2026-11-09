const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { acquireInstanceLock, instanceLockPath } = require('../lib/instance-lock');

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

function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

const quiet = { warn() {}, error() {} };

(async () => {
  await test('takes the lock, records the owner, and releases only its own lock', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-instance-lock-'));
    try {
      const lock = await acquireInstanceLock({ dataDir, log: quiet });
      assert.equal(lock.path, instanceLockPath(dataDir));
      const owner = JSON.parse(fs.readFileSync(lock.path, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.match(owner.startedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(fs.readdirSync(path.dirname(lock.path)), ['server.lock'], 'no candidate temp is left behind');
      // A successor that stole a stale lock must not have its lock removed by us.
      fs.writeFileSync(lock.path, JSON.stringify({ pid: process.pid + 100000, startedAt: 'x' }));
      await lock.release();
      assert.equal(fs.existsSync(lock.path), true, 'release leaves a lock that is no longer ours');
      fs.writeFileSync(lock.path, JSON.stringify({ pid: process.pid, startedAt: 'x' }));
      const again = await acquireInstanceLock({ dataDir, log: quiet });
      await again.release();
      assert.equal(fs.existsSync(lock.path), false);
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  await test('steals a lock whose owner process is gone, or whose owner is unreadable', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-instance-lock-'));
    try {
      const lockPath = instanceLockPath(dataDir);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startedAt: '2026-01-01T00:00:00.000Z' }));
      const warnings = [];
      const lock = await acquireInstanceLock({ dataDir, waitMs: 500, log: { warn: message => warnings.push(message) } });
      assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
      assert.match(warnings[0], /stale instance lock/);
      await lock.release();

      fs.writeFileSync(lockPath, 'not json');
      const second = await acquireInstanceLock({ dataDir, waitMs: 500, log: quiet });
      assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
      await second.release();
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  await test('waits for a live owner to exit, then takes over', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-instance-lock-'));
    try {
      const lockPath = instanceLockPath(dataDir);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const livePid = process.ppid;
      fs.writeFileSync(lockPath, JSON.stringify({ pid: livePid, startedAt: '2026-01-01T00:00:00.000Z' }));
      // Simulate the previous server exiting part-way through our wait.
      setTimeout(() => fs.unlinkSync(lockPath), 150);
      const started = Date.now();
      const lock = await acquireInstanceLock({ dataDir, waitMs: 5000, pollMs: 20, log: quiet });
      assert.ok(Date.now() - started >= 100, 'did not take the lock before the owner exited');
      assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
      await lock.release();
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  await test('refuses to start while a live foreign owner keeps the lock', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-instance-lock-'));
    try {
      const lockPath = instanceLockPath(dataDir);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const owner = { pid: process.ppid, startedAt: '2026-01-01T00:00:00.000Z', hostname: 'other' };
      fs.writeFileSync(lockPath, JSON.stringify(owner));
      await assert.rejects(
        acquireInstanceLock({ dataDir, waitMs: 120, pollMs: 20, log: quiet }),
        error => error.code === 'INSTANCE_LOCK_HELD' && new RegExp(`PID ${owner.pid}`).test(error.message) &&
          /2026-01-01T00:00:00.000Z/.test(error.message)
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), owner, 'the live owner keeps its lock');
      assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), ['server.lock'], 'no candidate temp is left behind');
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  await test('a second process against the same DATA_DIR exits with a clear error', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-instance-lock-'));
    try {
      const lock = await acquireInstanceLock({ dataDir, log: quiet });
      const child = spawnSync(process.execPath, ['-e', `
        require(${JSON.stringify(require.resolve('../lib/instance-lock'))})
          .acquireInstanceLock({ dataDir: process.argv[1], waitMs: 100, pollMs: 20, log: { warn() {} } })
          .then(() => process.exit(0), error => { console.error(error.code + ' ' + error.message); process.exit(3); });
      `, dataDir], { encoding: 'utf8' });
      assert.equal(child.status, 3, child.stderr);
      assert.match(child.stderr, /INSTANCE_LOCK_HELD/);
      assert.match(child.stderr, /Only one server may use a DATA_DIR/);
      await lock.release();
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  console.log(`instance-lock tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
