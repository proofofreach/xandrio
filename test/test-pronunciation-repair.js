const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const jsonStore = require('../lib/json-store');
const {
  PronunciationError,
  applyPronunciationRules,
  createCacheInvalidator,
  createPronunciationService,
  effectiveRules
} = require('../lib/pronunciation-repair');
const { registerPronunciationRoutes } = require('../lib/routes/pronunciation-routes');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message}${actual === expected ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

async function assertRejects(fn, statusCode, message) {
  try {
    await fn();
    assert(false, message);
  } catch (error) {
    assert(error instanceof PronunciationError && error.statusCode === statusCode, message);
  }
}

function rule(source, replacement, options = {}) {
  return { source, replacement, caseSensitive: false, wholeWord: true, ...options };
}

function split(text) {
  const matches = String(text).match(/.{1,18}(?:\s|$)/g);
  return matches ? matches.map(part => part.trim()).filter(Boolean) : [];
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

(async () => {
  console.log('\n━━━ Safe pronunciation substitution ━━━');
  assertEqual(
    applyPronunciationRules('Use C++ and C+ carefully.', [rule('C++', 'see plus plus')]),
    'Use see plus plus and C+ carefully.',
    'literal regex metacharacters are safe'
  );
  assertEqual(
    applyPronunciationRules('Ann met ANNE, not annual.', [rule('ann', 'Anne')]),
    'Anne met ANNE, not annual.',
    'case-insensitive whole-word matching does not alter substrings'
  );
  assertEqual(
    applyPronunciationRules('José met Joséphine.', [rule('José', 'ho-ZAY')]),
    'ho-ZAY met Joséphine.',
    'Unicode word boundaries are respected'
  );
  assertEqual(
    applyPronunciationRules('New York wins.', [rule('New', 'old'), rule('New York', 'Noo Yawk')]),
    'Noo Yawk wins.',
    'longest overlapping source wins'
  );
  assertEqual(
    applyPronunciationRules('A B', [rule('A', 'B'), rule('B', 'C')]),
    'B C',
    'replacement text is not recursively replaced'
  );

  console.log('\n━━━ Scope and persistence ━━━');
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pronunciation-test-'));
  const storeFile = path.join(tempDir, 'pronunciations.json');
  const cacheDir = path.join(tempDir, 'cache');
  await fsp.mkdir(cacheDir);
  const books = {
    alpha: { chapters: [{ text: 'Dr. Quinn went home. A quiet ending follows.' }] },
    beta: { chapters: [{ text: 'Nothing relevant.' }, { text: 'Dr. Quinn returned.' }] }
  };
  const invalidated = [];
  const invalidationOrder = [];
  const service = createPronunciationService({
    storeFile,
    jsonStore,
    loadBooks: async () => books,
    getChapters: async (_bookId, book) => book.chapters,
    splitIntoChunks: split,
    beforeInvalidate: async () => invalidationOrder.push('before'),
    invalidateCache: async affected => {
      invalidationOrder.push('files');
      return createCacheInvalidator(cacheDir)(affected);
    },
    onInvalidated: async affected => {
      invalidationOrder.push('after');
      invalidated.push(...affected);
    }
  });

  const globalCreated = await service.create({
    scope: 'global',
    input: { source: 'Dr.', replacement: 'Doctor', wholeWord: false }
  });
  assertEqual(globalCreated.affected.length, 2, 'global rule identifies affected chapters across books');
  assert(fs.existsSync(storeFile), 'rules persist to disk');
  assertEqual(await service.apply('Dr. Quinn', 'alpha'), 'Doctor Quinn', 'persisted global rule applies to narration text');

  const bookCreated = await service.create({
    scope: 'book',
    bookId: 'alpha',
    input: { source: 'Dr.', replacement: 'Drive', wholeWord: false }
  });
  assertEqual(bookCreated.affected.length, 1, 'book rule only affects its book');
  assertEqual(await service.apply('Dr. Quinn', 'alpha'), 'Drive Quinn', 'book rule overrides equivalent global rule');
  assertEqual(await service.apply('Dr. Quinn', 'beta'), 'Doctor Quinn', 'global rule remains effective in other books');

  const bookUpdated = await service.update({
    scope: 'book',
    bookId: 'alpha',
    id: bookCreated.rule.id,
    input: { replacement: 'Mister' }
  });
  assertEqual(bookUpdated.affected.length, 1, 'updating a rule identifies audio that must regenerate');
  assertEqual(await service.apply('Dr. Quinn', 'alpha'), 'Mister Quinn', 'updated replacement applies immediately');

  const stored = JSON.parse(await fsp.readFile(storeFile, 'utf8'));
  assertEqual(stored.version, 1, 'versioned pronunciation store is written');
  assertEqual(stored.global.length, 1, 'global rule is stored separately');
  assertEqual(stored.books.alpha.length, 1, 'book rule is stored under its book');
  assertEqual(effectiveRules(stored, 'alpha').length, 1, 'equivalent book rule shadows global rule');

  await assertRejects(
    () => service.create({ scope: 'global', input: { source: 'DR.', replacement: 'duplicate', wholeWord: false } }),
    409,
    'duplicate matching rules are rejected'
  );
  await assertRejects(
    () => service.update({ scope: 'book', bookId: 'alpha', id: 'missing', input: { replacement: 'x' } }),
    404,
    'missing rules return not found'
  );
  await assertRejects(
    () => service.create({ scope: 'book', bookId: 'missing', input: { source: 'x', replacement: 'y' } }),
    404,
    'book rules cannot be orphaned from a book'
  );

  console.log('\n━━━ Targeted cache invalidation ━━━');
  const cacheFiles = [
    'alpha_ch0_chunk0.mp3',
    'alpha_ch0_chunk1.mp3',
    'alpha_ch0_chunk2.mp3',
    'alpha_tts0123456789_ch0_chunk1.mp3',
    'alpha_tts0123456789_ch0_chunk0.mp3',
    'alpha_ttsffffffffff_ch0_chunk0.mp3',
    'alpha_tts0123456789_ch0.mp3',
    'alpha_tts0123456789_ch0.m4a',
    'alpha_tts0123456789_ch0.texthash',
    'alpha_tts0123456789_ch0_concat.txt',
    'alpha_ch1_chunk1.mp3',
    'beta_ch0_chunk1.mp3'
  ];
  await Promise.all(cacheFiles.map(name => fsp.writeFile(path.join(cacheDir, name), 'audio')));
  const invalidate = createCacheInvalidator(cacheDir);
  const removed = await invalidate([{
    bookId: 'alpha',
    chapterIndex: 0,
    fromChunkIndex: 1,
    fromChunkIndexByVariant: { '': 1, _tts0123456789: 1 }
  }]);
  assert(removed.includes('alpha_ch0_chunk1.mp3') && removed.includes('alpha_ch0_chunk2.mp3'), 'changed and subsequent chunks are removed');
  assert(removed.includes('alpha_tts0123456789_ch0_chunk1.mp3'), 'all voice variants are invalidated');
  assert(fs.existsSync(path.join(cacheDir, 'alpha_tts0123456789_ch0_chunk0.mp3')), 'mapped variants retain chunks before their own changed boundary');
  assert(removed.includes('alpha_ttsffffffffff_ch0_chunk0.mp3'), 'unknown historical variants invalidate conservatively from chunk zero');
  assert(removed.includes('alpha_tts0123456789_ch0.mp3') && removed.includes('alpha_tts0123456789_ch0.m4a'), 'stitched chapter outputs are removed');
  assert(fs.existsSync(path.join(cacheDir, 'alpha_ch0_chunk0.mp3')), 'unchanged earlier chunks are retained');
  assert(fs.existsSync(path.join(cacheDir, 'alpha_ch1_chunk1.mp3')), 'other chapters are retained');
  assert(fs.existsSync(path.join(cacheDir, 'beta_ch0_chunk1.mp3')), 'other books are retained');
  assert(invalidated.length >= 3, 'service emits in-memory invalidation hooks');
  assertEqual(invalidationOrder.slice(0, 3).join(','), 'before,files,after', 'running jobs can be cancelled before files are deleted');

  console.log('\n━━━ Route registration and validation ━━━');
  const routes = {};
  const app = {
    get(routePath, handler) { routes[`GET ${routePath}`] = handler; },
    post(routePath, handler) { routes[`POST ${routePath}`] = handler; },
    put(routePath, handler) { routes[`PUT ${routePath}`] = handler; },
    delete(routePath, handler) { routes[`DELETE ${routePath}`] = handler; }
  };
  registerPronunciationRoutes(app, { pronunciationService: service });
  assertEqual(Object.keys(routes).length, 4, 'CRUD pronunciation routes register');

  const badResponse = fakeResponse();
  await routes['POST /api/pronunciations'](
    { body: { scope: 'book', bookId: '../escape', source: 'x', replacement: 'y' }, query: {} },
    badResponse
  );
  assertEqual(badResponse.statusCode, 400, 'routes reject unsafe book identifiers');

  const createResponse = fakeResponse();
  await routes['POST /api/pronunciations'](
    { body: { scope: 'book', bookId: 'beta', source: 'relevant', replacement: 'REL-uh-vunt' }, query: {} },
    createResponse
  );
  assertEqual(createResponse.statusCode, 201, 'route creates a book pronunciation rule');
  assert(createResponse.body.success && createResponse.body.rule.id, 'route returns created rule and impact');

  const failingRoutes = {};
  registerPronunciationRoutes({
    get(routePath, handler) { failingRoutes[`GET ${routePath}`] = handler; },
    post() {}, put() {}, delete() {}
  }, { pronunciationService: { list: async () => { throw new Error('/private/data/pronunciations.json'); } } });
  const internalResponse = fakeResponse();
  const originalConsoleError = console.error;
  console.error = () => {};
  await failingRoutes['GET /api/pronunciations']({ query: {} }, internalResponse);
  console.error = originalConsoleError;
  assertEqual(internalResponse.statusCode, 500, 'unexpected route failures return 500');
  assertEqual(internalResponse.body.error, 'Failed to manage pronunciation rules', 'unexpected route failures hide internal details');

  await fsp.rm(tempDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
