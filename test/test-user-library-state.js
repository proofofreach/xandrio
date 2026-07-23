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
  const positions = {
    users: {
      alice: {
        bookA: { chapterIndex: 3, timestamp: 20, updatedAtMs: 200, finished: true }
      }
    }
  };

  const ignored = state.recordPosition(positions, {
    userId: 'alice',
    bookId: 'bookA',
    chapterIndex: 2,
    timestamp: 50,
    updatedAtMs: 100,
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
    updatedAtMs: 300,
    wasPlaying: false
  });
  assertEqual(accepted.ignored, undefined, 'Accepts newer forward progress');
  assertEqual(accepted.position.chapterIndex, 4, 'Stores the newer chapter');
  assertEqual(accepted.position.chapterStructureKey, 'v1-current', 'Stores the chapter structure identity with playback progress');
  assertEqual(accepted.position.finished, true, 'Preserves completion until an explicit backward update is allowed');
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

console.log(`\n${'═'.repeat(50)}`);
console.log(`User library state tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All user library state tests passed! ✅');
