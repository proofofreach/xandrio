#!/usr/bin/env node
// Server wiring for book lifecycle data integrity: a deleted clone voice
// leaves no book pinned to it, a new clone with the same name never inherits
// an old pin, shelf writes only land for books that exist, a retried delete
// finishes an interrupted deletion, the startup sweep removes files of
// committed deletions, and a profile migration moves every per-user store.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-book-state-'));
const DATA_DIR = path.join(testRoot, 'data');
const CACHE_DIR = path.join(testRoot, 'cache');
process.env.DATA_DIR = DATA_DIR;
process.env.CACHE_DIR = CACHE_DIR;
process.env.XANDRIO_PREGENERATE_ON_IMPORT = 'false';
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

const writeJSON = (name, value) => fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value));
const readJSON = name => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));

writeJSON('books.json', {
  live: { id: 'live', title: 'Live', addedBy: null, path: path.join(CACHE_DIR, 'live.epub') }
});
fs.writeFileSync(path.join(CACHE_DIR, 'live.epub'), 'x');
// A deletion committed before the process stopped, whose cleanup never ran.
writeJSON('book-deletions.json', {
  version: 1,
  revision: 2,
  pending: {},
  deletions: {
    crashed: { bookId: 'crashed', revision: 1, deletedAt: '2026-01-01T00:00:00.000Z' },
    failed: { bookId: 'failed', revision: 2, deletedAt: '2026-01-01T00:00:00.000Z' }
  }
});
for (const name of ['crashed.epub', 'crashed_cover.jpg', 'crashed_ch0.mp3', 'failed.epub', 'failed_ch1.mp3']) {
  fs.writeFileSync(path.join(CACHE_DIR, name), 'x');
}
// The settings snapshot is read when the server module loads.
writeJSON('settings.json', {
  voice: 'kokoro:af_heart',
  bookNarration: {
    live: { voiceId: 'chatterbox:ghost', fallbackPolicy: 'wait' },
    failed: { voiceId: 'kokoro:af_heart', fallbackPolicy: 'wait' }
  }
});

const { app, __test: hooks } = require('../server');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}
const assert = require('assert');

function wavBuffer() {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(16)]);
}

function cloneForm(name) {
  const form = new FormData();
  form.append('name', name);
  form.append('authorityConfirmed', 'true');
  form.append('audio', new Blob([wavBuffer()], { type: 'audio/wav' }), 'ref.wav');
  return form;
}

