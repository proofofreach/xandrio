const assert = require('assert');
const { startEventLoopMonitor } = require('../lib/event-loop-monitor');

function fakeHistogram(maxMs) {
  return {
    max: maxMs * 1e6,
    enabled: false,
    resets: 0,
    enable() { this.enabled = true; },
    disable() { this.enabled = false; },
    reset() { this.resets += 1; },
    percentile() { return maxMs * 1e6; }
  };
}

function run(maxMs) {
  const logs = [];
  let tick;
  const histogram = fakeHistogram(maxMs);
  const monitor = startEventLoopMonitor({
    log: message => logs.push(message),
    createHistogram: () => histogram,
    setIntervalFn: fn => { tick = fn; return null; },
    clearIntervalFn: () => {}
  });
  tick();
  monitor.stop();
  return { logs, histogram };
}

const blocked = run(11700);
assert.deepStrictEqual(blocked.logs, ['[event-loop] blocked up to 11700ms in the last 30s (p99 11700ms)']);
assert.strictEqual(blocked.histogram.resets, 1);
assert.strictEqual(blocked.histogram.enabled, false);

const healthy = run(40);
assert.deepStrictEqual(healthy.logs, []);
assert.strictEqual(healthy.histogram.resets, 1);

console.log('  ✓ event loop monitor reports only intervals that cross the threshold');
console.log('\n1 passed, 0 failed');
