const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {
  createOfflineReadinessNotifications
} = require('../lib/offline-readiness-notifications');
const jsonStore = require('../lib/json-store');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

function subscription(endpoint = 'https://push.example.test/device-1') {
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: 'public-key',
      auth: 'auth-secret'
    }
  };
}

(async () => {
  await test('stores an owner subscription and sends the prepared-book notification', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-push-'));
    const sent = [];
    const vapid = [];
    const service = createOfflineReadinessNotifications({
      filePath: path.join(dir, 'push-subscriptions.json'),
      vapidPublicKey: 'public-vapid',
      vapidPrivateKey: 'private-vapid',
      vapidSubject: 'mailto:operator@example.test',
      // The send path now runs every endpoint through the SSRF gate before
      // dispatch. These fixtures use a non-resolvable .test hostname, so the
      // check is stubbed to keep this unit test off the network; the gate
      // itself is exercised against real hostnames elsewhere.
      assertTarget: async () => {},
      webPush: {
        setVapidDetails: (...args) => vapid.push(args),
        sendNotification: async (...args) => sent.push(args)
      }
    });

    assert.strictEqual(service.enabled, true);
    assert.strictEqual(service.publicKey, 'public-vapid');
    await service.subscribe('account:device', subscription());
    const result = await service.notifyOwners(['account:device'], {
      bookId: 'book-1',
      title: 'Napoleon',
      bytesTotal: 994_000_000
    });

    assert.deepStrictEqual(vapid, [[
      'mailto:operator@example.test',
      'public-vapid',
      'private-vapid'
    ]]);
    assert.strictEqual(result.sent, 1);
    assert.strictEqual(sent[0][0].endpoint, subscription().endpoint);
    assert.deepStrictEqual(JSON.parse(sent[0][1]), {
      type: 'offline-audio-ready',
      bookId: 'book-1',
      title: 'Napoleon',
      bytesTotal: 994000000,
      url: '/'
    });
  });

  await test('removes an expired push subscription after a 410 response', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-push-expired-'));
    let attempts = 0;
    const service = createOfflineReadinessNotifications({
      filePath: path.join(dir, 'push-subscriptions.json'),
      vapidPublicKey: 'public-vapid',
      vapidPrivateKey: 'private-vapid',
      vapidSubject: 'mailto:operator@example.test',
      // The send path now runs every endpoint through the SSRF gate before
      // dispatch. These fixtures use a non-resolvable .test hostname, so the
      // check is stubbed to keep this unit test off the network; the gate
      // itself is exercised against real hostnames elsewhere.
      assertTarget: async () => {},
      webPush: {
        setVapidDetails() {},
        async sendNotification() {
          attempts += 1;
          const error = new Error('gone');
          error.statusCode = 410;
          throw error;
        }
      }
    });
    await service.subscribe('account:device', subscription());

    assert.deepStrictEqual(await service.notifyOwners(['account:device'], {
      bookId: 'book-1',
      title: 'Napoleon'
    }), { sent: 0, failed: 0, removed: 1 });
    assert.strictEqual(attempts, 1);
    assert.deepStrictEqual(await service.notifyOwners(['account:device'], {
      bookId: 'book-1',
      title: 'Napoleon'
    }), { sent: 0, failed: 0, removed: 0 });
    assert.strictEqual(attempts, 1);
  });

  await test('bounds a stalled push delivery with the configured deadline', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-push-timeout-'));
    let options;
    const service = createOfflineReadinessNotifications({
      filePath: path.join(dir, 'push-subscriptions.json'),
      vapidPublicKey: 'public-vapid',
      vapidPrivateKey: 'private-vapid',
      vapidSubject: 'mailto:operator@example.test',
      assertTarget: async () => {},
      sendTimeoutMs: 20,
      log: { warn() {} },
      webPush: {
        setVapidDetails() {},
        sendNotification: async (_subscription, _payload, value) => {
          options = value;
          return new Promise(() => {});
        }
      }
    });
    await service.subscribe('account:device', subscription());
    const startedAt = Date.now();
    assert.deepStrictEqual(
      await service.notifyOwners(['account:device'], { bookId: 'book-1' }),
      { sent: 0, failed: 1, removed: 0 }
    );
    assert(Date.now() - startedAt < 500, 'stalled delivery must not retain the worker');
    assert.strictEqual(options.timeout, 20, 'web-push receives the same transport deadline');
  });

  await test('is safely disabled when VAPID configuration is absent', async () => {
    const service = createOfflineReadinessNotifications({
      filePath: '/unused',
      webPush: {
        setVapidDetails() {},
        async sendNotification() {}
      }
    });

    assert.strictEqual(service.enabled, false);
    assert.strictEqual(await service.subscribe('owner', subscription()), false);
    assert.deepStrictEqual(await service.notifyOwners(['owner'], {
      bookId: 'book-1',
      title: 'Napoleon'
    }), { sent: 0, failed: 0, removed: 0 });
  });

  await test('caps the number of owner buckets and evicts the least-recently-updated owner', async () => {
    // push-subscription-store-unbounded-growth-no-rate-limit.md: the owner id
    // is client-controlled, so the per-owner subscription cap alone doesn't
    // stop unbounded growth of the store; the number of owners must be bounded too.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-push-owners-'));
    const filePath = path.join(dir, 'push-subscriptions.json');
    const service = createOfflineReadinessNotifications({
      filePath,
      vapidPublicKey: 'public-vapid',
      vapidPrivateKey: 'private-vapid',
      vapidSubject: 'mailto:operator@example.test',
      webPush: {
        setVapidDetails() {},
        async sendNotification() {}
      }
    });

    const MAX_OWNERS = 500;
    for (let index = 0; index < MAX_OWNERS; index += 1) {
      await service.subscribe(`owner-${index}`, subscription(`https://push.example.test/device-${index}`));
    }
    let data = await jsonStore.load(filePath, { version: 1, owners: {} });
    assert.strictEqual(Object.keys(data.owners).length, MAX_OWNERS, 'Accepts owners up to the cap');

    await service.subscribe('owner-new', subscription('https://push.example.test/device-new'));
    data = await jsonStore.load(filePath, { version: 1, owners: {} });
    assert.strictEqual(Object.keys(data.owners).length, MAX_OWNERS, 'Never exceeds the owner cap');
    assert(!data.owners['owner-0'], 'Evicts the least-recently-updated owner to make room');
    assert(Boolean(data.owners['owner-new']), 'Admits the new owner after eviction');
    assert(Boolean(data.owners['owner-499']), 'Keeps recently-updated owners');

    // Updating an existing owner refreshes its recency instead of counting as
    // new growth, and must not itself trigger an eviction.
    await service.subscribe('owner-1', subscription('https://push.example.test/device-1-again'));
    data = await jsonStore.load(filePath, { version: 1, owners: {} });
    assert.strictEqual(Object.keys(data.owners).length, MAX_OWNERS, 'Re-subscribing an existing owner does not evict anything');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
