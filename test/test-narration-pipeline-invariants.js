/**
 * Narration pipeline invariants: one book language for every engine, heading
 * detection on authored capitals, chunk plans inside the engine's text
 * bounds, and pronunciation rules that match the text a reader sees.
 */

const assert = require('assert');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const { normalizeLanguageCode } = require('../lib/book-language');
const { createBooksStore } = require('../lib/books-store');
const jsonStore = require('../lib/json-store');
const TTSQueue = require('../lib/tts-queue');
const {
  ENGINE_DEFINITIONS,
  adaptNarrationForEngine,
  chatterboxLanguage,
  createEngineAdapterRegistry,
  engineTextLimitsForVoice,
  kokoroLanguage
} = require('../lib/tts-engine-adapters');
const { narrationRenderRecipe } = require('../lib/narration-render-recipe');
const { buildNarrationPieces, isSpeakableText, prepareTtsText } = require('../lib/tts-text');
const { planSplitChunks } = require('../lib/chunk-planner');
const ChunkedTTS = require('../lib/chunked-tts');
const { applyPronunciationRules } = require('../lib/pronunciation-repair');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  const restore = () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

const AVA = 'en-US-AvaMultilingualNeural';
const ENGLISH_SPELLINGS = ['en', 'en-US', 'en-us', 'en-GB', 'en_GB', 'EN', 'eng', 'English', '[eng] English'];

function adapterFor(voice) {
  return createEngineAdapterRegistry({}).resolve(voice);
}

function recipeFor(voice, language) {
  return narrationRenderRecipe({
    adapter: adapterFor(voice),
    text: 'The house stood at the end of a long and quiet road.',
    outputPath: '/tmp/narration-invariants/chunk.mp3',
    language,
    voice
  });
}

function corpus() {
  const paragraphs = [];
  for (let index = 0; index < 18; index++) {
    paragraphs.push(index % 6 === 0 ? `CHAPTER ${index + 1}` : '');
    paragraphs.push('“No.”');
    paragraphs.push(`${'She walked along the shore and counted the boats that came in with the tide. '.repeat(1 + (index % 5))}`.trim());
    paragraphs.push('“Where were you?” he asked, and waited a long time for an answer that never came.');
  }
  return paragraphs.filter(Boolean).join('\n\n');
}

