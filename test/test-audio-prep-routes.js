const assert = require('assert');
const { registerAudioPrepRoutes } = require('../lib/routes/audio-prep-routes');

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

function createRoutes(overrides = {}) {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); }
  };
  const books = {
    visibleFailure: {
      title: 'Visible failure', author: 'Reader', path: '/books/visible',
      audioGenerationState: 'error', audioGenerationError: 'Engine stopped'
    },
    hiddenFailure: {
      title: 'Hidden failure', author: 'Reader', path: '/books/hidden',
      audioGenerationState: 'error', audioGenerationError: 'Do not expose'
    }
  };
  registerAudioPrepRoutes(app, {
    booksFile: 'books', shelvesFile: 'shelves', positionsFile: 'positions', settingsFile: 'settings',
    loadJSON: async file => ({ books, shelves: { reader: ['visibleFailure'] }, positions: { reader: {} } }[file] || {}),
    updateJSON: async () => ({}), fs: {},
    shelves: { shelfForUser: (store, userId) => store[userId] || [] },
    positionsForUser: (store, userId) => store[userId] || {},
    ttsQueue: { getQueueActivity: () => ({ active: 0, queued: 0, books: [] }), bookOrder: () => [] },
    premiumPrep: { getState: () => null }, offlinePreparationCoordinator: { move: () => false },
    getChaptersCached: async () => [{ text: 'front matter' }, { text: 'chapter one' }, { text: 'chapter two' }],
    chunkedTTS: {}, getTTSVariantKey: () => 'voice', getActiveInstantVoice: () => 'voice',
    isPremiumPrepEnabled: () => false, isPremiumVoiceActive: () => false, updateSettingsCache: () => {},
    userIdFromRequest: () => 'reader', getAvailableVoices: async () => [], transformNarrationText: async text => text,
    getChunkSizeForVoice: () => 100, getTTSVariantKeyForVoice: () => 'voice', getTtsOutputFormatForVoice: () => 'mp3',
    findPreferredAudioStartChapterIndex: () => 2,
    sendServerError: (_res, error) => { throw error; },
    ...overrides
  });
  return routes;
}

(async () => {
  await test('queue status exposes only the current user’s failed warmup with a retry chapter', async () => {
    const handler = createRoutes().get('GET /api/queue/status');
    let body;
    await handler({}, { json(value) { body = value; } });

    assert.strictEqual(body.active, 0);
    assert.strictEqual(body.queued, 0);
    assert.deepStrictEqual(body.books, [{
      id: 'visibleFailure',
      title: 'Visible failure',
      author: 'Reader',
      hasCover: false,
      active: 0,
      queued: 0,
      origins: {},
      chapters: [],
      failed: true,
      error: 'Engine stopped',
      retryChapterIndex: 2
    }]);
  });

  await test('voice cache plans each voice policy and chunk size once and reports cached chunks', async () => {
    const plannedSizes = [];
    const handler = createRoutes({
      fs: { access: async file => { if (!file.includes('kokoro') || file.endsWith('chunk2.mp3')) throw new Error('missing'); } },
      getAvailableVoices: async () => [
        { id: 'kokoro:a' }, { id: 'kokoro:b' }, { id: 'edge:a' }, { id: 'edge:b' }, { id: 'edge:c' }
      ],
      getChunkSizeForVoice: voiceId => (voiceId.startsWith('kokoro') ? 300 : 900),
      // edge:c shares edge's chunk size but not its policy.
      getSplitPolicyForVoice: voiceId => (voiceId.startsWith('kokoro') ? 'ramp-v1' : voiceId === 'edge:c' ? 'hybrid-v1' : 'legacy'),
      getTTSVariantKeyForVoice: voiceId => voiceId.replace(':', '-'),
      chunkedTTS: {
        async planChunks(_text, size, policy) {
          plannedSizes.push(`${policy}:${size}`);
          const length = size === 300 ? 3 : policy === 'hybrid-v1' ? 4 : 2;
          return Array.from({ length }, (_value, index) => `chunk ${index}`);
        },
        chunkPathForVariant: (bookId, chapterIndex, index, variantKey, format) => (
          `/cache/${bookId}_${variantKey}_ch${chapterIndex}_chunk${index}.${format}`
        )
      }
    }).get('GET /api/voice-cache/:bookId/:chapterIndex');
    let body;
    await handler(
      { params: { bookId: 'visibleFailure', chapterIndex: '1' } },
      { json(value) { body = value; }, status() { return this; } }
    );

    assert.deepStrictEqual(plannedSizes, ['ramp-v1:300', 'legacy:900', 'hybrid-v1:900']);
    assert.deepStrictEqual(body.voices, [
      { voiceId: 'kokoro:a', totalChunks: 3, readyChunks: 2, status: 'partial' },
      { voiceId: 'kokoro:b', totalChunks: 3, readyChunks: 2, status: 'partial' },
      { voiceId: 'edge:a', totalChunks: 2, readyChunks: 0, status: 'uncached' },
      { voiceId: 'edge:b', totalChunks: 2, readyChunks: 0, status: 'uncached' },
      { voiceId: 'edge:c', totalChunks: 4, readyChunks: 0, status: 'uncached' }
    ]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
