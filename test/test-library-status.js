/**
 * Library status vocabulary: device and narration states, the status line
 * truncation rule (brief fix 4) and the shared resume-point chapter label.
 *
 * Run: node test/test-library-status.js
 */
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

(async () => {
  const util = name => pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'util', name)).href;
  const {
    deviceState, narrationState, primaryState, statusLineVariants, gridTimeVariants
  } = await import(util('library-status.mjs'));
  const { chapterResumeLabel, chapterResumeLabels, chapterProgressContext } = await import(util('chapter-labels.mjs'));
  const { shortChapterContext } = await import(util('time-left.mjs'));

  console.log('\n━━━ device states ━━━');
  test('a verified download is on device with a check', () => {
    const state = deviceState({ kind: 'downloaded', downloaded: true });
    assert.strictEqual(state.long, 'On device');
    assert.strictEqual(state.glyph, 'check');
    assert.strictEqual(state.notable, true);
  });
  test('offline preparation shows a ring with its percentage', () => {
    const state = deviceState({ kind: 'preparing', preparedChapters: 23, totalChapters: 50 });
    assert.strictEqual(state.long, 'Preparing 46%');
    assert.strictEqual(state.short, '46% ready');
    assert.strictEqual(state.glyph, 'ring');
    assert.strictEqual(state.percent, 46);
    assert.strictEqual(state.tap, 'menu');
  });
  test('a failed offline preparation offers retry and states the failure in words', () => {
    const state = deviceState({ kind: 'preparation-error' });
    assert.strictEqual(state.long, 'Narration failed');
    assert.strictEqual(state.short, 'Failed');
    assert.strictEqual(state.warn, true);
    assert.strictEqual(state.glyph, 'retry');
    assert.strictEqual(state.tap, 'download');
  });
  test('a book that can be downloaded is not a notable state', () => {
    const state = deviceState({ kind: 'ready-to-prepare' });
    assert.strictEqual(state.glyph, 'download');
    assert.strictEqual(state.tap, 'download');
    assert.strictEqual(state.notable, false);
  });
  test('a pending check is never offered as a second download', () => {
    assert.strictEqual(deviceState({ kind: 'ready-to-prepare' }, { pending: true }).tap, 'none');
  });
  test('partial downloads keep the legacy continue action', () => {
    const state = deviceState({ kind: 'partial-download', cachedChapters: 1, totalChapters: 3 });
    assert.strictEqual(state.action, 'Partial 1/3 · Continue');
  });

  console.log('\n━━━ narration states ━━━');
  test('Audio activity rows map to words', () => {
    assert.strictEqual(narrationState({}, { failed: true }).long, 'Narration failed');
    assert.strictEqual(narrationState({}, { preparationStatus: 'generating', readyChapters: 23, totalChapters: 50 }).long, 'Preparing 46%');
    assert.strictEqual(narrationState({}, { preparationStatus: 'paused', readyAudioSeconds: 7800 }, 1).long, '2h 10m ready');
    assert.strictEqual(narrationState({}, { preparationStatus: 'paused', readyAudioSeconds: 7800 }, 1.25).long, '1h 44m ready');
  });
  test('the library record covers import warm-up failures', () => {
    assert.strictEqual(narrationState({ audioGenerationState: 'error' }).short, 'Failed');
    assert.strictEqual(narrationState({ audioGenerationState: 'generating', audioGeneratedChapters: 1, audioGenerationTotal: 4 }).long, 'Preparing 25%');
  });
  test('no evidence means no narration claim', () => {
    assert.strictEqual(narrationState({ audioGenerationState: 'partial' }, null), null);
    assert.strictEqual(narrationState({}, { preparationStatus: 'idle', readyAudioSeconds: 0 }), null);
  });
  test('a notable device state outranks narration; narration outranks context', () => {
    const device = deviceState({ kind: 'downloaded', downloaded: true });
    const narration = narrationState({}, { failed: true });
    const context = { long: 'Played Aug 14', short: 'Aug 14' };
    assert.strictEqual(primaryState({ device, narration, context }), device);
    assert.strictEqual(primaryState({ device: deviceState({}), narration, context }), narration);
    assert.strictEqual(primaryState({ device: deviceState({}), narration: null, context }), context);
  });

  console.log('\n━━━ truncation rule ━━━');
  test('variants drop the speed suffix before shortening the state word', () => {
    const variants = statusLineVariants({
      timeLeft: 13 * 3600 + 300, speed: 1, referenceSpeed: 1.25,
      stateWord: { long: 'Narration failed', short: 'Failed', warn: true }
    });
    assert.deepStrictEqual(variants.map(v => `${v.time} · ${v.state}`), [
      '13h 05m left at 1.0× · Narration failed',
      '13h 05m left · Narration failed',
      '13h 05m left · Failed'
    ]);
    assert(variants.every(v => v.warn));
  });
  test('a book at the stated speed has no suffix and no duplicate variant', () => {
    const variants = statusLineVariants({
      timeLeft: 9 * 3600 + 720, speed: 1.25, referenceSpeed: 1.25,
      stateWord: { long: '2h 10m ready', short: '2h 10m ready' }
    });
    assert.deepStrictEqual(variants.map(v => `${v.time} · ${v.state}`), ['9h 12m left · 2h 10m ready']);
  });
  test('state words are whole words in every variant', () => {
    const variants = statusLineVariants({ timeLeft: 60, stateWord: { long: 'Preparing 46%', short: '46% ready' } });
    assert(variants.every(v => ['Preparing 46%', '46% ready'].includes(v.state)));
  });
  test('grid time keeps a compact speed before dropping it', () => {
    assert.deepStrictEqual(gridTimeVariants({ timeLeft: 6 * 3600 + 120, speed: 1, referenceSpeed: 1.25 }),
      ['6h 02m left at 1.0×', '6h 02m · 1.0×', '6h 02m left']);
    assert.deepStrictEqual(gridTimeVariants({ timeLeft: 0 }), ['Finished']);
  });

  console.log('\n━━━ resume-point chapter label ━━━');
  const chapters = [
    { title: 'Copyright', type: 'copyright' },
    { title: 'Prologue', type: 'content' },
    { title: 'Chapter 1', type: 'chapter' },
    { title: 'Chapter 12', type: 'chapter' },
    { title: 'Epilogue', type: 'chapter' }
  ];
  test('the Continue label is the mini player context without the total', () => {
    const mini = shortChapterContext(chapterProgressContext(chapters, 3));
    assert.strictEqual(mini, 'Ch 12 of 12');
    assert.strictEqual(chapterResumeLabel(chapters, 3), 'Ch 12');
    assert(mini.startsWith(chapterResumeLabel(chapters, 3)));
  });
  test('unnumbered sections keep their names, as the mini player does', () => {
    assert.strictEqual(chapterResumeLabel(chapters, 1), 'Prologue');
    // A book with no authored numbers counts its chapters in reading order
    // (chapterNumbering), so an untitled narrative section is still numbered.
    assert.strictEqual(chapterResumeLabel([{ title: '', type: 'content' }], 0), 'Ch 1');
    assert.strictEqual(chapterResumeLabel([{ title: '', type: 'frontmatter' }], 0), 'Section 1');
  });
  test('labels for every index are trimmed for the meta cache', () => {
    const labels = chapterResumeLabels([...chapters, { title: 'A very long chapter title that goes on and on', type: 'content' }]);
    assert.strictEqual(labels.length, 6);
    assert(labels[5].length <= 28 && labels[5].endsWith('…'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
