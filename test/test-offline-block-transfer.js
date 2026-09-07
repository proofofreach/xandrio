const assert = require('assert');
const nodeCrypto = require('crypto');
const { pathToFileURL } = require('url');
const path = require('path');

if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}

const blockSize = 1024 * 1024;
const bytes = new Uint8Array(blockSize);
for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
const hash = value => `sha256-${nodeCrypto.createHash('sha256').update(value).digest('hex')}`;
const artifactId = hash(bytes);

function fixture(blockCount, finalSize = blockSize) {
  const total = ((blockCount - 1) * blockSize) + finalSize;
  const body = new Uint8Array(total);
  const blockHashes = [];
  for (let index = 0; index < blockCount; index++) {
    const length = index === blockCount - 1 ? finalSize : blockSize;
    const block = body.subarray(index * blockSize, (index * blockSize) + length);
    block.fill((index + 17) % 251);
    blockHashes.push(hash(block));
  }
  const identity = hash(body);
  return {
    body,
    descriptor: {
      index: 0,
      size: body.byteLength,
      artifactId: identity,
      contentHash: identity,
      etag: `"${identity}"`,
      blockSize,
      blockHashes,
      url: '/offline/audio'
    }
  };
}

function descriptor(size = bytes.byteLength) {
  return {
    index: 0,
    size,
    artifactId,
    contentHash: artifactId,
    etag: `"${artifactId}"`,
    blockSize,
    blockHashes: [hash(bytes)],
    url: '/offline/audio'
  };
}

function createStore({ corruptPending = false, quota = false } = {}) {
  const blocks = new Map();
  let ready = false;
  let corruptOnce = corruptPending;
  let writeSequence = 0;
  const key = index => String(index);
  return {
    blocks,
    get ready() { return ready; },
    async getBlock(_scope, _artifact, index) {
      const block = blocks.get(key(index));
      if (!block) return null;
      const copy = block.bytes.slice(0);
      if (corruptOnce && block.state === 'pending') {
        corruptOnce = false;
        new Uint8Array(copy)[0] ^= 1;
      }
      return { state: block.state, bytes: copy, writeId: block.writeId };
    },
    async listBlocks() {
      return [...blocks.entries()].map(([index, block]) => ({ index: Number(index), state: block.state, size: block.bytes.byteLength }));
    },
    async putPendingBlock(_scope, _artifact, index, value) {
      if (quota) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      const writeId = `write-${++writeSequence}`;
      blocks.set(key(index), { state: 'pending', bytes: value.slice(0), writeId });
      return writeId;
    },
    async markBlockVerified(_scope, _artifact, index, writeId) {
      const block = blocks.get(key(index));
      if (!block || block.writeId !== writeId) return false;
      block.state = 'verified';
      return true;
    },
    async deleteBlock(_scope, _artifact, index, _fence, writeId) {
      const block = blocks.get(key(index));
      if (writeId && (!block || block.writeId !== writeId)) return false;
      blocks.delete(key(index));
      return true;
    },
    async markChapterReady() { ready = true; }
  };
}

function responseFor(request, body = bytes, overrides = {}) {
  const range = request.headers.Range.match(/^bytes=(\d+)-(\d+)$/);
  const start = Number(range[1]);
  const end = Number(range[2]);
  const payload = body.subarray(start, end + 1);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    }
  }), {
    status: overrides.status || 206,
    headers: {
      etag: overrides.etag === undefined ? `"${artifactId}"` : overrides.etag,
      'content-range': overrides.range === undefined ? `bytes ${start}-${end}/${body.byteLength}` : overrides.range,
      ...overrides.headers
    }
  });
}

function rangedResponse(request, fixtureBody, fixtureDescriptor, stream) {
  const range = request.headers.Range.match(/^bytes=(\d+)-(\d+)$/);
  const start = Number(range[1]);
  const end = Number(range[2]);
  const body = stream || new ReadableStream({
    start(controller) {
      controller.enqueue(fixtureBody.subarray(start, end + 1));
      controller.close();
    }
  });
  return new Response(body, {
    status: 206,
    headers: {
      etag: fixtureDescriptor.etag,
      'content-range': `bytes ${start}-${end}/${fixtureBody.byteLength}`
    }
  });
}

