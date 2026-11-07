const crypto = require('crypto');
const {
  GENERATION_ORIGIN,
  GENERATION_PRIORITY
} = require('./audio-generation-intent');

function requestAbortError() {
  const error = new Error('Offline preparation request was cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function preparationIdentityChanged(identity, record) {
  return Boolean((identity?.packageVariantKey && identity.packageVariantKey !== record?.packageVariantKey) ||
    (identity?.sourceTextRevision && identity.sourceTextRevision !== record?.sourceTextRevision) ||
    String(identity?.retainedPackageRevision || '') !== String(record?.retainedPackageRevision || ''));
}

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
  const bytesPrepared = Math.max(0, Number(intent?.preparedBytes) || 0);
  return {
    bookId,
    state,
    readyChapters,
    totalChapters: total,
    readyChunks: currentReadyChunks,
    totalChunks: currentTotalChunks,
    errorChapters: Number(current?.errorChunks) > 0 ? 1 : 0,
    nextChapter: Math.min(total, Math.max(0, Number(intent?.nextChapter) || 0)),
    percent: state === 'ready' ? 100 : Math.max(0, Math.min(99, Math.round(progress * 100))),
    bytesPrepared,
    bytesTotal: state === 'ready' ? bytesPrepared : null,
    packageVariantKey: String(intent?.packageVariantKey || current?.variantKey || ''),
    bitrateKbps: Math.max(0, Number(intent?.bitrateKbps || current?.bitrateKbps) || 0)
  };
}

function createSlot(limit) {
  const capacity = Math.max(1, Math.floor(Number(limit) || 1));
  const waiters = [];
  let active = 0;
  return async function runInSlot(task, signal) {
    if (signal?.aborted) throw requestAbortError();
    if (active < capacity) {
      active += 1;
    } else {
      await new Promise((resolve, reject) => {
        const waiter = { resolve, signal, onAbort: null };
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(requestAbortError());
        };
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        waiters.push(waiter);
      });
    }
    try {
      return await task();
    } finally {
      const waiter = waiters.shift();
      if (waiter) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.resolve();
      } else {
        active -= 1;
      }
    }
  };
}

