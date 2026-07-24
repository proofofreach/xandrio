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

  console.log('6 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
