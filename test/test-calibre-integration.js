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
  assert.strictEqual(await disabledAccess.claimPairingCode(disabledPairing.code), null,
    'a disabled account cannot claim a pairing code');

  // Calibre tokens are bound to the account's credential epoch. A password
  // change or admin reset used to leave them valid.
  const credentials = { usr_epoch: { active: true, credentialEpoch: 2, passwordChangedAt: '2026-08-01T00:00:00Z' } };
  const epochJson = memoryJsonStore();
  const epochAccess = createCalibreAccessStore({
    filePath: 'epoch-calibre-access.json',
    jsonStore: epochJson,
    now: () => now,
    accountCredentials: async userId => credentials[userId] || null
  });
  const epochPairing = await epochAccess.issuePairingCode({ userId: 'usr_epoch' });
  const epochClaim = await epochAccess.claimPairingCode(epochPairing.code);
  assert.strictEqual((await epochAccess.resolveToken(epochClaim.token))?.userId, 'usr_epoch');
  const stalePairing = await epochAccess.issuePairingCode({ userId: 'usr_epoch' });
  credentials.usr_epoch = { active: true, credentialEpoch: 3, passwordChangedAt: new Date(now).toISOString() };
  assert.strictEqual(await epochAccess.resolveToken(epochClaim.token), null,
    'a password change revokes Calibre tokens issued before it');
  assert.strictEqual(await epochAccess.claimPairingCode(stalePairing.code), null,
    'a password change kills pending pairing codes');
  const freshPairing = await epochAccess.issuePairingCode({ userId: 'usr_epoch' });
  const freshClaim = await epochAccess.claimPairingCode(freshPairing.code);
  assert.strictEqual((await epochAccess.resolveToken(freshClaim.token))?.userId, 'usr_epoch',
    'a token paired after the change works');
  assert(!('credentialEpoch' in (await epochAccess.listConnections('usr_epoch'))[0]),
    'the epoch is not exposed in the connection list');

  // Connections stored before epoch binding carry no epoch. One created
  // after the last password change stays valid and is stamped with the current
  // epoch; one created before it is refused.
  await epochJson.update('epoch-calibre-access.json', data => {
    data.connections.cal_legacy_new = { id: 'cal_legacy_new', userId: 'usr_epoch', clientName: 'Calibre',
      tokenHash: require('crypto').createHash('sha256').update('xcal_legacy_new').digest('hex'),
      createdAt: new Date(now + 1).toISOString(), lastUsedAt: new Date(now + 1).toISOString() };
    data.connections.cal_legacy_old = { id: 'cal_legacy_old', userId: 'usr_epoch', clientName: 'Calibre',
      tokenHash: require('crypto').createHash('sha256').update('xcal_legacy_old').digest('hex'),
      createdAt: '2026-07-01T00:00:00Z', lastUsedAt: '2026-07-01T00:00:00Z' };
  });
  assert.strictEqual(await epochAccess.resolveToken('xcal_legacy_old'), null,
    'a legacy token created before the last password change is refused');
  assert.strictEqual((await epochAccess.resolveToken('xcal_legacy_new'))?.id, 'cal_legacy_new',
    'a legacy token created after the last password change stays valid');
  credentials.usr_epoch = { active: true, credentialEpoch: 4, passwordChangedAt: new Date(now + 5).toISOString() };
  assert.strictEqual(await epochAccess.resolveToken('xcal_legacy_new'), null,
    'a stamped legacy token is revoked by the next password change');

  // "Sign out other devices" removes every connection and pending code.
  const revokePairing = await epochAccess.issuePairingCode({ userId: 'usr_epoch' });
  const revokeClaim = await epochAccess.claimPairingCode(revokePairing.code);
  const pendingCode = await epochAccess.issuePairingCode({ userId: 'usr_epoch' });
  assert(await epochAccess.revokeAllForUser('usr_epoch') >= 1);
  assert.strictEqual(await epochAccess.resolveToken(revokeClaim.token), null, 'revokeAllForUser revokes tokens');
  assert.strictEqual(await epochAccess.claimPairingCode(pendingCode.code), null, 'revokeAllForUser kills pending codes');

  // Brute-force budget: a 6-digit code is only defensible with a strict
  // attempt limit, so wrong guesses must spend the live pairings.
  const guessStore = createCalibreAccessStore({
    filePath: 'calibre-access.json',
    jsonStore: memoryJsonStore(),
    now: () => now
  });
  const target = await guessStore.issuePairingCode({ userId: 'usr_guess' });
  const wrong = String((Number(target.code) + 1) % 1_000_000).padStart(6, '0');
  for (let attempt = 0; attempt < 9; attempt++) {
    assert.strictEqual(await guessStore.claimPairingCode(wrong), null);
  }
  // Nine misses have not burned the code the operator is looking at.
  const survivor = await guessStore.claimPairingCode(target.code);
  assert.ok(survivor && survivor.token, 'a live code survives a sub-budget guess run');

  const burned = await guessStore.issuePairingCode({ userId: 'usr_guess' });
  const burnedWrong = String((Number(burned.code) + 1) % 1_000_000).padStart(6, '0');
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.strictEqual(await guessStore.claimPairingCode(burnedWrong), null);
  }
  assert.strictEqual(await guessStore.claimPairingCode(burned.code), null,
    'exhausting the attempt budget burns every outstanding pairing');
  // Issuing a new code is the operator-driven reset.
  const reissued = await guessStore.issuePairingCode({ userId: 'usr_guess' });
  const afterReset = await guessStore.claimPairingCode(reissued.code);
  assert.ok(afterReset && afterReset.token, 'a freshly issued code resets the budget');

  // Only one code per user stays claimable, so extra live codes cannot
  // multiply a guesser's hit probability.
  const first = await guessStore.issuePairingCode({ userId: 'usr_single' });
  const second = await guessStore.issuePairingCode({ userId: 'usr_single' });
  assert.strictEqual(await guessStore.claimPairingCode(first.code), null,
    'issuing a new code retires the previous one');
  assert.ok((await guessStore.claimPairingCode(second.code))?.token);

  assert.strictEqual(validateCalibreAccessStore({ pairings: {}, connections: {} }), true);
  assert.match(validateCalibreAccessStore({ pairings: [], connections: {} }), /pairings/);
  assert.match(validateCalibreAccessStore({ pairings: {}, connections: { bad: { id: 'other' } } }), /connection/);

  console.log('43 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
