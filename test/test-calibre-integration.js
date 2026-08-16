const assert = require('assert');
const {
  createCalibreAccessStore,
  sanitizeCalibreMetadata,
  stableCalibreBookId,
  validateCalibreAccessStore
} = require('../lib/calibre-integration');

function memoryJsonStore() {
  const state = {};
  return {
    async load(_filePath, fallback = {}) {
      return Object.keys(state).length ? structuredClone(state) : structuredClone(fallback);
    },
    async update(_filePath, mutator, fallback = {}) {
      const current = Object.keys(state).length ? structuredClone(state) : structuredClone(fallback);
      const result = await mutator(current);
      Object.keys(state).forEach(key => delete state[key]);
      Object.assign(state, current);
      return result;
    }
  };
}

(async () => {
  let now = Date.parse('2026-08-16T12:00:00Z');
  const access = createCalibreAccessStore({
    filePath: 'calibre-access.json',
    jsonStore: memoryJsonStore(),
    now: () => now
  });

  const issued = await access.issuePairingCode({ userId: 'usr_reader' });
  assert.match(issued.code, /^\d{6}$/);
  assert.strictEqual(issued.expiresInSeconds, 600);

  const claimed = await access.claimPairingCode(issued.code, { clientName: 'Study Mac' });
  assert.match(claimed.token, /^xcal_[A-Za-z0-9_-]+$/);
  assert.strictEqual(claimed.connection.userId, 'usr_reader');
  assert.strictEqual(claimed.connection.clientName, 'Study Mac');
  assert(!JSON.stringify(await access.listConnections('usr_reader')).includes(claimed.token));
  assert.strictEqual(await access.claimPairingCode(issued.code, { clientName: 'Again' }), null);

  const resolved = await access.resolveToken(claimed.token);
  assert.strictEqual(resolved.id, claimed.connection.id);
  assert.strictEqual(resolved.userId, 'usr_reader');
  assert.strictEqual(await access.resolveToken('xcal_wrong'), null);
  now += 1_000;
  await access.resolveToken(claimed.token);
  assert.strictEqual((await access.listConnections('usr_reader'))[0].lastUsedAt, new Date(now).toISOString());

  assert.strictEqual(await access.revokeConnection('usr_reader', resolved.id), true);
  assert.strictEqual(await access.resolveToken(claimed.token), null);

  const expiring = await access.issuePairingCode({ userId: 'default' });
  now += 10 * 60 * 1000 + 1;
  assert.strictEqual(await access.claimPairingCode(expiring.code), null);

  const firstId = stableCalibreBookId('library-a', 'book-a');
  assert.match(firstId, /^[a-f0-9]{40}$/);
  assert.strictEqual(firstId, stableCalibreBookId('library-a', 'book-a'));
  assert.notStrictEqual(firstId, stableCalibreBookId('library-a', 'book-b'));
  assert.throws(() => stableCalibreBookId('', 'book-a'), /library/i);

  assert.deepStrictEqual(sanitizeCalibreMetadata({
    libraryUuid: ' library-a ',
    bookUuid: ' book-a ',
    calibreId: 42,
    title: '  A   Book  ',
    authors: ['Ada Author', '', 'Bob Writer'],
    language: 'EN-us',
    isbn: ' 9780000000001 ',
    publisher: ' Press ',
    publishedDate: '2024-02-03T00:00:00Z',
    description: '<p>Hello</p>',
    tags: ['One', 'Two', 'One'],
    series: 'Series Name',
    seriesIndex: 2,
    lastModified: '2026-08-16T10:00:00Z'
  }), {
    libraryUuid: 'library-a',
    bookUuid: 'book-a',
    calibreId: '42',
    title: 'A Book',
    authors: ['Ada Author', 'Bob Writer'],
    author: 'Ada Author & Bob Writer',
    language: 'en-us',
    isbn: '9780000000001',
    publisher: 'Press',
    publishedDate: '2024-02-03T00:00:00Z',
    description: '<p>Hello</p>',
    tags: ['One', 'Two'],
    series: 'Series Name',
    seriesIndex: 2,
    lastModified: '2026-08-16T10:00:00Z'
  });

  assert.deepStrictEqual(sanitizeCalibreMetadata({
    libraryUuid: 'library-a', bookUuid: 'book-a', publisher: null,
    description: '', tags: [], seriesIndex: null
  }), {
    libraryUuid: 'library-a', bookUuid: 'book-a', publisher: null,
    description: null, tags: [], seriesIndex: null
  });

  const disabledAccess = createCalibreAccessStore({
    filePath: 'disabled-calibre-access.json',
    jsonStore: memoryJsonStore(),
    isUserActive: async userId => userId !== 'usr_disabled'
  });
  const disabledPairing = await disabledAccess.issuePairingCode({ userId: 'usr_disabled' });
  const disabledConnection = await disabledAccess.claimPairingCode(disabledPairing.code);
  assert.strictEqual(await disabledAccess.resolveToken(disabledConnection.token), null);

  assert.strictEqual(validateCalibreAccessStore({ pairings: {}, connections: {} }), true);
  assert.match(validateCalibreAccessStore({ pairings: [], connections: {} }), /pairings/);
  assert.match(validateCalibreAccessStore({ pairings: {}, connections: { bad: { id: 'other' } } }), /connection/);

  console.log('27 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
