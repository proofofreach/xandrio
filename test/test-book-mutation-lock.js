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
  const empty = await multi.withBookMutationLocks([], async () => 'empty-ok');
  assert.strictEqual(empty, 'empty-ok', 'an empty key set still runs the task');

  // Ownership must not leak into work that outlives the critical section. A
  // timer armed while holding the lock (the post-delete sweeps) fires after
  // release and must queue behind a later holder (a re-import), not run inside it.
  const leak = createBookMutationLocks();
  let fireTimer;
  await leak.withBookMutationLock('book', async () => {
    const timerFired = new Promise(resolve => { fireTimer = resolve; });
    timerFired.then(() => leak.withBookMutationLock('book', async () => {
      leakEvents.push('sweep');
    }));
  });
  const leakEvents = [];
  let releaseImport;
  const reimport = leak.withBookMutationLock('book', async () => {
    leakEvents.push('import-start');
    await new Promise(resolve => { releaseImport = resolve; });
    leakEvents.push('import-end');
  });
  await new Promise(resolve => setImmediate(resolve));
  fireTimer();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepStrictEqual(leakEvents, ['import-start'],
    'a deferred task from a released holder waits for the current holder');
  releaseImport();
  await reimport;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepStrictEqual(leakEvents, ['import-start', 'import-end', 'sweep'],
    'the deferred task runs after the current holder releases');
  const stateLeak = createBookMutationLocks();
  let fireStateTimer;
  const stateEvents = [];
  await stateLeak.withBookMutationLock('book', async () => {
    new Promise(resolve => { fireStateTimer = resolve; })
      .then(() => stateLeak.withBookStateLock('book', async () => stateEvents.push('state')));
  });
  let releaseHolder;
  const holderAgain = stateLeak.withBookMutationLock('book', async () => {
    stateEvents.push('holder');
    await new Promise(resolve => { releaseHolder = resolve; });
  });
  await new Promise(resolve => setImmediate(resolve));
  fireStateTimer();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepStrictEqual(stateEvents, ['holder'],
    'a leaked state section also queues instead of bypassing the lock');
  releaseHolder();
  await holderAgain;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepStrictEqual(stateEvents, ['holder', 'state']);

  // A waiter on behalf of abortable work leaves the queue when aborted, so a
  // holder that awaits that work (book deletion awaiting a guide) cannot
  // deadlock. Later waiters still serialize behind the holder.
  const abortable = createBookMutationLocks();
  const abortEvents = [];
  const controller = new AbortController();
  let guideWork;
  let later;
  let deletionEntered;
  const entered = new Promise(resolve => { deletionEntered = resolve; });
  const deletion = abortable.withBookMutationLock('book', async () => {
    abortEvents.push('delete-start');
    deletionEntered();
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    const settled = await guideWork;
    abortEvents.push('delete-end');
    return settled;
  });
  await entered;
  // The guide runs in its own async context, outside the deletion.
  guideWork = abortable.withBookStateLock('book', async () => abortEvents.push('guide-ran'),
    { signal: controller.signal }).then(() => 'resolved', error => error.name);
  later = abortable.withBookStateLock('book', async () => abortEvents.push('later'));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 1000));
  const waiterSettled = await Promise.race([deletion, timeout]);
  await later;
  assert.strictEqual(waiterSettled, 'AbortError', 'an aborted waiter rejects while the holder still runs');
  assert.deepStrictEqual(abortEvents, ['delete-start', 'delete-end', 'later'],
    'the aborted waiter never runs and a later waiter still waits for the holder');
  await assert.rejects(
    abortable.withBookStateLock('book', async () => {}, { signal: AbortSignal.abort() }),
    error => error.name === 'AbortError',
    'an already-aborted signal rejects without queueing'
  );
  assert.strictEqual(await abortable.withBookStateLock('book', async () => 'free'), 'free',
    'the lock is free after aborted waits');

  console.log('17 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
