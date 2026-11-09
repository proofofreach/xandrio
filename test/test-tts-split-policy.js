const assert = require('assert');
const {
  LEGACY_SPLIT_POLICY,
  HYBRID_SPLIT_POLICY,
  RAMP_SPLIT_POLICY,
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

  function rampChapter() {
    return Array.from({ length: 30 }, (_, paragraph) => Array.from(
      { length: 6 },
      (_, index) => `Paragraph ${paragraph + 1} sentence ${index + 1} walks the long road home${index % 2 ? ', pausing at the river' : ''}.`
    ).join(' ')).join('\n\n');
  }

  await test('ramp policy has its own cache identity', () => {
    assert.strictEqual(normalizeSplitPolicy(RAMP_SPLIT_POLICY), RAMP_SPLIT_POLICY);
    assert.strictEqual(splitPolicyVariantSuffix(RAMP_SPLIT_POLICY), ':splitramp1');
  });

  await test('ramp starts with a short sentence-bounded chunk and doubles to the legacy size', () => {
    const text = rampChapter();
    const plan = planNarrationForPolicy(text, { policy: RAMP_SPLIT_POLICY, firstMaxChars: 400, maxChars: 4000 });
    const lengths = plan.chunks.map(chunk => chunk.text.length);
    assert(lengths[0] <= 400 && lengths[0] >= 200, lengths.join(','));
    assert(/[.!?]$/.test(plan.chunks[0].text), 'the first chunk ends on a sentence boundary');
    for (let index = 0; index < lengths.length; index++) {
      assert(lengths[index] <= Math.min(4000, 400 * 2 ** index), `chunk ${index} exceeds its ramp limit: ${lengths.join(',')}`);
    }
    assert(lengths.slice(4, -1).every(length => length > 3000), `continuation chunks stay legacy-sized: ${lengths.join(',')}`);
    const legacy = planNarrationForPolicy(text, { policy: LEGACY_SPLIT_POLICY, maxChars: 4000 });
    const words = chunks => chunks.map(chunk => chunk.text).join(' ').split(/\s+/).join(' ');
    assert.strictEqual(words(plan.chunks), words(legacy.chunks), 'ramp preserves every word in order');
    assert(plan.chunks.length <= legacy.chunks.length + 4, 'the ramp adds only a few requests per chapter');
  });

  await test('ramp splits only a sentence that cannot fit the chunk it opens', () => {
    const longSentence = `${'The procession wound on, and on, through the square, '.repeat(14)}until dusk.`;
    const text = `CHAPTER ONE\n\n${longSentence} A short sentence follows.`;
    const plan = planNarrationForPolicy(text, { policy: RAMP_SPLIT_POLICY, firstMaxChars: 400, maxChars: 4000 });
    // The lone heading must not consume the short first slot by itself.
    assert(/^chapter one/i.test(plan.chunks[0].text), plan.chunks[0].text);
    assert(plan.chunks[0].text.length <= 400, `first chunk is ${plan.chunks[0].text.length}`);
    assert(plan.chunks[0].text.length > 100, 'the first chunk carries narration, not just the heading');
    const lastSegment = plan.chunks[0].segments.at(-1);
    assert.strictEqual(lastSegment.pauseIntent, 'sentence', 'a mid-sentence boundary gets no paragraph pause');
    assert.strictEqual(lastSegment.paragraphFinal, false);
    assert.strictEqual(plan.chunks.at(-1).segments.at(-1).paragraphFinal, true);
  });

  await test('Edge uses the ramp by default and EDGE_SPLIT_POLICY restores legacy identity', () => {
    const { createEngineAdapterRegistry } = require('../lib/tts-engine-adapters');
    const previous = process.env.EDGE_SPLIT_POLICY;
    try {
      delete process.env.EDGE_SPLIT_POLICY;
      const edge = createEngineAdapterRegistry({ defaultChunkSize: 4000 }).resolve('en-US-AndrewMultilingualNeural');
      assert.strictEqual(edge.splitPolicy('en-US-AndrewMultilingualNeural'), RAMP_SPLIT_POLICY);
      const ramp = edge.variantKey('en-US-AndrewMultilingualNeural');
      assert(ramp.endsWith(':splitramp1'), ramp);
      process.env.EDGE_SPLIT_POLICY = LEGACY_SPLIT_POLICY;
      assert.strictEqual(edge.splitPolicy('en-US-AndrewMultilingualNeural'), LEGACY_SPLIT_POLICY);
      const legacy = edge.variantKey('en-US-AndrewMultilingualNeural');
      assert.strictEqual(`${legacy}:splitramp1`, ramp, 'legacy keeps the pre-ramp cache namespace');
    } finally {
      if (previous === undefined) delete process.env.EDGE_SPLIT_POLICY;
      else process.env.EDGE_SPLIT_POLICY = previous;
    }
  });

  await test('ChunkedTTS applies the ramp with the active chunk size and recovers it from variant keys', async () => {
    const ChunkedTTS = require('../lib/chunked-tts');
    const tts = new ChunkedTTS(require('os').tmpdir(), null, {
      splitPolicyProvider: () => RAMP_SPLIT_POLICY,
      chunkSizeProvider: () => 4000
    });
    const chunks = tts.splitIntoChunksWithMeta(rampChapter(), 4000);
    assert(chunks[0].text.length <= 400);
    assert(chunks.some(chunk => chunk.text.length > 3000), 'continuations are not capped at the hybrid 900');
    const worker = tts._recoveryWorker({ variantKey: 'en-US-AndrewMultilingualNeural:chunk4000:outmp3:splitramp1' });
    assert.strictEqual(worker.getActiveSplitPolicy(), RAMP_SPLIT_POLICY);
  });

  // A symbol run glued to prose, as converted tables and ornaments leave it.
  function symbolHeavyChapter(fillerWords, symbolChars) {
    const filler = 'walked home slowly through the cold rain that evening and then sat down by the fire to rest for a while before supper'
      .split(' ').slice(0, fillerWords).join(' ');
    const symbols = '§ ¶ † ‡ * • ~ = + # @ % & | ^ < > { } [ ] '.repeat(40).slice(0, symbolChars);
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
    const sentences = names.map(name => `${name} ${filler}.`);
    return { names, text: [...sentences.slice(0, 3), symbols, ...sentences.slice(3)].join(' ') };
  }

  const PLAN_BOUNDS = [[LEGACY_SPLIT_POLICY, 280, 280], [RAMP_SPLIT_POLICY, 280, 280], [HYBRID_SPLIT_POLICY, 280, 900]];

  await test('narrates every speakable sentence when symbol runs are coalesced away', () => {
    const { planSplitChunks } = require('../lib/chunk-planner');
    for (const fillerWords of [7, 10, 20]) {
      for (const symbolChars of [200, 263, 357, 431]) {
        const { names, text } = symbolHeavyChapter(fillerWords, symbolChars);
        for (const [policy, maxChars] of PLAN_BOUNDS) {
          const spoken = planSplitChunks(text, maxChars, policy).map(chunk => chunk.text).join(' ');
          const missing = names.filter(name => !spoken.includes(`${name} walked`));
          assert.deepStrictEqual(missing, [], `${policy} at ${maxChars}, ${fillerWords} words, ${symbolChars} symbols`);
        }
      }
    }
  });

  await test('never plans a chunk above the policy bound or without speakable text', () => {
    const { planSplitChunks } = require('../lib/chunk-planner');
    const { isSpeakableText } = require('../lib/tts-text');
    const texts = [
      ...[7, 10, 20].flatMap(words => [200, 357, 431].map(chars => symbolHeavyChapter(words, chars).text)),
      // A heading that opens a full chunk cannot be merged into it whole.
      `Prologue\n\n${'The rain kept falling over the quiet harbour town. '.repeat(5).trim()}`
    ];
    for (const text of texts) {
      for (const [policy, maxChars, bound] of PLAN_BOUNDS) {
        for (const chunk of planSplitChunks(text, maxChars, policy)) {
          assert(chunk.text.length <= bound, `${policy} planned ${chunk.text.length} > ${bound}`);
          assert(isSpeakableText(chunk.text), `${policy} planned an unspeakable chunk: ${chunk.text.slice(0, 60)}`);
        }
      }
    }
  });

  await test('keeps a short section number that precedes a full chunk', () => {
    const { planSplitChunks } = require('../lib/chunk-planner');
    // One sentence just under the bound, so "5." cannot join it whole.
    const sentence = `That this chaos is hard to conceive, ${'and the mind turns over every form it knows, '.repeat(9)}until it rests.`;
    for (const text of [`5.\n\n${sentence}`, `The first part ends here, quietly and briefly.\n\n5.\n\n${sentence}`]) {
      for (const [policy, maxChars, bound] of PLAN_BOUNDS) {
        const chunks = planSplitChunks(text, sentence.length + 1, policy);
        const limit = Math.max(bound, sentence.length + 1);
        assert(chunks.every(chunk => chunk.text.length <= limit), `${policy}: ${chunks.map(chunk => chunk.text.length)} > ${limit}`);
        const spoken = chunks.map(chunk => chunk.text).join(' ').replace(/\s+/g, ' ');
        assert(spoken.includes('5. That this chaos') || /5\.$/.test(chunks[0].text), `${policy} keeps the section number: ${spoken.slice(0, 80)}`);
        assert(spoken.includes('until it rests.'), `${policy} keeps the whole sentence`);
      }
    }
  });

  console.log(`tts-split-policy tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