function createOfflinePreparationCoordinator({
  stateStore,
  getBookChapters,
  chapterStatus,
  prepareChapter,
  // Optional second phase. With it, prepareChapter only narrates and returns a
  // source handle; finalizeChapter packages that source. Narration of later
  // chapters then overlaps packaging of earlier ones.
  finalizeChapter = null,
  maxConcurrentFinalizations = 1,
  // Returns a release function. The chapter's narrated audio must survive
  // cache eviction from narration until its package commits or fails.
  retainChapter = () => () => {},
  preparationIdentity = () => null,
  shouldPrepareChapter = () => true,
  cancelRequest = () => 0,
  discardRequest = async () => 0,
  maxConcurrentTitles = null,
  maxTrackedTitles = 24,
  createRequestId = () => crypto.randomBytes(8).toString('hex'),
  now = Date.now,
  onError = () => {},
  beforeReadyCommit = async () => {},
  onReady = async () => {}
} = {}) {
  if (!stateStore || typeof stateStore.putOfflinePreparation !== 'function') {
    throw new TypeError('Offline preparation requires a durable state store');
  }
  if (
    typeof getBookChapters !== 'function' ||
    typeof chapterStatus !== 'function' ||
    typeof prepareChapter !== 'function' ||
    typeof shouldPrepareChapter !== 'function' ||
    (finalizeChapter !== null && typeof finalizeChapter !== 'function')
  ) {
    throw new TypeError('Offline preparation requires chapter loading, status, and preparation');
  }
  const pipelined = typeof finalizeChapter === 'function';
  // Packaging is bounded across every title. The TTS engine already holds
  // most host CPU, so one encode at a time keeps narration fed.
  const finalizeSlot = createSlot(maxConcurrentFinalizations);

  const capacity = Math.max(
    1,
    Number.isFinite(Number(maxConcurrentTitles)) && Number(maxConcurrentTitles) > 0
      ? Math.floor(Number(maxConcurrentTitles))
      : Math.max(1, Number(maxTrackedTitles) || 24)
  );
  const trackedCapacity = Math.max(capacity, Number(maxTrackedTitles) || 24);
  const workers = new Map();
  const pending = [];
  const activeBooks = new Set();
  const controllers = new Map();
  const rerun = new Set();
  const paused = new Set();
  const removed = new Set();
  const requestEpochs = new Map();
  const requestInvocations = new Map();
  const persistedRequestEpochs = new Map();
  const persistedOwnerEpochs = new Map();
  let activeTitles = 0;
  let mutations = Promise.resolve();

  function mutate(work) {
    const result = mutations.then(work, work);
    mutations = result.catch(() => {});
    return result;
  }

  function currentRequestEpoch(bookId) {
    return requestEpochs.get(bookId) || 0;
  }

  function bumpRequestEpoch(bookId) {
    const next = currentRequestEpoch(bookId) + 1;
    requestEpochs.set(bookId, next);
    return next;
  }

  function invocationSet(bookId) {
    let records = requestInvocations.get(bookId);
    if (!records) {
      records = new Set();
      requestInvocations.set(bookId, records);
    }
    return records;
  }

  function assertInvocationCurrent(invocation) {
    if (
      invocation.controller.signal.aborted ||
      currentRequestEpoch(invocation.bookId) !== invocation.epoch
    ) throw requestAbortError();
  }

  function retireInvocations(bookId, ownerId, nextEpoch) {
    const records = requestInvocations.get(bookId);
    if (!records) return [];
    const selected = [...records].filter(record => ownerId === null || record.ownerId === ownerId);
    for (const record of records) {
      if (selected.includes(record)) record.controller.abort();
      else record.epoch = nextEpoch;
    }
    return selected;
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

  async function status(bookId, resolvedIdentity = null) {
    const { chapters } = await loadTarget(bookId);
    const intent = await stateStore.getOfflinePreparation?.(bookId);
    if (!intent) return progressStatus(bookId, chapters.length, null);
    const identity = resolvedIdentity || await preparationIdentity({ bookId });
    if (preparationIdentityChanged(identity, intent)) {
      return progressStatus(bookId, chapters.length, {
        ...identity,
        state: 'not-requested',
        nextChapter: 0,
        readyChapters: 0,
        preparedBytes: 0
      });
    }
    const nextChapter = Math.min(
      Math.max(0, Number(intent.nextChapter) || 0),
      Math.max(0, chapters.length - 1)
    );
    const current = intent.state === 'ready'
      ? null
      : await chapterStatus({ bookId, chapterIndex: nextChapter, ...identity });
    const result = progressStatus(bookId, chapters.length, intent, current);
    if (
      result.state === 'preparing' &&
      pending.some(entry => entry.bookId === bookId) &&
      !activeBooks.has(bookId)
    ) {
      result.state = 'waiting';
    }
    return result;
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

  // Ownership is checked and written inside one mutation, so a pause or
  // replacement committed after a worker's last check is never overwritten.
  // Only the worker's own pause acknowledgement may write over a pause.
  async function persist(record, updates = {}, { allowPaused = false } = {}) {
    return mutate(async () => {
      if (removed.has(record.bookId)) return false;
      if (!allowPaused && paused.has(record.bookId)) return false;
      const current = await stateStore.getOfflinePreparation?.(record.bookId);
      if (!current || current.requestId !== record.requestId) return false;
      if (!allowPaused && current.state === 'paused') return false;
      await persistUnlocked(record, updates);
      return true;
    });
  }

  async function recordIsCurrent(record, signal = null) {
    if (signal?.aborted) return false;
    if (removed.has(record.bookId) || paused.has(record.bookId)) return false;
    const current = await stateStore.getOfflinePreparation?.(record.bookId);
    return Boolean(current && current.requestId === record.requestId);
  }

  async function runBook(bookId, signal) {
    if (signal?.aborted) return;
    const { book, chapters } = await loadTarget(bookId);
    if (signal?.aborted) return;
    const record = await stateStore.getOfflinePreparation(bookId);
    if (!record) return;
    const wasReady = record.state === 'ready';
    let repairRequired = false;
    let preparedAnyChapter = false;
    const repairPass = record.state === 'ready';
    let readyChapters = repairPass
      ? 0
      : Math.min(chapters.length, Math.max(0, Number(record.readyChapters) || 0));
    let preparedBytes = repairPass ? 0 : Math.max(0, Number(record.preparedBytes) || 0);
    // The durable frontier. Chapters commit strictly in order, and only a
    // commit advances it, so it never passes a chapter that is not ready. A
    // repair pass re-proves every chapter, so it starts from the beginning.
    let nextChapter = repairPass ? 0 : Math.min(
      chapters.length,
      Math.max(0, Number(record.nextChapter) || 0)
    );
    // Narration and packaging share one signal. A packaging failure aborts
    // narration that has run ahead, and cancellation reaches both.
    const pipeline = new AbortController();
    const relayAbort = () => pipeline.abort();
    signal?.addEventListener?.('abort', relayAbort, { once: true });
    if (signal?.aborted) pipeline.abort();
    let commits = Promise.resolve();
    let commitFailure = null;
    let commitStale = false;

    async function commitChapter(chapterIndex, { skipped = false, prepared = false, source, current, pinnedIdentity }) {
      if (skipped) {
        readyChapters += 1;
        nextChapter = chapterIndex + 1;
        return persist(record, {
          state: wasReady && !repairRequired ? 'ready' : 'preparing',
          nextChapter,
          readyChapters,
          preparedBytes: wasReady && !repairRequired ? record.preparedBytes : preparedBytes
        });
      }
      if (prepared) {
        if (pipelined) {
          await finalizeSlot(() => finalizeChapter({
            bookId,
            chapterIndex,
            priority: GENERATION_PRIORITY.DOWNLOAD,
            origin: GENERATION_ORIGIN.OFFLINE_DOWNLOAD,
            requestId: record.requestId,
            signal: pipeline.signal,
            ...pinnedIdentity
          }, source), pipeline.signal);
        }
        // Readiness comes only from the published artifact, never from the
        // finalize call returning.
        current = await chapterStatus({ bookId, chapterIndex, ...pinnedIdentity });
        if (!current?.ready) {
          throw new Error(`Offline audio package is not ready for chapter ${chapterIndex + 1}`);
        }
      }
      if (!await recordIsCurrent(record, signal)) return false;
      readyChapters += 1;
      preparedBytes += Math.max(0, Number(current?.size) || 0);
      nextChapter = chapterIndex + 1;
      return persist(record, {
        state: wasReady && !repairRequired ? 'ready' : 'preparing',
        nextChapter,
        readyChapters,
        preparedBytes: wasReady && !repairRequired ? record.preparedBytes : preparedBytes
      });
    }

    // Every queued step runs, even after a failure or a stale request, so
    // each chapter hold is released exactly when its step settles.
    function enqueueCommit(chapterIndex, step) {
      commits = commits.then(async () => {
        try {
          if (commitFailure || commitStale) return;
          if (!await commitChapter(chapterIndex, step)) commitStale = true;
        } finally {
          step.release?.();
        }
      }).catch(error => {
        commitFailure = commitFailure || error;
        pipeline.abort();
      });
    }

    // Resolves true when every queued chapter committed and this worker still
    // owns the request.
    async function flushCommits() {
      await commits;
      if (commitFailure) throw commitFailure;
      return !commitStale;
    }

    try {
      const firstChapter = repairPass ? 0 : nextChapter;
      for (let chapterIndex = firstChapter; chapterIndex < chapters.length; chapterIndex += 1) {
        if (commitFailure) break;
        if (!await recordIsCurrent(record, signal)) return;
        const currentIdentity = await preparationIdentity({ bookId });
        if (preparationIdentityChanged(currentIdentity, record)) {
          pipeline.abort();
          await commits;
          await request(bookId);
          return;
        }
        if (!await shouldPrepareChapter({
          bookId,
          chapterIndex,
          chapter: chapters[chapterIndex]
        })) {
          enqueueCommit(chapterIndex, { skipped: true });
        } else {
          const pinnedIdentity = {
            sourceVariantKey: record.sourceVariantKey,
            sourceVoice: record.sourceVoice,
            sourceChunkSize: record.sourceChunkSize,
            sourceTextRevision: record.sourceTextRevision,
            retainedPackageRevision: record.retainedPackageRevision,
            retainedArtifacts: currentIdentity?.retainedArtifacts,
            packageVariantKey: record.packageVariantKey
          };
          const current = await chapterStatus({ bookId, chapterIndex, ...pinnedIdentity });
          if (current?.ready) {
            enqueueCommit(chapterIndex, { current, pinnedIdentity });
          } else {
            repairRequired = true;
            if (commitFailure) break;
            const release = retainChapter({ bookId, chapterIndex });
            let source;
            try {
              if (!await persist(record, {
                state: 'preparing',
                nextChapter,
                readyChapters,
                preparedBytes
              })) {
                release();
                return;
              }
              source = await prepareChapter({
                bookId,
                chapterIndex,
                priority: GENERATION_PRIORITY.DOWNLOAD,
                origin: GENERATION_ORIGIN.OFFLINE_DOWNLOAD,
                requestId: record.requestId,
                signal: pipeline.signal,
                ...pinnedIdentity
              });
            } catch (error) {
              release();
              throw error;
            }
            preparedAnyChapter = true;
            enqueueCommit(chapterIndex, { prepared: true, source, pinnedIdentity, release });
          }
        }
        // Without a separate packaging phase the chapter is already complete;
        // commit it before narrating the next one.
        if (!pipelined && !await flushCommits()) return;
        // Operators may deliberately configure fewer concurrent title workers
        // than tracked intents. Yield after a durable chapter boundary so a
        // pending or newly foregrounded title never waits for an entire book.
        if (pending.length > 0 && (!repairPass || repairRequired)) {
          if (!await flushCommits()) return;
          rerun.add(bookId);
          return;
        }
      }
      if (!await flushCommits()) return;
      if (!await recordIsCurrent(record, signal)) return;
      if (preparationIdentityChanged(await preparationIdentity({ bookId }), record)) {
        await request(bookId);
        return;
      }
      const publishedIdentity = await beforeReadyCommit({ book, chapters, record: { ...record, preparedBytes }, signal,
        beforePublish: async () => {
          if (!await recordIsCurrent(record, signal) ||
            preparationIdentityChanged(await preparationIdentity({ bookId }), record)) throw requestAbortError();
        } });
      if (!await recordIsCurrent(record, signal)) return;
      if (publishedIdentity?.packageVariantKey === record.packageVariantKey &&
          publishedIdentity?.sourceTextRevision === record.sourceTextRevision &&
          publishedIdentity.retainedPackageRevision) {
        record.retainedPackageRevision = publishedIdentity.retainedPackageRevision;
      }
      if (preparationIdentityChanged(await preparationIdentity({ bookId }), record)) {
        await request(bookId);
        return;
      }
      if (!await persist(record, {
        state: 'ready',
        nextChapter: chapters.length,
        readyChapters: chapters.length,
        preparedBytes,
        lastError: null
      })) return;
      if (!wasReady || preparedAnyChapter) {
        const readyEvent = {
          book,
          chapters,
          record: { ...record, preparedBytes },
          status: progressStatus(bookId, chapters.length, {
            ...record,
            state: 'ready',
            nextChapter: chapters.length,
            readyChapters: chapters.length,
            preparedBytes
          })
        };
        // Delivery is best-effort and must not retain a title worker or its
        // mutation lifecycle after readiness is durably committed.
        void Promise.resolve()
          .then(() => onReady(readyEvent))
          .catch(error => onError(error, { bookId, phase: 'ready-notification' }));
      }
    } catch (thrown) {
      // Earlier chapters already narrated still commit in order unless the
      // request was cancelled, so the error names the true failing chapter.
      await commits;
      const error = commitFailure || thrown;
      const current = await stateStore.getOfflinePreparation?.(bookId);
      if (!current || current.requestId !== record.requestId || removed.has(bookId)) return;
      // `record` holds the values this run started from. Persist the whole
      // committed frontier so a resume neither repeats nor double-counts work.
      if (paused.has(bookId)) {
        await persist(record, {
          state: 'paused',
          nextChapter,
          readyChapters,
          preparedBytes
        }, { allowPaused: true });
        return;
      }
      await persist(record, {
        state: 'error',
        nextChapter,
        readyChapters,
        preparedBytes,
        lastError: String(error?.message || 'Audio preparation failed').slice(0, 300)
      });
      throw error;
    } finally {
      // Early returns leave no packaging behind a released title worker.
      signal?.removeEventListener?.('abort', relayAbort);
      pipeline.abort();
      await commits;
    }
  }

  function drain() {
    while (activeTitles < capacity && pending.length > 0) {
      const entry = pending.shift();
      activeTitles += 1;
      activeBooks.add(entry.bookId);
      const controller = new AbortController();
      controllers.set(entry.bookId, controller);
      Promise.resolve()
        .then(() => runBook(entry.bookId, controller.signal))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          activeTitles -= 1;
          activeBooks.delete(entry.bookId);
          if (controllers.get(entry.bookId) === controller) controllers.delete(entry.bookId);
          workers.delete(entry.bookId);
          const shouldRerun = rerun.delete(entry.bookId);
          paused.delete(entry.bookId);
          removed.delete(entry.bookId);
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

  function request(bookId, { ownerId = null } = {}) {
    const cleanOwnerId = typeof ownerId === 'string' && ownerId ? ownerId.slice(0, 256) : null;
    const invocation = {
      bookId,
      ownerId: cleanOwnerId,
      epoch: currentRequestEpoch(bookId),
      controller: new AbortController(),
      promise: null
    };
    invocationSet(bookId).add(invocation);
    const promise = requestInvocation(bookId, cleanOwnerId, invocation)
      .finally(() => {
        const records = requestInvocations.get(bookId);
        records?.delete(invocation);
        if (records?.size === 0) requestInvocations.delete(bookId);
      });
    invocation.promise = promise;
    return promise;
  }

  async function requestInvocation(bookId, cleanOwnerId, invocation) {
    const { chapters } = await loadTarget(bookId);
    assertInvocationCurrent(invocation);
    const identity = await preparationIdentity({ bookId });
    assertInvocationCurrent(invocation);
    const admission = await mutate(async () => {
      assertInvocationCurrent(invocation);
      const existing = await stateStore.getOfflinePreparation?.(bookId);
      assertInvocationCurrent(invocation);
      const identityChanged = Boolean(existing && preparationIdentityChanged(identity, existing));
      if (!existing || existing.state === 'paused' || identityChanged) {
        const intents = await stateStore.listOfflinePreparations?.() || [];
        assertInvocationCurrent(invocation);
        const tracked = intents.filter(intent =>
          intent.bookId !== bookId &&
          intent.state !== 'ready' && intent.state !== 'paused'
        ).length;
        if (tracked >= trackedCapacity) {
          const error = new Error('Too many titles are already waiting for offline preparation');
          error.statusCode = 429;
          throw error;
        }
      }
      const startsFreshRequest = !existing ||
        existing.state === 'paused' ||
        existing?.state === 'error' ||
        identityChanged;
      const resetsProgress = identityChanged;
      const retainedReady = !startsFreshRequest && existing.state === 'ready' && identity?.retained === true &&
        Boolean(identity.retainedPackageRevision) && Number.isSafeInteger(identity.retainedPackageBytes) &&
        identity.retainedPackageBytes >= 0;
      const owners = Array.isArray(existing?.owners) ? existing.owners.slice() : [];
      if (cleanOwnerId && !owners.includes(cleanOwnerId)) owners.push(cleanOwnerId);
      const record = {
        bookId,
        totalChapters: chapters.length,
        requestedAt: existing?.requestedAt || now(),
        requestId: startsFreshRequest ? createRequestId() : existing?.requestId || createRequestId(),
        nextChapter: resetsProgress
          ? 0
          : Math.min(chapters.length, Math.max(0, Number(existing?.nextChapter) || 0)),
        readyChapters: resetsProgress
          ? 0
          : Math.min(chapters.length, Math.max(0, Number(existing?.readyChapters) || 0)),
        preparedBytes: retainedReady ? identity.retainedPackageBytes
          : resetsProgress ? 0 : Math.max(0, Number(existing?.preparedBytes) || 0),
        packageVariantKey: String(identity?.packageVariantKey || existing?.packageVariantKey || ''),
        bitrateKbps: Math.max(0, Number(identity?.bitrateKbps || existing?.bitrateKbps) || 0),
        sourceVariantKey: String(identity?.sourceVariantKey || existing?.sourceVariantKey || ''),
        sourceTextRevision: String(identity?.sourceTextRevision || existing?.sourceTextRevision || ''),
        retainedPackageRevision: String(identity?.retainedPackageRevision || ''),
        sourceVoice: String(identity?.sourceVoice || existing?.sourceVoice || ''),
        sourceChunkSize: Math.max(
          0,
          Number(identity?.sourceChunkSize || existing?.sourceChunkSize) || 0
        ),
        owners,
        state: startsFreshRequest ? 'preparing' : (existing?.state || 'preparing')
      };
      assertInvocationCurrent(invocation);
      paused.delete(bookId);
      removed.delete(bookId);
      await persistUnlocked(record, { owners });
      persistedRequestEpochs.set(bookId, invocation.epoch);
      if (cleanOwnerId) {
        let ownerEpochs = persistedOwnerEpochs.get(bookId);
        if (!ownerEpochs) {
          ownerEpochs = new Map();
          persistedOwnerEpochs.set(bookId, ownerEpochs);
        }
        ownerEpochs.set(cleanOwnerId, invocation.epoch);
      }
      assertInvocationCurrent(invocation);
      return { record, startsFreshRequest, retainedReady, replacedRequestId: identityChanged ? existing?.requestId : null };
    });
    assertInvocationCurrent(invocation);
    if (admission.replacedRequestId && admission.replacedRequestId !== admission.record.requestId) {
      controllers.get(bookId)?.abort();
      cancelRequest(admission.replacedRequestId);
      await discardRequest(admission.replacedRequestId);
      assertInvocationCurrent(invocation);
    }
    if (!admission.retainedReady) {
      schedule(bookId, {
        afterCurrent: Boolean(admission.startsFreshRequest && workers.has(bookId))
      });
    }
    assertInvocationCurrent(invocation);
    return status(bookId);
  }

  async function restore() {
    const intents = await stateStore.listOfflinePreparations?.() || [];
    const resumed = [];
    const failed = [];
    const deferred = [];
    for (const intent of intents) {
      if (intent.state === 'ready' || intent.state === 'paused') continue;
      try {
        await request(intent.bookId);
        resumed.push(intent.bookId);
      } catch {
        failed.push(intent.bookId);
      }
    }
    return { resumedBooks: resumed.length, failedBooks: failed, deferredBooks: deferred };
  }

  function cancel(bookId, { remove = false, ownerId = null } = {}) {
    const cleanOwnerId = typeof ownerId === 'string' && ownerId ? ownerId.slice(0, 256) : null;
    const cancelEpoch = bumpRequestEpoch(bookId);
    const invocations = retireInvocations(bookId, cleanOwnerId, cancelEpoch);
    return Promise.all(invocations.map(record => record.promise?.catch(() => {})))
      .then(() => cancelAfterInvocations(bookId, { remove, cleanOwnerId, cancelEpoch }));
  }

  async function cancelAfterInvocations(bookId, { remove, cleanOwnerId, cancelEpoch }) {
    return mutate(async () => {
      const record = await stateStore.getOfflinePreparation?.(bookId);
      const liveInvocations = [...(requestInvocations.get(bookId) || [])]
        .filter(invocation => !invocation.controller.signal.aborted);
      const replacementInvocation = liveInvocations.some(invocation =>
        invocation.epoch >= cancelEpoch && (!cleanOwnerId || invocation.ownerId === cleanOwnerId)
      );
      if (replacementInvocation || (!cleanOwnerId && (persistedRequestEpochs.get(bookId) || 0) >= cancelEpoch)) {
        return { bookId, state: record.state || 'preparing' };
      }
      const pendingOtherOwner = cleanOwnerId && liveInvocations
        .some(invocation => invocation.ownerId !== cleanOwnerId && !invocation.controller.signal.aborted);
      if (cleanOwnerId && Array.isArray(record?.owners) && record.owners.length > 0) {
        if (!record.owners.includes(cleanOwnerId)) {
          return { bookId, state: record.state || 'preparing' };
        }
        if ((persistedOwnerEpochs.get(bookId)?.get(cleanOwnerId) || 0) >= cancelEpoch) {
          return { bookId, state: record.state || 'preparing' };
        }
        const owners = record.owners.filter(owner => owner !== cleanOwnerId);
        persistedOwnerEpochs.get(bookId)?.delete(cleanOwnerId);
        if (owners.length > 0) {
          await persistUnlocked(record, { owners });
          return { bookId, state: record.state || 'preparing' };
        }
        if (pendingOtherOwner) {
          await persistUnlocked(record, { owners: [] });
          return { bookId, state: record.state || 'preparing' };
        }
        record.owners = [];
        if (record.state === 'ready') {
          await persistUnlocked(record, { owners: [] });
          return { bookId, state: 'ready' };
        }
      }
      if (pendingOtherOwner && !record) return { bookId, state: 'preparing' };
      paused.add(bookId);
      controllers.get(bookId)?.abort();
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
        persistedRequestEpochs.delete(bookId);
        persistedOwnerEpochs.delete(bookId);
        if (!activeBooks.has(bookId)) {
          paused.delete(bookId);
          removed.delete(bookId);
        }
        return { bookId, state: 'removed' };
      }
      if (record) await persistUnlocked(record, { state: 'paused', owners: [] });
      if (!activeBooks.has(bookId)) paused.delete(bookId);
      return { bookId, state: 'paused' };
    });
  }

  function prioritize(bookId) {
    const pendingIndex = pending.findIndex(entry => entry.bookId === bookId);
    if (pendingIndex < 0) return workers.has(bookId);
    if (pendingIndex > 0) {
      const [entry] = pending.splice(pendingIndex, 1);
      pending.unshift(entry);
    }
    return true;
  }

  /**
   * Move one waiting title a single place through the pending order. A title
   * already being prepared holds a worker and is not repositioned — stopping
   * and restarting it would throw away finished chapters.
   *
   * @param {string} bookId
   * @param {'up'|'down'} direction
   * @returns {boolean} whether the pending order changed
   */
  function move(bookId, direction) {
    if (direction !== 'up' && direction !== 'down') return false;
    const index = pending.findIndex(entry => entry.bookId === bookId);
    if (index < 0) return false;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= pending.length) return false;
    [pending[index], pending[target]] = [pending[target], pending[index]];
    return true;
  }

  async function waitForIdle(bookId) {
    while (workers.has(bookId) || requestInvocations.has(bookId)) {
      const waiting = [workers.get(bookId), ...(requestInvocations.get(bookId) || [])]
        .map(value => value?.promise || value)
        .filter(Boolean)
        .map(promise => promise.catch(() => {}));
      await Promise.all(waiting);
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  return {
    request,
    status,
    restore,
    cancel,
    prioritize,
    move,
    waitForIdle
  };
}

module.exports = {
  aggregateStatus,
  createOfflinePreparationCoordinator
};
