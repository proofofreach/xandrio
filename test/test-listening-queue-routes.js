const assert = require('assert');
const { registerListeningQueueRoutes } = require('../lib/routes/listening-queue-routes');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

(async () => {
  const handlers = new Map();
  const app = {};
  for (const method of ['get', 'put', 'post', 'patch', 'delete']) {
    app[method] = (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler);
  }
  const files = {
    queues: {},
    books: {
      one: { id: 'one', title: 'North, Book 1', author: 'Author' },
      two: { id: 'two', title: 'North, Book 2', author: 'Author' },
      three: { id: 'three', title: 'Elsewhere', author: 'Other' }
    },
    positions: { users: { user_a: {} } }
  };
  const loadJSON = async file => structuredClone(files[file] || {});
  const updateJSON = async (file, mutator) => {
    const draft = structuredClone(files[file] || {});
    const result = await mutator(draft);
    files[file] = draft;
    return result;
  };
  registerListeningQueueRoutes(app, {
    listeningQueueFile: 'queues',
    booksFile: 'books',
    positionsFile: 'positions',
    loadJSON,
    updateJSON
  });
  const req = (body = {}, params = {}) => ({
    body,
    params,
    query: {},
    headers: { 'x-xandrio-user-id': 'user_a' }
  });

  let res = response();
  await handlers.get('POST /api/listening-queue/items')(req({ bookId: 'one' }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.queue.bookIds, ['one']);

  res = response();
  await handlers.get('GET /api/listening-queue')(req(), res);
  assert.deepStrictEqual(res.body.books.map(book => book.id), ['one']);

  res = response();
  await handlers.get('PUT /api/listening-queue/books/:bookId/settings')(
    req({ settings: { playbackSpeed: 1.5, ignored: true } }, { bookId: 'one' }),
    res
  );
  assert.deepStrictEqual(res.body.settings, { playbackSpeed: 1.5 });

  res = response();
  await handlers.get('PUT /api/listening-queue/books/:bookId/settings')(
    req({ settings: { playbackSpeed: null } }, { bookId: 'one' }),
    res
  );
  assert.deepStrictEqual(res.body.settings, {});

  res = response();
  await handlers.get('POST /api/listening-queue/advance')(req({ finishedBookId: 'one' }), res);
  assert.strictEqual(res.body.nextBookId, 'two');
  assert.strictEqual(res.body.seriesSuggested, true);

  files.queues.users.user_a.bookIds = ['one', 'two', 'three'];
  files.positions.users.user_a.two = { finished: true };
  res = response();
  await handlers.get('POST /api/listening-queue/advance')(req({ finishedBookId: 'one' }), res);
  assert.strictEqual(res.body.nextBookId, 'three');

  // A flag toggle from a client whose cached list is stale keeps the stored
  // list, and a stale full-list write is refused.
  files.queues.users.user_a.bookIds = ['two'];
  res = response();
  await handlers.get('GET /api/listening-queue')(req(), res);
  const readRevision = res.body.queue.revision;
  res = response();
  await handlers.get('POST /api/listening-queue/items')(req({ bookId: 'three' }), res);
  assert.deepStrictEqual(res.body.queue.bookIds, ['two', 'three']);
  assert.strictEqual(res.body.queue.revision, readRevision + 1);

  res = response();
  await handlers.get('PUT /api/listening-queue')(req({ queue: { autoContinue: false } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.queue.bookIds, ['two', 'three']);
  assert.strictEqual(res.body.queue.autoContinue, false);
  assert.strictEqual(res.body.queue.revision, readRevision + 1);

  res = response();
  await handlers.get('PUT /api/listening-queue')(req({ queue: { bookIds: ['two'], autoContinue: true, revision: readRevision } }), res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'QUEUE_REVISION_CONFLICT');
  assert.deepStrictEqual(res.body.queue.bookIds, ['two', 'three']);
  assert.deepStrictEqual(files.queues.users.user_a.bookIds, ['two', 'three']);
  assert.strictEqual(files.queues.users.user_a.autoContinue, false, 'a refused write changes nothing');

  res = response();
  await handlers.get('PUT /api/listening-queue')(req({ queue: { bookIds: ['three', 'two'] } }), res);
  assert.strictEqual(res.statusCode, 409, 'a full list without a revision is refused');

  res = response();
  await handlers.get('PUT /api/listening-queue')(req({ queue: { bookIds: ['three', 'two'], revision: readRevision + 1 } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.queue.bookIds, ['three', 'two']);
  assert.strictEqual(res.body.queue.revision, readRevision + 2);

  res = response();
  await handlers.get('PUT /api/listening-queue')(req({ queue: {} }), res);
  assert.strictEqual(res.statusCode, 400, 'an empty update is refused');

  const client = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'features', 'listening-queue.js'), 'utf8');
  for (const call of client.matchAll(/apiSend\('PUT', '\/api\/listening-queue',[\s\S]*?\}\);/g)) {
    assert.ok(!call[0].includes('bookIds') || call[0].includes('revision'), 'every client list write names a revision');
  }

  console.log('8 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
