const jsonStore = require('./json-store');

const DEFAULT_STORE = Object.freeze({ version: 1, owners: {} });
const MAX_SUBSCRIPTIONS_PER_OWNER = 8;

function cleanOwnerId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    ? value
    : '';
}

function cleanSubscription(value) {
  const endpoint = typeof value?.endpoint === 'string' ? value.endpoint : '';
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError('Push subscription endpoint is invalid');
  }
  if (url.protocol !== 'https:' || endpoint.length > 4096) {
    throw new TypeError('Push subscription endpoint must use HTTPS');
  }
  const subscriptionKeys = [value?.keys?.p256dh, value?.keys?.auth];
  if (subscriptionKeys.some(key =>
    typeof key !== 'string' || !key || key.length > 1024
  )) {
    throw new TypeError('Push subscription keys are invalid');
  }
  return {
    endpoint,
    expirationTime: Number.isFinite(value.expirationTime) ? value.expirationTime : null,
    keys: {
      p256dh: subscriptionKeys[0],
      auth: subscriptionKeys[1]
    }
  };
}

function createOfflineReadinessNotifications({
  filePath,
  webPush,
  vapidPublicKey,
  vapidPrivateKey,
  vapidSubject,
  log = console
} = {}) {
  const publicKey = String(vapidPublicKey || '').trim();
  const privateKey = String(vapidPrivateKey || '').trim();
  const subject = String(vapidSubject || '').trim();
  const enabled = Boolean(
    filePath &&
    webPush?.setVapidDetails &&
    webPush?.sendNotification &&
    publicKey &&
    privateKey &&
    /^(?:mailto:|https:\/\/)/.test(subject)
  );
  if (enabled) webPush.setVapidDetails(subject, publicKey, privateKey);

  async function subscribe(ownerId, rawSubscription) {
    if (!enabled) return false;
    const owner = cleanOwnerId(ownerId);
    if (!owner) throw new TypeError('Push subscription owner is invalid');
    const subscription = cleanSubscription(rawSubscription);
    await jsonStore.update(filePath, data => {
      if (!data.owners || typeof data.owners !== 'object') data.owners = {};
      const existing = Array.isArray(data.owners[owner]) ? data.owners[owner] : [];
      const retained = existing.filter(item => item?.endpoint !== subscription.endpoint);
      retained.push(subscription);
      data.owners[owner] = retained.slice(-MAX_SUBSCRIPTIONS_PER_OWNER);
    }, { ...DEFAULT_STORE, owners: {} });
    return true;
  }

  async function unsubscribe(ownerId, endpoint) {
    if (!enabled) return false;
    const owner = cleanOwnerId(ownerId);
    if (!owner || typeof endpoint !== 'string' || !endpoint) return false;
    let removed = false;
    await jsonStore.update(filePath, data => {
      const existing = Array.isArray(data.owners?.[owner]) ? data.owners[owner] : [];
      const retained = existing.filter(item => item?.endpoint !== endpoint);
      removed = retained.length !== existing.length;
      if (!removed) return jsonStore.SKIP_SAVE;
      if (retained.length > 0) data.owners[owner] = retained;
      else delete data.owners[owner];
    }, { ...DEFAULT_STORE, owners: {} });
    return removed;
  }

  async function notifyOwners(ownerIds, book = {}) {
    const report = { sent: 0, failed: 0, removed: 0 };
    if (!enabled) return report;
    const owners = [...new Set((Array.isArray(ownerIds) ? ownerIds : []).map(cleanOwnerId).filter(Boolean))];
    if (owners.length === 0) return report;
    const data = await jsonStore.load(filePath, { ...DEFAULT_STORE, owners: {} });
    const subscriptions = owners.flatMap(owner =>
      (Array.isArray(data.owners?.[owner]) ? data.owners[owner] : [])
        .map(subscription => ({ owner, subscription }))
    );
    const payload = JSON.stringify({
      type: 'offline-audio-ready',
      bookId: String(book.bookId || '').slice(0, 128),
      title: String(book.title || 'Your audiobook').slice(0, 180),
      bytesTotal: Math.max(0, Math.round(Number(book.bytesTotal) || 0)),
      url: '/'
    });

    for (const { owner, subscription } of subscriptions) {
      try {
        await webPush.sendNotification(subscription, payload, {
          TTL: 24 * 60 * 60,
          urgency: 'normal'
        });
        report.sent += 1;
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          if (await unsubscribe(owner, subscription.endpoint)) report.removed += 1;
          continue;
        }
        report.failed += 1;
        log.warn?.(`Offline readiness notification failed: ${error?.message || error}`);
      }
    }
    return report;
  }

  return {
    enabled,
    publicKey: enabled ? publicKey : '',
    subscribe,
    unsubscribe,
    notifyOwners
  };
}

module.exports = {
  createOfflineReadinessNotifications
};
