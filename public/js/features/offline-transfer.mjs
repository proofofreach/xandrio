const BLOCK_SIZE = 1024 * 1024;
const MAX_QUANTUM = 16 * BLOCK_SIZE;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class OfflineTransferError extends Error {
  constructor(code, message, { status, retryAt, size, cause } = {}) {
    super(message);
    this.name = 'OfflineTransferError';
    this.code = code;
    if (status != null) this.status = status;
    if (retryAt != null) this.retryAt = retryAt;
    if (size != null) this.size = size;
    if (cause != null) this.cause = cause;
  }
}

function transferError(code, message, details) {
  return new OfflineTransferError(code, message, details);
}

function abortedError(signal) {
  if (signal?.reason instanceof OfflineTransferError) return signal.reason;
  return transferError('TRANSFER_CANCELLED', 'Offline transfer was cancelled', { status: 499, cause: signal?.reason });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortedError(signal);
}

function linkedController(parent) {
  const controller = new AbortController();
  let removeParent = () => {};
  if (parent) {
    const abort = () => controller.abort(parent.reason);
    if (parent.aborted) abort();
    else {
      parent.addEventListener('abort', abort, { once: true });
      removeParent = () => parent.removeEventListener('abort', abort);
    }
  }
  return { controller, removeParent };
}

function isSha256(value) {
  return typeof value === 'string' && /^sha256-[a-f0-9]{64}$/.test(value);
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    throw transferError('TRANSFER_CONTRACT', 'Offline descriptor must be an object');
  }
  if (!Number.isSafeInteger(descriptor.index) || descriptor.index < 0 ||
      !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0 ||
      descriptor.blockSize !== BLOCK_SIZE || !isSha256(descriptor.artifactId) ||
      !isSha256(descriptor.contentHash) || typeof descriptor.url !== 'string' ||
      descriptor.url.length === 0 || !Array.isArray(descriptor.blockHashes)) {
    throw transferError('TRANSFER_CONTRACT', 'Offline descriptor is malformed');
  }
  if (!/^"sha256-[a-f0-9]{64}"$/.test(descriptor.etag || '')) {
    throw transferError('TRANSFER_CONTRACT', 'Offline descriptor has an invalid ETag');
  }
  if (descriptor.contentHash !== descriptor.artifactId || descriptor.etag !== `"${descriptor.artifactId}"`) {
    throw transferError('TRANSFER_CONTRACT', 'Offline descriptor identities do not match');
  }
  const count = Math.ceil(descriptor.size / BLOCK_SIZE);
  if (descriptor.blockHashes.length !== count || !descriptor.blockHashes.every(isSha256)) {
    throw transferError('TRANSFER_CONTRACT', 'Offline descriptor has invalid block hashes');
  }
}

function expectedBlockSize(descriptor, index) {
  const start = index * BLOCK_SIZE;
  return Math.min(BLOCK_SIZE, descriptor.size - start);
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const size = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(size)) return null;
  return { start, end, size };
}

function parseUnsatisfiedSize(value) {
  const match = /^bytes \*\/(\d+)$/.exec(value || '');
  if (!match) return null;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) ? size : null;
}

