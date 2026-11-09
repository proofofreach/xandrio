const assert = require('assert');
const { buildChapterTransition, chapterTextIdentity, textIdentityTransition } = require('../lib/chapter-reprocess');
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

{
  // A position past the book outranks all real forward-only progress, on
  // every write path that stores the supplied coordinates.
  const bounded = { chapterStructureKey: 'new-key', chapterCount: 3, chapterDurations: [600, 900], totalDuration: 2400 };
  const write = (state, suppliedStructureKey = 'new-key', book = bounded, extraTransitions = transitions) =>
    mapStateWriteToCurrent({ bookId: 'book', suppliedStructureKey, book, transitions: extraTransitions, state });
  assert.strictEqual(write({ chapterIndex: 3, timestamp: 0 }).invalid, 'chapter');
  assert.strictEqual(write({ chapterIndex: 999, timestamp: 0 }).invalid, 'chapter');
  assert.strictEqual(write({ chapterIndex: 2, timestamp: 10 }).invalid, undefined);
  assert.strictEqual(write({ chapterIndex: 0, timestamp: 600000 }).invalid, 'timestamp',
    'milliseconds sent as seconds are rejected against the measured chapter duration');
  assert.strictEqual(write({ chapterIndex: 0, timestamp: 1200 }).invalid, undefined,
    'a slower narrator than the measured one still fits the slack');
  assert.strictEqual(write({ chapterIndex: 2, timestamp: 4900 }).invalid, 'timestamp',
    'an unmeasured chapter is bounded by the whole book');
  assert.strictEqual(write({ chapterIndex: 0, timestamp: 90000 }, 'new-key', { chapterStructureKey: 'new-key' }).invalid,
    'timestamp', 'a book without durations still has a sane cap');
  assert.strictEqual(write({ chapterIndex: 400, timestamp: 0 }, 'new-key', { chapterStructureKey: 'new-key' }).invalid,
    undefined, 'a legacy record without a chapter count is not bounded by a guess');
  assert.strictEqual(write({ chapterIndex: 3, timestamp: 0 }, '', { chapterCount: 3 }).invalid, 'chapter',
    'a book without a structure key is bounded too');

  const relabeled = { chapterStructureKey: 'new-key', chapterCount: 3, totalDuration: 2400 };
  const metadataOnly = { book: { previousStructureKey: 'old-key', nextStructureKey: 'new-key', transition: { safe: true, metadataOnly: true } } };
  assert.strictEqual(write({ chapterIndex: 7, timestamp: 0 }, 'old-key', relabeled, metadataOnly).invalid, 'chapter',
    'a metadata-only relabel passes coordinates through, so they are bounded too');

  const unchanged = buildChapterTransition([chapter(first), chapter(second)], [chapter(first), chapter(second)]);
  const sameText = { book: { previousStructureKey: 'old-key', nextStructureKey: 'new-key', transition: unchanged } };
  assert.strictEqual(write({ chapterIndex: 1, timestamp: 1e9 }, 'old-key', { chapterStructureKey: 'new-key', chapterCount: 2, totalDuration: 200 }, sameText).invalid,
    'timestamp', 'an unchanged-identity remap keeps the supplied timestamp, so it is bounded after mapping');
}

{
  // After a same-key re-cut the previous text is gone; the recorded identity
  // must yield the transition the text itself would have.
  const third = 'Third section. '.repeat(40);
  const before = [chapter(`${first} ${third}`, 150), chapter(second, 100)];
  const after = [chapter(first, 100), chapter(`${third} ${second}`, 150)];
  const fromText = buildChapterTransition(before, after);
  const fromIdentity = textIdentityTransition(chapterTextIdentity(before, 'k'), chapterTextIdentity(after, 'k'));
  assert.strictEqual(fromIdentity.safe, true);
  const coordinates = ranges => ranges.map(({ index, start, end, length, duration }) => ({ index, start, end, length, duration }));
  assert.deepStrictEqual(coordinates(fromIdentity.previousRanges), coordinates(fromText.previousRanges));
  assert.deepStrictEqual(coordinates(fromIdentity.nextRanges), coordinates(fromText.nextRanges));
  assert.deepStrictEqual(fromIdentity.indexMap, fromText.indexMap);
  assert.deepStrictEqual(fromIdentity.reusableAudio, fromText.reusableAudio);
  assert.strictEqual(textIdentityTransition(chapterTextIdentity(before, 'k'),
    chapterTextIdentity([chapter('Other text.'), chapter(second)], 'k')).safe, false,
    'changed narration cannot be remapped from identities');
}

console.log('8 passed, 0 failed');
