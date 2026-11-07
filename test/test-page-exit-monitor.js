const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { normalizeReport } = require('../lib/playback-health');

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

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
}

function fakeTarget() {
  const listeners = {};
  return {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: type => (listeners[type] || []).forEach(fn => fn())
  };
}

(async () => {
  const { classifyPreviousExit, startPageExitMonitor } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'page-exit-monitor.mjs')).href
  );
  const now = 1_000_000;

  await test('a recent foreground heartbeat that never ended is a crash', () => {
    assert.strictEqual(classifyPreviousExit({ beatAt: now - 4000, visible: true }, now), 'page-crash');
    assert.strictEqual(
      classifyPreviousExit({ beatAt: now - 4000, visible: true, offlineWork: true }, now),
      'page-crash-offline-work'
    );
  });

  await test('a clean exit, an old heartbeat or a suspended page is not a crash', () => {
    assert.strictEqual(classifyPreviousExit({ beatAt: now - 4000, visible: true, ended: true }, now), null);
    assert.strictEqual(classifyPreviousExit({ beatAt: now - 10 * 60 * 1000, visible: true }, now), null);
    assert.strictEqual(classifyPreviousExit({ beatAt: now - 4000, visible: false, playing: false }, now), null);
    assert.strictEqual(classifyPreviousExit(null, now), null);
    assert.strictEqual(classifyPreviousExit({ beatAt: now + 5000, visible: true }, now), null);
  });

  await test('a background page killed while playing is reported separately', () => {
    assert.strictEqual(classifyPreviousExit({ beatAt: now - 20000, visible: false, playing: true }, now), 'page-killed-playing');
    assert.strictEqual(classifyPreviousExit({ beatAt: now - 5 * 60 * 1000, visible: false, playing: true }, now), null);
  });

  await test('pagehide marks the session ended so the next launch reports nothing', () => {
    const storage = memoryStorage();
    const target = fakeTarget();
    const reports = [];
    let clock = now;
    startPageExitMonitor({ storage, target, now: () => clock, isVisible: () => true, report: r => reports.push(r), setIntervalFn: () => {} });
    target.fire('pagehide');
    clock += 3000;
    startPageExitMonitor({ storage, target: fakeTarget(), now: () => clock, isVisible: () => true, report: r => reports.push(r), setIntervalFn: () => {} });
    assert.deepStrictEqual(reports, []);
  });

  await test('a session that dies without pagehide is reported once on the next launch', () => {
    const storage = memoryStorage();
    const reports = [];
    let clock = now;
    startPageExitMonitor({ storage, target: fakeTarget(), now: () => clock, isVisible: () => true, offlineWork: () => true, report: r => reports.push(r), setIntervalFn: () => {} });
    clock += 6000;
    startPageExitMonitor({ storage, target: fakeTarget(), now: () => clock, isVisible: () => true, report: r => reports.push(r), setIntervalFn: () => {} });
    clock += 1000;
    const third = fakeTarget();
    startPageExitMonitor({ storage, target: third, now: () => clock, isVisible: () => true, report: r => reports.push(r), setIntervalFn: () => {} });
    // The second launch also died; each death is counted once.
    assert.deepStrictEqual(reports, ['page-crash-offline-work', 'page-crash']);
  });

  await test('the server keeps the exit counts', () => {
    for (const type of ['page-crash', 'page-crash-offline-work', 'page-killed-playing', 'page-killed-playing-offline-work']) {
      const report = normalizeReport({ v: 1, platform: 'ios', standalone: true, errors: { [type]: 1 } });
      assert.deepStrictEqual(report.errors, { [type]: 1 });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
