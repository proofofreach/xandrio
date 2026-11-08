const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  createLaunchAgentPlist,
  createRuntimeSupervisor,
  runtimeRevision,
  runtimeSignature
} = require('../lib/local-service-runtime');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error.stack || error);
    failed++;
  }
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-local-service-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'public'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'server.js'), 'console.log("server v1");\n');
  fs.writeFileSync(path.join(root, 'lib', 'feature.js'), 'module.exports = "v1";\n');
  fs.writeFileSync(path.join(root, 'public', 'app.js'), 'console.log("ui v1");\n');
  fs.writeFileSync(path.join(root, 'data', 'books.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  return root;
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => {
    child.signalCode = signal;
    setImmediate(() => {
      child.exitCode = 0;
      child.emit('exit', 0, signal);
    });
    return true;
  };
  return child;
}

(async () => {
  console.log('\nLocal Service Runtime');

  await test('fingerprints backend runtime inputs and ignores live static/data files', () => {
    const root = fixtureRoot();
    const initial = runtimeSignature(root);
    const initialRevision = runtimeRevision(root);

    fs.writeFileSync(path.join(root, 'public', 'app.js'), 'console.log("ui v2");\n');
    fs.writeFileSync(path.join(root, 'data', 'books.json'), '{"changed":true}\n');
    assert.strictEqual(runtimeSignature(root), initial);
    assert.strictEqual(runtimeRevision(root), initialRevision);

    fs.writeFileSync(path.join(root, 'lib', 'feature.js'), 'module.exports = "v2";\n');
    assert.notStrictEqual(runtimeSignature(root), initial);
    assert.notStrictEqual(runtimeRevision(root), initialRevision);
  });

  await test('restarts the child once after a backend change becomes stable', async () => {
    const root = fixtureRoot();
    const children = [];
    let now = 1_000;
    const supervisor = createRuntimeSupervisor({
      root,
      stableMs: 500,
      now: () => now,
      spawnChild: ({ revision }) => {
        const child = fakeChild();
        child.revision = revision;
        children.push(child);
        return child;
      },
      log: () => {}
    });

    supervisor.start({ schedule: false });
    assert.strictEqual(children.length, 1);

    fs.writeFileSync(path.join(root, 'lib', 'feature.js'), 'module.exports = "v2";\n');
    await supervisor.checkNow();
    assert.strictEqual(children.length, 1, 'change must settle before restart');

    now += 500;
    await supervisor.checkNow();
    assert.strictEqual(children.length, 2);
    assert.notStrictEqual(children[0].revision, children[1].revision);

    await supervisor.checkNow();
    assert.strictEqual(children.length, 2, 'stable runtime must not restart repeatedly');
    await supervisor.stop();
  });

  await test('relaunches only after the old server has exited, even when it needs SIGKILL', async () => {
    const root = fixtureRoot();
    const children = [];
    const events = [];
    let now = 1_000;
    const supervisor = createRuntimeSupervisor({
      root,
      stableMs: 0,
      stopTimeoutMs: 20,
      now: () => now,
      spawnChild: () => {
        const child = new EventEmitter();
        child.exitCode = null;
        child.signalCode = null;
        // A draining server ignores SIGTERM past the timeout; the process
        // (and its listening socket) goes away a moment after SIGKILL.
        child.kill = signal => {
          events.push(`kill:${signal}`);
          if (signal === 'SIGKILL') {
            setTimeout(() => {
              child.signalCode = signal;
              events.push('exit');
              child.emit('exit', null, signal);
            }, 30);
          }
          return true;
        };
        children.push(child);
        events.push(`launch:${children.length}`);
        return child;
      },
      log: () => {}
    });

    supervisor.start({ schedule: false });
    fs.writeFileSync(path.join(root, 'lib', 'feature.js'), 'module.exports = "v2";\n');
    await supervisor.checkNow();
    now += 1;
    await supervisor.checkNow();
    assert.deepStrictEqual(events, ['launch:1', 'kill:SIGTERM', 'kill:SIGKILL', 'exit', 'launch:2']);
    children[1].kill = () => {
      setImmediate(() => { children[1].exitCode = 0; children[1].emit('exit', 0, null); });
      return true;
    };
    await supervisor.stop();
  });

  await test('default stop timeout outlasts the server shutdown drain', () => {
    const { DEFAULT_STOP_TIMEOUT_MS } = require('../lib/local-service-runtime');
    const { DEFAULT_SHUTDOWN_TIMEOUT_MS } = require('../lib/graceful-shutdown');
    assert.ok(Number.isFinite(DEFAULT_SHUTDOWN_TIMEOUT_MS), 'shutdown drain deadline is exported');
    assert.ok(DEFAULT_STOP_TIMEOUT_MS > DEFAULT_SHUTDOWN_TIMEOUT_MS,
      `stop timeout ${DEFAULT_STOP_TIMEOUT_MS} must exceed the ${DEFAULT_SHUTDOWN_TIMEOUT_MS} ms drain`);
  });

  await test('launch agent always starts the tracked supervisor from this checkout', () => {
    const plist = createLaunchAgentPlist({
      label: 'com.xandrio.server',
      nodePath: '/opt/homebrew/bin/node',
      root: '/Users/example/Xandrio & Books'
    });
    assert(plist.includes('/Users/example/Xandrio &amp; Books/scripts/local-service.js'));
    assert(plist.includes('<key>KeepAlive</key>'));
    // launchd must not SIGKILL the supervisor while it waits for the server.
    assert(plist.includes('<key>ExitTimeOut</key>\n  <integer>30</integer>'));
    assert(!plist.includes('<string>server.js</string>'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
