const assert = require('assert');
const { createBookMutationLocks } = require('../lib/book-mutation-lock');

(async () => {
  const locks = createBookMutationLocks();
  let release;
  const first = locks.withBookMutationLock('book', async () => {
    await new Promise(resolve => { release = resolve; });
    return 'first';
  });
  await new Promise(resolve => setImmediate(resolve));
  const busy = await locks.withBookMutationLock('book', async () => 'second', {
    ifBusy: 'return',
    busyValue: { changed: false, reason: 'busy' }
  });
  assert.deepStrictEqual(busy, { changed: false, reason: 'busy' },
    'a concurrent rebuild returns a no-op instead of entering the mutation');
  release();
  assert.strictEqual(await first, 'first', 'the active per-book mutation completes normally');

  const order = [];
  let releaseState;
  const state = locks.withBookStateLock('shared', async () => {
    order.push('state-start');
    await new Promise(resolve => { releaseState = resolve; });
    order.push('state-end');
  });
  await new Promise(resolve => setImmediate(resolve));
  const mutation = locks.withBookMutationLock('shared', async () => {
    order.push('mutation');
    await locks.withBookStateLock('shared', async () => order.push('nested-state'));
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(order, ['state-start'], 'state and mutation operations mutually exclude');
  releaseState();
  await Promise.all([state, mutation]);
  assert.deepStrictEqual(order, ['state-start', 'state-end', 'mutation', 'nested-state'],
    'mutation owns the outer lock and may enter its state section without deadlock');

  console.log('4 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