function retryAfterMs(value, now) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now());
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitterDelay(attempt, random) {
  const base = [500, 1500, 4000][Math.min(attempt, 2)];
  return Math.floor(base * (0.75 + (random() * 0.5)));
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw transferError('TRANSFER_CONTRACT', 'WebCrypto is required for offline transfer verification');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function storeCall(signal, action) {
  throwIfAborted(signal);
  try {
    const value = await action();
    throwIfAborted(signal);
    return value;
  } catch (error) {
    if (signal?.aborted) throw abortedError(signal);
    if (error instanceof OfflineTransferError) throw error;
    throw transferError('STORAGE_FAILED', 'Offline storage operation failed', { cause: error });
  }
}

async function verifyPendingBlock({ store, descriptor, scope, fence, index, signal }) {
  while (true) {
    const saved = await storeCall(signal, () => store.getBlock(scope, descriptor.artifactId, index));
    if (!saved || saved.state !== 'pending') return saved?.state === 'verified';
    if (typeof saved.writeId !== 'string' || !saved.writeId) {
      throw transferError('STORAGE_FAILED', 'Offline pending block has no write generation');
    }
    const bytes = saved.bytes instanceof ArrayBuffer ? saved.bytes : null;
    const valid = Boolean(
      bytes && bytes.byteLength === expectedBlockSize(descriptor, index) &&
      await sha256(bytes) === descriptor.blockHashes[index]
    );
    if (valid) {
      const committed = await storeCall(signal, () =>
        store.markBlockVerified(scope, descriptor.artifactId, index, saved.writeId, fence)
      );
      if (committed) return true;
      continue;
    }
    const deleted = await storeCall(signal, () =>
      store.deleteBlock(scope, descriptor.artifactId, index, fence, saved.writeId)
    );
    if (deleted) return false;
  }
}

async function verifyAllPending({ store, descriptor, scope, fence, signal }) {
  const blocks = await storeCall(signal, () => store.listBlocks(scope, descriptor.artifactId));
  const byIndex = new Map(blocks.map(block => [block.index, block]));
  for (const [index, block] of byIndex) {
    if (!Number.isInteger(index) || index < 0 || index >= descriptor.blockHashes.length) continue;
    if (block.state === 'pending') await verifyPendingBlock({ store, descriptor, scope, fence, index, signal });
  }
  return storeCall(signal, () => store.listBlocks(scope, descriptor.artifactId));
}

function verifiedBytes(descriptor, blocks) {
  const verified = new Set(blocks.filter(block => block.state === 'verified').map(block => block.index));
  let bytes = 0;
  for (let index = 0; index < descriptor.blockHashes.length; index++) {
    if (verified.has(index)) bytes += expectedBlockSize(descriptor, index);
  }
  return { bytes, verified };
}

function firstMissingRun(descriptor, verified, maxBytes, lastLimit = descriptor.blockHashes.length - 1) {
  let first = 0;
  while (first < descriptor.blockHashes.length && verified.has(first)) first++;
  if (first === descriptor.blockHashes.length || first > lastLimit) return null;
  const maxBlocks = Math.max(1, Math.floor(Math.min(MAX_QUANTUM, maxBytes) / BLOCK_SIZE));
  let last = first;
  while (last + 1 < descriptor.blockHashes.length && last + 1 <= lastLimit &&
      !verified.has(last + 1) && (last - first + 1) < maxBlocks) last++;
  const start = first * BLOCK_SIZE;
  return { first, last, start, end: (last * BLOCK_SIZE) + expectedBlockSize(descriptor, last) - 1 };
}

async function cancelBody(response) {
  try { await response?.body?.cancel?.(); } catch { /* the response is already unusable */ }
}

async function readChunk(reader, controller, timeoutMs, signal) {
  throwIfAborted(signal);
  let timer;
  let removeAbort = () => {};
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = transferError('TRANSFER_TIMEOUT', 'Offline transfer body timed out', { status: 408 });
      controller.abort(error);
      reject(error);
      Promise.resolve().then(() => reader.cancel(error)).catch(() => {});
    }, timeoutMs);
  });
  const aborted = new Promise((_, reject) => {
    if (!signal) return;
    const abort = () => {
      const error = abortedError(signal);
      reject(error);
      Promise.resolve().then(() => reader.cancel(error)).catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([reader.read(), timeout, aborted]);
  } finally {
    clearTimeout(timer);
    removeAbort();
  }
}

async function fetchRange({ fetchImpl, descriptor, run, signal, headerTimeoutMs }) {
  const { controller, removeParent } = linkedController(signal);
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = transferError('TRANSFER_TIMEOUT', 'Offline transfer headers timed out', { status: 408 });
        controller.abort(error);
        reject(error);
      }, headerTimeoutMs);
    });
    const response = await Promise.race([
      fetchImpl(descriptor.url, {
        headers: { Range: `bytes=${run.start}-${run.end}`, 'If-Range': descriptor.etag },
        signal: controller.signal
      }),
      timeout
    ]);
    if (!response || typeof response.status !== 'number' || !response.headers) {
      throw transferError('TRANSFER_CONTRACT', 'Offline transfer returned an invalid response');
    }
    return { response, controller, dispose: removeParent };
  } catch (error) {
    removeParent();
    if (signal?.aborted) throw abortedError(signal);
    if (controller.signal.aborted && controller.signal.reason instanceof OfflineTransferError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    // Keep the parent signal connected while the response body is consumed.
  }
}

function responseError(response, descriptor) {
  if (response.status === 200 || response.status === 409) {
    return transferError('DESCRIPTOR_CHANGED', 'Offline descriptor no longer matches the artifact', { status: response.status });
  }
  if (response.status === 416) {
    return transferError('DESCRIPTOR_CHANGED', 'Offline descriptor size no longer matches the artifact', {
      status: 416,
      size: parseUnsatisfiedSize(response.headers.get('content-range'))
    });
  }
  if (TRANSIENT_STATUSES.has(response.status)) {
    return transferError('TRANSFER_RETRYABLE', `Offline transfer returned ${response.status}`, { status: response.status });
  }
  if (response.status !== 206) {
    return transferError('TRANSFER_CONTRACT', `Unexpected offline transfer status ${response.status}`, { status: response.status });
  }
  const range = parseContentRange(response.headers.get('content-range'));
  if (!range || range.size !== descriptor.size) {
    return transferError('DESCRIPTOR_CHANGED', 'Offline transfer response has a different size', { status: 206, size: range?.size });
  }
  return null;
}

