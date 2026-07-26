const assert = require('assert');
const {
  booksNeedingAudioBackfill,
  createBookAudioPreloader
} = require('../lib/book-audio-preloader');

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
  await test('generates every non-empty chapter when a book is ingested', async () => {
    const generated = [];
    const progress = [];
    const preloader = createBookAudioPreloader({
      getChapters: async () => [
        { title: 'Preface', text: 'preface' },
        { title: 'Blank', text: '' },
        { title: 'Chapter 1', text: 'one' },
        { title: 'Chapter 2', text: 'two' }
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

    assert.deepStrictEqual(generated.map(request => request.chapterIndex), [2, 3, 0]);
    assert(generated.every(request => request.bookId === 'book-1'));
    assert.strictEqual(result.generatedChapters, 3);
    assert.strictEqual(result.totalChapters, 4);
    assert.strictEqual(progress.at(-1).state, 'ready');
  });

  await test('backfills existing books that never completed full audio generation', async () => {
    const books = {
      old: {
        id: 'old',
        path: '/library/old.epub',
        addedAt: '2025-01-01T00:00:00.000Z'
      },
      interrupted: {
        id: 'interrupted',
        path: '/library/interrupted.epub',
        addedAt: '2026-01-01T00:00:00.000Z',
        audioGenerationState: 'generating'
      },
      ready: {
        id: 'ready',
        path: '/library/ready.epub',
        audioGenerationState: 'ready'
      },
      deleted: { id: 'deleted', path: '/library/deleted.epub' }
    };

    assert.deepStrictEqual(
      booksNeedingAudioBackfill(books, id => id === 'deleted').map(book => book.id),
      ['interrupted', 'old']
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
