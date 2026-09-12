import '../offline-store.js';
import { OfflineTransferError, transferChapter } from './offline-transfer.mjs';

export const OFFLINE_BLOCK_WRITER_FLAG = 'xandrio_offline_block_writer_v1';
export const OFFLINE_BLOCK_WRITER_VALUE = 'enabled';
export const OFFLINE_BLOCK_CONTRACT_VERSION = 2;
export const OFFLINE_BLOCK_SCHEMA_VERSION = 1;

const LEASE_RENEW_MS = 5_000;
const POLL_READY_MS = 1_500;
const POLL_IDLE_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const DESCRIPTOR_TIMEOUT_MS = 15_000;
const METADATA_MAX_BYTES = 2 * 1024 * 1024;
const QUANTUM_BYTES = 16 * 1024 * 1024;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => value == null ? value : structuredClone(value);

function cancellation(code, message) {
  return new OfflineTransferError(code, message, { status: 499 });
}

function metadataFailure(code, message, details = {}) {
  return new OfflineTransferError(code, message, details);
}

function newStorageRevision(now) {
  let nonce = '';
  try { nonce = globalThis.crypto.randomUUID(); } catch {}
  if (!nonce) nonce = Math.random().toString(36).slice(2);
  return `intent-${now()}-${nonce}`;
}

function writerFlagEnabled(storage = globalThis.localStorage) {
  try {
    return storage?.getItem?.(OFFLINE_BLOCK_WRITER_FLAG) === OFFLINE_BLOCK_WRITER_VALUE;
  } catch {
    return false;
  }
}

export function offlineArtifactUrl(scope, artifactId) {
  return `/__xandrio_offline__/audio/${encodeURIComponent(scope)}/${encodeURIComponent(artifactId)}`;
}

function chapterEntry(descriptor, scope) {
  return {
    artifactId: descriptor.artifactId,
    size: descriptor.size,
    contentHash: descriptor.contentHash,
    etag: descriptor.etag,
    blockSize: descriptor.blockSize,
    blockHashes: descriptor.blockHashes.slice(),
    variantKey: descriptor.variantKey,
    provenance: descriptor.provenance,
    sourceFingerprint: descriptor.sourceFingerprint || '',
    localUrl: offlineArtifactUrl(scope, descriptor.artifactId),
    bodyVerificationVersion: 2
  };
}

function validManifest(manifest, bookId) {
  return Boolean(
    manifest?.schemaVersion === OFFLINE_BLOCK_SCHEMA_VERSION &&
    String(manifest.bookId) === String(bookId) &&
    typeof manifest.revision === 'string' && manifest.revision &&
    typeof manifest.sourceRevision === 'string' && manifest.sourceRevision &&
    Array.isArray(manifest.chapters) &&
    Number(manifest.totalChapters) === manifest.chapters.length
  );
}

function isStorageFailure(error) {
  if (error?.code === 'STORAGE_FAILED') return true;
  return ['QuotaExceededError', 'UnknownError', 'InvalidStateError'].includes(error?.name);
}

function transferState(error) {
  if (error?.code === 'TRANSFER_RETRY_LATER') return 'retry-later';
  if (['TRANSFER_TIMEOUT', 'METADATA_TIMEOUT', 'METADATA_NETWORK', 'METADATA_EOF'].includes(error?.code)) return 'interrupted';
  if (error?.code === 'PLAYBACK_BANDWIDTH') return 'interrupted';
  if (error?.code === 'STORAGE_RESERVE') return 'storage-error';
  if (isStorageFailure(error)) return 'storage-error';
  if (error?.code === 'TRANSFER_CANCELLED') return 'interrupted';
  if (error?.code === 'HIDDEN') return 'hidden';
  if (error?.code === 'OFFLINE') return 'offline';
  if (error?.code === 'AUTH_SCOPE_CHANGED') return 'auth-changed';
  if (error?.code === 'MANUAL_PAUSE') return 'paused';
  if (error?.code === 'DESCRIPTOR_CHANGED') return 'refreshing';
  return 'transfer-error';
}

function resumableError(error) {
  if (['METADATA_TIMEOUT', 'METADATA_NETWORK', 'METADATA_EOF'].includes(error?.code)) return true;
  if (['TRANSFER_TIMEOUT', 'TRANSFER_NETWORK', 'TRANSFER_RETRYABLE'].includes(error?.code)) {
    return false;
  }
  const status = Number(error?.status);
  return error?.code === 'TRANSFER_RETRY_LATER' ||
    error?.code === 'TRANSFER_TIMEOUT' ||
    error?.code === 'HIDDEN' ||
    error?.code === 'OFFLINE' ||
    error?.code === 'LEASE_LOST' ||
    error?.code === 'PLAYBACK_BANDWIDTH' ||
    status >= 500 || [408, 425, 429].includes(status);
}