function isRetryable(error) {
  if (error?.code === 'TRANSFER_RETRY_LATER') return false;
  return error?.code === 'TRANSFER_TIMEOUT' || error?.code === 'TRANSFER_NETWORK' ||
    error?.code === 'TRANSFER_RETRYABLE' || TRANSIENT_STATUSES.has(error?.status);
}

async function abortableSleep(delay, sleepImpl, signal) {
  throwIfAborted(signal);
  let removeAbort = () => {};
  const aborted = new Promise((_, reject) => {
    if (!signal) return;
    const abort = () => reject(abortedError(signal));
    signal.addEventListener('abort', abort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  });
  try {
    await Promise.race([sleepImpl(delay), aborted]);
  } finally {
    removeAbort();
  }
}

async function streamRun({ response, controller, descriptor, run, store, scope, fence, signal, inactivityTimeoutMs, reportNetwork, reportVerified }) {
  if (!response.body?.getReader) {
    throw transferError('TRANSFER_CONTRACT', 'Offline transfer response has no readable body', { status: response.status });
  }
  const range = parseContentRange(response.headers.get('content-range'));
  if (!range || range.start !== run.start || range.end !== run.end || range.size !== descriptor.size ||
      response.headers.get('etag') !== descriptor.etag) {
    await cancelBody(response);
    throw transferError('TRANSFER_CONTRACT', 'Offline transfer response headers do not match the requested range', { status: response.status });
  }
  const declaredLength = response.headers.get('content-length');
  const expectedLength = run.end - run.start + 1;
  if (declaredLength != null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== expectedLength)) {
    await cancelBody(response);
    throw transferError('TRANSFER_CONTRACT', 'Offline transfer response has an invalid content length', { status: response.status });
  }
  const reader = response.body.getReader();
  let received = 0;
  let index = run.first;
  let partial = new Uint8Array(expectedBlockSize(descriptor, index));
  let offset = 0;
  try {
    while (true) {
      const item = await readChunk(reader, controller, inactivityTimeoutMs, signal);
      if (item.done) break;
      const chunk = item.value instanceof Uint8Array ? item.value : new Uint8Array(item.value);
      let chunkOffset = 0;
      received += chunk.byteLength;
      reportNetwork(chunk.byteLength);
      if (received > (run.end - run.start + 1)) {
        throw transferError('TRANSFER_CONTRACT', 'Offline transfer body exceeded the requested range', { status: response.status });
      }
      while (chunkOffset < chunk.byteLength) {
        throwIfAborted(signal);
        const copied = Math.min(partial.byteLength - offset, chunk.byteLength - chunkOffset);
        partial.set(chunk.subarray(chunkOffset, chunkOffset + copied), offset);
        offset += copied;
        chunkOffset += copied;
        if (offset !== partial.byteLength) continue;
        await storeCall(signal, () => store.putPendingBlock(scope, descriptor.artifactId, index, partial.buffer, fence));
        const verified = await verifyPendingBlock({ store, descriptor, scope, fence, index, signal });
        if (!verified) throw transferError('TRANSFER_CONTRACT', 'Offline storage did not preserve a received block');
        reportVerified(partial.byteLength);
        index++;
        offset = 0;
        if (index <= run.last) {
          partial = new Uint8Array(expectedBlockSize(descriptor, index));
        }
      }
    }
    if (received < run.end - run.start + 1) {
      throw transferError('TRANSFER_NETWORK', 'Offline transfer body ended before the requested range was complete');
    }
    if (received !== run.end - run.start + 1 || index !== run.last + 1 || offset !== 0) {
      throw transferError('TRANSFER_CONTRACT', 'Offline transfer body length did not match the requested range', { status: response.status });
    }
  } catch (error) {
    await Promise.resolve(reader.cancel(error)).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Transfers and verifies at most one 16 MiB missing range for a chapter.
 */
export async function transferChapter({
  store,
  descriptor,
  scope,
  bookId,
  revision,
  fence,
  signal,
  onProgress,
  fetchImpl = fetch,
  maxBytes = MAX_QUANTUM,
  headerTimeoutMs = 15_000,
  inactivityTimeoutMs = 30_000,
  maxRetryAfterWaitMs = 5_000,
  sleepImpl = defaultSleep,
  random = Math.random,
  now = Date.now
} = {}) {
  validateDescriptor(descriptor);
  if (!store || typeof fetchImpl !== 'function' || typeof scope !== 'string' || typeof bookId !== 'string' ||
      typeof revision !== 'string' || !fence || !Number.isFinite(maxBytes) || maxBytes < BLOCK_SIZE ||
      maxBytes > MAX_QUANTUM || Math.floor(maxBytes / BLOCK_SIZE) < 1 ||
      !Number.isFinite(headerTimeoutMs) || headerTimeoutMs <= 0 || !Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
    throw transferError('TRANSFER_CONTRACT', 'Offline transfer arguments are malformed');
  }
  throwIfAborted(signal);

  let networkBytes = 0;
  let blockList = await verifyAllPending({ store, descriptor, scope, fence, signal });
  let state = verifiedBytes(descriptor, blockList);
  const emitProgress = () => {
    try { onProgress?.({ verifiedBytes: state.bytes, networkBytes, size: descriptor.size }); } catch {}
  };
  const reportNetwork = delta => {
    networkBytes += delta;
    emitProgress();
  };
  const reportVerified = delta => {
    state.bytes += delta;
    emitProgress();
  };
  emitProgress();
  if (state.bytes === descriptor.size) {
    await storeCall(signal, () => store.markChapterReady(scope, descriptor.artifactId, fence));
    return { complete: true, verifiedBytes: state.bytes, networkBytes };
  }

  let run = firstMissingRun(descriptor, state.verified, maxBytes);
  const quantumLast = run.last;
  let attempt = 0;
  while (true) {
    throwIfAborted(signal);
    let madeBlockProgress = false;
    try {
      const { response, controller, dispose } = await fetchRange({ fetchImpl, descriptor, run, signal, headerTimeoutMs });
      if (TRANSIENT_STATUSES.has(response.status)) {
        const retryAfter = retryAfterMs(response.headers.get('retry-after'), now);
        if (retryAfter != null && retryAfter > maxRetryAfterWaitMs) {
          await cancelBody(response);
          dispose();
          throw transferError('TRANSFER_RETRY_LATER', 'Offline transfer is rate limited', {
            status: response.status,
            retryAt: now() + retryAfter
          });
        }
        if (retryAfter != null) {
          await cancelBody(response);
          dispose();
          throw transferError('TRANSFER_RETRYABLE', 'Offline transfer should be retried later', {
            status: response.status,
            retryAt: now() + retryAfter
          });
        }
      }
      const statusFailure = responseError(response, descriptor);
      if (statusFailure) {
        await cancelBody(response);
        dispose();
        throw statusFailure;
      }
      try {
        await streamRun({ response, controller, descriptor, run, store, scope, fence, signal, inactivityTimeoutMs, reportNetwork, reportVerified: bytes => {
          madeBlockProgress = true;
          reportVerified(bytes);
        } });
      } finally {
        dispose();
      }
      blockList = await storeCall(signal, () => store.listBlocks(scope, descriptor.artifactId));
      state = verifiedBytes(descriptor, blockList);
      if (state.bytes === descriptor.size) {
        await storeCall(signal, () => store.markChapterReady(scope, descriptor.artifactId, fence));
      }
      return { complete: state.bytes === descriptor.size, verifiedBytes: state.bytes, networkBytes };
    } catch (error) {
      if (signal?.aborted) throw abortedError(signal);
      if ((error instanceof TypeError || error?.name === 'NetworkError') && !error.code) {
        error = transferError('TRANSFER_NETWORK', 'Offline transfer network request failed', { cause: error });
      }
      if (!isRetryable(error)) throw error;
      if (madeBlockProgress) {
        blockList = await storeCall(signal, () => store.listBlocks(scope, descriptor.artifactId));
        state = verifiedBytes(descriptor, blockList);
        run = firstMissingRun(descriptor, state.verified, maxBytes, quantumLast);
        if (!run) {
          const complete = state.bytes === descriptor.size;
          if (complete) await storeCall(signal, () => store.markChapterReady(scope, descriptor.artifactId, fence));
          return { complete, verifiedBytes: state.bytes, networkBytes };
        }
        attempt = 0;
        continue;
      }
      if (attempt >= 3) throw error;
      const retryAfter = error.retryAt == null ? null : Math.max(0, error.retryAt - now());
      const delay = retryAfter == null ? jitterDelay(attempt, random) : retryAfter;
      attempt++;
      await abortableSleep(delay, sleepImpl, signal);
    }
  }
}
