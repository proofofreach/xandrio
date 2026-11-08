const { AsyncLocalStorage } = require('async_hooks');

function createBookMutationLocks() {
  const tails = new Map();
  const mutationActive = new Set();
  const ownership = new AsyncLocalStorage();

  function abortError(signal) {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    const error = new Error('Book lock wait aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
  }

  // A waiter whose signal aborts before it acquires the lock rejects at once
  // and never runs its task. The queue position is still released only when
  // the previous holder finishes, so later waiters stay serialized. Once the
  // task starts, the signal no longer affects the lock: the holder runs to
  // completion.
  function queue(map, key, task, signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const previous = map.get(key) || Promise.resolve();
    let run;
    let turn;
    if (signal) {
      run = new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        turn = previous.then(() => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) return undefined;
          return Promise.resolve().then(task).then(resolve, reject);
        });
      });
    } else {
      run = previous.then(task);
      turn = run;
    }
    const tail = turn.then(() => {}, () => {});
    map.set(key, tail);
    tail.then(() => {
      if (map.get(key) === tail) map.delete(key);
    });
    return run;
  }

  // Ownership is an AsyncLocalStorage context, so timers and detached
  // promises started inside a critical section inherit it. Each held key maps
  // to a token that is marked released when the section ends; reentrancy is
  // granted only while the token is live, so work that outlives the holder
  // queues like any other caller.
  function holds(key) {
    const token = ownership.getStore()?.held?.get(key);
    return Boolean(token && !token.released);
  }

  function liveHeld() {
    const held = new Map();
    for (const [key, token] of ownership.getStore()?.held || []) {
      if (!token.released) held.set(key, token);
    }
    return held;
  }

  function withBookMutationLock(bookId, task, options = {}) {
    const key = String(bookId);
    if (options.ifBusy === 'return' && mutationActive.has(key)) {
      return Promise.resolve(options.busyValue);
    }
    // Reentrant: a mutation already holding this book must not enqueue
    // behind itself (self-deadlock). Run directly in the same ownership.
    if (holds(key)) {
      return Promise.resolve().then(task);
    }
    return queue(tails, key, async () => {
      mutationActive.add(key);
      const token = { released: false };
      try {
        const held = liveHeld();
        held.set(key, token);
        return await ownership.run({ bookId: key, mutation: true, held }, task);
      } finally {
        token.released = true;
        mutationActive.delete(key);
      }
    }, options.signal);
  }

  // Acquire several book locks atomically-enough: keys are taken in sorted
  // order, so two multi-key acquirers can never wait on each other in a cycle
  // (consistent global order ⇒ no deadlock). An empty key set still runs the
  // task; a single-key task on an unrelated id is not blocked.
  function withBookMutationLocks(bookIds, task) {
    const keys = [...new Set((Array.isArray(bookIds) ? bookIds : []).map(String))].sort();
    const enter = i => i >= keys.length
      ? Promise.resolve().then(task)
      : withBookMutationLock(keys[i], () => (
        i + 1 < keys.length ? enter(i + 1) : Promise.resolve().then(task)
      ));
    return enter(0);
  }

  function withBookStateLock(bookId, task, options = {}) {
    const key = String(bookId);
    // A mutation is the outer lock. Nested state operations already have
    // exclusive ownership and must not enqueue behind themselves.
    if (holds(key)) {
      return Promise.resolve().then(task);
    }
    return queue(tails, key, () => ownership.run({ bookId: key, mutation: false }, task), options.signal);
  }

  return {
    withBookMutationLock,
    withBookMutationLocks,
    withBookStateLock,
    isBookMutationActive: bookId => mutationActive.has(String(bookId))
  };
}

module.exports = { createBookMutationLocks };
