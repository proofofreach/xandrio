/**
 * User Library State Tests
 *
 * Exercises the production state interface shared by sync profiles, positions,
 * pairing codes, and user-scoped library features.
 * Run: node test/test-user-library-state.js
 */

const { createUserLibraryState } = require('../lib/user-library-state');

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

function section(name) {
  console.log(`\n━━━ ${name} ━━━`);
}

const state = createUserLibraryState({ now: () => 1_735_689_600_000 });

section('1. position conflict resolution');

(() => {
  // updatedAtMs is wall-clock epoch milliseconds -- it is rendered with
  // toISOString() and compared against the server clock -- so the fixtures use
  // times around the injected clock rather than small counters.
  const NOW = 1_735_689_600_000;
  const positions = {
    users: {
      alice: {
        bookA: { chapterIndex: 3, timestamp: 20, updatedAtMs: NOW - 2_000, finished: true }
      }
    }
  };

  const ignored = state.recordPosition(positions, {
    userId: 'alice',
    bookId: 'bookA',
    chapterIndex: 2,
    timestamp: 50,
    updatedAtMs: NOW - 3_000,
    wasPlaying: true
  });
  assertEqual(ignored.ignored, true, 'Ignores stale positions that would move playback backward');
  assertEqual(ignored.position.chapterIndex, 3, 'Keeps the newer saved chapter');

  const accepted = state.recordPosition(positions, {
    userId: 'alice',
    bookId: 'bookA',
    chapterIndex: 4,
    timestamp: 5,
    chapterStructureKey: 'v1-current',
    updatedAtMs: NOW - 1_000,
    wasPlaying: false
  });
  assertEqual(accepted.ignored, undefined, 'Accepts newer forward progress');
  assertEqual(accepted.position.chapterIndex, 4, 'Stores the newer chapter');
  assertEqual(accepted.position.chapterStructureKey, 'v1-current', 'Stores the chapter structure identity with playback progress');
  assertEqual(accepted.position.finished, true, 'Preserves completion until an explicit backward update is allowed');

  // updatedAtMs is the sole conflict key and comes from the client, so an
  // out-of-range value must not become the stored high-water mark -- that
  // would make every later real update compare as older and freeze the book.
  const farFuture = state.recordPosition(positions, {
    userId: 'alice',
    bookId: 'bookA',
    chapterIndex: 5,
    timestamp: 1,
    updatedAtMs: 8.64e15,
    wasPlaying: false
  });
  assertEqual(farFuture.position.updatedAtMs, NOW, 'A far-future client timestamp falls back to the server clock');

  const laterStillWins = state.recordPosition(positions, {
    userId: 'alice',
    bookId: 'bookA',
    chapterIndex: 6,
    timestamp: 1,
    wasPlaying: false
  });
  assertEqual(laterStillWins.position.chapterIndex, 6, 'A normal update is still accepted after a poisoned timestamp');

  const ancient = state.recordPosition(positions, {
    userId: 'alice',
    bookId: 'bookA',
    chapterIndex: 7,
    timestamp: 1,
    updatedAtMs: 100,
    wasPlaying: false
  });
  assertEqual(ancient.position.updatedAtMs, NOW, 'An implausibly old client timestamp falls back to the server clock');
})();

section('2. canonical sync profile state');

(() => {
  const users = state.normalizeUsersStore({});
  const user = { id: 'usr_alice', name: 'Alice Library', createdAt: '2025-01-01T00:00:00.000Z', devices: {} };
  state.upsertDevice(user, 'dev_phone', '  Alice\nPhone  ');
  users.users[user.id] = user;

  const profile = state.publicProfile(user, 'dev_phone');
  assertEqual(state.userIdFromRequest({ headers: { 'x-xandrio-user-id': 'usr_alice' }, query: {}, body: {} }), 'usr_alice', 'Uses a valid sync user header');
  assertEqual(state.userIdFromRequest({ headers: { 'x-xandrio-user-id': 'bad/user' }, query: {}, body: {} }), 'default', 'Rejects unsafe sync user identifiers');
  assertEqual(state.userIdFromRequest({ user: { id: 'usr_account' }, headers: { 'x-xandrio-user-id': 'usr_alice' }, query: {}, body: {} }), 'usr_account', 'An authenticated account overrides self-asserted headers');
  assertEqual(state.userIdFromRequest({ user: { id: null, lan: true }, headers: { 'x-xandrio-user-id': 'usr_alice' }, query: {}, body: {} }), 'usr_alice', 'Trusted-LAN callers keep header-based sync identity');
  assertEqual(profile.deviceId, 'dev_phone', 'Includes the active device in public profile state');
  assertEqual(profile.devices[0].name, 'Alice Phone', 'Normalizes display names before publishing devices');
})();

section('3. pairing-code transitions');

(() => {
  const pairings = { codes: [{ codeHash: 'expired', expiresAtMs: 1, usedAt: null }] };
  const issued = state.issuePairingCode(pairings, 'usr_alice');
  assert(/^\d{6}$/.test(issued.code), 'Issues a six-digit pairing code');
  assertEqual(pairings.codes.length, 1, 'Prunes expired pairing codes before issuing a replacement');

  const claim = state.findPairingClaim(pairings, `${issued.code.slice(0, 3)}-${issued.code.slice(3)}`);
  assertEqual(claim.userId, 'usr_alice', 'Finds a valid formatted pairing code for its profile');
  state.consumePairingClaim(claim);
  assert(Boolean(pairings.codes[0].usedAt), 'Marks a claimed code as used only after consumption');
  assertEqual(state.findPairingClaim(pairings, issued.code), null, 'Does not allow a consumed code to be claimed twice');
})();

