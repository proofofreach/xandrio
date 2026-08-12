const assert = require('assert');
const { buildChapterTransition } = require('../lib/chapter-reprocess');
const { mapStateWriteToCurrent } = require('../lib/chapter-transition-state');

function chapter(text, duration = 100) {
  return { text, estimatedDuration: duration };
}

const first = 'First section. '.repeat(80);
const second = 'Second section. '.repeat(80);
const transition = buildChapterTransition(
  [chapter(first), chapter(second)],
  [chapter(`${first} ${second}`, 200)]
);
const book = { chapterStructureKey: 'new-key' };
const transitions = {
  book: { previousStructureKey: 'old-key', nextStructureKey: 'new-key', transition }
};

{
  const result = mapStateWriteToCurrent({
    bookId: 'book',
    suppliedStructureKey: 'new-key',
    book,
    transitions,
    state: { chapterIndex: 0, timestamp: 25, chunkIndex: 1, chunkTime: 2 }
  });
  assert.strictEqual(result.mapped, false);
  assert.strictEqual(result.state.chapterStructureKey, 'new-key');
}

{
  const result = mapStateWriteToCurrent({
    bookId: 'book',
    suppliedStructureKey: 'old-key',
    book,
    transitions,
    state: {
      chapterIndex: 1,
      timestamp: 50,
      characterOffset: 100,
      positionApproximate: true
    }
  });
  assert.strictEqual(result.state.positionApproximate, true,
    'a time-estimated character offset remains explicitly approximate after remapping');
}

{
  const result = mapStateWriteToCurrent({
    bookId: 'book',
    suppliedStructureKey: 'old-key',
    book,
    transitions,
    state: { chapterIndex: 1, timestamp: 50, positionApproximate: true }
  });
  assert(result.state.characterOffset > first.length && result.state.timestamp > 100,
    'a missing character estimate falls back to the saved timestamp ratio instead of chapter start');
  assert.strictEqual(result.state.positionApproximate, true);
}

{
  const result = mapStateWriteToCurrent({
    bookId: 'book',
    suppliedStructureKey: 'old-key',
    book,
    transitions,
    state: { chapterIndex: 1, timestamp: 50, characterOffset: 100, chunkIndex: 1, chunkTime: 2 }
  });
  assert.strictEqual(result.mapped, true);
  assert.strictEqual(result.state.chapterIndex, 0);
  assert(result.state.timestamp > 100 && result.state.timestamp < 200);
  assert.strictEqual(result.state.characterOffset, first.normalize('NFKC').replace(/\s+/gu, ' ').trim().length + 1 + 100);
  assert.strictEqual(result.state.positionApproximate, undefined);
  assert.strictEqual(result.state.chunkIndex, undefined);
  assert.strictEqual(result.state.chapterStructureKey, 'new-key');
}

{
  const result = mapStateWriteToCurrent({
    bookId: 'book',
    suppliedStructureKey: 'too-old-key',
    book,
    transitions,
    state: { chapterIndex: 1, timestamp: 50 }
  });
  assert.strictEqual(result.approximate, true);
  assert.strictEqual(result.state.chapterIndex, 0);
  assert.strictEqual(result.state.timestamp, 0);
}

{
  const repeated = 'Repeated chapter. '.repeat(80);
  const duplicateTransition = buildChapterTransition(
    [chapter(repeated), chapter(repeated)],
    [chapter(repeated), chapter(repeated)]
  );
  assert.deepStrictEqual(duplicateTransition.reusableAudio, {},
    'duplicate narration hashes are not treated as uniquely reusable audio');
}

console.log('6 passed, 0 failed');
