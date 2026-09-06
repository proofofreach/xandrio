const crypto = require('node:crypto');

function abortError() {
  const error = new Error('Offline window request was cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function createOfflineWindowPreparation({ getBookChapters, prepareChapter, identity, onError = () => {} }) {
  const claims = new Map();
  const jobs = new Map();
  const bookEpochs = new Map();
  const invocations = new Map();
  const admissions = new Map();

  const epoch = bookId => bookEpochs.get(bookId) || 0;
  const assertCurrent = invocation => {
    if (invocation.controller.signal.aborted || epoch(invocation.bookId) !== invocation.epoch) {
      throw abortError();
    }
  };
  const invocationSet = bookId => {
    let records = invocations.get(bookId);
    if (!records) {
      records = new Set();
      invocations.set(bookId, records);
    }
    return records;
  };
  const admit = (key, work) => {
    const previous = admissions.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    admissions.set(key, current);
    current.finally(() => {
      if (admissions.get(key) === current) admissions.delete(key);
    }).catch(() => {});
    return current;
  };

  function request(bookId, chapterIndexes, ownerId = 'default') {
    if (!Array.isArray(chapterIndexes) || chapterIndexes.length > 4 ||
        chapterIndexes.some(index => !Number.isInteger(index) || index < 0)) {
      return Promise.reject(new TypeError('Offline window must contain at most four valid chapter indexes'));
    }
    const key = `${ownerId}:${bookId}`;
    const invocation = {
      bookId,
      key,
      epoch: epoch(bookId),
      controller: new AbortController(),
      promise: null
    };
    invocationSet(bookId).add(invocation);
    const promise = requestInvocation(bookId, chapterIndexes, key, invocation)
      .finally(() => {
        const records = invocations.get(bookId);
        records?.delete(invocation);
        if (records?.size === 0) invocations.delete(bookId);
      });
    invocation.promise = promise;
    return promise;
  }

  async function requestInvocation(bookId, chapterIndexes, key, invocation) {
    const { chapters } = await getBookChapters(bookId);
    assertCurrent(invocation);
    if (chapterIndexes.some(index => index >= chapters.length)) {
      throw new TypeError('Offline window must contain at most four valid chapter indexes');
    }
    const currentIdentity = await identity({ bookId });
    assertCurrent(invocation);
    const indexes = [...new Set(chapterIndexes)].filter(index => !chapters[index].empty);
    const signature = JSON.stringify([currentIdentity.packageVariantKey, indexes]);

    return admit(key, async () => {
      assertCurrent(invocation);
      const previous = claims.get(key);
      if (
        previous?.signature === signature &&
        !previous.controller.signal.aborted &&
        previous.epoch === epoch(bookId)
      ) {
        return { state: previous.state, chapterIndexes: indexes };
      }
      if (!previous && claims.size >= 24) {
        throw Object.assign(new Error('Too many offline windows are preparing'), { statusCode: 429 });
      }
      previous?.controller.abort();
      assertCurrent(invocation);
      const record = {
        bookId,
        signature,
        state: 'preparing',
        controller: new AbortController(),
        requestId: `window-${crypto.randomBytes(12).toString('hex')}`,
        epoch: invocation.epoch
      };
      claims.set(key, record);
      const task = (async () => {
        for (const chapterIndex of indexes) {
          if (record.controller.signal.aborted || epoch(bookId) !== record.epoch) return;
          await prepareChapter({
            bookId, chapterIndex, ...currentIdentity,
            signal: record.controller.signal, requestId: record.requestId,
            priority: 'background', origin: 'offline-download'
          });
          if (record.controller.signal.aborted || epoch(bookId) !== record.epoch) return;
        }
        record.state = 'ready';
      })().catch(error => {
        record.state = 'error';
        if (!record.controller.signal.aborted && epoch(bookId) === record.epoch) {
          onError(error, { bookId });
        }
      }).finally(() => {
        jobs.delete(task);
        if (claims.get(key) === record) claims.delete(key);
      });
      jobs.set(task, bookId);
      assertCurrent(invocation);
      return { state: 'preparing', chapterIndexes: indexes };
    });
  }

  async function cancelBook(bookId) {
    bookEpochs.set(bookId, epoch(bookId) + 1);
    const pending = [...(invocations.get(bookId) || [])];
    for (const invocation of pending) invocation.controller.abort();
    for (const record of claims.values()) {
      if (record.bookId === bookId) record.controller.abort();
    }
    await Promise.all([
      ...pending.map(invocation => invocation.promise?.catch(() => {})),
      ...[...jobs].filter(([, id]) => id === bookId).map(([task]) => task)
    ]);
  }

  return { request, cancelBook };
}

module.exports = { createOfflineWindowPreparation };
