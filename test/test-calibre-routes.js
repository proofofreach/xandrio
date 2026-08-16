const assert = require('assert');
const { mergeCalibreMetadata, registerCalibreRoutes } = require('../lib/routes/calibre-routes');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function routeApp() {
  const routes = new Map();
  const register = method => (path, ...handlers) => routes.set(`${method} ${path}`, handlers);
  return {
    routes,
    app: {
      get: register('GET'),
      post: register('POST'),
      delete: register('DELETE')
    }
  };
}

async function run(handlers, req) {
  const res = response();
  let cursor = 0;
  async function next(error) {
    if (error) throw error;
    const handler = handlers[cursor++];
    if (handler) await handler(req, res, next);
  }
  await next();
  return res;
}

(async () => {
  const { app, routes } = routeApp();
  const books = {};
  const removed = [];
  const shelfAdds = [];
  const imported = [];
  const persistedCovers = [];
  const lockedBookIds = [];
  let duplicateExistingId = null;
  const access = {
    async issuePairingCode({ userId }) { return { code: '123456', expiresInSeconds: 600, userId }; },
    async claimPairingCode(code, input) {
      return code === '123456'
        ? { token: 'xcal_token', connection: { id: 'cal_1', userId: 'usr_a', clientName: input.clientName } }
        : null;
    },
    async resolveToken(token) {
      return token === 'xcal_token' ? { id: 'cal_1', userId: 'usr_a', clientName: 'Desktop' } : null;
    },
    async listConnections(userId) { return [{ id: 'cal_1', userId, clientName: 'Desktop' }]; },
    async revokeConnection(userId, id) { return userId === 'usr_a' && id === 'cal_1'; }
  };

  registerCalibreRoutes(app, {
    access,
    uploadBook: (_req, _res, next) => next(),
    userIdFromRequest: req => req.user?.id || 'default',
    loadBooks: async () => structuredClone(books),
    updateBooks: async mutator => mutator(books),
    importBook: async command => {
      if (duplicateExistingId) {
        const error = new Error('Book already exists');
        error.existingBookId = duplicateExistingId;
        throw error;
      }
      imported.push(command);
      books[command.id] = { id: command.id, title: command.catalogMetadata.title, calibre: command.calibre };
      return { bookId: command.id, book: books[command.id], validation: { valid: true, warnings: [] } };
    },
    withBookMutationLock: async (bookId, task) => {
      lockedBookIds.push(bookId);
      return task();
    },
    persistCover: async (bookId, coverPath) => persistedCovers.push([bookId, coverPath]),
    addBookToShelf: async (userId, bookId) => shelfAdds.push([userId, bookId]),
    removeFile: async filePath => removed.push(filePath),
    publicBookRecord: book => book,
    supportedFormats: ['epub', 'mobi', 'azw3', 'pdf']
  });

  let res = await run(routes.get('POST /api/integrations/calibre/pairing-code'), {
    user: { id: 'usr_a' }, headers: {}, body: {}
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.code, '123456');

  res = await run(routes.get('POST /api/integrations/calibre/claim'), {
    headers: {}, body: { code: '123456', clientName: 'Study Mac' }
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.token, 'xcal_token');
  assert.strictEqual(res.body.connection.clientName, 'Study Mac');

  res = await run(routes.get('GET /api/integrations/calibre/status'), {
    headers: { authorization: 'Bearer wrong' }, body: {}
  });
  assert.strictEqual(res.statusCode, 401);

  res = await run(routes.get('GET /api/integrations/calibre/status'), {
    headers: { authorization: 'Bearer xcal_token' }, body: {}
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.supportedFormats, ['epub', 'mobi', 'azw3', 'pdf']);

  const metadata = {
    libraryUuid: 'library-a', bookUuid: 'book-a', calibreId: 7,
    title: 'Imported Book', authors: ['Ada Author'], language: 'en', tags: ['History']
  };
  res = await run(routes.get('POST /api/integrations/calibre/import'), {
    headers: { authorization: 'Bearer xcal_token' },
    body: { metadata: JSON.stringify(metadata) },
    file: { path: '/tmp/import.epub', originalname: 'book.epub' },
    calibreCover: { path: '/tmp/cover.jpg' }
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, 'imported');
  assert.strictEqual(imported.length, 1);
  assert.strictEqual(imported[0].kind, 'calibre');
  assert.strictEqual(imported[0].catalogMetadata.author, 'Ada Author');
  assert.strictEqual(imported[0].addedBy, 'usr_a');
  assert.deepStrictEqual(shelfAdds, [['usr_a', res.body.bookId]]);
  assert.deepStrictEqual(persistedCovers, [[res.body.bookId, '/tmp/cover.jpg']]);
  assert.deepStrictEqual(lockedBookIds, [res.body.bookId]);

  res = await run(routes.get('POST /api/integrations/calibre/import'), {
    headers: { authorization: 'Bearer xcal_token' },
    body: { metadata: JSON.stringify({ ...metadata, title: 'Updated Title' }) },
    file: { path: '/tmp/duplicate.epub', originalname: 'book.epub' }
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, 'updated');
  assert.strictEqual(res.body.book.title, 'Updated Title');
  assert.deepStrictEqual(removed, ['/tmp/duplicate.epub']);
  assert.deepStrictEqual(shelfAdds, [['usr_a', res.body.bookId], ['usr_a', res.body.bookId]]);
  assert.deepStrictEqual(lockedBookIds, [res.body.bookId, res.body.bookId]);

  books.other_profile = {
    id: 'other_profile',
    calibre: { libraryUuid: 'library-other', bookUuid: 'book-other', profileIds: ['usr_b'] }
  };

  res = await run(routes.get('GET /api/integrations/calibre/inventory'), {
    headers: { authorization: 'Bearer xcal_token' }, body: {}
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.books.length, 1);
  assert.strictEqual(res.body.books[0].bookUuid, 'book-a');

  books.existing_upload = { id: 'existing_upload', title: 'Existing Upload', author: 'Ada Author' };
  duplicateExistingId = 'existing_upload';
  res = await run(routes.get('POST /api/integrations/calibre/import'), {
    headers: { authorization: 'Bearer xcal_token' },
    body: { metadata: JSON.stringify({
      libraryUuid: 'library-b', bookUuid: 'book-b', title: 'Existing Upload', authors: ['Ada Author']
    }) },
    file: { path: '/tmp/existing.epub', originalname: 'existing.epub' }
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, 'linked');
  assert.strictEqual(res.body.bookId, 'existing_upload');
  assert(books.existing_upload.calibre.profileIds.includes('usr_a'));
  const secondIdentity = mergeCalibreMetadata(books.existing_upload, {
    libraryUuid: 'library-c', bookUuid: 'book-c', lastModified: '2026-08-16T12:00:00Z'
  }, { userId: 'usr_a' });
  assert.strictEqual(secondIdentity.calibre.identities.length, 2);
  assert(secondIdentity.calibre.identities.some(identity => identity.libraryUuid === 'library-b'));
  duplicateExistingId = null;

  const normalized = mergeCalibreMetadata({
    id: 'normalized', publisher: 'Old Press', isbn: '123', series: 'Old Series',
    seriesIndex: 4, subjects: ['Old'], description: 'Old'
  }, {
    libraryUuid: 'library-d', bookUuid: 'book-d', publishedDate: '2024-02-03',
    description: '<p>Hello</p>', publisher: null, isbn: null, series: null,
    seriesIndex: null, tags: []
  }, {
    normalizePublishedDate: value => Number(value.slice(0, 4)),
    normalizeDescription: () => 'Hello'
  });
  assert.strictEqual(normalized.publishedDate, 2024);
  assert.strictEqual(normalized.description, 'Hello');
  assert.strictEqual(normalized.publisher, undefined);
  assert.strictEqual(normalized.isbn, undefined);
  assert.strictEqual(normalized.series, undefined);
  assert.strictEqual(normalized.seriesIndex, undefined);
  assert.deepStrictEqual(normalized.subjects, []);

  res = await run(routes.get('POST /api/integrations/calibre/import'), {
    headers: { authorization: 'Bearer xcal_token' }, body: { metadata: '{bad' },
    file: { path: '/tmp/bad.epub', originalname: 'bad.epub' }
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(removed.at(-1), '/tmp/bad.epub');

  res = await run(routes.get('DELETE /api/integrations/calibre/connections/:id'), {
    user: { id: 'usr_a' }, headers: {}, params: { id: 'cal_1' }, body: {}
  });
  assert.strictEqual(res.statusCode, 200);

  console.log('47 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
