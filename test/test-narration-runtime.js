const assert = require('assert');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function createRuntimeFixture(options = {}) {
  const { EventEmitter } = require('events');
  const { createNarrationRuntime } = require('../lib/narration-runtime');
  const alive = new Set(options.alive || []);
  const signals = [];
  const writes = [];
  const removals = [];
  const spawned = [];
  const timers = [];
  const logs = [];
  const commands = new Map(Object.entries(options.commands || {}).map(([pid, command]) => [Number(pid), command]));
  let persistedPid = options.persistedPid || null;

  const child = (pid = 9001) => {
    const value = new EventEmitter();
    value.pid = pid;
    value.stdout = new EventEmitter();
    value.stderr = new EventEmitter();
    value.kill = signal => signals.push({ pid, signal, via: 'child' });
    return value;
  };

  const runtime = createNarrationRuntime({
    rootDir: options.rootDir || '/tmp/xandrio-runtime-root',
    dataDir: '/tmp/xandrio-runtime-test',
    env: options.env || {},
    chatterboxVoiceDir: '/tmp/voices',
    process: {
      spawn: (engine, spec) => {
        const value = options.child || child(options.spawnPid || 9001);
        spawned.push({ engine, spec, child: value });
        alive.add(value.pid);
        return value;
      },
      exists: pid => alive.has(pid),
      kill: (pid, signal) => {
        signals.push({ pid, signal, via: 'process' });
        if (options.exitOnSignal !== false) alive.delete(pid);
      },
      command: pid => commands.get(pid) || '',
      findChatterbox: () => options.discovered || [],
      waitForExit: async (pid, timeoutMs) => options.waitForExit
        ? options.waitForExit(pid, timeoutMs, alive)
        : !alive.has(pid)
    },
    pidStore: {
      read: () => persistedPid,
      write: pid => { persistedPid = pid; writes.push(pid); },
      remove: expectedPid => {
        removals.push(expectedPid ?? null);
        if (expectedPid === undefined || expectedPid === null || persistedPid === expectedPid) persistedPid = null;
      }
    },
    timers: {
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeout: timer => { timer.cleared = true; }
    },
    health: {
      kokoro: async () => true,
      chatterbox: typeof options.chatterboxHealth === 'function'
        ? options.chatterboxHealth
        : async () => options.chatterboxHealth || { up: false }
    },
    shouldAutoStart: {
      kokoro: () => true,
      chatterbox: () => true
    },
    logger: {
      log: message => logs.push(String(message)),
      warn: message => logs.push(String(message)),
      error: message => logs.push(String(message))
    },
    output: { stdout: { write() {} }, stderr: { write() {} } }
  });

  return { runtime, alive, signals, writes, removals, spawned, timers, logs, get persistedPid() { return persistedPid; } };
}

