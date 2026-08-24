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

  // Multi-key acquisition: sorted order must serialize two overlapping
  // acquirers without deadlock, and each key must be held for the whole task.
  const multi = createBookMutationLocks();
  const events = [];
  let releaseA;
  const holder = multi.withBookMutationLocks(['a', 'b'], async () => {
    events.push('holder-start');
    await new Promise(resolve => { releaseA = resolve; });
    events.push('holder-end');
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(events, ['holder-start'],
    'multi-key holder runs while no one else contends yet');
  const waiter = multi.withBookMutationLocks(['b', 'a'], async () => {
    events.push('waiter-start');
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(events, ['holder-start'],
    'overlapping multi-key acquisition waits instead of deadlocking');
  releaseA();
  await Promise.all([holder, waiter]);
  assert.deepStrictEqual(events, ['holder-start', 'holder-end', 'waiter-start'],
    'waiter proceeds only after the holder releases every key');
  // A single-key task touching a non-held key is not blocked by a multi-key holder.
  const unrelated = multi.withBookMutationLock('c', async () => 'c-ok');
  assert.strictEqual(await unrelated, 'c-ok', 'unrelated single-key task unaffected');

  console.log('8 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