(async () => {
  const { transferChapter, OfflineTransferError } = await import(pathToFileURL(path.join(__dirname, '../public/js/features/offline-transfer.mjs')));
  const options = (store, fetchImpl, extra = {}) => ({
    store, descriptor: descriptor(), scope: 'scope', bookId: 'book', revision: 'rev', fence: { epoch: 1 },
    fetchImpl, sleepImpl: async () => {}, random: () => 0, headerTimeoutMs: 30, inactivityTimeoutMs: 30, ...extra
  });

  await test('restart verifies a pending block and requests only the missing range', async () => {
    const store = createStore();
    store.blocks.set('0', { state: 'pending', bytes: bytes.buffer.slice(0), writeId: 'seed-1' });
    const requests = [];
    const result = await transferChapter(options(store, async (_url, request) => {
      requests.push(request.headers.Range);
      return responseFor(request);
    }));
    assert.deepStrictEqual(requests, []);
    assert.strictEqual(result.complete, true);
    assert.strictEqual(store.ready, true);
  });

  await test('corrupt pending bytes are deleted before a fresh network range', async () => {
    const store = createStore({ corruptPending: true });
    store.blocks.set('0', { state: 'pending', bytes: bytes.buffer.slice(0), writeId: 'seed-1' });
    const requests = [];
    await transferChapter(options(store, async (_url, request) => {
      requests.push(request.headers.Range);
      return responseFor(request);
    }));
    assert.deepStrictEqual(requests, [`bytes=0-${blockSize - 1}`]);
  });

  await test('generation CAS prevents concurrent bad bytes from deleting or verifying good bytes', async () => {
    const store = createStore();
    const corrupt = bytes.slice(0);
    corrupt[0] ^= 1;
    let badWriteId = '';
    let failedConditionalDeletes = 0;
    let resolveBadRead;
    const badRead = new Promise(resolve => { resolveBadRead = resolve; });
    const barriers = [pairBarrier(), pairBarrier()];
    const listCalls = { bad: 0, good: 0 };
    const wrapper = role => ({
      ...store,
      async listBlocks(...args) {
        const snapshot = await store.listBlocks(...args);
        const phase = listCalls[role]++;
        if (phase < barriers.length) await barriers[phase].arrive();
        return snapshot;
      },
      async putPendingBlock(...args) {
        if (role === 'good') await badRead;
        const writeId = await store.putPendingBlock(...args);
        if (role === 'bad') badWriteId = writeId;
        return writeId;
      },
      async getBlock(...args) {
        const block = await store.getBlock(...args);
        if (role === 'bad' && block?.state === 'pending' && block.writeId === badWriteId) {
          resolveBadRead();
        }
        return block;
      },
      async deleteBlock(...args) {
        const deleted = await store.deleteBlock(...args);
        if (role === 'bad' && args[4] === badWriteId && !deleted) failedConditionalDeletes++;
        return deleted;
      }
    });
    function pairBarrier() {
      let arrivals = 0;
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      return {
        async arrive() {
          arrivals++;
          if (arrivals === 2) release();
          await ready;
        }
      };
    }

    const badTransfer = transferChapter(options(
      wrapper('bad'),
      async (_url, request) => responseFor(request, corrupt)
    ));
    const goodTransfer = transferChapter(options(
      wrapper('good'),
      async (_url, request) => responseFor(request, bytes)
    ));
    const [badResult, goodResult] = await Promise.all([badTransfer, goodTransfer]);
    const saved = await store.getBlock('scope', artifactId, 0);
    assert.strictEqual(badResult.complete, true);
    assert.strictEqual(goodResult.complete, true);
    assert.strictEqual(saved.state, 'verified');
    assert.strictEqual(hash(new Uint8Array(saved.bytes)), artifactId);
    assert.ok(failedConditionalDeletes >= 1);
  });

  await test('quota failure does not retry the network request', async () => {
    const store = createStore({ quota: true });
    let calls = 0;
    await assert.rejects(
      transferChapter(options(store, async (_url, request) => { calls++; return responseFor(request); })),
      error => error.code === 'STORAGE_FAILED'
    );
    assert.strictEqual(calls, 1);
  });

  await test('cancellation aborts a stalled body', async () => {
    const store = createStore();
    const abort = new AbortController();
    const pending = transferChapter(options(store, async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
      status: 206, headers: { etag: `"${artifactId}"`, 'content-range': `bytes 0-${blockSize - 1}/${blockSize}` }
    }), { signal: abort.signal, inactivityTimeoutMs: 1_000 }));
    setTimeout(() => abort.abort(), 5);
    await assert.rejects(pending, error => error.code === 'TRANSFER_CANCELLED');
  });

  await test('header and body timeouts are typed errors', async () => {
    const store = createStore();
    await assert.rejects(
      transferChapter(options(store, async () => new Promise(() => {}), { headerTimeoutMs: 5 })),
      error => error.code === 'TRANSFER_TIMEOUT'
    );
    await assert.rejects(
      transferChapter(options(createStore(), async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
        status: 206, headers: { etag: `"${artifactId}"`, 'content-range': `bytes 0-${blockSize - 1}/${blockSize}` }
      }), { inactivityTimeoutMs: 5 })),
      error => error.code === 'TRANSFER_TIMEOUT'
    );
  });

  await test('malformed ETag and content range reject without accepting bytes', async () => {
    await assert.rejects(
      transferChapter(options(createStore(), async (_url, request) => responseFor(request, bytes, { etag: '"bad"' }))),
      error => error.code === 'TRANSFER_CONTRACT' || error.code === 'DESCRIPTOR_CHANGED'
    );
    await assert.rejects(
      transferChapter(options(createStore(), async (_url, request) => responseFor(request, bytes, { range: 'bytes 1-2/3' }))),
      error => error.code === 'DESCRIPTOR_CHANGED'
    );
  });

  await test('500 and 429 retry before a valid ranged response', async () => {
    const store = createStore();
    let calls = 0;
    const result = await transferChapter(options(store, async (_url, request) => {
      calls++;
      if (calls === 1) return new Response(null, { status: 500 });
      if (calls === 2) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
      return responseFor(request);
    }));
    assert.strictEqual(calls, 3);
    assert.strictEqual(result.complete, true);
  });

  await test('unexpected 200 and 416 expose descriptor changes', async () => {
    await assert.rejects(
      transferChapter(options(createStore(), async () => new Response(null, { status: 200 }))),
      error => error.code === 'DESCRIPTOR_CHANGED'
    );
    await assert.rejects(
      transferChapter(options(createStore(), async () => new Response(null, {
        status: 416, headers: { 'content-range': `bytes */${blockSize + 1}` }
      }))),
      error => error instanceof OfflineTransferError && error.code === 'DESCRIPTOR_CHANGED' && error.size === blockSize + 1
    );
  });

  await test('rejects malformed descriptors before fetching', async () => {
    let calls = 0;
    for (const malformed of [
      { ...descriptor(), artifactId: 'sha256-bad' },
      { ...descriptor(), contentHash: `sha256-${'f'.repeat(64)}` },
      { ...descriptor(), etag: '"different"' },
      { ...descriptor(), blockSize: 64 },
      { ...descriptor(), blockHashes: [] }
    ]) {
      await assert.rejects(
        transferChapter(options(createStore(), async () => { calls++; return new Response(); }, { descriptor: malformed })),
        error => error.code === 'TRANSFER_CONTRACT'
      );
    }
    assert.strictEqual(calls, 0);
  });

  await test('caps a call at one 16 MiB aligned quantum', async () => {
    const data = fixture(17);
    const store = createStore();
    const requests = [];
    const result = await transferChapter(options(store, async (_url, request) => {
      requests.push(request.headers.Range);
      return rangedResponse(request, data.body, data.descriptor);
    }, { descriptor: data.descriptor }));
    assert.deepStrictEqual(requests, [`bytes=0-${(16 * blockSize) - 1}`]);
    assert.strictEqual(result.complete, false);
    assert.strictEqual(result.verifiedBytes, 16 * blockSize);
    assert.strictEqual(result.networkBytes, 16 * blockSize);
    assert.strictEqual(store.ready, false);
  });

  await test('resumes after a dropped body without exceeding the original quantum', async () => {
    const data = fixture(3, 19);
    const store = createStore();
    const requests = [];
    let calls = 0;
    const result = await transferChapter(options(store, async (_url, request) => {
      calls++;
      requests.push(request.headers.Range);
      if (calls > 1) return rangedResponse(request, data.body, data.descriptor);
      const range = request.headers.Range.match(/^bytes=(\d+)-(\d+)$/);
      const start = Number(range[1]);
      const end = Number(range[2]);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(data.body.subarray(start, start + blockSize));
          setTimeout(() => {
            controller.enqueue(data.body.subarray(start + blockSize, start + blockSize + 31));
            setTimeout(() => controller.close(), 0);
          }, 0);
        }
      });
      return new Response(stream, {
        status: 206,
        headers: {
          etag: data.descriptor.etag,
          'content-range': `bytes ${start}-${end}/${data.body.byteLength}`
        }
      });
    }, { descriptor: data.descriptor }));
    assert.deepStrictEqual(requests, [
      `bytes=0-${data.body.byteLength - 1}`,
      `bytes=${blockSize}-${data.body.byteLength - 1}`
    ]);
    assert.strictEqual(result.complete, true);
    assert.strictEqual(result.verifiedBytes, data.body.byteLength);
    assert.strictEqual(result.networkBytes, data.body.byteLength + 31);
  });

  await test('bounds retries when every response ends in the middle of a block', async () => {
    const store = createStore();
    let calls = 0;
    await assert.rejects(
      transferChapter(options(store, async (_url, request) => {
        calls++;
        const range = request.headers.Range.match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(range[1]);
        const end = Number(range[2]);
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(0, blockSize / 2));
            controller.close();
          }
        }), {
          status: 206,
          headers: {
            etag: `"${artifactId}"`,
            'content-range': `bytes ${start}-${end}/${blockSize}`
          }
        });
      })),
      error => error.code === 'TRANSFER_NETWORK'
    );
    assert.strictEqual(calls, 4);
    assert.strictEqual(store.blocks.size, 0);
  });

  await test('requests the exact final partial block on resume', async () => {
    const data = fixture(2, 23);
    const store = createStore();
    store.blocks.set('0', { state: 'verified', bytes: data.body.slice(0, blockSize).buffer, writeId: 'seed-1' });
    const requests = [];
    const result = await transferChapter(options(store, async (_url, request) => {
      requests.push(request.headers.Range);
      return rangedResponse(request, data.body, data.descriptor);
    }, { descriptor: data.descriptor }));
    assert.deepStrictEqual(requests, [`bytes=${blockSize}-${data.body.byteLength - 1}`]);
    assert.strictEqual(result.complete, true);
    assert.strictEqual(result.networkBytes, 23);
  });

  await test('retries exactly four transient attempts and never retries permanent failures', async () => {
    let transientCalls = 0;
    await assert.rejects(
      transferChapter(options(createStore(), async () => {
        transientCalls++;
        return new Response(null, { status: 503 });
      })),
      error => error.code === 'TRANSFER_RETRYABLE' && error.status === 503
    );
    assert.strictEqual(transientCalls, 4);

    let permanentCalls = 0;
    await assert.rejects(
      transferChapter(options(createStore(), async () => {
        permanentCalls++;
        return new Response(null, { status: 403 });
      })),
      error => error.code === 'TRANSFER_CONTRACT' && error.status === 403
    );
    assert.strictEqual(permanentCalls, 1);
  });

  await test('returns a persisted retryAt for a long Retry-After', async () => {
    let calls = 0;
    const currentTime = 10_000;
    await assert.rejects(
      transferChapter(options(createStore(), async () => {
        calls++;
        return new Response(null, { status: 429, headers: { 'retry-after': '30' } });
      }, { now: () => currentTime, maxRetryAfterWaitMs: 5_000 })),
      error => error.code === 'TRANSFER_RETRY_LATER' && error.status === 429 && error.retryAt === currentTime + 30_000
    );
    assert.strictEqual(calls, 1);
  });

  await test('cancels unexpected response bodies and rejects malformed lengths', async () => {
    let cancelled = false;
    const unexpected = new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; }
    }), { status: 200 });
    await assert.rejects(
      transferChapter(options(createStore(), async () => unexpected)),
      error => error.code === 'DESCRIPTOR_CHANGED'
    );
    assert.strictEqual(cancelled, true);

    await assert.rejects(
      transferChapter(options(createStore(), async (_url, request) => responseFor(request, bytes, {
        headers: { 'content-length': String(blockSize - 1) }
      }))),
      error => error.code === 'TRANSFER_CONTRACT'
    );
  });

  await test('storage reads fail before network and storage writes do not retry', async () => {
    let calls = 0;
    const brokenRead = createStore();
    brokenRead.listBlocks = async () => { throw new Error('IDB unavailable'); };
    await assert.rejects(
      transferChapter(options(brokenRead, async () => { calls++; return new Response(); })),
      error => error.code === 'STORAGE_FAILED'
    );
    assert.strictEqual(calls, 0);

    const brokenWrite = createStore();
    brokenWrite.markBlockVerified = async () => { throw new Error('transaction aborted'); };
    await assert.rejects(
      transferChapter(options(brokenWrite, async (_url, request) => {
        calls++;
        return responseFor(request);
      })),
      error => error.code === 'STORAGE_FAILED'
    );
    assert.strictEqual(calls, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