async function run() {
  await test('adopts a healthy persisted Chatterbox PID and terminates duplicate managed processes', async () => {
    const fixture = createRuntimeFixture({
      persistedPid: 410,
      alive: [410, 411],
      commands: {
        410: 'xandrio-chatterbox:8767 python chatterbox-server.py',
        411: 'xandrio-chatterbox:8767 python chatterbox-server.py'
      },
      discovered: [
        { pid: 410, command: 'xandrio-chatterbox:8767 python chatterbox-server.py' },
        { pid: 411, command: 'xandrio-chatterbox:8767 python chatterbox-server.py' }
      ],
      chatterboxHealth: { up: true }
    });

    await fixture.runtime.start('chatterbox');

    assert.strictEqual(fixture.runtime.processHint('chatterbox'), true);
    assert.strictEqual(await fixture.runtime.health('chatterbox'), true);
    assert.deepStrictEqual(fixture.spawned, []);
    assert.deepStrictEqual(fixture.signals, [{ pid: 411, signal: 'SIGTERM', via: 'process' }]);
    assert.deepStrictEqual(fixture.writes, []);
  });

  await test('replaces an unhealthy managed Chatterbox process only after it exits', async () => {
    const fixture = createRuntimeFixture({
      persistedPid: 420,
      alive: [420],
      commands: { 420: 'xandrio-chatterbox:8767 python chatterbox-server.py' },
      discovered: [{ pid: 420, command: 'xandrio-chatterbox:8767 python chatterbox-server.py' }],
      chatterboxHealth: { up: false }
    });

    await fixture.runtime.start('chatterbox');

    assert.deepStrictEqual(fixture.signals, [{ pid: 420, signal: 'SIGTERM', via: 'process' }]);
    assert.strictEqual(fixture.spawned.length, 1);
    assert.deepStrictEqual(fixture.writes, [9001]);
    assert.strictEqual(fixture.runtime.processHint('chatterbox'), true);
  });

  await test('does not spawn a duplicate when an unhealthy managed PID survives SIGTERM and SIGKILL', async () => {
    const fixture = createRuntimeFixture({
      persistedPid: 430,
      alive: [430],
      commands: { 430: 'xandrio-chatterbox:8767 python chatterbox-server.py' },
      discovered: [{ pid: 430, command: 'xandrio-chatterbox:8767 python chatterbox-server.py' }],
      chatterboxHealth: { up: false },
      exitOnSignal: false
    });

    await fixture.runtime.start('chatterbox');

    assert.deepStrictEqual(fixture.signals, [
      { pid: 430, signal: 'SIGTERM', via: 'process' },
      { pid: 430, signal: 'SIGKILL', via: 'process' }
    ]);
    assert.strictEqual(fixture.spawned.length, 0);
    assert.strictEqual(fixture.persistedPid, 430);
    assert.strictEqual(fixture.runtime.processHint('chatterbox'), false);
  });

  await test('supervises an exited Chatterbox child with a queued exponential restart', async () => {
    const fixture = createRuntimeFixture({ chatterboxHealth: { up: false } });

    await fixture.runtime.start('chatterbox');
    const firstChild = fixture.spawned[0].child;
    firstChild.emit('exit', 1, null);

    assert.deepStrictEqual(fixture.removals, [9001]);
    assert.strictEqual(fixture.timers.length, 2);
    assert.strictEqual(fixture.timers[0].delay, 30000);
    assert.strictEqual(fixture.timers[1].delay, 1000);
    assert.strictEqual(fixture.runtime.processHint('chatterbox'), true);

    await fixture.timers[1].callback();
    assert.strictEqual(fixture.spawned.length, 2);
  });

  await test('stopping Chatterbox cancels supervision and terminates its owned child', async () => {
    const fixture = createRuntimeFixture({ chatterboxHealth: { up: false } });

    await fixture.runtime.start('chatterbox');
    fixture.runtime.stop('chatterbox');

    assert.deepStrictEqual(fixture.signals, [
      { pid: 9001, signal: 'SIGTERM', via: 'child' }
    ]);
    assert.strictEqual(fixture.timers[0].cleared, true);
    assert.deepStrictEqual(fixture.removals, [9001]);
    assert.strictEqual(fixture.runtime.processHint('chatterbox'), false);
  });

  await test('stopping an adopted Chatterbox PID uses the process fallback', async () => {
    const fixture = createRuntimeFixture({
      persistedPid: 440,
      alive: [440],
      commands: { 440: 'xandrio-chatterbox:8767 python chatterbox-server.py' },
      discovered: [{ pid: 440, command: 'xandrio-chatterbox:8767 python chatterbox-server.py' }],
      chatterboxHealth: { up: true }
    });

    await fixture.runtime.start('chatterbox');
    fixture.runtime.stop('chatterbox');

    assert.deepStrictEqual(fixture.signals, [
      { pid: 440, signal: 'SIGTERM', via: 'process' }
    ]);
    assert.deepStrictEqual(fixture.removals, [440]);
    assert.strictEqual(fixture.runtime.processHint('chatterbox'), false);
  });

  await test('stop cancels an in-flight Chatterbox start before its health check resolves', async () => {
    let resolveHealth;
    const delayedHealth = new Promise(resolve => { resolveHealth = resolve; });
    const fixture = createRuntimeFixture({ chatterboxHealth: () => delayedHealth });

    const starting = fixture.runtime.start('chatterbox');
    fixture.runtime.stop('chatterbox');
    assert.strictEqual(fixture.runtime.processHint('chatterbox'), false);

    resolveHealth({ up: false });
    await starting;

    assert.strictEqual(fixture.spawned.length, 0);
    assert.strictEqual(fixture.runtime.processHint('chatterbox'), false);

    await fixture.runtime.start('chatterbox');

    assert.strictEqual(fixture.spawned.length, 1);
    assert.strictEqual(fixture.runtime.processHint('chatterbox'), true);
  });

  await test('a new explicit Chatterbox start supersedes a cancelled in-flight start', async () => {
    let resolveHealth;
    const delayedHealth = new Promise(resolve => { resolveHealth = resolve; });
    const fixture = createRuntimeFixture({ chatterboxHealth: () => delayedHealth });

    const cancelledStart = fixture.runtime.start('chatterbox');
    fixture.runtime.stop('chatterbox');
    const restarted = fixture.runtime.start('chatterbox');

    resolveHealth({ up: false });
    await Promise.all([cancelledStart, restarted]);

    assert.strictEqual(fixture.spawned.length, 1);
    assert.strictEqual(fixture.runtime.processHint('chatterbox'), true);
  });

  await test('starts, reports, and stops Kokoro through the same lifecycle interface', async () => {
    const fixture = createRuntimeFixture();

    fixture.runtime.start('kokoro');

    assert.strictEqual(fixture.spawned.length, 1);
    assert.strictEqual(fixture.spawned[0].engine, 'kokoro');
    assert.strictEqual(fixture.runtime.processHint('kokoro'), true);
    assert.strictEqual(await fixture.runtime.health('kokoro'), true);

    fixture.runtime.stop('kokoro');
    assert.deepStrictEqual(fixture.signals, [{ pid: 9001, signal: 'SIGTERM', via: 'child' }]);
    assert.strictEqual(fixture.runtime.processHint('kokoro'), false);
  });

  await test('starts Chatterbox Multilingual V3 with its MPS server identity', async () => {
    const fixture = createRuntimeFixture({
      rootDir: '/tmp/xandrio-v3',
      env: { CHATTERBOX_ENGINE: 'v3', CHATTERBOX_PORT: '8767' },
      chatterboxHealth: { up: false }
    });

    await fixture.runtime.start('chatterbox');

    assert.strictEqual(fixture.spawned.length, 1);
    assert.strictEqual(fixture.spawned[0].spec.title, 'xandrio-chatterbox-v3:8767');
    assert.deepStrictEqual(fixture.spawned[0].spec.args, [
      '/tmp/xandrio-v3/m4-server/chatterbox-v3-server.py'
    ]);
    assert(fixture.logs.some(message => message.includes('Multilingual V3 PyTorch/MPS')));
  });

  await test('starts converted Chatterbox V3 with the MLX server identity', async () => {
    const fixture = createRuntimeFixture({
      rootDir: '/tmp/xandrio-v3-mlx',
      env: { CHATTERBOX_ENGINE: 'v3-mlx', CHATTERBOX_PORT: '8767' },
      chatterboxHealth: { up: false }
    });

    await fixture.runtime.start('chatterbox');

    assert.strictEqual(fixture.spawned.length, 1);
    assert.strictEqual(fixture.spawned[0].spec.title, 'xandrio-chatterbox-mlx:8767');
    assert.deepStrictEqual(fixture.spawned[0].spec.args, [
      '/tmp/xandrio-v3-mlx/m4-server/chatterbox-mlx-server.py'
    ]);
    assert(fixture.logs.some(message => message.includes('V3 MLX 8-bit (English)')));
  });

  console.log(`narration-runtime tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
