const { AsyncLocalStorage } = require('async_hooks');

function createBookMutationLocks() {
  const tails = new Map();
  const mutationActive = new Set();
  const ownership = new AsyncLocalStorage();

  function queue(map, key, task) {
    const previous = map.get(key) || Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(() => {}, () => {});
    map.set(key, tail);
    tail.then(() => {
      if (map.get(key) === tail) map.delete(key);
    });
    return run;
  }

  function withBookMutationLock(bookId, task, options = {}) {
    const key = String(bookId);
    if (options.ifBusy === 'return' && mutationActive.has(key)) {
      return Promise.resolve(options.busyValue);
    }
    return queue(tails, key, async () => {
      mutationActive.add(key);
      try {
        return await ownership.run({ bookId: key, mutation: true }, task);
      } finally {
        mutationActive.delete(key);
      }
    });
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

  function withBookStateLock(bookId, task) {
    const key = String(bookId);
    // A mutation is the outer lock. Nested state operations already have
    // exclusive ownership and must not enqueue behind themselves.
    if (ownership.getStore()?.mutation && ownership.getStore()?.bookId === key) {
      return Promise.resolve().then(task);
    }
    return queue(tails, key, () => ownership.run({ bookId: key, mutation: false }, task));
  }

  return {
    withBookMutationLock,
    withBookMutationLocks,
    withBookStateLock,
    isBookMutationActive: bookId => mutationActive.has(String(bookId))
  };
}

module.exports = { createBookMutationLocks };
