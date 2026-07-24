const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { planRollingOfflineWindow } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'features', 'rolling-offline.mjs')).href
  );

  assert.deepStrictEqual(planRollingOfflineWindow({
    currentChapter: 5,
    chapterCount: 10,
    cachedChapters: [0, 3, 4, 5, 8]
  }), {
    retain: [4, 5, 6, 7],
    prepare: [6, 7],
    evict: [0, 3, 8]
  });

  assert.deepStrictEqual(planRollingOfflineWindow({
    currentChapter: 0,
    chapterCount: 3,
    cachedChapters: []
  }), {
    retain: [0, 1, 2],
    prepare: [0, 1, 2],
    evict: []
  });

  assert.deepStrictEqual(planRollingOfflineWindow({
    currentChapter: 99,
    chapterCount: 0,
    cachedChapters: [0]
  }), {
    retain: [],
    prepare: [],
    evict: [0]
  });

  console.log('3 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