section('4. cross-user book-position cleanup');

(() => {
  const positions = {
    users: {
      alice: { bookA: { timestamp: 1 }, bookB: { timestamp: 2 } },
      bob: { bookA: { timestamp: 3 } }
    }
  };
  state.removeBookPositions(positions, 'bookA');

  assert(!positions.users.alice.bookA, 'Removes a deleted book position from the first user');
  assert(!positions.users.bob.bookA, 'Removes a deleted book position from every user');
  assert(Boolean(positions.users.alice.bookB), 'Preserves positions for unrelated books');
})();

section('4b. chapter-structure migration');

(() => {
  const positions = {
    users: {
      alice: { bookA: { timestamp: 1 }, bookB: { timestamp: 2 } },
      bob: { bookA: { timestamp: 3 } }
    }
  };
  state.setBookPositionsStructureKey(positions, 'bookA', 'v1-current');

  assertEqual(positions.users.alice.bookA.chapterStructureKey, 'v1-current', 'Migrates an existing position without discarding progress');
  assertEqual(positions.users.bob.bookA.chapterStructureKey, 'v1-current', 'Migrates the same book across sync users');
  assertEqual(positions.users.alice.bookB.chapterStructureKey, undefined, 'Does not stamp unrelated books');
})();

section('5. user-scoped position reads');

(() => {
  const positions = {
    users: {
      alice: { bookA: { timestamp: 1 }, bookB: { timestamp: 2 } },
      bob: { bookA: { timestamp: 3 } }
    }
  };
  const selected = state.positionsForBooks(positions, 'alice', ['bookB', 'missing', 'bookA']);

  assertEqual(selected.bookB.timestamp, 2, 'Returns the current user’s requested position');
  assertEqual(selected.missing, null, 'Represents missing requested positions as null');
  assertEqual(selected.bookA.timestamp, 1, 'Does not read the same book from another user');
})();

section('6. device registration bounds and identity');

(() => {
  // upsertdevice-unbounded-device-records-grow-users-json-forever.md: the
  // device map must not grow without bound, and the oldest (least-recently-
  // seen) device should be evicted to make room for a new one.
  const user = { id: 'usr_bob', name: 'Bob Library', createdAt: '2025-01-01T00:00:00.000Z', devices: {} };
  for (let index = 0; index < 20; index += 1) {
    state.upsertDevice(user, `dev_${index}`, `Device ${index}`);
  }
  assertEqual(Object.keys(user.devices).length, 20, 'Accepts devices up to the cap');
  state.upsertDevice(user, 'dev_20', 'Device 20');
  assertEqual(Object.keys(user.devices).length, 20, 'Never exceeds the device cap');
  assert(!user.devices.dev_0, 'Evicts the least-recently-seen device to make room');
  assert(Boolean(user.devices.dev_20), 'Admits the new device after eviction');
  assert(Boolean(user.devices.dev_19), 'Keeps recently-seen devices');

  // Re-registering an existing device must not itself count as growth or
  // trigger an eviction.
  state.upsertDevice(user, 'dev_20', 'Device 20 renamed');
  assertEqual(Object.keys(user.devices).length, 20, 'Re-registering an existing device does not evict anything');
  assertEqual(user.devices.dev_20.name, 'Device 20 renamed', 'Updates an existing device in place');

  // playback-runway-prefetch-session-key-random-per-request.md: a caller that
  // sends no device id must get a stable id back, not a fresh random one
  // every call, so downstream capacity/dedup keys built from it are reusable.
  const reqA = { headers: {}, query: {}, body: {}, ip: '203.0.113.5' };
  const reqB = { headers: {}, query: {}, body: {}, ip: '203.0.113.5' };
  const reqC = { headers: {}, query: {}, body: {}, ip: '203.0.113.9' };
  const reqD = { headers: {}, query: {}, body: {}, user: { id: 'usr_bob' }, ip: '203.0.113.5' };
  assertEqual(state.deviceIdFromRequest(reqA), state.deviceIdFromRequest(reqB), 'Same caller address yields the same fallback device id');
  assert(state.deviceIdFromRequest(reqA) !== state.deviceIdFromRequest(reqC), 'Different caller addresses yield different fallback device ids');
  assert(state.deviceIdFromRequest(reqD) !== state.deviceIdFromRequest(reqA), 'An authenticated account identity takes priority over the address');
  assert(/^[A-Za-z0-9_-]{1,64}$/.test(state.deviceIdFromRequest(reqA)), 'The fallback device id is still a valid sync id');
  assertEqual(state.deviceIdFromRequest({ headers: { 'x-xandrio-device-id': 'dev_client' }, query: {}, body: {} }), 'dev_client', 'A client-supplied device id still wins');
})();

console.log(`\n${'═'.repeat(50)}`);
console.log(`User library state tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All user library state tests passed! ✅');
