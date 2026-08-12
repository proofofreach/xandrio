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
    withBookStateLock,
    isBookMutationActive: bookId => mutationActive.has(String(bookId))
  };
}

module.exports = { createBookMutationLocks };
