const crypto = require('crypto');
const {
  GENERATION_ORIGIN,
  GENERATION_PRIORITY
} = require('./audio-generation-intent');

function aggregateStatus(bookId, statuses, intent) {
  const totalChapters = statuses.length;
  const readyChapters = statuses.filter(status => status?.ready).length;
  const errorChapters = statuses.filter(status => Number(status?.errorChunks) > 0).length;
  const readyChunks = statuses.reduce((sum, status) => sum + (Number(status?.readyChunks) || 0), 0);
  const totalChunks = statuses.reduce((sum, status) => sum + (Number(status?.totalChunks) || 0), 0);
  let state = 'preparing';
  if (!intent && readyChapters < totalChapters) state = 'not-requested';
  else if (errorChapters > 0 || intent?.state === 'error') state = 'error';
  else if (readyChapters === totalChapters && totalChapters > 0) state = 'ready';
  else if (intent?.state === 'paused') state = 'paused';
  return {
    bookId,
    state,
    readyChapters,
    totalChapters,
    readyChunks,
    totalChunks,
    errorChapters,
    nextChapter: Math.max(0, Number(intent?.nextChapter) || 0),
    percent: totalChapters > 0 ? Math.round((readyChapters / totalChapters) * 100) : 0
  };
}

function progressStatus(bookId, totalChapters, intent, current = null) {
  const total = Math.max(0, Number(totalChapters) || 0);
  let readyChapters = Math.min(total, Math.max(0, Number(intent?.readyChapters) || 0));
  if (intent?.state === 'ready') readyChapters = total;
  const currentReadyChunks = Math.max(0, Number(current?.readyChunks) || 0);
  const currentTotalChunks = Math.max(0, Number(current?.totalChunks) || 0);
  const currentFraction = currentTotalChunks > 0
    ? Math.min(1, currentReadyChunks / currentTotalChunks)
    : 0;
  let state = intent?.state || 'not-requested';
  if (Number(current?.errorChunks) > 0 || state === 'error') state = 'error';
  else if (readyChapters === total && total > 0) state = 'ready';
  const progress = total > 0 ? (readyChapters + currentFraction) / total : 0;
  return {
    bookId,
    state,
    readyChapters,
    totalChapters: total,
    readyChunks: currentReadyChunks,
    totalChunks: currentTotalChunks,
    errorChapters: Number(current?.errorChunks) > 0 ? 1 : 0,
    nextChapter: Math.min(total, Math.max(0, Number(intent?.nextChapter) || 0)),
    percent: state === 'ready' ? 100 : Math.max(0, Math.min(99, Math.round(progress * 100)))
  };
}