async function main() {
  // 1. Book language
  await test('every common spelling of English normalizes to the base code', () => {
    for (const spelling of ENGLISH_SPELLINGS) assert.strictEqual(normalizeLanguageCode(spelling), 'en', spelling);
    assert.strictEqual(normalizeLanguageCode('de-DE'), 'de');
    assert.strictEqual(normalizeLanguageCode('Français'), 'fr');
    assert.strictEqual(normalizeLanguageCode(''), '');
  });

  await test('the chosen Edge voice narrates every English book, whatever its declared spelling', () => {
    for (const spelling of ENGLISH_SPELLINGS) {
      assert.strictEqual(TTSQueue.getVoiceForLanguage(spelling, AVA).voice, AVA, spelling);
      assert.strictEqual(recipeFor(AVA, spelling).recipe.synthesis.voice, AVA, spelling);
    }
    assert.strictEqual(TTSQueue.getVoiceForLanguage('de-DE', AVA).voice, 'de-DE-FlorianMultilingualNeural');
  });

  await test('a mislabelled Edge render no longer matches the corrected recipe', () => {
    // Before normalization an en-US book was rendered by Andrew under Ava's
    // variant key. The recipe fingerprint carries the resolved voice, so the
    // verified marker of that render cannot match the corrected recipe.
    const corrected = recipeFor(AVA, 'en-US');
    const andrewRecipe = recipeFor('en-US-AndrewMultilingualNeural', 'en');
    assert.notStrictEqual(corrected.fingerprint, andrewRecipe.fingerprint);
    assert.strictEqual(corrected.fingerprint, recipeFor(AVA, 'en').fingerprint);
  });

  await test('Kokoro reads English with the voice accent and keeps default recipes', () => {
    assert.strictEqual(kokoroLanguage('en-gb', 'af_heart'), 'en');
    assert.strictEqual(kokoroLanguage('en-US', 'af_heart'), 'en');
    assert.strictEqual(kokoroLanguage('en', 'bf_emma'), 'en-gb');
    assert.strictEqual(kokoroLanguage('English', 'bm_george'), 'en-gb');
    assert.strictEqual(kokoroLanguage('es-ES', 'ef_dora'), 'es');
    // Default English books keep the language they always sent.
    assert.strictEqual(recipeFor('kokoro:af_heart', 'en').recipe.synthesis.language, 'en');
    assert.strictEqual(recipeFor('kokoro:af_heart', 'en-GB').recipe.synthesis.language, 'en');
  });

  await test('Chatterbox V3 receives a normalized language_id only for non-English books', async () => {
    const definition = ENGINE_DEFINITIONS.find(engine => engine.id === 'chatterbox');
    const bodies = [];
    const queue = { _generateHttpTTS: async (_http, _text, _path, body) => { bodies.push(body); } };
    await withEnv('CHATTERBOX_ENGINE', 'v3', async () => {
      assert.strictEqual(chatterboxLanguage('de-DE'), 'de');
      assert.strictEqual(chatterboxLanguage('en-US'), null);
      await definition.generate(queue, { text: 'Hallo Welt, wie geht es dir heute?', outputPath: '/tmp/x.mp3', language: 'de-DE', voice: 'chatterbox:brick-scott' });
      await definition.generate(queue, { text: 'Hello there, how are you today?', outputPath: '/tmp/y.mp3', language: 'en', voice: 'chatterbox:brick-scott' });
      assert.strictEqual(recipeFor('chatterbox:brick-scott', 'de').recipe.synthesis.language, 'de');
      assert.strictEqual(recipeFor('chatterbox:brick-scott', 'en').recipe.synthesis.language, null);
    });
    assert.strictEqual(bodies[0].language_id, 'de');
    assert.strictEqual('language_id' in bodies[1], false);
    await withEnv('CHATTERBOX_ENGINE', 'mlx', () => {
      assert.strictEqual(chatterboxLanguage('de'), null, 'English-only servers keep their recipe');
    });
  });

  await test('stored book records read back with a canonical language', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'narration-invariants-'));
    try {
      const filePath = path.join(dir, 'books.json');
      await fsp.writeFile(filePath, JSON.stringify({
        a: { id: 'a', title: 'A', language: 'en-US' },
        b: { id: 'b', title: 'B', language: 'English' },
        c: { id: 'c', title: 'C' }
      }));
      const store = createBooksStore({ filePath, jsonStore });
      const books = await store.load();
      assert.strictEqual(books.a.language, 'en');
      assert.strictEqual(books.b.language, 'en');
      assert.strictEqual(books.c.language, undefined);
      await store.update(library => { library.c.title = 'C2'; });
      const persisted = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      assert.strictEqual(persisted.a.language, 'en', 'the next write persists the canonical value');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  // 2. Headings
  await test('an all-caps heading is classified before casing normalization', () => {
    const structure = buildNarrationPieces('THE RETURN\n\nShe came back to the house after many years away.', 4000);
    assert.strictEqual(structure.blocks[0].kind, 'heading');
    assert.strictEqual(structure.blocks[0].text, 'THE Return', 'engines still get the de-shouted text');
    const heading = structure.pieces[0];
    assert.strictEqual(heading.pauseIntent, 'heading');
    const adapted = adaptNarrationForEngine('edge', prepareTtsText('THE RETURN', { documentStart: false }), {
      segments: [heading], pauseIntent: 'heading'
    });
    assert.strictEqual(adapted.text, 'THE Return:');
  });

  // 3. Engine text bounds
  const CHATTERBOX_LIMITS = { minChars: 20, maxChars: 400 };
  await test('engine definitions declare their text bounds', () => {
    assert.deepStrictEqual(engineTextLimitsForVoice('chatterbox:brick-scott'), CHATTERBOX_LIMITS);
    assert.deepStrictEqual(engineTextLimitsForVoice('moss-nano:a'), { minChars: 1, maxChars: null });
    assert.deepStrictEqual(engineTextLimitsForVoice(AVA), { minChars: 20, maxChars: null });
  });

  await test('paragraph plans merge text shorter than the engine floor', () => {
    const text = '“No.”\n\nHe turned and walked out of the room without another word.';
    const limits = CHATTERBOX_LIMITS;
    const chunks = planSplitChunks(text, 280, 'paragraph-v1', limits);
    for (const chunk of chunks) {
      assert(isSpeakableText(chunk.text, { minimumLength: limits.minChars }), `refused chunk: ${chunk.text}`);
    }
    assert.match(chunks[0].text, /No\./);
    // Nano renders a lone "No." and keeps its paragraph-per-chunk plan.
    const nano = planSplitChunks(text, 160, 'paragraph-v1', { minChars: 1, maxChars: null });
    assert.strictEqual(nano.length, 2);
  });

  await test('hybrid plans never exceed the engine maximum', () => {
    const limits = CHATTERBOX_LIMITS;
    const chunks = planSplitChunks(corpus(), 280, 'hybrid-v1', limits);
    assert(chunks.length > 1);
    for (const chunk of chunks) assert(chunk.text.length <= limits.maxChars, `${chunk.text.length} chars`);
  });

  await test('ChunkedTTS plans with the bounds of its voice engine', async () => {
    const tts = new ChunkedTTS(os.tmpdir(), null, {
      voiceProvider: () => 'chatterbox:brick-scott',
      splitPolicyProvider: () => 'hybrid-v1',
      chunkSize: 280
    });
    const chunks = await tts.planChunksWithMeta(corpus(), 280);
    assert(chunks.every(chunk => chunk.text.length <= 400));
    assert.deepStrictEqual(tts.splitIntoChunksWithMeta(corpus(), 280).map(chunk => chunk.text), chunks.map(chunk => chunk.text));
  });

  await test('default engine plans are unchanged by the engine bounds', () => {
    const text = corpus();
    const defaults = [
      ['en-US-AvaMultilingualNeural', 4000, 'ramp-v1'],
      ['en-US-AvaMultilingualNeural', 4000, 'legacy-v1'],
      ['kokoro:af_heart', 600, 'legacy-v1'],
      ['kokoro:af_heart', 600, 'hybrid-v1'],
      ['chatterbox:brick-scott', 280, 'legacy-v1'],
      ['chatterbox:brick-scott', 380, 'legacy-v1'],
      ['moss-nano:a', 160, 'paragraph-v1']
    ];
    for (const [voice, size, policy] of defaults) {
      assert.deepStrictEqual(
        planSplitChunks(text, size, policy, engineTextLimitsForVoice(voice)),
        planSplitChunks(text, size, policy),
        `${voice} ${policy}`
      );
    }
  });

  // 4. Pronunciation rules
  await test('a typed apostrophe matches a typographic one', () => {
    const rules = [{ source: "don't", replacement: 'do not', wholeWord: true }];
    assert.strictEqual(applyPronunciationRules('I don’t know.', rules), 'I do not know.');
    const curly = [{ source: 'Ma’am', replacement: 'Mam', wholeWord: true }];
    assert.strictEqual(applyPronunciationRules("Yes, Ma'am.", curly), 'Yes, Mam.');
  });

  await test('rules compare NFC text and treat combining marks as word characters', () => {
    const decomposed = 'Zoë met Zoe.';
    assert.strictEqual(
      applyPronunciationRules(decomposed, [{ source: 'Zoe', replacement: 'Zoey', wholeWord: true }]),
      'Zoë met Zoey.'
    );
    assert.strictEqual(
      applyPronunciationRules('Zoë left.', [{ source: 'Zoë', replacement: 'Zo-ee', wholeWord: true }]),
      'Zo-ee left.'
    );
    assert.strictEqual(
      applyPronunciationRules('Zoë left.', [{ source: 'Zoë', replacement: 'Zo-ee', wholeWord: true }]),
      'Zo-ee left.'
    );
    // Text outside a match keeps its original code points.
    assert.strictEqual(
      applyPronunciationRules('Café and Kvothe.', [{ source: 'Kvothe', replacement: 'Quothe', wholeWord: true }]),
      'Café and Quothe.'
    );
  });

  await ChunkedTTS.closeChunkPlanPool();
  console.log(`narration-pipeline-invariants tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