function responseRetryAt(response, currentTime) {
  const value = response?.headers?.get?.('Retry-After');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return currentTime + (seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(currentTime, timestamp) : 0;
}

function priorityIndexes(job, descriptors) {
  const ready = descriptors.filter(item => item?.state === 'ready');
  if (!ready.length) return [];
  const requested = [job.currentChapter, job.currentChapter + 1]
    .filter(index => Number.isInteger(index) && ready.some(item => item.index === index));
  const rest = ready.map(item => item.index)
    .filter(index => !requested.includes(index));
  const offset = rest.length ? job.rotation % rest.length : 0;
  return [...requested, ...rest.slice(offset), ...rest.slice(0, offset)];
}

export function createOfflineDeviceCoordinator({
  indexedDB = globalThis.indexedDB,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  getScope = () => 'default',
  getRequestHeaders = () => ({}),
  getWorkerState = () => ({ contractVersion: 0, compatible: false }),
  storage = globalThis.localStorage,
  storageManager = globalThis.navigator?.storage,
  documentRef = globalThis.document,
  ownerId = `device-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
  onSnapshot = () => {},
  onActivity = () => {},
  metadataTimeoutMs = DESCRIPTOR_TIMEOUT_MS,
  metadataMaxBytes = METADATA_MAX_BYTES,
  now = Date.now
} = {}) {
  const createStore = globalThis.XandrioOfflineStore?.createStore;
  const store = createStore ? createStore({ indexedDB }) : null;
  const jobs = new Map();
  const running = new Map();
  let snapshot = {};
  let snapshotScope = '';
  let lease = null;
  let renewTimer = null;
  let pumpTimer = null;
  let pumping = false;
  let playbackActive = false;
  let scopeTransition = Promise.resolve();

  const emitSnapshot = () => onSnapshot(clone(snapshot), snapshotScope);
  const writerEnabled = () => writerFlagEnabled(storage);
  const writerCapable = () => Boolean(
    writerEnabled() && store && indexedDB && globalThis.crypto?.subtle &&
    getWorkerState()?.compatible &&
    Number(getWorkerState()?.contractVersion) >= OFFLINE_BLOCK_CONTRACT_VERSION
  );

  function abortJob(job, reason) {
    for (const controller of job.controllers || []) controller.abort(reason);
    job.controllers?.clear();
  }

  function settleJob(job, value) {
    const resolve = job.resolve;
    job.resolve = null;
    job.completion = null;
    resolve?.(value);
  }

  function jobController(job) {
    const controller = new AbortController();
    job.controllers.add(controller);
    return controller;
  }

  async function fetchMetadata(job, url, init = {}) {
    const controller = jobController(job);
    const timer = setTimeout(() => controller.abort(metadataFailure(
      'METADATA_TIMEOUT',
      'Offline metadata request timed out',
      { status: 408 }
    )), Math.max(50, Number(metadataTimeoutMs) || DESCRIPTOR_TIMEOUT_MS));
    let response = null;
    try {
      try {
        response = await fetchImpl(url, { ...init, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : metadataFailure('METADATA_TIMEOUT', 'Offline metadata request timed out', { status: 408 });
        }
        throw metadataFailure('METADATA_NETWORK', 'Offline metadata request failed', { cause: error });
      }
      if (!response || typeof response.status !== 'number' || !response.headers) {
        throw metadataFailure('METADATA_CONTRACT', 'Offline metadata returned an invalid response');
      }
      if (response.status === 304) return { response, payload: null };
      const contentEncoding = String(response.headers.get('Content-Encoding') || '').toLowerCase();
      const declaredValue = contentEncoding && contentEncoding !== 'identity'
        ? null
        : response.headers.get('Content-Length');
      const declared = declaredValue == null || declaredValue === '' ? null : Number(declaredValue);
      const limit = Math.max(1024, Number(metadataMaxBytes) || METADATA_MAX_BYTES);
      if (declared != null && (!Number.isSafeInteger(declared) || declared < 0 || declared > limit)) {
        await response.body?.cancel?.().catch?.(() => {});
        throw metadataFailure('METADATA_CONTRACT', 'Offline metadata response is too large');
      }
      if (!response.body?.getReader) {
        if (declared === 0 || declared == null) return { response, payload: null };
        throw metadataFailure('METADATA_EOF', 'Offline metadata response ended before its body');
      }
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          const chunk = item.value instanceof Uint8Array ? item.value : new Uint8Array(item.value);
          received += chunk.byteLength;
          if (received > limit) {
            await reader.cancel().catch(() => {});
            throw metadataFailure('METADATA_CONTRACT', 'Offline metadata response is too large');
          }
          chunks.push(chunk);
        }
      } catch (error) {
        if (error instanceof OfflineTransferError) throw error;
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : metadataFailure('METADATA_TIMEOUT', 'Offline metadata request timed out', { status: 408 });
        }
        throw metadataFailure('METADATA_EOF', 'Offline metadata response was interrupted', { cause: error });
      }
      if (declared != null && received !== declared) {
        throw metadataFailure('METADATA_EOF', 'Offline metadata response ended early');
      }
      if (received === 0) return { response, payload: null };
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        throw metadataFailure('METADATA_CONTRACT', 'Offline metadata response is not valid JSON', { cause: error });
      }
      return { response, payload };
    } finally {
      clearTimeout(timer);
      job.controllers.delete(controller);
    }
  }

  function abortAll(reason = cancellation('TRANSFER_CANCELLED', 'Offline transfer was cancelled')) {
    for (const job of jobs.values()) abortJob(job, reason);
  }

  async function releaseLease() {
    clearInterval(renewTimer);
    renewTimer = null;
    const token = lease;
    lease = null;
    if (token) await store?.releaseLease(token).catch(() => {});
  }

  async function ensureLease() {
    if (!store || documentRef?.hidden) return null;
    if (lease && await store.renewLease(lease).catch(() => false)) return lease;
    lease = await store.acquireLease(ownerId).catch(() => null);
    if (lease && !renewTimer) {
      renewTimer = setInterval(async () => {
        const current = lease;
        if (!current || await store.renewLease(current).catch(() => false)) return;
        lease = null;
        abortAll(cancellation('LEASE_LOST', 'Another Xandrio tab owns offline storage'));
        schedulePump(POLL_IDLE_MS);
      }, LEASE_RENEW_MS);
    }
    return lease;
  }

  async function saveJob(job, { activateReplacement = false, publish = true } = {}) {
    if (jobs.get(job.bookId) !== job || job.scope !== snapshotScope) return false;
    const token = await ensureLease();
    if (!token) return false;
    if (jobs.get(job.bookId) !== job || job.scope !== snapshotScope) return false;
    const fence = await store.captureFence(token, job.scope, job.bookId);
    if (jobs.get(job.bookId) !== job || job.scope !== snapshotScope) return false;
    job.fence = fence;
    const visible = job.baseReady && !activateReplacement
      ? {
          ...job.baseEntry,
          replacement: {
            storageRevision: job.storageRevision,
            sourceRevision: job.sourceRevision || '',
            descriptorRevision: job.descriptor?.revision || '',
            state: job.state,
            retryAt: job.retryAt || null,
            progressPercent: job.progressPercent || 0,
            probeRetryable: Boolean(job.entry?.probeRetryable)
          },
          autoResume: job.autoResume,
          manualPaused: job.manualPaused,
          mode: job.mode,
          windowIndexes: job.windowIndexes?.slice(0, 4) || [],
          currentChapter: job.currentChapter,
          storageBackend: 'idb'
        }
      : {
          ...job.entry,
          bookId: job.bookId,
          revision: job.entry.revision || `pending-${now()}`,
          descriptorRevision: job.descriptor?.revision || '',
          sourceRevision: job.sourceRevision || '',
          state: job.state,
          autoResume: job.autoResume,
          manualPaused: job.manualPaused,
          mode: job.mode,
          windowIndexes: job.windowIndexes?.slice(0, 4) || [],
          currentChapter: job.currentChapter,
          retryAt: job.retryAt || null,
          probeRetryable: Boolean(job.entry?.probeRetryable),
          storageBackend: 'idb'
    };
    await store.saveTitle(job.scope, visible, fence);
    if (jobs.get(job.bookId) !== job || job.scope !== snapshotScope) return false;
    job.savedVisible = clone(visible);
    if (publish) {
      snapshot[job.bookId] = clone(visible);
      emitSnapshot();
    }
    return true;
  }

  async function reviveForUserIntent(job) {
    if (jobs.get(job.bookId) !== job || job.scope !== snapshotScope) return false;
    const token = await ensureLease();
    if (!token) return false;
    const fence = await store.captureFence(token, job.scope, job.bookId);
    if (jobs.get(job.bookId) !== job || job.scope !== snapshotScope) return false;
    await store.reviveTitle(job.scope, job.bookId, fence);
    return jobs.get(job.bookId) === job && job.scope === snapshotScope;
  }

  async function hydrate(scope = getScope(), legacyManifest = {}) {
    snapshotScope = String(scope || 'default');
    if (!store) {
      snapshot = {};
      emitSnapshot();
      return snapshot;
    }
    await store.open();
    await store.importLegacy(snapshotScope, legacyManifest || {});
    snapshot = await store.listTitles(snapshotScope);
    emitSnapshot();
    for (const entry of Object.values(snapshot)) {
      const probeRetryable = entry?.state === 'verifying' || entry?.probeRetryable === true ||
        entry?.replacement?.state === 'verifying' || entry?.replacement?.probeRetryable === true;
      if (entry?.storageBackend !== 'idb' || (entry?.autoResume !== true && !probeRetryable) || entry?.manualPaused) continue;
      const bookId = String(entry.bookId || '');
      if (!bookId || jobs.has(bookId)) continue;
      const job = makeJob(entry.titleData?.book || { id: bookId }, entry.titleData?.chapters || [], entry);
      if (probeRetryable) job.autoResume = true;
      jobs.set(bookId, job);
    }
    if ([...jobs.values()].some(job => job.autoResume && !job.manualPaused)) schedulePump(0);
    return clone(snapshot);
  }

  function makeJob(book, chapters, entry, mode = entry?.mode || 'full', priorEntry = null) {
    const id = String(book.id);
    const baseCandidate = priorEntry || entry;
    const playableBase = baseCandidate?.mode === 'full' && baseCandidate?.state === 'ready' &&
      Array.isArray(baseCandidate?.chapterEntries) && baseCandidate.chapterEntries.some(Boolean);
    const storageRevision = String(
      entry?.replacement?.storageRevision || entry?.revision || newStorageRevision(now)
    );
    return {
      bookId: id,
      scope: snapshotScope || String(getScope() || 'default'),
      book: clone(book),
      chapters: clone(chapters),
      mode,
      entry: clone({ ...entry, revision: storageRevision }),
      storageRevision,
      baseEntry: playableBase ? clone(baseCandidate) : null,
      baseReady: playableBase,
      state: entry?.replacement?.state || (entry?.state === 'paused' ? 'paused' : 'preparing'),
      autoResume: entry?.autoResume !== false,
      manualPaused: Boolean(entry?.manualPaused),
      sourceRevision: String(entry?.replacement?.sourceRevision || entry?.sourceRevision || ''),
      descriptor: null,
      descriptorEtag: '',
      newEntries: [],
      completed: new Set(),
      rotation: 0,
      currentChapter: Math.max(0, Number(entry?.currentChapter) || 0),
      refreshedProtocol: false,
      retryAt: Number(entry?.retryAt) || 0,
      probeAttempts: 0,
      nextRunAt: 0,
      controllers: new Set(),
      intentPosted: false,
      intentPromise: null,
      fence: null,
      savedVisible: null,
      resolve: null,
      completion: null,
      progressPercent: Number(entry?.progressPercent) || 0,
      transientAttempts: 0,
      windowIndexes: Array.isArray(entry?.windowIndexes)
        ? entry.windowIndexes.filter(Number.isInteger).slice(0, 4)
        : []
    };
  }

  async function fetchManifest(job, { force = false } = {}) {
    const headers = { ...getRequestHeaders() };
    if (!force && job.descriptorEtag) headers['If-None-Match'] = job.descriptorEtag;
    const { response, payload: manifest } = await fetchMetadata(job, `/api/offline/preparation/${encodeURIComponent(job.bookId)}/manifest`, {
      credentials: 'same-origin', headers
    });
    if (response.status === 304 && job.descriptor) return job.descriptor;
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      const error = new Error(`Offline descriptor request failed (${response.status})`);
      error.status = response.status;
      const retryAt = responseRetryAt(response, now());
      if (retryAt) {
        error.code = 'TRANSFER_RETRY_LATER';
        error.retryAt = retryAt;
      }
      throw error;
    }
    if (!validManifest(manifest, job.bookId)) {
      throw metadataFailure('METADATA_CONTRACT', 'Offline descriptor response is malformed');
    }
    job.descriptorEtag = response.headers.get('etag') || `"${manifest.revision}"`;
    if (job.sourceRevision && manifest.sourceRevision !== job.sourceRevision) {
      job.sourceRevision = manifest.sourceRevision;
      job.newEntries = [];
      job.completed.clear();
      job.rotation = 0;
    } else if (!job.sourceRevision) {
      job.sourceRevision = manifest.sourceRevision;
    }
    job.descriptor = manifest;
    return manifest;
  }

  async function postIntent(job) {
    const route = job.mode === 'rolling'
      ? `/api/offline/preparation/${encodeURIComponent(job.bookId)}/window`
      : `/api/offline/preparation/${encodeURIComponent(job.bookId)}`;
    const body = job.mode === 'rolling'
      ? { chapterIndexes: job.windowIndexes.slice(0, 4) }
      : {};
    const { response, payload } = await fetchMetadata(job, route, {
      method: 'POST', credentials: 'same-origin',
      headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!response.ok) {
      const error = new Error(payload?.error || `Offline preparation failed (${response.status})`);
      error.status = response.status;
      const retryAt = responseRetryAt(response, now());
      if (retryAt) {
        error.code = 'TRANSFER_RETRY_LATER';
        error.retryAt = retryAt;
      }
      throw error;
    }
    return true;
  }

  async function ensureIntent(job) {
    if (job.intentPosted) return true;
    if (job.intentPromise) return job.intentPromise;
    const pending = postIntent(job).then(() => {
      if (jobs.get(job.bookId) !== job || job.scope !== snapshotScope) {
        throw cancellation('TRANSFER_CANCELLED', 'Offline download no longer exists');
      }
      job.intentPosted = true;
      return true;
    }).finally(() => {
      if (job.intentPromise === pending) job.intentPromise = null;
    });
    job.intentPromise = pending;
    return pending;
  }

  async function storageBudgetAllows(scope, descriptor) {
    let estimate;
    try { estimate = await storageManager?.estimate?.(); } catch { return true; }
    const quota = Number(estimate?.quota);
    const usage = Number(estimate?.usage);
    if (!Number.isFinite(quota) || !Number.isFinite(usage) || quota < usage) return true;
    const remaining = quota - usage;
    const reserve = Math.max(QUANTUM_BYTES, Math.ceil(remaining * 0.05));
    const blocks = await store.listBlocks(scope, descriptor.artifactId).catch(() => []);
    // Pending blocks already occupy their storage. The transfer verifies them
    // before it makes a network request, so they do not consume this reserve.
    const have = new Set(blocks.filter(item => ['pending', 'verified'].includes(item.state)).map(item => item.index));
    let needed = 0;
    for (let index = 0; index < descriptor.blockHashes.length && needed < QUANTUM_BYTES; index++) {
      if (!have.has(index)) needed += Math.min(descriptor.blockSize, descriptor.size - index * descriptor.blockSize);
    }
    if (needed === 0) return true;
    return remaining - reserve >= needed;
  }

  async function probe(scope, descriptor, { signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(cancellation('PROBE_TIMEOUT', 'Offline playback probe timed out')), PROBE_TIMEOUT_MS);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener?.('abort', abort, { once: true });
    try {
      const response = await fetchImpl(offlineArtifactUrl(scope, descriptor.artifactId), {
        headers: { Range: 'bytes=0-1' }, signal: controller.signal
      });
      const validHeaders = Boolean(
        response.status === 206 &&
        response.headers.get('X-Xandrio-Offline-Cache') === 'hit' &&
        Number(response.headers.get('X-Xandrio-Offline-Contract')) >= OFFLINE_BLOCK_CONTRACT_VERSION &&
        response.headers.get('X-Xandrio-Artifact-SHA256') === descriptor.artifactId &&
        Number(response.headers.get('Content-Length')) === Math.min(2, descriptor.size)
      );
      if (!validHeaders) {
        await response.body?.cancel?.().catch?.(() => {});
        return false;
      }
      const bytes = await response.arrayBuffer();
      return bytes.byteLength === Math.min(2, descriptor.size);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
  }

  function completeIndexes(job) {
    const allowed = job.mode === 'rolling' ? new Set(job.windowIndexes) : null;
    return job.descriptor.chapters.filter(item =>
      item?.state === 'ready' && (!allowed || allowed.has(item.index))
    );
  }

  async function finishIfComplete(job) {
    const descriptors = completeIndexes(job);
    const expected = job.mode === 'rolling'
      ? job.windowIndexes.filter(index => job.descriptor.chapters[index]?.state !== 'empty').length
      : job.descriptor.chapters.filter(item => item?.state !== 'empty').length;
    if (descriptors.length !== expected || descriptors.some(item => !job.completed.has(item.index))) return false;
    const first = descriptors[0];
    const probeController = first ? jobController(job) : null;
    let playable = true;
    try {
      if (first) playable = await probe(job.scope, first, { signal: probeController.signal });
    } finally {
      if (probeController) job.controllers.delete(probeController);
    }
    if (!playable) {
      job.state = 'verifying';
      job.probeAttempts += 1;
      job.autoResume = job.probeAttempts < 4;
      job.nextRunAt = job.autoResume ? now() + POLL_IDLE_MS : 0;
      job.entry.probeRetryable = true;
      await saveJob(job);
      if (job.autoResume) schedulePump(POLL_IDLE_MS);
      else settleJob(job, false);
      return false;
    }
    const chapterEntries = Array.from(
      { length: Number(job.descriptor.totalChapters) || job.chapters.length },
      (_, index) => job.newEntries[index] || null
    );
    job.entry = {
      ...job.entry,
      bookId: job.bookId,
      revision: job.storageRevision,
      sourceRevision: job.sourceRevision,
      descriptorRevision: job.descriptor.revision,
      packageVariantKey: job.descriptor.packageVariantKey,
      variantKey: job.descriptor.packageVariantKey,
      packageBytes: Number(job.descriptor.bytesTotal) || 0,
      bytes: chapterEntries.reduce((sum, item) => sum + (Number(item?.size) || 0), 0),
      chapterEntries,
      state: job.mode === 'full' ? 'ready' : 'partial',
      autoResume: false,
      retryAt: null,
      downloadedAt: new Date(now()).toISOString(),
      probeRetryable: false,
      storageBackend: 'idb'
    };
    job.state = job.entry.state;
    if (job.mode === 'rolling') {
      const token = await ensureLease();
      if (!token) return false;
      const fence = await store.captureFence(token, job.scope, job.bookId);
      await store.pruneRolling(
        job.scope,
        job.bookId,
        chapterEntries.filter(Boolean).map(item => item.artifactId),
        fence
      );
    }
    job.autoResume = false;
    if (!await saveJob(job, { activateReplacement: true, publish: false })) {
      job.autoResume = true;
      return false;
    }
    let finalized;
    try {
      finalized = await store.finalizeTitle(
        job.scope,
        job.bookId,
        job.entry.revision,
        job.fence
      );
    } catch (error) {
      job.autoResume = true;
      if (/lease|fence is stale|fence is not current/i.test(String(error?.message || ''))) {
        throw cancellation('LEASE_LOST', 'Offline finalization lost its storage lease');
      }
      throw error;
    }
    if (jobs.get(job.bookId) !== job || job.scope !== snapshotScope) return false;
    snapshot[job.bookId] = clone(finalized || job.savedVisible || job.entry);
    emitSnapshot();
    onActivity({ bookId: job.bookId, state: 'complete', progressPercent: 100 });
    settleJob(job, true);
    jobs.delete(job.bookId);
    return true;
  }

  async function transferOne(job, descriptor) {
    if (jobs.get(job.bookId) !== job || job.scope !== snapshotScope) return;
    const token = await ensureLease();
    if (!token) return;
    const controller = jobController(job);
    const fence = await store.captureFence(token, job.scope, job.bookId);
    if (jobs.get(job.bookId) !== job || job.scope !== snapshotScope) {
      job.controllers.delete(controller);
      return;
    }
    job.fence = fence;
    try {
      if (!await storageBudgetAllows(job.scope, descriptor)) {
        throw new OfflineTransferError('STORAGE_RESERVE', 'Not enough storage remains for the next verified block');
      }
      await store.putChapter(job.scope, job.bookId, job.storageRevision, descriptor, fence, job.mode === 'rolling' ? 'rolling' : 'full');
      const result = await transferChapter({
        store, descriptor, scope: job.scope, bookId: job.bookId,
        revision: job.storageRevision, fence, signal: controller.signal, fetchImpl,
        onProgress: progress => {
          const base = job.newEntries.reduce((sum, item) => sum + (Number(item?.size) || 0), 0);
          const total = Number(job.descriptor.bytesTotal) || Number(job.descriptor.bytesPrepared) || 0;
          job.progressPercent = total > 0 ? Math.min(99, Math.round(((base + progress.verifiedBytes) / total) * 100)) : 0;
          onActivity({ bookId: job.bookId, state: 'downloading', ...progress, progressPercent: job.progressPercent });
        }
      });
      if (result.complete) {
        job.completed.add(descriptor.index);
        job.newEntries[descriptor.index] = chapterEntry(descriptor, job.scope);
        job.rotation += 1;
        job.state = 'downloading';
        await saveJob(job);
      }
    } finally {
      job.controllers.delete(controller);
    }
  }

  async function processJob(job) {
    if (job.manualPaused || !job.autoResume || documentRef?.hidden || globalThis.navigator?.onLine === false) return;
    if (job.retryAt > now()) {
      job.nextRunAt = job.retryAt;
      schedulePump(Math.min(POLL_IDLE_MS, job.retryAt - now()));
      return;
    }
    // Relaunches repeat the idempotent preparation request. This also ensures
    // the durable device intent exists before any server or transfer request.
    await ensureIntent(job);
    let manifest = await fetchManifest(job);
    job.transientAttempts = 0;
    if (await finishIfComplete(job)) return;
    const allowed = job.mode === 'rolling' ? new Set(job.windowIndexes) : null;
    const candidates = priorityIndexes(job, manifest.chapters)
      .filter(index => !job.completed.has(index) && (!allowed || allowed.has(index)));
    if (!candidates.length) {
      if (manifest.state === 'error') {
        job.state = 'preparation-error';
        job.autoResume = false;
        job.nextRunAt = 0;
        await saveJob(job);
        settleJob(job, false);
        return;
      }
      job.state = 'preparing';
      job.nextRunAt = now() + POLL_READY_MS;
      await saveJob(job);
      schedulePump(POLL_READY_MS);
      return;
    }
    try {
      await transferOne(job, manifest.chapters[candidates[0]]);
      job.nextRunAt = 0;
      await finishIfComplete(job);
    } catch (error) {
      if (error?.code === 'DESCRIPTOR_CHANGED' || error?.code === 'TRANSFER_CONTRACT') {
        if (!job.refreshedProtocol) {
          job.refreshedProtocol = true;
          manifest = await fetchManifest(job, { force: true });
          if (manifest.sourceRevision !== job.sourceRevision) {
            job.sourceRevision = manifest.sourceRevision;
            job.completed.clear();
            job.newEntries = [];
          }
          schedulePump(0);
          return;
        }
      }
      if (error?.code === 'TRANSFER_RETRY_LATER') job.retryAt = Number(error.retryAt) || now() + POLL_IDLE_MS;
      job.nextRunAt = job.retryAt || 0;
      job.state = transferState(error);
      job.autoResume = error?.code !== 'STORAGE_RESERVE' && !isStorageFailure(error) &&
        resumableError(error);
      if (job.autoResume && !job.nextRunAt) job.nextRunAt = now() + POLL_IDLE_MS;
      await saveJob(job).catch(() => {});
      if (error?.code === 'TRANSFER_CANCELLED' || error?.code === 'LEASE_LOST') return;
      if (job.autoResume) schedulePump(Math.max(0, (job.nextRunAt || now()) - now()));
      else {
        onActivity({ bookId: job.bookId, state: 'error' });
        settleJob(job, false);
      }
    }
  }

  function schedulePump(delay = 0) {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      void pump();
    }, Math.max(0, delay));
  }

  async function pump() {
    if (pumping || documentRef?.hidden || globalThis.navigator?.onLine === false || !writerCapable()) return;
    // Hydration with no durable work must not capture the cross-tab lease. A
    // page reload cannot reliably finish an IndexedDB release before the old
    // document is destroyed, so an idle owner would strand the new page until
    // the full lease timeout elapsed.
    if (![...jobs.values()].some(job => job.autoResume && !job.manualPaused)) {
      void releaseLease();
      return;
    }
    pumping = true;
    try {
      if (!await ensureLease()) return schedulePump(POLL_IDLE_MS);
      const slots = playbackActive ? 1 : 2;
      const runnable = [...jobs.values()].filter(job =>
        job.autoResume && !job.manualPaused && !running.has(job.bookId) &&
        (!job.nextRunAt || job.nextRunAt <= now())
      );
      while (running.size < slots && runnable.length) {
        const job = runnable.shift();
        const task = processJob(job)
          .catch(async error => {
            job.state = transferState(error);
            job.autoResume = !isStorageFailure(error) && resumableError(error);
            if (job.autoResume && error?.code !== 'TRANSFER_RETRY_LATER') {
              job.transientAttempts += 1;
              if (job.transientAttempts >= 4) job.autoResume = false;
            }
            if (error?.code === 'TRANSFER_RETRY_LATER') {
              job.retryAt = Number(error.retryAt) || now() + POLL_IDLE_MS;
            }
            if (job.autoResume) job.nextRunAt = job.retryAt || now() + POLL_IDLE_MS;
            await saveJob(job).catch(() => {});
            if (!job.autoResume) {
              onActivity({ bookId: job.bookId, state: 'error' });
              settleJob(job, false);
            }
          })
          .finally(() => {
            running.delete(job.bookId);
            if (jobs.get(job.bookId) === job) {
              jobs.delete(job.bookId);
              jobs.set(job.bookId, job);
            }
            const future = [...jobs.values()]
              .map(candidate => Number(candidate.nextRunAt) || 0)
              .filter(value => value > now())
              .sort((left, right) => left - right)[0];
            const hasRunnableIntent = [...jobs.values()].some(candidate =>
              candidate.autoResume && !candidate.manualPaused
            );
            if (hasRunnableIntent) {
              schedulePump(future ? Math.min(POLL_IDLE_MS, future - now()) : 0);
            } else {
              void releaseLease();
            }
          });
        running.set(job.bookId, task);
      }
    } finally {
      pumping = false;
    }
  }

  async function start(book, chapters, entry, { mode = 'full', chapterIndexes = [], currentChapter = 0 } = {}) {
    if (!writerCapable()) return null;
    const scope = String(getScope() || 'default');
    if (scope !== snapshotScope) await hydrate(scope, {});
    let job = jobs.get(String(book.id));
    if (job && (!job.autoResume || job.manualPaused)) {
      settleJob(job, false);
      jobs.delete(job.bookId);
      job = null;
    }
    if (!job) {
      const priorEntry = snapshot[String(book.id)] || null;
      const pending = {
        ...clone(entry), bookId: String(book.id), titleData: clone(entry.titleData),
        revision: newStorageRevision(now), state: 'preparing',
        autoResume: true, manualPaused: false, storageBackend: 'idb',
        mode, windowIndexes: [...new Set(chapterIndexes)]
          .filter(index => Number.isInteger(index) && index >= 0 && index < chapters.length)
          .slice(0, 4),
        currentChapter: Math.max(0, Number(currentChapter) || 0)
      };
      job = makeJob(book, chapters, pending, mode, priorEntry);
      jobs.set(job.bookId, job);
    }
    job.mode = mode;
    job.currentChapter = Math.max(0, Number(currentChapter) || 0);
    job.windowIndexes = [...new Set(chapterIndexes)]
      .filter(index => Number.isInteger(index) && index >= 0 && index < chapters.length)
      .slice(0, 4);
    job.autoResume = true;
    job.manualPaused = false;
    job.state = 'preparing';
    job.completion ||= new Promise(resolve => { job.resolve = resolve; });
    const completion = job.completion;
    // The local intent is durable before either server preparation or transfer begins.
    if (!await reviveForUserIntent(job) || !await saveJob(job)) {
      jobs.delete(job.bookId);
      settleJob(job, false);
      return completion;
    }
    // Publish the durable intent immediately. Preparation can take minutes and
    // the Activity pane must show the user-owned job before the first body
    // arrives or the first progress callback runs.
    onActivity({
      bookId: job.bookId,
      state: 'preparing',
      progressPercent: job.progressPercent
    });
    schedulePump(0);
    return completion;
  }

  async function pause(bookId) {
    const job = jobs.get(String(bookId));
    if (!job) return false;
    job.manualPaused = true;
    job.autoResume = false;
    job.state = 'paused';
    abortJob(job, cancellation('MANUAL_PAUSE', 'Offline download was paused'));
    await saveJob(job).catch(() => {});
    onActivity({ bookId: job.bookId, state: 'paused' });
    settleJob(job, false);
    return true;
  }

  async function remove(bookId, scope = getScope()) {
    const id = String(bookId);
    const job = jobs.get(id);
    if (job) {
      job.autoResume = false;
      abortJob(job, cancellation('TRANSFER_CANCELLED', 'Offline download was removed'));
      settleJob(job, false);
      jobs.delete(id);
    }
    await store?.deleteTitle(String(scope || 'default'), id);
    delete snapshot[id];
    emitSnapshot();
    onActivity({ bookId: id, state: 'removed' });
    return true;
  }

  async function verifyArtifact(entry) {
    const artifactId = String(entry?.artifactId || '');
    const hashes = entry?.blockHashes;
    if (!artifactId || !Array.isArray(hashes) || !globalThis.crypto?.subtle) return false;
    for (let index = 0; index < hashes.length; index++) {
      const block = await store.getBlock(String(getScope() || 'default'), artifactId, index);
      if (!block || block.state !== 'verified') return false;
      const digest = await globalThis.crypto.subtle.digest('SHA-256', block.bytes);
      const actual = `sha256-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      if (actual !== hashes[index]) return false;
    }
    return true;
  }

  async function invalidateChapter(bookId, chapterIndex, { deleteBytes = false } = {}) {
    const id = String(bookId);
    const entry = snapshot[id];
    const chapter = entry?.chapterEntries?.[chapterIndex];
    if (!chapter) return false;
    const token = await ensureLease();
    if (!token) throw new Error('Another Xandrio tab owns offline storage');
    const fence = await store.captureFence(token, snapshotScope, id);
    if (deleteBytes) {
      const blocks = await store.listBlocks(snapshotScope, chapter.artifactId);
      for (const block of blocks) {
        await store.deleteBlock(snapshotScope, chapter.artifactId, block.index, fence);
      }
    }
    const next = clone(entry);
    next.chapterEntries[chapterIndex] = null;
    next.bytes = next.chapterEntries.reduce((sum, item) => sum + (Number(item?.size) || 0), 0);
    if (next.mode !== 'rolling') next.state = 'incomplete';
    await store.saveTitle(snapshotScope, next, fence);
    snapshot[id] = next;
    emitSnapshot();
    return true;
  }

  function setPlaybackActive(value) {
    playbackActive = Boolean(value);
    if (playbackActive && running.size > 1) {
      let retained = false;
      for (const bookId of running.keys()) {
        if (!retained) {
          retained = true;
          continue;
        }
        const job = jobs.get(bookId);
        if (job) abortJob(job, cancellation(
          'PLAYBACK_BANDWIDTH',
          'Offline transfer yielded bandwidth to playback'
        ));
      }
    }
    schedulePump(0);
  }

  function wake({ workerCertified = false } = {}) {
    if (workerCertified) {
      for (const job of jobs.values()) {
        if (job.state !== 'verifying' && !job.entry?.probeRetryable) continue;
        job.probeAttempts = 0;
        job.autoResume = true;
        job.nextRunAt = 0;
      }
    }
    schedulePump(0);
  }

  async function transitionScope(fromScope, toScope, legacyManifest = {}) {
    const retire = () => {
      abortAll(cancellation('AUTH_SCOPE_CHANGED', 'Offline account changed'));
      for (const job of jobs.values()) settleJob(job, false);
      jobs.clear();
    };
    // Abort current writers before setCurrentUser can expose the next account.
    retire();
    scopeTransition = scopeTransition.catch(() => undefined).then(async () => {
      // A prior queued transition may have hydrated resumable jobs after the
      // synchronous abort above. Retire them before applying this newer scope.
      retire();
      await releaseLease();
      if (store) await store.fenceScopes(String(fromScope || 'default'), String(toScope || 'default'));
      await hydrate(String(toScope || 'default'), legacyManifest);
    });
    return scopeTransition;
  }

  function onVisibilityChange() {
    if (documentRef?.hidden) {
      abortAll(cancellation('HIDDEN', 'Offline transfer paused while Xandrio is hidden'));
      void releaseLease();
      return;
    }
    schedulePump(0);
  }

  documentRef?.addEventListener?.('visibilitychange', onVisibilityChange);
  globalThis.addEventListener?.('online', () => schedulePump(0));
  globalThis.addEventListener?.('offline', () => abortAll(cancellation('OFFLINE', 'Offline transfer paused without a connection')));

  return {
    store,
    hydrate,
    snapshot: () => clone(snapshot),
    startFull: (book, chapters, entry) => start(book, chapters, entry, { mode: 'full' }),
    startWindow: (book, chapters, entry, chapterIndexes, currentChapter) =>
      start(book, chapters, entry, { mode: 'rolling', chapterIndexes, currentChapter }),
    pause,
    remove,
    verifyArtifact,
    invalidateChapter,
    probe,
    transitionScope,
    setPlaybackActive,
    wake,
    writerEnabled,
    writerCapable,
    close: async () => {
      abortAll();
      for (const job of jobs.values()) settleJob(job, false);
      jobs.clear();
      clearTimeout(pumpTimer);
      await releaseLease();
    }
  };
}
