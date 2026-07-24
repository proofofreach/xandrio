const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

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

(async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'chapter-navigation.mjs'));
  const { navigateChapterSelection, shouldAllowBackwardReconciliation } = await import(moduleUrl.href);

  await test('backward chapter selection saves the selected chapter after loading it', async () => {
    let currentChapter = 33;
    const calls = [];

    await navigateChapterSelection({
      nextChapter: 17,
      chapterCount: 39,
      getCurrentChapter: () => currentChapter,
      checkpointPlayback: options => calls.push(['checkpoint', currentChapter, options]),
      savePosition: async options => calls.push(['save', currentChapter, options]),
      loadChapter: async (nextChapter, options) => {
        calls.push(['load', nextChapter, options]);
        currentChapter = nextChapter;
      }
    });

    assert.deepStrictEqual(calls.map(call => call.slice(0, 2)), [
      ['checkpoint', 33],
      ['save', 33],
      ['load', 17],
      ['checkpoint', 17],
      ['save', 17]
    ]);
    assert.strictEqual(calls[2][2].commitImmediately, true);
    assert.strictEqual(calls[4][2].allowBackward, true);
  });

  await test('provisional forward selection does not falsely commit skipped chapters', async () => {
    let currentChapter = 5;
    const saves = [];
    let loadOptions;

    await navigateChapterSelection({
      nextChapter: 12,
      chapterCount: 20,
      getCurrentChapter: () => currentChapter,
      checkpointPlayback() {},
      savePosition: async options => saves.push({ chapter: currentChapter, options }),
      loadChapter: async (nextChapter, options) => {
        currentChapter = nextChapter;
        loadOptions = options;
      }
    });

    assert.strictEqual(saves.length, 1);
    assert.strictEqual(saves[0].chapter, 5);
    assert.strictEqual(loadOptions.provisionalForward, true);
  });

  await test('bookmark navigation commits its selected chapter and seek position', async () => {
    let currentChapter = 5;
    const saves = [];
    let loadOptions;

    await navigateChapterSelection({
      nextChapter: 12,
      chapterCount: 20,
      commitImmediately: true,
      seekToSeconds: 42,
      getCurrentChapter: () => currentChapter,
      checkpointPlayback() {},
      savePosition: async options => saves.push({ chapter: currentChapter, options }),
      loadChapter: async (nextChapter, options) => {
        currentChapter = nextChapter;
        loadOptions = options;
      }
    });

    assert.strictEqual(saves.length, 2);
    assert.strictEqual(saves[1].chapter, 12);
    assert.strictEqual(loadOptions.seekToSeconds, 42);
    assert.strictEqual(loadOptions.commitImmediately, true);
  });

  await test('a newer local checkpoint can intentionally reconcile behind the server', async () => {
    assert.strictEqual(shouldAllowBackwardReconciliation(
      { chapterIndex: 5, timestamp: 0, updatedAt: 300 },
      { chapterIndex: 33, timestamp: 0, updatedAt: 200 }
    ), true);
    assert.strictEqual(shouldAllowBackwardReconciliation(
      { chapterIndex: 5, timestamp: 0, updatedAt: 100 },
      { chapterIndex: 33, timestamp: 0, updatedAt: 200 }
    ), false);
    assert.strictEqual(shouldAllowBackwardReconciliation(
      { chapterIndex: 33, timestamp: 0, updatedAt: 300 },
      { chapterIndex: 5, timestamp: 0, updatedAt: 200 }
    ), false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});
