/**
 * Profile migration retry-idempotency tests.
 *
 * The profile route persists users.json before it migrates positions and the
 * listening queue. A process failure at that boundary is safe to retry: the
 * source profiles remain available, already-migrated target values win, and a
 * later retry converges without changing either migrated store.
 * Run: node test/test-profile-migration-idempotency.js
 */

const assert = require('assert');
const { createUserLibraryState } = require('../lib/user-library-state');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ❌ ${name}`);
    console.error(error.stack || error);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createJsonStore(initialFiles, failAfterUsersOnce = false) {
  const files = clone(initialFiles);
  let shouldFailAfterUsers = failAfterUsersOnce;

  return {
    files,
    async updateJSON(name, updater) {
      const next = clone(files[name]);
      const result = updater(next);
      files[name] = next;
      if (name === 'users.json' && shouldFailAfterUsers) {
        shouldFailAfterUsers = false;
        throw new Error('injected crash after users.json persistence');
      }
      return result;
    }
  };
}

async function runProfileMigration(store, state, fromUserId, toUserId) {
  // This is the persistence ordering used by POST /api/sync/profile: profile
  // creation is committed first, then each independently persisted scoped
  // store gets its target-wins merge.
  await store.updateJSON('users.json', data => {
    const users = state.normalizeUsersStore(data);
    users.users[toUserId] ||= {
      id: toUserId,
      name: 'Migrated Library',
      createdAt: '2025-01-01T00:00:00.000Z',
      devices: {}
    };
  });
  await store.updateJSON('positions.json', data => {
    state.migratePositions(data, fromUserId, toUserId);
  });
  await store.updateJSON('listening-queue.json', data => {
    state.migrateUserScopedStore(data, fromUserId, toUserId);
  });
}

(async () => {
  const state = createUserLibraryState();
  const legacyUserId = 'default';
  const targetUserId = 'usr_retry';
  const initialFiles = {
    'users.json': { users: { default: { id: 'default', name: 'Legacy Library', devices: {} } } },
    'positions.json': {
      users: {
        default: {
          sourceOnly: { chapterIndex: 1, timestamp: 12 },
          conflict: { chapterIndex: 2, timestamp: 20 }
        },
        usr_retry: {
          targetOnly: { chapterIndex: 4, timestamp: 40 },
          conflict: { chapterIndex: 9, timestamp: 90 }
        }
      }
    },
    'listening-queue.json': {
      users: {
        default: {
          sourceOnly: { queuedAt: 1 },
          conflict: { queuedAt: 2 }
        },
        usr_retry: {
          targetOnly: { queuedAt: 4 },
          conflict: { queuedAt: 9 }
        }
      }
    }
  };

  await test('retry after a crash between profile and scoped-state writes converges without loss', async () => {
    const store = createJsonStore(initialFiles, true);

    await assert.rejects(
      () => runProfileMigration(store, state, legacyUserId, targetUserId),
      /injected crash after users\.json persistence/
    );
    assert(store.files['users.json'].users[targetUserId], 'the target profile was persisted before the crash');
    assert.deepStrictEqual(store.files['positions.json'], initialFiles['positions.json'], 'the crash occurred before positions migration');
    assert.deepStrictEqual(store.files['listening-queue.json'], initialFiles['listening-queue.json'], 'the crash occurred before queue migration');

    await runProfileMigration(store, state, legacyUserId, targetUserId);
    const afterRetry = clone(store.files);

    assert.deepStrictEqual(afterRetry['positions.json'].users.default, initialFiles['positions.json'].users.default, 'retry preserves source positions');
    assert.deepStrictEqual(afterRetry['listening-queue.json'].users.default, initialFiles['listening-queue.json'].users.default, 'retry preserves source queue entries');
    assert.deepStrictEqual(afterRetry['positions.json'].users[targetUserId], {
      sourceOnly: { chapterIndex: 1, timestamp: 12 },
      targetOnly: { chapterIndex: 4, timestamp: 40 },
      conflict: { chapterIndex: 9, timestamp: 90 }
    }, 'retry merges positions while retaining target conflicts');
    assert.deepStrictEqual(afterRetry['listening-queue.json'].users[targetUserId], {
      sourceOnly: { queuedAt: 1 },
      targetOnly: { queuedAt: 4 },
      conflict: { queuedAt: 9 }
    }, 'retry merges queue entries while retaining target conflicts');

    await runProfileMigration(store, state, legacyUserId, targetUserId);
    assert.deepStrictEqual(store.files, afterRetry, 'a second completed migration produces the same persisted state');
  });

  console.log(`\nProfile migration idempotency tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
