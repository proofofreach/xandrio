const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const server = require('../lib/chapter-playability');

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
    console.error(`    ${error.message}`);
  }
}

// Production 2026-10-18: chapter 12 of book 1b2d4d.
const productionDivider = { title: 'Part 2', type: 'divider', empty: true, text: 'Part 2 \nSEX' };
const prose = text => ({ title: 'Chapter', type: 'chapter', text });

(async () => {
  const client = await import(pathToFileURL(
    path.join(__dirname, '..', 'public', 'js', 'util', 'chapter-playability.mjs')
  ).href);

  await test('server and browser share one predicate implementation', () => {
    assert.strictEqual(server.isPlayableChapter, client.isPlayableChapter);
    assert.strictEqual(server.findPlayableChapterIndex, client.findPlayableChapterIndex);
    assert.strictEqual(server.resolvePlayableChapterIndex, client.resolvePlayableChapterIndex);
  });

  await test('structural sections and blank text are not playable', () => {
    assert.strictEqual(client.isPlayableChapter(productionDivider), false);
    assert.strictEqual(client.isPlayableChapter({ type: 'part', text: 'Part One has a long epigraph.' }), false);
    assert.strictEqual(client.isPlayableChapter({ type: 'cover', empty: true }), false);
    assert.strictEqual(client.isPlayableChapter(prose('   \n\t ')), false);
    assert.strictEqual(client.isPlayableChapter(null), false);
    assert.strictEqual(client.isPlayableChapter(undefined), false);
  });

  await test('narrative chapters and structure-only records are playable', () => {
    assert.strictEqual(client.isPlayableChapter(prose('It was a bright cold day in April.')), true);
    assert.strictEqual(client.isPlayableChapter({ title: 'Divider with prose', type: 'divider', text: 'A long dedication.' }), true,
      'only the import-time empty flag marks a divider as silent');
    assert.strictEqual(client.isPlayableChapter({ title: 'One' }), true,
      'a record without text is judged by structure alone');
  });

  await test('adjacent search skips silent sections in both directions', () => {
    const chapters = [prose('Eleven.'), productionDivider, { type: 'cover', empty: true }, prose('Twelve.')];
    assert.strictEqual(client.findPlayableChapterIndex(chapters, 0, 1), 3);
    assert.strictEqual(client.findPlayableChapterIndex(chapters, 3, -1), 0);
    assert.strictEqual(client.findPlayableChapterIndex(chapters, 3, 1), null);
    assert.strictEqual(client.findPlayableChapterIndex(chapters, 0, -1), null);
  });

  await test('a caller-supplied rule can exclude chapters the server found unspeakable', () => {
    const chapters = [prose('Eleven.'), prose('* * *'), prose('Twelve.')];
    const known = new Set([1]);
    const rule = (chapter, index) => client.isPlayableChapter(chapter) && !known.has(index);
    assert.strictEqual(client.findPlayableChapterIndex(chapters, 0, 1, rule), 2);
    assert.strictEqual(client.resolvePlayableChapterIndex(chapters, 1, -1, rule), 0);
  });

  await test('resolution keeps a playable target and redirects a silent one', () => {
    const chapters = [{ type: 'cover', empty: true }, prose('One.'), productionDivider, prose('Two.'), { type: 'divider', empty: true }];
    assert.strictEqual(client.resolvePlayableChapterIndex(chapters, 1, 1), 1);
    assert.strictEqual(client.resolvePlayableChapterIndex(chapters, 2, 1), 3, 'forward travel lands after the divider');
    assert.strictEqual(client.resolvePlayableChapterIndex(chapters, 2, -1), 1, 'backward travel lands before it');
    assert.strictEqual(client.resolvePlayableChapterIndex(chapters, 4, 1), 3, 'a trailing section falls back to the last chapter');
    assert.strictEqual(client.resolvePlayableChapterIndex(chapters, 0, 1), 1, 'a cover resolves to the first chapter');
    assert.strictEqual(client.resolvePlayableChapterIndex([productionDivider], 0, 1), null);
    assert.strictEqual(client.resolvePlayableChapterIndex([], 0, 1), null);
  });

  await test('the server error helpers identify unspeakable chapters', () => {
    const error = server.chapterUnspeakableError();
    assert.strictEqual(error.code, server.CHAPTER_UNSPEAKABLE);
    assert.strictEqual(server.isUnspeakableChapterError(error), true);
    assert.strictEqual(server.isUnspeakableChapterError(new Error('other')), false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
