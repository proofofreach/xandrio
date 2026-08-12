const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const GenerationJournal = require('../lib/generation-journal');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-generation-indexes-'));
  try {
    const journal = new GenerationJournal(path.join(dir, 'generation.json'));
    await journal.putChapter({ bookId: 'book', chapterIndex: 0, variantKey: 'a', text: 'zero' });
    await journal.putChapter({ bookId: 'book', chapterIndex: 1, variantKey: 'a', text: 'one' });
    await journal.putChapter({ bookId: 'book', chapterIndex: 2, variantKey: 'b', text: 'two' });
    await journal.putChapter({ bookId: 'other', chapterIndex: 1, variantKey: 'a', text: 'other' });

    assert.strictEqual(await journal.removeChapterIndexes('book', [0, 1]), 2);
    const remaining = await journal.listChapters();
    assert.deepStrictEqual(
      remaining.map(item => [item.bookId, item.chapterIndex]),
      [['book', 2], ['other', 1]]
    );
    console.log('2 passed, 0 failed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
