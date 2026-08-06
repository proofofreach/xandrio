const assert = require('assert');
const {
  screenStrategies
} = require('../scripts/benchmark-kokoro-split-sweep');
const {
  firstMaxCharsForPolicy,
  isProductionHybridConfig
} = require('../scripts/benchmark-kokoro-split-ab');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function result(overrides = {}) {
  return {
    id: 'legacy-420',
    policy: 'legacy-v1',
    chunks: 5,
    synthesisMs: 1000,
    longestChunkMs: 300,
    currentAndNextMs: 500,
    acousticPass: true,
    ...overrides
  };
}

test('advances a materially faster low-latency candidate to blind review', () => {
  const results = [
    result(),
    result({
      id: 'continuation-550',
      policy: 'hybrid-v1',
      chunks: 4,
      synthesisMs: 970,
      longestChunkMs: 320,
      currentAndNextMs: 510
    })
  ];
  const decision = screenStrategies(results);
  assert.strictEqual(decision.selected, 'legacy-420');
  assert.strictEqual(decision.changed, false);
  assert.deepStrictEqual(decision.finalists, ['continuation-550']);
  assert.strictEqual(results[1].requestReductionPercent, 20);
});

test('keeps the current default when fewer requests worsen blocking latency', () => {
  const decision = screenStrategies([
    result(),
    result({
      id: 'continuation-750',
      policy: 'hybrid-v1',
      chunks: 3,
      synthesisMs: 900,
      longestChunkMs: 450,
      currentAndNextMs: 520
    })
  ]);
  assert.strictEqual(decision.selected, 'legacy-420');
  assert.strictEqual(decision.changed, false);
  assert.deepStrictEqual(decision.finalists, []);
});

test('requires a cache-keyed implementation for custom blind finalists', () => {
  assert.strictEqual(isProductionHybridConfig({
    targetChars: 750,
    maxChars: 900,
    minChars: 200
  }), true);
  assert.strictEqual(isProductionHybridConfig({
    targetChars: 475,
    maxChars: 525,
    minChars: 200
  }), false);
});

test('matches the production first-chunk clamp for non-default voices', () => {
  assert.strictEqual(firstMaxCharsForPolicy('legacy-v1', 460), 460);
  assert.strictEqual(firstMaxCharsForPolicy('hybrid-v1', 460), 420);
  assert.strictEqual(firstMaxCharsForPolicy('hybrid-v1', 400), 400);
});

if (!process.exitCode) {
  console.log(`kokoro-split-sweep tests: ${passed} passed, 0 failed`);
}