(async () => {
  console.log('\n--- Book state integrity (server) ---');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, route, body) => fetch(`${base}${route}`, {
    method,
    ...(body instanceof FormData ? { body } : body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  }).then(async response => ({ status: response.status, body: await response.json().catch(() => null) }));

  try {
    await test('a book pinned to a voice that no longer exists falls back to the default narrator', async () => {
      assert.strictEqual(hooks.getActiveVoice('live'), 'kokoro:af_heart');
      const narration = hooks.getBookNarration('live');
      assert.strictEqual(narration.voiceId, 'kokoro:af_heart');
      assert.strictEqual(narration.inherited, true);
    });

    await test('a new clone never satisfies an old pin left on its id', async () => {
      const created = await send('POST', '/api/voices/clone', cloneForm('Ghost'));
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      assert.strictEqual(created.body.voice.id, 'ghost');
      assert.strictEqual(readJSON('settings.json').bookNarration.live, undefined, 'the stale pin is cleared');
      assert.strictEqual(hooks.getActiveVoice('live'), 'kokoro:af_heart');
    });

    await test('deleting a clone clears every book pinned to it', async () => {
      const created = await send('POST', '/api/voices/clone', cloneForm('Narrator'));
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      const settings = readJSON('settings.json');
      settings.voice = 'chatterbox:narrator';
      settings.bookNarration.live = { voiceId: 'chatterbox:narrator', fallbackPolicy: 'wait' };
      writeJSON('settings.json', settings);
      await hooks.refreshSettingsSnapshots();
      assert.strictEqual(hooks.getActiveVoice('live'), 'chatterbox:narrator');

      const removed = await send('DELETE', '/api/voices/clone/narrator');
      assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
      const after = readJSON('settings.json');
      assert.notStrictEqual(after.voice, 'chatterbox:narrator', 'the global choice falls back to the default');
      assert.strictEqual(after.bookNarration.live, undefined);
      assert(after.bookNarration.failed, 'pins to other voices stay');
      assert.strictEqual(removed.body.booksReset, 1);
      assert.strictEqual(hooks.getActiveVoice('live'), after.voice);
    });

    await test('a shelf write for a book that does not exist is refused', async () => {
      assert.strictEqual(await hooks.addBookToShelf('reader', 'missing'), false);
      assert.strictEqual(await hooks.addBookToShelf('reader', 'live'), true);
      const shelves = readJSON('shelves.json');
      assert.deepStrictEqual(Object.keys(shelves.users.reader.books), ['live']);
    });

    await test('retrying the delete of a committed deletion finishes its cleanup', async () => {
      const result = await send('DELETE', '/api/book/failed');
      assert.strictEqual(result.status, 200, JSON.stringify(result.body));
      assert(!fs.existsSync(path.join(CACHE_DIR, 'failed.epub')));
      assert(!fs.existsSync(path.join(CACHE_DIR, 'failed_ch1.mp3')));
      assert.strictEqual(readJSON('settings.json').bookNarration.failed, undefined, 'per-book narrator is removed');
      const never = await send('DELETE', '/api/book/never-existed');
      assert.strictEqual(never.status, 404);
    });

    await test('the startup sweep removes files of committed deletions and keeps live books', async () => {
      const result = await hooks.sweepDeletedBookArtifacts();
      assert.strictEqual(result.removed, 3, JSON.stringify(result));
      const left = fs.readdirSync(CACHE_DIR).filter(name => !fs.statSync(path.join(CACHE_DIR, name)).isDirectory());
      assert.deepStrictEqual(left, ['live.epub']);
    });

    await test('the startup sweep refuses to run when books.json is missing', async () => {
      fs.writeFileSync(path.join(CACHE_DIR, 'crashed.epub'), 'x');
      fs.renameSync(path.join(DATA_DIR, 'books.json'), path.join(DATA_DIR, 'books.json.moved'));
      try {
        const result = await hooks.sweepDeletedBookArtifacts();
        assert.strictEqual(result.skipped, 'catalog-unavailable');
        assert(fs.existsSync(path.join(CACHE_DIR, 'crashed.epub')));
      } finally {
        fs.renameSync(path.join(DATA_DIR, 'books.json.moved'), path.join(DATA_DIR, 'books.json'));
      }
    });

    await test('profile migration moves shelves, bookmarks, client settings and merges queues', async () => {
      writeJSON('shelves.json', { users: { default: { books: { live: { addedAt: '1' } } } } });
      writeJSON('bookmarks.json', { users: { default: { live: [{ id: 'bm_1', chapterIndex: 0, timestamp: 1 }] } } });
      writeJSON('client-settings.json', { users: { default: { smartRewindEnabled: false } } });
      writeJSON('listening-queues.json', {
        users: {
          default: { bookIds: ['live', 'b'], autoContinue: true, bookSettings: {} },
          usr_target: { bookIds: ['c'], autoContinue: true, bookSettings: {} }
        }
      });
      const result = await send('POST', '/api/sync/profile', { userId: 'usr_target', migrateFromUserId: 'default', name: 'Me' });
      assert.strictEqual(result.status, 200, JSON.stringify(result.body));
      assert(readJSON('shelves.json').users.usr_target.books.live, 'shelf moved');
      assert.strictEqual(readJSON('bookmarks.json').users.usr_target.live[0].id, 'bm_1', 'bookmarks moved');
      assert.strictEqual(readJSON('client-settings.json').users.usr_target.smartRewindEnabled, false, 'client settings moved');
      assert.deepStrictEqual(readJSON('listening-queues.json').users.usr_target.bookIds, ['c', 'live', 'b'], 'queues merged');
    });
  } finally {
    server.close();
  }

  console.log(`\nBook state integrity (server) tests: ${passed} passed, ${failed} failed`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
