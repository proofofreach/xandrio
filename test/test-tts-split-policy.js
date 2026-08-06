const assert = require('assert');
const {
  LEGACY_SPLIT_POLICY,
  HYBRID_SPLIT_POLICY,
  normalizeSplitPolicy,
  splitPolicyVariantSuffix,
  planNarrationForPolicy
} = require('../lib/tts-split-policy');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

(async () => {
  await test('keeps legacy splitting as the default and preserves its cache namespace', () => {
    assert.strictEqual(normalizeSplitPolicy(), LEGACY_SPLIT_POLICY);
    assert.strictEqual(normalizeSplitPolicy('unknown'), LEGACY_SPLIT_POLICY);
    assert.strictEqual(splitPolicyVariantSuffix(LEGACY_SPLIT_POLICY), '');
  });

  await test('gives the opt-in hybrid policy an explicit cache identity', () => {
    assert.strictEqual(normalizeSplitPolicy(HYBRID_SPLIT_POLICY), HYBRID_SPLIT_POLICY);
    assert.strictEqual(splitPolicyVariantSuffix(HYBRID_SPLIT_POLICY), ':splithybrid1');
  });

  await test('scopes Kokoro cache identity only when the candidate is enabled', () => {
    const { getKokoroVariantKey } = require('../lib/kokoro-tuning');
    const previous = process.env.KOKORO_SPLIT_POLICY;
    try {
      delete process.env.KOKORO_SPLIT_POLICY;
      const control = getKokoroVariantKey('kokoro:af_heart');
      process.env.KOKORO_SPLIT_POLICY = HYBRID_SPLIT_POLICY;
      const candidate = getKokoroVariantKey('kokoro:af_heart');
      assert(!control.includes(':split'));
      assert(candidate.endsWith(':splithybrid1'));
      assert.notStrictEqual(candidate, control);
    } finally {
      if (previous === undefined) delete process.env.KOKORO_SPLIT_POLICY;
      else process.env.KOKORO_SPLIT_POLICY = previous;
    }
  });

  await test('keeps the first hybrid chunk short and uses larger bounded continuation chunks', () => {
    const paragraph = Array.from(
      { length: 48 },
      (_, index) => `Sentence ${index + 1} carries enough narration to exercise a natural boundary.`
    ).join(' ');
    const plan = planNarrationForPolicy(paragraph, {
      policy: HYBRID_SPLIT_POLICY,
      firstMaxChars: 420,
      targetChars: 750,
      maxChars: 900,
      minChars: 200
    });

    assert(plan.chunks.length >= 4);
    assert(plan.chunks[0].text.length <= 420);
    assert(plan.chunks.slice(1).every(chunk => chunk.text.length <= 900));
    assert(plan.chunks.slice(1, -1).every(chunk => chunk.text.length >= 200));
    assert(plan.chunks.slice(1).some(chunk => chunk.text.length > 420));
  });

  await test('retains heading and dialogue metadata through hybrid packing', () => {
    const text = [
      'CHAPTER ONE',
      '',
      '“Wait—do not go,” she said. The door closed behind him.',
      '',
      'The corridor was quiet. Another measured sentence followed.'
    ].join('\n');
    const plan = planNarrationForPolicy(text, {
      policy: HYBRID_SPLIT_POLICY,
      firstMaxChars: 120,
      targetChars: 180,
      maxChars: 220,
      minChars: 40
    });
    const segments = plan.chunks.flatMap(chunk => chunk.segments);

    assert(segments.some(segment => segment.kind === 'heading'));
    assert(segments.some(segment => segment.kind === 'dialogue'));
    assert(plan.chunks.map(chunk => chunk.text).join('\n\n').includes('Wait—do not go'));
  });

  console.log(`tts-split-policy tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