function createOfflinePreparationCoordinator({
  stateStore,
  getBookChapters,
  chapterStatus,
  prepareChapter,
  shouldPrepareChapter = () => true,
  cancelRequest = () => 0,
  discardRequest = async () => 0,
  maxConcurrentTitles = 2,
  maxTrackedTitles = 24,
  createRequestId = () => crypto.randomBytes(8).toString('hex'),
  now = Date.now,
  onError = () => {}
} = {}) {
  if (!stateStore || typeof stateStore.putOfflinePreparation !== 'function') {
    throw new TypeError('Offline preparation requires a durable state store');
  }
  if (
    typeof getBookChapters !== 'function' ||
    typeof chapterStatus !== 'function' ||
    typeof prepareChapter !== 'function' ||
    typeof shouldPrepareChapter !== 'function'
  ) {
    throw new TypeError('Offline preparation requires chapter loading, status, and preparation');
  }

  const capacity = Math.max(1, Number(maxConcurrentTitles) || 2);
  const trackedCapacity = Math.max(capacity, Number(maxTrackedTitles) || 24);
  const workers = new Map();
  const pending = [];
  const rerun = new Set();
  const paused = new Set();
  const removed = new Set();
  let activeTitles = 0;
  let mutations = Promise.resolve();

  function mutate(work) {
    const result = mutations.then(work, work);
    mutations = result.catch(() => {});
    return result;
  }

  async function loadTarget(bookId) {
    const target = await getBookChapters(bookId);
    if (!Array.isArray(target?.chapters) || target.chapters.length === 0) {
      const error = new Error('Book has no downloadable chapters');
      error.statusCode = 400;
      throw error;
    }
    return target;
  }

  async function status(bookId) {
    const { chapters } = await loadTarget(bookId);
    const intent = await stateStore.getOfflinePreparation?.(bookId);
    if (!intent) return progressStatus(bookId, chapters.length, null);
    const nextChapter = Math.min(
      Math.max(0, Number(intent.nextChapter) || 0),
      Math.max(0, chapters.length - 1)
    );
    const current = intent.state === 'ready'
      ? null
      : await chapterStatus({ bookId, chapterIndex: nextChapter });
    return progressStatus(bookId, chapters.length, intent, current);
  }

  async function persistUnlocked(record, updates = {}) {
    if (removed.has(record.bookId)) return;
    const payload = {
      ...record,
      ...updates,
      updatedAt: now()
    };
    if (!Object.prototype.hasOwnProperty.call(updates, 'owners')) delete payload.owners;
    await stateStore.putOfflinePreparation(payload);
  }

  async function persist(record, updates = {}) {
    return mutate(async () => {
      if (removed.has(record.bookId)) return false;
      const current = await stateStore.getOfflinePreparation?.(record.bookId);
      if (!current || current.requestId !== record.requestId) return false;
      await persistUnlocked(record, updates);
      return true;
    });
  }

  async function recordIsCurrent(record) {
    if (removed.has(record.bookId) || paused.has(record.bookId)) return false;
    const current = await stateStore.getOfflinePreparation?.(record.bookId);
    return Boolean(current && current.requestId === record.requestId);
  }

  async function runBook(bookId) {
    const { chapters } = await loadTarget(bookId);
    const record = await stateStore.getOfflinePreparation(bookId);
    if (!record) return;
    let readyChapters = 0;
    let nextChapter = Math.min(
      chapters.length,
      Math.max(0, Number(record.nextChapter) || 0)
    );
    try {
      for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
        nextChapter = chapterIndex;
        if (!await recordIsCurrent(record)) return;
        if (!await shouldPrepareChapter({
          bookId,
          chapterIndex,
          chapter: chapters[chapterIndex]
        })) {
          readyChapters += 1;
          nextChapter = chapterIndex + 1;
          await persist(record, {
            state: 'preparing',
            nextChapter,
            readyChapters
          });
          continue;
        }
        const current = await chapterStatus({ bookId, chapterIndex });
        if (!current?.ready) {
          await persist(record, {
            state: 'preparing',
            nextChapter: chapterIndex,
            readyChapters
          });
          await prepareChapter({
            bookId,
            chapterIndex,
            priority: GENERATION_PRIORITY.DOWNLOAD,
            origin: GENERATION_ORIGIN.OFFLINE_DOWNLOAD,
            requestId: record.requestId
          });
        }
        if (!await recordIsCurrent(record)) return;
        readyChapters += 1;
        nextChapter = chapterIndex + 1;
        await persist(record, {
          state: 'preparing',
          nextChapter,
          readyChapters
        });
      }
      if (!await recordIsCurrent(record)) return;
      await persist(record, {
        state: 'ready',
        nextChapter: chapters.length,
        readyChapters: chapters.length,
        lastError: null
      });
    } catch (error) {
      const current = await stateStore.getOfflinePreparation?.(bookId);
      if (!current || current.requestId !== record.requestId || removed.has(bookId)) return;
      if (paused.has(bookId)) {
        await persist(record, {
          state: 'paused',
          readyChapters
        });
        return;
      }
      await persist(record, {
        state: 'error',
        nextChapter,
        readyChapters,
        lastError: String(error?.message || 'Audio preparation failed').slice(0, 300)
      });
      throw error;
    }
  }

  function drain() {
    while (activeTitles < capacity && pending.length > 0) {
      const entry = pending.shift();
      activeTitles += 1;
      Promise.resolve()
        .then(() => runBook(entry.bookId))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          activeTitles -= 1;
          workers.delete(entry.bookId);
          const shouldRerun = rerun.delete(entry.bookId);
          if (shouldRerun) schedule(entry.bookId);
          drain();
        });
    }
  }

  function schedule(bookId, { afterCurrent = false } = {}) {
    if (workers.has(bookId)) {
      if (afterCurrent) rerun.add(bookId);
      return workers.get(bookId);
    }
    const completion = new Promise((resolve, reject) => {
      pending.push({ bookId, resolve, reject });
    });
    completion.catch(error => onError(error, { bookId }));
    workers.set(bookId, completion);
    drain();
    return completion;
  }

  async function request(bookId, { ownerId = null } = {}) {
    const { chapters } = await loadTarget(bookId);
    const admission = await mutate(async () => {
      const existing = await stateStore.getOfflinePreparation?.(bookId);
      if (!existing) {
        const intents = await stateStore.listOfflinePreparations?.() || [];
        const tracked = intents.filter(intent => intent.state !== 'ready').length;
        if (tracked >= trackedCapacity) {
          const error = new Error('Too many titles are already waiting for offline preparation');
          error.statusCode = 429;
          throw error;
        }
      }
      const startsFreshRequest = existing?.state === 'paused' || existing?.state === 'error';
      const cleanOwnerId = typeof ownerId === 'string' && ownerId ? ownerId.slice(0, 256) : null;
      const owners = Array.isArray(existing?.owners) ? existing.owners.slice() : [];
      if (cleanOwnerId && !owners.includes(cleanOwnerId)) owners.push(cleanOwnerId);
      const record = {
        bookId,
        totalChapters: chapters.length,
        requestedAt: existing?.requestedAt || now(),
        requestId: startsFreshRequest ? createRequestId() : existing?.requestId || createRequestId(),
        nextChapter: Math.min(chapters.length, Math.max(0, Number(existing?.nextChapter) || 0)),
        readyChapters: Math.min(chapters.length, Math.max(0, Number(existing?.readyChapters) || 0)),
        owners,
        state: 'preparing'
      };
      paused.delete(bookId);
      removed.delete(bookId);
      await persistUnlocked(record, { owners });
      return { record, startsFreshRequest };
    });
    schedule(bookId, {
      afterCurrent: Boolean(admission.startsFreshRequest && workers.has(bookId))
    });
    return status(bookId);
  }

  async function restore() {
    const intents = await stateStore.listOfflinePreparations?.() || [];
    const resumed = [];
    const failed = [];
    const deferred = [];
    for (const intent of intents) {
      if (intent.state === 'ready' || intent.state === 'paused') continue;
      if (resumed.length >= trackedCapacity) {
        deferred.push(intent.bookId);
        continue;
      }
      try {
        await loadTarget(intent.bookId);
        schedule(intent.bookId);
        resumed.push(intent.bookId);
      } catch {
        failed.push(intent.bookId);
      }
    }
    return { resumedBooks: resumed.length, failedBooks: failed, deferredBooks: deferred };
  }

  async function cancel(bookId, { remove = false, ownerId = null } = {}) {
    return mutate(async () => {
      const record = await stateStore.getOfflinePreparation?.(bookId);
      const cleanOwnerId = typeof ownerId === 'string' && ownerId ? ownerId.slice(0, 256) : null;
      if (!remove && cleanOwnerId && Array.isArray(record?.owners) && record.owners.length > 0) {
        if (!record.owners.includes(cleanOwnerId)) {
          return { bookId, state: record.state || 'preparing' };
        }
        const owners = record.owners.filter(owner => owner !== cleanOwnerId);
        if (owners.length > 0) {
          await persistUnlocked(record, { owners });
          return { bookId, state: record.state || 'preparing' };
        }
        record.owners = [];
      }
      paused.add(bookId);
      rerun.delete(bookId);
      if (remove) removed.add(bookId);
      if (record?.requestId) {
        cancelRequest(record.requestId);
        await discardRequest(record.requestId);
      }
      const pendingIndex = pending.findIndex(entry => entry.bookId === bookId);
      if (pendingIndex >= 0) {
        const [entry] = pending.splice(pendingIndex, 1);
        workers.delete(bookId);
        entry.resolve();
      }
      if (remove) {
        await stateStore.removeOfflinePreparation?.(bookId);
        return { bookId, state: 'removed' };
      }
      if (record) await persistUnlocked(record, { state: 'paused', owners: [] });
      return { bookId, state: 'paused' };
    });
  }

  async function waitForIdle(bookId) {
    while (workers.has(bookId)) {
      await workers.get(bookId).catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  return {
    request,
    status,
    restore,
    cancel,
    waitForIdle
  };
}

module.exports = {
  aggregateStatus,
  createOfflinePreparationCoordinator
};
