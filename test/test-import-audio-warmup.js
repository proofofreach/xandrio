const assert = require('assert');
const {
  createImportAudioWarmup
} = require('../lib/import-audio-warmup');

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
    console.error(`    ${error.stack || error.message}`);
  }
}

(async () => {
  await test('warms only the preferred playable chapter when a book is ingested', async () => {
    const generated = [];
    const progress = [];
    const preloader = createImportAudioWarmup({
      getChapters: async () => [
        { title: 'Preface', text: 'preface' },
        { title: 'Blank', text: '' },
        { title: 'Chapter 1', text: 'one' },
        { title: 'Chapter 2', text: 'two' },
        { title: 'Chapter 3', text: 'three' },
        { title: 'Chapter 4', text: 'four' },
        { title: 'Chapter 5', text: 'five' },
        { title: 'Chapter 6', text: 'six' }
      ],
      preferredStartIndex: () => 2,
      generateChapter: async request => generated.push(request),
      onProgress: async update => progress.push(update)
    });

    const result = await preloader.generate({
      bookId: 'book-1',
      bookPath: '/library/book-1.epub',
      language: 'en',
      voice: 'reader'
    });

    assert.deepStrictEqual(generated.map(request => request.chapterIndex), [2]);
    assert(generated.every(request => request.bookId === 'book-1'));
    assert.strictEqual(result.generatedChapters, 1);
    assert.strictEqual(result.totalChapters, 8);
    assert.strictEqual(progress.at(-1).state, 'partial');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
