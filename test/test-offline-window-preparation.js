const assert = require('node:assert/strict');
const { createOfflineWindowPreparation } = require('../lib/offline-window-preparation');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ stalled = true } = {}) {
  const calls = [];
  const errors = [];
  const coordinator = createOfflineWindowPreparation({
    getBookChapters: async () => ({ chapters: [{ empty: true }, ...Array.from({ length: 6 }, () => ({ text: 'Audio' }))] }),
    identity: async () => ({ packageVariantKey: 'voice:offline', sourceVariantKey: 'voice' }),
    prepareChapter: request => {
      calls.push(request);
      if (!stalled) return Promise.resolve();
      return new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        request.resolve = resolve;
      });
    },
    onError: error => errors.push(error)
  });
  return { coordinator, calls, errors };
}
async function main() {
  await test('validates the bounded window before scheduling work', async () => {
    const f = fixture();
    for (const indexes of [null, [1, 2, 3, 4, 5], [-1], [7], [1.5], ['1']]) {
      await assert.rejects(f.coordinator.request('book', indexes, 'device'), TypeError);
    }
    assert.equal(f.calls.length, 0);
  });
  await test('deduplicates indexes and excludes structural empty chapters', async () => {
    const f = fixture({ stalled: false });
    const result = await f.coordinator.request('book', [0, 2, 2, 1], 'device');
    await tick();
    assert.deepEqual(result.chapterIndexes, [2, 1]);
    assert.deepEqual(f.calls.map(call => call.chapterIndex), [2, 1]);
    assert(f.calls.every(call => call.origin === 'offline-download' && call.requestId.startsWith('window-')));
  });
  await test('identical in-flight windows are idempotent', async () => {
    const f = fixture();
    await f.coordinator.request('book', [1, 2], 'device');
    await f.coordinator.request('book', [1, 2], 'device');
    assert.equal(f.calls.length, 1);
    await f.coordinator.cancelBook('book');
    assert.equal(f.errors.length, 0);
  });
  await test('replacing one device window leaves another device claim active', async () => {
    const f = fixture();
    await f.coordinator.request('book', [1], 'device-a');
    await f.coordinator.request('book', [2], 'device-b');
    const [first, other] = f.calls;
    await f.coordinator.request('book', [3], 'device-a');
    assert.equal(first.signal.aborted, true);
    assert.equal(other.signal.aborted, false);
    assert.equal(f.calls[2].signal.aborted, false);
    await f.coordinator.cancelBook('book');
    assert(f.calls.every(call => call.signal.aborted));
    assert.equal(f.errors.length, 0);
  });
  await test('book deletion waits only for the affected book and leaves other work alive', async () => {
    const f = fixture();
    await f.coordinator.request('first', [1], 'device');
    await f.coordinator.request('second', [1], 'device');
    await f.coordinator.cancelBook('first');
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.calls[1].signal.aborted, false);
    await f.coordinator.cancelBook('second');
  });
  await test('bounds active claims and releases admission after cancellation', async () => {
    const f = fixture();
    for (let index = 0; index < 24; index++) await f.coordinator.request(`book-${index}`, [1], 'device');
    await assert.rejects(f.coordinator.request('overflow', [1], 'device'), error => error.statusCode === 429);
    await f.coordinator.cancelBook('book-0');
    await f.coordinator.request('overflow', [1], 'device');
    await Promise.all(Array.from({ length: 24 }, (_, index) => f.coordinator.cancelBook(`book-${index}`)));
    await f.coordinator.cancelBook('overflow');
  });
  await test('book cancellation fences a window still awaiting its first load', async () => {
    let release;
    const load = new Promise(resolve => { release = resolve; });
    const calls = [];
    const coordinator = createOfflineWindowPreparation({
      getBookChapters: async () => load,
      identity: async () => ({ packageVariantKey: 'voice:offline' }),
      prepareChapter: async request => calls.push(request)
    });
    const request = coordinator.request('book', [0], 'device');
    const cancel = coordinator.cancelBook('book');
    release({ chapters: [{ text: 'Audio' }] });
    await assert.rejects(request, error => error.name === 'AbortError');
    await cancel;
    assert.equal(calls.length, 0);
  });
  await test('a request started after cancellation is not retired with the old window', async () => {
    const loads = [];
    const calls = [];
    const coordinator = createOfflineWindowPreparation({
      getBookChapters: async () => new Promise(resolve => loads.push(resolve)),
      identity: async () => ({ packageVariantKey: 'voice:offline' }),
      prepareChapter: async request => calls.push(request)
    });
    const stale = coordinator.request('book', [0], 'device');
    const cancel = coordinator.cancelBook('book');
    const replacement = coordinator.request('book', [0], 'device');
    while (loads.length < 2) await tick();
    loads[0]({ chapters: [{ text: 'Old' }] });
    loads[1]({ chapters: [{ text: 'New' }] });
    await assert.rejects(stale, error => error.name === 'AbortError');
    await cancel;
    assert.deepEqual(await replacement, { state: 'preparing', chapterIndexes: [0] });
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);
    await coordinator.cancelBook('book');
  });
  await test('a replacement does not join an aborted active window', async () => {
    const f = fixture();
    await f.coordinator.request('book', [1], 'device');
    const cancel = f.coordinator.cancelBook('book');
    const replacement = f.coordinator.request('book', [1], 'device');
    await cancel;
    assert.deepEqual(await replacement, { state: 'preparing', chapterIndexes: [1] });
    await tick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.calls[1].signal.aborted, false);
    await f.coordinator.cancelBook('book');
  });
  console.log(`offline-window-preparation tests: ${passed} passed, 0 failed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
