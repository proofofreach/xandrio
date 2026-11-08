import { API_BASE, apiSend, canClaimLegacyOfflineStorage, getOfflineStorageScopeId, syncHeaders } from '../api.js';
import { escapeHTML, formatDuration, relativeTime } from '../util/format.js';
import { readJSON, writeJSON } from '../util/storage.js';
import { showToast, showUndoToast } from '../ui/toast.js';
import { confirmSheet } from '../ui/confirm.js';
import { planRollingOfflineWindow } from './rolling-offline.mjs';

export const OFFLINE_AUDIO_CACHE = 'xandrio-offline-audio';
export const OFFLINE_TITLE_CACHE = 'xandrio-offline-titles';
const OFFLINE_BOOKS_KEY = 'xandrio_offline_books';
const OFFLINE_DELETION_CURSOR_KEY = 'xandrio_offline_deletion_cursor';
const OFFLINE_LEGACY_CACHE_OWNER_KEY = 'xandrio_offline_legacy_cache_owner';
const PENDING_POSITIONS_KEY = 'xandrio_pending_positions';
const OFFLINE_SCOPE_PARAM = 'xandrio-offline-scope';
const OFFLINE_CONTENT_HASH_HEADER = 'X-Xandrio-Content-SHA256';
const OFFLINE_BODY_VERIFICATION_VERSION = 1;
const OFFLINE_MANIFEST_VERSION = 3;
// Markers written by the service worker on every scoped offline audio
// response. See public/sw.js — they are what makes a cache miss distinguishable
// from a transient media error.
const OFFLINE_CACHE_MARKER = 'x-xandrio-offline-cache';
const OFFLINE_SW_VERSION_MARKER = 'x-xandrio-sw';
const OFFLINE_CONTRACT_MARKER = 'x-xandrio-offline-contract';
/**
 * The worker build shipped with this shell. Exact identity is the synchronous
 * fast path during boot; compatible older/newer workers prove route semantics
 * with OFFLINE_ROUTE_CONTRACT_VERSION instead of tying downloads to a build id.
 * This value MUST equal CACHE_VERSION in public/sw.js.
 */
export const EXPECTED_OFFLINE_SW_VERSION = 'xandrio-v226';
export const MINIMUM_OFFLINE_ROUTE_CONTRACT = 1;
const BLOCK_OFFLINE_ROUTE_CONTRACT = 2;
// A chapter is only ever invalidated after this many playback failures whose
// cheap probe still says the cache is fine. Below it, we assume Safari.
const SUSPECT_FAILURES_BEFORE_HASH = 3;
const FULL_DOWNLOAD_CONCURRENCY = 2;
const DOWNLOAD_PREPARE_TIMEOUT_MS = 30 * 60 * 1000;
const DOWNLOAD_RETRY_DELAYS_MS = [0, 350, 1000];
// Waiting for a chapter to be narrated used to mean a status request every
// 1.5 seconds for as long as DOWNLOAD_PREPARE_TIMEOUT_MS allows — up to 1200
// requests for one chapter, all of them landing on the same server that is
// trying to generate the audio. Poll quickly while progress is arriving and
// back off when it is not; any real progress resets the interval.
const PREPARE_POLL_MIN_MS = 1500;
const PREPARE_POLL_MAX_MS = 15000;
const PREPARE_POLL_BACKOFF = 1.5;
// Whole-book preparation takes hours. Its status poll started at 5 seconds,
// which measured ~440 requests in 37 minutes for one phone. Check every 15
// seconds right after a chapter becomes ready, stretch towards 30 seconds
// while nothing changes, and stop while hidden unless a transfer is running.
const PREPARATION_POLL_MIN_MS = 15000;
const PREPARATION_POLL_MAX_MS = 30000;
const PREPARATION_POLL_BACKOFF = 1.5;
const OFFLINE_TRANSFER_SCHEMA_VERSION = 1;
const SHA256_IDENTITY = /^sha256-[a-f0-9]{64}$/;
// Cross-tab exclusion for the CacheStorage writer. The browser releases a Web
// Lock when its page dies, so a killed download never strands the next launch.
const OFFLINE_DOWNLOAD_LOCK = 'xandrio-offline-cache-download';
const DESCRIPTOR_REFRESH_LIMIT = 2;
// A transfer pass that cannot progress (a network blip, a 5xx, or a server
// package that needs repair) waits 15 s, then doubles up to 5 minutes. The
// poll honours this; user-driven triggers (launch, online, foreground) do not.
const TRANSFER_RETRY_MIN_MS = 15000;
const TRANSFER_RETRY_MAX_MS = 5 * 60 * 1000;

export function shouldUseOfflineBookFallback(error, online = navigator.onLine) {
  if (!online) return true;
  const status = Number(error?.status);
  return !Number.isFinite(status) || status >= 500;
}

let deps = {};
let downloadAbort = null;
let manifestAudit = null;
let rollingAbort = null;
let rollingRequestKey = '';
let activeDownloadBookId = '';
let activeDownloadCompletion = null;
let activeDownloadActivity = null;
let downloadWakeLock = null;
let downloadWakeLockRequest = null;
let downloadWakeLockActive = false;
let downloadWakeLockVisibilityHandler = null;
let preparationPollTimer = null;
const rollingCompletions = new Map();
const legacyCacheMigrations = new Map();
const deletionReconciliations = new Map();
const pendingPositionFlushes = new Map();
const pendingPositionFlushControllers = new Map();
let certifiedOfflineController = null;
let certifiedOfflineContract = 0;
let offlineDevice = null;
let offlineDeviceLoading = null;
let offlineDeviceSnapshot = {};
let offlineDeviceSnapshotScope = '';
const offlineDeviceActivities = new Map();

function publishDeviceSnapshot(snapshot, scope) {
  offlineDeviceSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  offlineDeviceSnapshotScope = String(scope || '');
  if (typeof document?.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('xandrio:offlinechange'));
  }
}

async function loadOfflineDevice() {
  if (offlineDevice) return offlineDevice;
  if (offlineDeviceLoading) return offlineDeviceLoading;
  if (!globalThis.indexedDB) return null;
  offlineDeviceLoading = import('./offline-device.mjs').then(({ createOfflineDeviceCoordinator }) => {
    offlineDevice = createOfflineDeviceCoordinator({
      getScope: offlineScopeId,
      getRequestHeaders: syncHeaders,
      getWorkerState: offlineWorkerControllerState,
      onSnapshot: publishDeviceSnapshot,
      onActivity: activity => {
        if (typeof document?.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') return;
        const bookId = String(activity?.bookId || '');
        if (bookId && ['complete', 'paused', 'removed', 'error'].includes(activity?.state)) {
          offlineDeviceActivities.delete(bookId);
        } else if (bookId) {
          const savedBook = offlineDeviceSnapshot[bookId]?.titleData?.book || {};
          const title = offlineDeviceSnapshot[bookId]?.title || savedBook.title || 'Untitled';
          offlineDeviceActivities.set(bookId, {
            id: bookId,
            title,
            author: savedBook.author || 'Unknown Author',
            hasCover: Boolean(savedBook.hasCover),
            percent: Number(activity.progressPercent) || 0,
            phase: activity.state === 'downloading' ? 'Downloading' : 'Preparing audio',
            bytesReceived: Number(activity.verifiedBytes) || 0,
            bytesTotal: Number(activity.size) || 0
          });
        }
        document.dispatchEvent(new CustomEvent('xandrio:downloadactivity', {
          detail: { downloads: [...offlineDeviceActivities.values()] }
        }));
        if (offlineDeviceActivities.size > 0) {
          // Wake-lock permission is advisory and can hang behind a browser
          // prompt. Start it best-effort without retaining the transfer owner.
          void Promise.race([
            holdDownloadWakeLock(),
            new Promise(resolve => setTimeout(() => resolve(false), 3000))
          ]).catch(() => false);
        } else if (!downloadAbort) {
          void releaseDownloadWakeLock();
        }
      }
    });
    return offlineDevice;
  }).catch(error => {
    console.warn(`Block offline storage is unavailable: ${error?.message || error}`);
    return null;
  }).finally(() => { offlineDeviceLoading = null; });
  return offlineDeviceLoading;
}

export function offlineWorkerControllerState() {
  const controller = globalThis.navigator?.serviceWorker?.controller || null;
  return {
    controlled: Boolean(controller),
    scriptURL: controller?.scriptURL || '',
    contractVersion: controller === certifiedOfflineController ? certifiedOfflineContract : 0,
    compatible: hasCompatibleOfflineWorkerController()
  };
}

export function hasCompatibleOfflineWorkerController() {
  const controller = globalThis.navigator?.serviceWorker?.controller || null;
  if (!controller) return false;
  if (controller === certifiedOfflineController && certifiedOfflineContract >= MINIMUM_OFFLINE_ROUTE_CONTRACT) {
    return true;
  }
  // The exact worker shipped with this app is trusted synchronously. This keeps
  // chapter selection free of a MessageChannel round trip; boot certification
  // covers compatible workers from other builds.
  try {
    return new URL(controller.scriptURL, globalThis.location?.origin || 'https://localhost')
      .searchParams.get('v') === EXPECTED_OFFLINE_SW_VERSION;
  } catch {
    return false;
  }
}

export async function certifyOfflineWorkerController(options = {}) {
  const controller = options.controller || globalThis.navigator?.serviceWorker?.controller || null;
  if (!controller?.postMessage || typeof MessageChannel === 'undefined') {
    return offlineWorkerControllerState();
  }
  const timeoutMs = Math.max(50, Number(options.timeoutMs) || 1500);
  const channel = new MessageChannel();
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      resolve(event.data || null);
    };
    try {
      controller.postMessage({ type: 'XANDRIO_OFFLINE_CONTRACT_QUERY' }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
  const contractVersion = Number(result?.contractVersion) || 0;
  if (contractVersion >= MINIMUM_OFFLINE_ROUTE_CONTRACT) {
    certifiedOfflineController = controller;
    certifiedOfflineContract = contractVersion;
    offlineDevice?.wake?.({ workerCertified: true });
  }
  return offlineWorkerControllerState();
}

export function offlineDownloadsSupported() {
  return typeof window !== 'undefined' &&
    globalThis.document?.documentElement?.dataset?.pwaStorageAllowed !== 'false' &&
    'caches' in window &&
    typeof window.caches?.open === 'function';
}

// True while this page downloads, verifies or migrates offline audio: the work
// that holds whole chapters in memory. Read by the page-exit monitor.
export function offlineWorkInProgress() {
  return Boolean(
    activeDownloadCompletion || manifestAudit ||
    rollingCompletions.size > 0 || legacyCacheMigrations.size > 0
  );
}

export function initOffline(options = {}) {
  deps = options;
  // Distrust is session state, and this is the session boundary. A chapter that
  // failed to play last time is given another chance now — the download is
  // verified, and the usual causes (memory pressure, a backgrounded tab) do not
  // survive a relaunch.
  suspectChapters.clear();
  document.getElementById('offline-books-list')?.addEventListener('click', handleOfflineManagerClick);
  document.addEventListener('xandrio:deploymentchange', refreshOfflineAvailability);
  document.removeEventListener('xandrio:cancelofflinedownload', handleOfflineDownloadCancel);
  document.addEventListener('xandrio:cancelofflinedownload', handleOfflineDownloadCancel);
  window.addEventListener('online', flushPendingPositions);
  window.addEventListener('online', reconcileDeletedOfflineBooks);
  window.addEventListener('online', refreshOfflinePreparations);
  window.addEventListener('online', resumeInterruptedOfflineDownloads);
  document.addEventListener('visibilitychange', resumeInterruptedOfflineDownloads);
  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);
  window.addEventListener('resize', updateOfflineBanner);
  window.addEventListener('xandrio:authscopechange', event => {
    const fromScope = String(event?.detail?.fromScope || 'default');
    const toScope = String(event?.detail?.toScope || 'default');
    const legacyWaits = [
      activeDownloadCompletion,
      ...rollingCompletions.values(),
      pendingPositionFlushes.get(fromScope)
    ].filter(Boolean);
    downloadAbort?.abort();
    rollingAbort?.abort();
    pendingPositionFlushControllers.get(fromScope)?.abort();
    // transitionScope aborts writers synchronously before its first await.
    const transition = offlineDevice
      ? offlineDevice.transitionScope(fromScope, toScope, readLegacyOfflineManifest(toScope))
      : loadOfflineDevice().then(device => device?.transitionScope(
          fromScope,
          toScope,
          readLegacyOfflineManifest(toScope)
        ));
    // Cancelled legacy writers may reject, but a failed durable scope fence
    // must stop setCurrentUser from exposing the incoming account.
    event?.detail?.waitUntil?.(Promise.all([transition, Promise.allSettled(legacyWaits)]));
  });
  const isLocalOfflineMedia = media => {
    try {
      const source = new URL(media?.currentSrc || media?.src || '', globalThis.location?.href);
      return source.pathname.startsWith('/__xandrio_offline__/audio/') ||
        source.searchParams.has(OFFLINE_SCOPE_PARAM);
    } catch {
      return false;
    }
  };
  document.addEventListener('play', event => {
    if (globalThis.HTMLMediaElement && event.target instanceof HTMLMediaElement) {
      offlineDevice?.setPlaybackActive(!isLocalOfflineMedia(event.target));
    }
  }, true);
  document.addEventListener('pause', event => {
    if (globalThis.HTMLMediaElement && event.target instanceof HTMLMediaElement) {
      if (!isLocalOfflineMedia(event.target)) offlineDevice?.setPlaybackActive(false);
    }
  }, true);
  // A download can finish while the page is uncontrolled (first install) or
  // while an older worker is still in charge. Both resolve on their own, so
  // re-check at startup and whenever the controlling worker changes rather than
  // leaving the user with a book stuck in "Verifying".
  navigator.serviceWorker?.addEventListener?.('message', event => {
    if (event?.data?.type !== 'XANDRIO_OFFLINE_AUDIO_READY') return;
    void refreshOfflinePreparations().catch(() => {});
  });
  navigator.serviceWorker?.addEventListener?.(
    'controllerchange',
    () => {
      void certifyOfflineWorkerController()
        .catch(() => offlineWorkerControllerState())
        .then(() => reprobeVerifyingDownloads())
        .catch(() => {});
    }
  );
  renderOfflineState({ audit: false });
  void reprobeVerifyingDownloads().catch(() => {});
  // Again once cache migration has finished: entries moved into the scoped
  // audio cache are only probeable at their final location, so a pass that ran
  // before migration cannot certify them.
  void migrateLegacyOfflineCaches()
    .catch(() => false)
    .then(() => reprobeVerifyingDownloads())
    .catch(() => {});
  void prepareOfflineStorage({ waitForAudio: true })
    .then(() => resumeInterruptedOfflineDownloads())
    .finally(() => scheduleOfflineManifestAudit());
  void refreshOfflinePreparations();
  updateOfflineBanner();
  flushPendingPositions();
  void reconcileDeletedOfflineBooks();
}

async function handleOfflineDownloadCancel(event) {
  const bookId = String(event?.detail?.bookId || '');
  if (!bookId) return;
  if (cancelOfflineDownload(bookId)) return;
  try {
    await cancelOfflinePreparation(bookId);
  } catch {
    showToast('Could not remove offline setup', 'error');
  }
}

function refreshOfflineAvailability() {
  renderOfflineState({ audit: false });
  if (
    typeof document?.dispatchEvent === 'function' &&
    typeof globalThis.CustomEvent === 'function'
  ) {
    document.dispatchEvent(new CustomEvent('xandrio:offlinechange'));
  }
}

export async function prepareOfflineStorage({ waitForAudio = false } = {}) {
  const scope = offlineScopeId();
  const manifest = readLegacyOfflineManifest(scope);
  if (
    'caches' in window &&
    localStorage.getItem(OFFLINE_LEGACY_CACHE_OWNER_KEY) === scope
  ) {
    await migrateLegacyCache(OFFLINE_TITLE_CACHE, scope, manifest).catch(error => {
      console.warn('Offline cover migration failed:', error);
    });
  }
  // Audio can be large. Keep the first render responsive; playback migrates
  // only its requested chapter if that chapter is still in the legacy cache.
  const audioMigration = migrateLegacyOfflineCaches().catch(error => {
    console.warn('Offline cache migration failed:', error);
  });
  if (waitForAudio) await audioMigration;
  // Hydration completes before the library reads the synchronous facade. New
  // block-backed entries live in IndexedDB; localStorage remains a projection
  // for legacy CacheStorage downloads only.
  await certifyOfflineWorkerController({ timeoutMs: 1500 }).catch(() => offlineWorkerControllerState());
  const device = await loadOfflineDevice();
  await device?.hydrate(scope, manifest).catch(error => {
    console.warn('Offline title snapshot could not be loaded:', error);
  });
}

function offlineScopeId() {
  return String(getOfflineStorageScopeId() || 'default');
}

function offlineManifestKey(scopeId = offlineScopeId()) {
  return `${OFFLINE_BOOKS_KEY}:${scopeId}`;
}

function offlineCacheName(baseName, scopeId = offlineScopeId()) {
  return `${baseName}:${scopeId}`;
}

function offlineDeletionCursorKey(scopeId = offlineScopeId()) {
  return `${OFFLINE_DELETION_CURSOR_KEY}:${scopeId}`;
}

function updateOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  banner.hidden = navigator.onLine;
  const rootStyle = document.documentElement?.style;
  if (!rootStyle) return;
  if (banner.hidden) {
    rootStyle.removeProperty('--offline-banner-offset');
    return;
  }
  rootStyle.setProperty('--offline-banner-offset', `${Math.ceil(banner.getBoundingClientRect().height)}px`);
}

function readLegacyOfflineManifest(scopeId = offlineScopeId()) {
  const key = offlineManifestKey(scopeId);
  const scoped = readJSON(key, null);
  if (scoped && typeof scoped === 'object') return scoped;
  if (!canClaimLegacyOfflineStorage()) return {};

  // One-time migration from the pre-account manifest. Authentication is
  // resolved before library boot, so ownership is assigned to the currently
  // authenticated (or last authenticated offline) account only.
  const legacy = readJSON(OFFLINE_BOOKS_KEY, null);
  const migrated = legacy && typeof legacy === 'object' ? legacy : {};
  if (writeJSON(key, migrated)) {
    if (Object.keys(migrated).length > 0) {
      localStorage.setItem(OFFLINE_LEGACY_CACHE_OWNER_KEY, scopeId);
    }
    localStorage.removeItem(OFFLINE_BOOKS_KEY);
  }
  return migrated;
}

export function getOfflineManifest(scopeId = offlineScopeId()) {
  const legacy = readLegacyOfflineManifest(scopeId);
  if (offlineDeviceSnapshotScope !== String(scopeId)) return legacy;
  // Imported CacheStorage references are migration input, not IndexedDB
  // authority. Keep reading their live localStorage records while the legacy
  // writer is active; only block-backed titles overlay that projection.
  const blockTitles = Object.fromEntries(Object.entries(offlineDeviceSnapshot).filter(
    ([, entry]) => entry?.storageBackend === 'idb'
  ));
  return { ...legacy, ...blockTitles };
}

function saveOfflineManifest(manifest, scopeId = offlineScopeId()) {
  const legacyProjection = Object.fromEntries(Object.entries(manifest || {}).filter(
    ([, entry]) => entry?.storageBackend !== 'idb'
  ));
  if (!writeJSON(offlineManifestKey(scopeId), legacyProjection)) {
    throw new Error('Could not save offline download state');
  }
  if (typeof document?.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('xandrio:offlinechange'));
    document.dispatchEvent(new CustomEvent('xandrio:preparationactivity', {
      detail: { preparations: offlinePreparationActivities(manifest) }
    }));
  }
}

function offlinePreparationActivities(manifest = getOfflineManifest()) {
  return Object.values(manifest)
    .filter(entry =>
      entry?.mode === 'full' &&
      ['preparing', 'preparation-waiting'].includes(offlineState(entry))
    )
    .map(entry => ({
      id: String(entry.bookId),
      title: entry.title || entry.titleData?.book?.title || 'Untitled',
      author: entry.titleData?.book?.author || 'Unknown Author',
      hasCover: Boolean(entry.titleData?.book?.hasCover),
      percent: Math.max(0, Math.min(99, Math.round(Number(entry.progressPercent) || 0))),
      readyChapters: Math.max(0, Number(entry.preparedChapters) || 0),
      totalChapters: Math.max(0, Number(entry.chapters) || 0)
    }));
}

function emitDownloadActivity(activity = activeDownloadActivity) {
  if (typeof document?.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') return;
  document.dispatchEvent(new CustomEvent('xandrio:downloadactivity', {
    detail: { downloads: activity ? [{ ...activity }] : [] }
  }));
}

function setDownloadActivity(book, percent, phase, telemetry = {}) {
  activeDownloadActivity = {
    id: String(book.id),
    title: book.title || 'Untitled',
    author: book.author || 'Unknown Author',
    hasCover: Boolean(book.hasCover),
    percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))),
    phase: phase || 'Downloading',
    bytesReceived: Math.max(0, Number(telemetry.bytesReceived) || 0),
    bytesTotal: Math.max(0, Number(telemetry.bytesTotal) || 0),
    bytesPerSecond: Math.max(0, Number(telemetry.bytesPerSecond) || 0),
    etaSeconds: Number.isFinite(telemetry.etaSeconds)
      ? Math.max(0, Number(telemetry.etaSeconds))
      : null
  };
  emitDownloadActivity();
}

function clearDownloadActivity() {
  activeDownloadActivity = null;
  emitDownloadActivity(null);
}

function downloadProgressTracker(book, chapters, working, showOverlay) {
  const weights = chapters.map(chapter => {
    const duration = Number(chapter?.estimatedDuration);
    if (Number.isFinite(duration) && duration > 0) return duration;
    const suppliedLength = Number(chapter?.textLength);
    const textLength = Number.isFinite(suppliedLength) && suppliedLength >= 0
      ? suppliedLength : String(chapter?.text || '').length;
    return textLength > 0 ? textLength : 1;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || chapters.length;
  const fractions = chapters.map(() => 0);
  const chapterBytes = chapters.map((_, index) => Number(working.chapterEntries?.[index]?.size) || 0);
  const initialBytes = chapterBytes.reduce((sum, value) => sum + value, 0);
  const expectedBytes = Math.max(initialBytes, Number(working.packageBytes) || 0);
  const transferStartedAt = Date.now();
  let lastPercent = -1;
  let lastPhase = '';

  return (chapterIndex, fraction, phase = 'Preparing', transfer = null) => {
    if (Number.isInteger(chapterIndex) && chapterIndex >= 0 && chapterIndex < fractions.length) {
      fractions[chapterIndex] = Math.max(
        fractions[chapterIndex],
        Math.max(0, Math.min(1, Number(fraction) || 0))
      );
    }
    if (
      Number.isInteger(chapterIndex) &&
      chapterIndex >= 0 &&
      chapterIndex < chapterBytes.length &&
      Number.isFinite(transfer?.received)
    ) {
      chapterBytes[chapterIndex] = Math.max(chapterBytes[chapterIndex], Number(transfer.received));
    }
    const completedWeight = fractions.reduce(
      (sum, value, index) => sum + (value * weights[index]),
      0
    );
    const chapterProgress = fractions.reduce((sum, value) => sum + value, 0)
      / Math.max(1, fractions.length);
    const weightedProgress = completedWeight / totalWeight;
    const allComplete = fractions.every(value => value >= 1);
    // Short front matter should still produce visible progress. Duration
    // weighting remains useful for large chapters, while chapter progress is
    // the floor that matches the server's sequential preparation workflow.
    const receivedBytes = chapterBytes.reduce((sum, value) => sum + value, 0);
    const byteProgress = expectedBytes > 0 ? Math.min(1, receivedBytes / expectedBytes) : null;
    const percent = allComplete
      ? 99
      : Math.min(98, Math.round((
        byteProgress == null ? Math.max(weightedProgress, chapterProgress) : byteProgress
      ) * 100));
    const elapsedSeconds = Math.max(0.001, (Date.now() - transferStartedAt) / 1000);
    const transferredThisRun = Math.max(0, receivedBytes - initialBytes);
    const bytesPerSecond = transferredThisRun > 0 ? transferredThisRun / elapsedSeconds : 0;
    const remainingBytes = Math.max(0, expectedBytes - receivedBytes);
    const etaSeconds = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null;
    working.progressPercent = percent;
    working.progressPhase = phase;
    if (percent === lastPercent && phase === lastPhase) return;
    lastPercent = percent;
    lastPhase = phase;
    setDownloadActivity(book, percent, phase, {
      bytesReceived: receivedBytes,
      bytesTotal: expectedBytes,
      bytesPerSecond,
      etaSeconds
    });
    if (showOverlay) {
      deps.showAudioLoading?.('Downloading book for offline', {
        detail: phase,
        percent,
        status: 'generating'
      });
    }
  };
}

function offlineChapterSnapshot(chapter, index) {
  const text = String(chapter?.text || '');
  return {
    index: Number.isInteger(chapter?.index) ? chapter.index : index,
    title: chapter?.title || `Chapter ${index + 1}`,
    rawTitle: chapter?.rawTitle || chapter?.title || '',
    type: chapter?.type || 'chapter',
    empty: Boolean(chapter?.empty),
    estimatedDuration: Number(chapter?.estimatedDuration) || 0,
    // The start-chapter heuristic only needs to distinguish substantial
    // narrative content. Keeping a short prefix avoids duplicating the book
    // text into localStorage while preserving that behavior offline.
    text: text.slice(0, 256),
    textTruncated: Boolean(chapter?.textTruncated || text.length > 256),
    ...(Number.isFinite(chapter?.textLength) ? { textLength: chapter.textLength } : {}),
    ...(Number.isFinite(chapter?.normalizedTextLength) ? { normalizedTextLength: chapter.normalizedTextLength } : {})
  };
}

function offlineTitleData(book, chapters) {
  return {
    book: structuredClone(book),
    chapters: chapters.map(offlineChapterSnapshot)
  };
}

export function offlineEntryForBook(bookId) {
  return getOfflineManifest()[bookId] || null;
}

function validTitleData(entry) {
  const data = entry?.titleData;
  return Boolean(
    data?.book?.id &&
    String(data.book.id) === String(entry.bookId) &&
    Array.isArray(data.chapters) &&
    data.chapters.length === Number(entry.chapters)
  );
}

// Deliberately two predicates, not one with a flag.
//
// These answer different questions and previously did not: one predicate served
// both "can the player rebuild itself from this?" and "is this Downloaded?",
// so a partial download was filed under Downloaded and failed to play. Keeping
// them separate means broadening one cannot silently broaden the other.

/**
 * Can the app rebuild a player, library card or cover from this entry offline?
 *
 * Intentionally broad: a partially downloaded book is still worth opening for
 * the chapters it does have, and that partial offline playback is a supported
 * feature. Never use this to decide what to call Downloaded.
 */
function isHydratableOfflineEntry(entry) {
  if (entry?.mode !== 'full' || !validTitleData(entry)) return false;
  // A progressive download keeps its verified chapters while the server
  // prepares the rest, so the preparation states are partial copies too.
  return [
    'ready', 'repairing', 'incomplete', 'verifying',
    'preparing', 'preparation-waiting', 'prepared', 'preparation-error', 'preparation-paused'
  ].includes(offlineState(entry));
}

/**
 * Is this book completely on this device and proven playable from it?
 *
 * The only predicate that may drive Downloaded semantics. `ready` is reached
 * exclusively by finishing every chapter, verifying bytes against the server
 * hash, and confirming the scoped worker route serves them.
 */
function isCompletedOfflineEntry(entry) {
  return isHydratableOfflineEntry(entry) && offlineState(entry) === 'ready';
}

function hasCachedChapter(entry) {
  return Array.isArray(entry?.chapterEntries) && entry.chapterEntries.some(Boolean);
}

export function hasOfflineBookData(bookId) {
  const entry = offlineEntryForBook(bookId);
  return isHydratableOfflineEntry(entry) && hasCachedChapter(entry);
}

export function getOfflineBookData(bookId) {
  const entry = offlineEntryForBook(bookId);
  if (!isHydratableOfflineEntry(entry) || !hasCachedChapter(entry)) return null;
  const data = structuredClone(entry.titleData);
  if (data.book.hasCover) data.book.coverUrl = offlineTitleRequest(bookId).url;
  return data;
}

export function getOfflineLibraryBooks() {
  return Object.values(getOfflineManifest())
    .filter(entry => isHydratableOfflineEntry(entry) && hasCachedChapter(entry))
    .sort((a, b) => String(b.downloadedAt || '').localeCompare(String(a.downloadedAt || '')))
    .map(entry => {
      const book = structuredClone(entry.titleData.book);
      if (book.hasCover) book.coverUrl = offlineTitleRequest(book.id).url;
      return book;
    });
}

export async function getVerifiedOfflineLibraryBooks() {
  if (!('caches' in window)) return [];
  await auditOfflineManifest({ presenceOnly: true });
  return getOfflineLibraryBooks();
}

function availableDownloadStatus(cachedChapters = 0, totalChapters = 0) {
  if (!offlineDownloadsSupported()) {
    return {
      kind: 'download-unavailable',
      label: 'Downloads unavailable in this browser',
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  if (!navigator.onLine) {
    return {
      kind: 'download-offline',
      label: 'Connect to download',
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  return {
    kind: 'ready-to-prepare',
    label: 'Download',
    downloaded: false,
    cachedChapters,
    totalChapters
  };
}

export function offlineStatusForBook(bookId, manifest = getOfflineManifest()) {
  const entry = manifest[bookId] || null;
  if (!entry) return availableDownloadStatus();
  const cachedChapters = Array.isArray(entry.chapterEntries)
    ? entry.chapterEntries.filter(Boolean).length
    : 0;
  const totalChapters = Number(entry.chapters) || 0;
  if (entry.mode === 'rolling') {
    return {
      kind: 'partial',
      label: `${cachedChapters} chapter${cachedChapters === 1 ? '' : 's'} cached`,
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  const state = offlineState(entry);
  if (state === 'preparing') {
    return {
      kind: 'preparing',
      label: cachedChapters > 0
        ? `${cachedChapters} of ${totalChapters} chapters on this device · Preparing the rest`
        : `Preparing audio · ${Number(entry.preparedChapters) || 0} of ${totalChapters} · Safe to close`,
      downloaded: false,
      cachedChapters,
      totalChapters,
      preparedChapters: Number(entry.preparedChapters) || 0
    };
  }
  if (state === 'preparation-waiting') {
    return {
      kind: 'preparation-waiting',
      label: cachedChapters > 0
        ? `${cachedChapters} of ${totalChapters} chapters on this device · Waiting for audio`
        : `Waiting for audio · ${Number(entry.preparedChapters) || 0} of ${totalChapters}`,
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  if (state === 'preparation-paused') {
    return {
      kind: 'preparation-paused',
      label: 'Offline setup paused · Resume',
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  if (state === 'prepared') {
    if (!offlineDownloadsSupported() || !navigator.onLine) {
      return availableDownloadStatus(cachedChapters, totalChapters);
    }
    return {
      kind: 'prepared',
      autoResume: entry.autoResume === true,
      label: entry.autoResume ? 'Waiting to download · Keep Xandrio open' : 'Audio prepared · Download to this device',
      downloaded: false,
      cachedChapters,
      totalChapters,
      bytesTotal: Math.max(0, Number(entry.packageBytes) || 0)
    };
  }
  if (state === 'preparation-error') {
    return {
      kind: 'preparation-error',
      label: 'Retry audio preparation',
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  if (state === 'preparation-capacity') {
    return {
      kind: 'preparation-capacity',
      label: 'Offline queue is full · Try again',
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  // Routed through the strict predicate on purpose: this is the single place
  // that may report `downloaded: true`, and it must not widen with the
  // hydration predicate.
  if (isCompletedOfflineEntry(entry)) {
    return {
      kind: 'downloaded',
      label: 'Downloaded',
      downloaded: true,
      cachedChapters,
      totalChapters
    };
  }
  if (state === 'repairing') {
    return {
      kind: 'downloading',
      label: `Downloading · ${cachedChapters} of ${totalChapters} chapters`,
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  // Stored and byte-verified, but the scoped playback route is unconfirmed.
  // Never reported as downloaded — that claim is what failed the user before.
  if (state === 'verifying') {
    return {
      kind: 'verifying',
      label: 'Verifying download — reopen Xandrio to finish',
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  if (state === 'incomplete' && isHydratableOfflineEntry(entry) && cachedChapters > 0) {
    return {
      kind: 'partial-download',
      label: `${cachedChapters} of ${totalChapters} chapters downloaded`,
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  return {
    kind: 'repair-needed',
    label: state === 'stale' ? 'Update download' : 'Download incomplete',
    downloaded: false,
    cachedChapters,
    totalChapters
  };
}

export function isBookDownloadedForOffline(bookId, chapterIndex = 0) {
  const entry = offlineEntryForBook(bookId);
  const legacyReady = entry?.manifestVersion === 2 &&
    entry?.mode === 'full' &&
    entry?.state === 'ready' &&
    Array.isArray(entry?.chapterEntries);
  return Boolean(
    entry && (isHydratableOfflineEntry(entry) || entry.mode === 'rolling' || legacyReady) &&
    Array.isArray(entry.chapterEntries) &&
    chapterIndex >= 0 && chapterIndex < entry.chapterEntries.length &&
    entry.chapterEntries[chapterIndex]
  );
}

export async function isChapterAvailableOffline(bookId, chapterIndex = 0) {
  if (!isBookDownloadedForOffline(bookId, chapterIndex)) return false;
  const blockEntry = offlineEntryForBook(bookId);
  if (blockEntry?.storageBackend === 'idb') {
    return Boolean(blockEntry.chapterEntries?.[chapterIndex]?.artifactId);
  }
  if (!('caches' in window)) return false;
  const scope = offlineScopeId();
  const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE, scope));
  const manifest = getOfflineManifest(scope);
  const entry = manifest[bookId];
  const request = offlineAudioRequest(bookId, chapterIndex, scope);
  let cached;
  try {
    cached = await matchLocalChapterCache(cache, request, scope);
  } catch {
    // A failed legacy copy is not evidence that the original audio is missing.
    // Keep its manifest pointer so a later migration can retry.
    return false;
  }
  if (offlineScopeId() !== scope) return false;
  const expected = entry?.chapterEntries?.[chapterIndex];
  if (cached && expected) {
    if (expected.bodyVerificationVersion === OFFLINE_BODY_VERIFICATION_VERSION) return true;
    const identity = await contentIdentity(cached, { verifyBody: true }).catch(() => null);
    if (offlineScopeId() !== scope) return false;
    if (identity && canReuseChapter(expected, identity, expected.variantKey)) {
      expected.bodyVerificationVersion = OFFLINE_BODY_VERIFICATION_VERSION;
      saveOfflineManifest(manifest, scope);
      await backfillContentIdentity(cache, request, cached, identity).catch(() => {});
      return offlineScopeId() === scope;
    }
    await cache.delete(request).catch(() => {});
  }

  if (!entry || !Array.isArray(entry.chapterEntries) || !entry.chapterEntries[chapterIndex]) return false;
  entry.chapterEntries[chapterIndex] = null;
  entry.bytes = entry.chapterEntries.reduce((sum, chapter) => sum + (Number(chapter?.size) || 0), 0);
  if (entry.mode !== 'rolling') entry.state = 'incomplete';
  saveOfflineManifest(manifest, scope);
  return false;
}

// Runtime-only distrust, keyed `bookId:chapterIndex`.
//
// `failures` is the tally for this session and survives a clean probe, because
// a two-byte probe cannot prove a whole chapter is playable — a chapter that
// keeps failing while passing it has to be escalated eventually. `distrusted`
// is the routing flag and *is* cleared by a clean probe, so a one-off Safari
// error costs a single chapter load rather than the rest of the session.
// Neither is persisted; the durable manifest is written only on deterministic
// evidence.
const suspectChapters = new Map();

function suspectKey(bookId, chapterIndex) {
  return `${bookId}:${chapterIndex}`;
}

/**
 * Prove the exact scoped service-worker route can serve a downloaded chapter.
 *
 * Byte-exact storage was already verified against the server hash; what this
 * adds is that the route the media element actually uses answers correctly.
 * Deliberately not an audio-element probe: on iOS that costs a media element,
 * interacts with activation rules, and cannot be run per chapter — a two-byte
 * Range request through the same URL is deterministic and nearly free.
 *
 * @returns {Promise<{ok: boolean, swVersion: string, reason: string}>}
 */
export function hasOfflineWorkerController() {
  return Boolean(globalThis.navigator?.serviceWorker?.controller);
}

/**
 * The script URL this shell registers. Versioning forces the browser to install
 * this build; compatibility is still decided by the explicit route contract.
 */
export const OFFLINE_WORKER_SCRIPT_URL = `/sw.js?v=${EXPECTED_OFFLINE_SW_VERSION}`;

/**
 * The one strict reading of a scoped offline probe response, shared by download
 * verification and runtime classification so the two can never drift.
 *
 * @returns {{outcome: 'hit'|'miss'|'indeterminate', swVersion: string, reason: string}}
 *   hit           — this exact worker served the chapter from cache. Proof the
 *                   route works.
 *   miss          — this exact worker states the chapter is not cached. The only
 *                   evidence strong enough to write to the manifest.
 *   indeterminate — anything else: no controller, transport failure, a worker
 *                   from another build, a malformed answer, a transient 5xx.
 *                   Proves nothing, so nothing durable may be concluded.
 */
async function readOfflineProbe(bookId, chapterIndex, options = {}) {
  const probe = options.probe || (request => fetch(request, { cache: 'no-store' }));
  // Certification and classification both require the exact worker *before*
  // fetching. A worker of another build could answer with its own semantics, and
  // its answer — in either direction — is not evidence about this contract.
  const entry = offlineEntryForBook(bookId);
  const blockChapter = entry?.storageBackend === 'idb'
    ? entry.chapterEntries?.[chapterIndex]
    : null;
  const requiredContract = blockChapter ? BLOCK_OFFLINE_ROUTE_CONTRACT : MINIMUM_OFFLINE_ROUTE_CONTRACT;
  if (!hasCompatibleOfflineWorkerController()) {
    return {
      outcome: 'indeterminate',
      swVersion: '',
      reason: hasOfflineWorkerController() ? 'unexpected-controller' : 'uncontrolled'
    };
  }

  let response = null;
  try {
    response = await probe(new Request(
      blockChapter?.localUrl || offlineAudioRequest(bookId, chapterIndex),
      { headers: { Range: 'bytes=0-1' } }
    ));
  } catch {
    return { outcome: 'indeterminate', swVersion: '', contractVersion: 0, reason: 'probe-failed' };
  }

  // A worker from another build may implement different cache semantics, so
  // nothing it says is evidence about this contract — in either direction.
  const swVersion = response?.headers?.get?.(OFFLINE_SW_VERSION_MARKER) || '';
  const contractVersion = Number(response?.headers?.get?.(OFFLINE_CONTRACT_MARKER)) || 0;
  if (contractVersion < requiredContract) {
    return {
      outcome: 'indeterminate',
      swVersion,
      contractVersion,
      reason: contractVersion ? 'worker-contract-too-old' : 'unversioned-worker'
    };
  }

  const marker = response.headers.get(OFFLINE_CACHE_MARKER);
  if (response.status === 504 && marker === 'miss') {
    return { outcome: 'miss', swVersion, contractVersion, reason: '' };
  }
  if (response.status !== 206 || marker !== 'hit') {
    return { outcome: 'indeterminate', swVersion, contractVersion, reason: 'unexpected-status' };
  }
  if (
    blockChapter &&
    response.headers.get('X-Xandrio-Artifact-SHA256') !== blockChapter.artifactId
  ) {
    return { outcome: 'indeterminate', swVersion, contractVersion, reason: 'artifact-mismatch' };
  }
  if (Number(response.headers.get('Content-Length')) !== 2) {
    return { outcome: 'indeterminate', swVersion, contractVersion, reason: 'bad-length' };
  }
  const range = /^bytes 0-1\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
  if (!range) return { outcome: 'indeterminate', swVersion, contractVersion, reason: 'malformed-range' };
  return { outcome: 'hit', swVersion, contractVersion, reason: '', totalBytes: Number(range[1]) };
}

/**
 * Prove the exact scoped service-worker route can serve a downloaded chapter.
 *
 * Byte-exact storage was already verified against the server hash; what this
 * adds is that the route the media element actually uses answers correctly.
 * Deliberately not an audio-element probe: on iOS that costs a media element,
 * interacts with activation rules, and cannot be run per chapter — a two-byte
 * Range request through the same URL is deterministic and nearly free.
 *
 * @returns {Promise<{ok: boolean, swVersion: string, reason: string}>}
 */
async function probeOfflinePlaybackRoute(bookId, chapterIndex, expectedSize, options = {}) {
  const result = await readOfflineProbe(bookId, chapterIndex, options);
  if (result.outcome !== 'hit') {
    return {
      ok: false,
      swVersion: result.swVersion,
      contractVersion: result.contractVersion || 0,
      reason: result.reason || result.outcome
    };
  }
  // Exact, not merely well-formed: a well-formed range over a different
  // artifact would otherwise pass.
  if (Number(result.totalBytes) !== Number(expectedSize)) {
    return {
      ok: false,
      swVersion: result.swVersion,
      contractVersion: result.contractVersion || 0,
      reason: 'range-mismatch'
    };
  }
  return {
    ok: true,
    swVersion: result.swVersion,
    contractVersion: result.contractVersion || 0,
    reason: ''
  };
}

/**
 * Re-probe every download left in `verifying`, promoting the ones that now pass.
 *
 * A download reaches `verifying` when its bytes are sound but the route could
 * not be confirmed — an uncontrolled page on first install, or a worker from a
 * different build. Both resolve themselves, so this runs at startup and on
 * `controllerchange` rather than asking the user to do anything.
 */
export async function reprobeVerifyingDownloads() {
  if (!('caches' in globalThis) || !hasCompatibleOfflineWorkerController()) return false;
  const manifest = getOfflineManifest();
  let changed = false;
  for (const [bookId, entry] of Object.entries(manifest)) {
    if (entry?.storageBackend === 'idb') continue;
    if (!Array.isArray(entry?.chapterEntries)) continue;
    // Two populations need checking: entries still waiting for certification,
    // and entries certified before this contract existed or against an earlier
    // worker build. The latter are currently claiming Downloaded on the strength
    // of a check that no longer means what it meant.
    const uncertified = entry.state === 'verifying';
    const probedContractVersion = Number(entry.probedContractVersion);
    const staleCertificate = entry.state === 'ready'
      && (
        !Number.isFinite(probedContractVersion)
        || probedContractVersion < MINIMUM_OFFLINE_ROUTE_CONTRACT
      );
    if (!uncertified && !staleCertificate) continue;

    const chapterIndex = entry.chapterEntries.findIndex(Boolean);
    if (chapterIndex < 0) continue;
    const check = await probeOfflinePlaybackRoute(
      bookId,
      chapterIndex,
      entry.chapterEntries[chapterIndex]?.size
    ).catch(() => ({ ok: false, swVersion: '' }));

    const latest = getOfflineManifest();
    // Do not fight a download or repair that started after this pass began.
    if (latest[bookId]?.state !== entry.state) continue;

    if (check.ok) {
      latest[bookId] = {
        ...latest[bookId],
        state: 'ready',
        progressPhase: 'Downloaded',
        probedSwVersion: check.swVersion,
        probedContractVersion: check.contractVersion
      };
    } else if (staleCertificate) {
      // Bytes are intact and stay intact — but an unconfirmed route cannot keep
      // claiming Downloaded. It returns to verifying and is retried later.
      latest[bookId] = {
        ...latest[bookId],
        state: 'verifying',
        progressPhase: 'Verifying'
      };
    } else {
      // Still uncertified: leave it exactly as it is and try again next time.
      continue;
    }
    saveOfflineManifest(latest);
    changed = true;
  }
  if (changed) renderOfflineState({ audit: false });
  return changed;
}

/**
 * Presence-only local availability for the chapter-load path.
 *
 * Routing must be cheap. Full-body verification already happened at download
 * time, and re-running it here would stall the first play of every chapter by
 * however long it takes to hash tens of megabytes on a phone. Corruption that
 * slipped past download verification surfaces as a playback failure, which
 * classifyLocalChapter then diagnoses off the critical path.
 *
 * @returns {Promise<{available: boolean, url: string|null, mode: string|null}>}
 */
export async function localChapterSource(bookId, chapterIndex = 0) {
  const unavailable = { available: false, url: null, mode: null };
  if (!bookId || !Number.isInteger(chapterIndex) || chapterIndex < 0) return unavailable;
  if (suspectChapters.get(suspectKey(bookId, chapterIndex))?.distrusted) return unavailable;
  const entry = offlineEntryForBook(bookId);
  if (entry?.storageBackend !== 'idb' && !('caches' in globalThis)) return unavailable;
  if (!isBookDownloadedForOffline(bookId, chapterIndex)) {
    return { ...unavailable, reason: 'not-downloaded' };
  }

  if (entry?.storageBackend === 'idb') {
    const chapter = entry.chapterEntries?.[chapterIndex];
    const worker = offlineWorkerControllerState();
    if (!chapter?.localUrl) return { ...unavailable, reason: 'not-downloaded' };
    if (!worker.compatible || worker.contractVersion < BLOCK_OFFLINE_ROUTE_CONTRACT) {
      return { ...unavailable, reason: 'worker-update-required', cached: true, mode: entry.mode || null };
    }
    return { available: true, url: chapter.localUrl, mode: entry.mode || null };
  }
  const scope = offlineScopeId();
  const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE, scope));
  const request = offlineAudioRequest(bookId, chapterIndex, scope);
  const cached = await matchLocalChapterCache(cache, request, scope).catch(() => null);
  if (offlineScopeId() !== scope) return unavailable;
  if (!cached) return { ...unavailable, reason: 'cache-miss' };
  // The scoped URL only means anything to the service worker. Handed to a media
  // element on an uncontrolled page it reaches the server instead, which serves
  // a different encode of the same chapter — silently streaming while claiming
  // to play locally. Without a controller there is no local playback to offer.
  if (!hasOfflineWorkerController()) {
    return { ...unavailable, reason: 'worker-update-required', cached: true, mode: entry?.mode || null };
  }
  // navigator.onLine is advisory and cannot make a network-first legacy worker
  // safe. Only a certified cache-only contract may receive the scoped URL in
  // any connectivity state.
  if (!hasCompatibleOfflineWorkerController()) {
    return { ...unavailable, reason: 'worker-update-required', cached: true, mode: entry?.mode || null };
  }
  return {
    available: true,
    url: request.url,
    mode: entry?.mode || null
  };
}

/**
 * Distrust one chapter for the rest of this session, without touching storage.
 *
 * Called the moment local playback fails. Falling back to streaming is cheap
 * and reversible; deleting a download is neither, and mobile Safari produces
 * transient media errors often enough that acting durably on one is wrong.
 */
export function markLocalChapterSuspect(bookId, chapterIndex = 0) {
  if (!bookId || !Number.isInteger(chapterIndex) || chapterIndex < 0) return;
  const key = suspectKey(bookId, chapterIndex);
  const current = suspectChapters.get(key) || { failures: 0, distrusted: false };
  suspectChapters.set(key, { failures: current.failures + 1, distrusted: true });
}

// Route locally again, but remember that this chapter has failed before.
function trustLocalChapterAgain(bookId, chapterIndex) {
  const key = suspectKey(bookId, chapterIndex);
  const current = suspectChapters.get(key);
  if (current) suspectChapters.set(key, { ...current, distrusted: false });
}

function clearLocalChapterSuspicion(bookId, chapterIndex) {
  suspectChapters.delete(suspectKey(bookId, chapterIndex));
}

/**
 * Diagnose a suspect chapter away from the playback path.
 *
 * Runs the same scoped service-worker request the media element uses, so it
 * exercises the real route rather than a proxy for it.
 *
 * @returns {Promise<'transient'|'missing'|'corrupt'|'unplayable'|'indeterminate'>}
 *   transient     — this exact worker served the chapter from cache; trust it
 *                   again on the next chapter load.
 *   missing       — this exact worker states it is not cached. The only verdict
 *                   that writes to the manifest, and even then the bytes are
 *                   kept so a repair can revalidate them cheaply.
 *   corrupt       — repeated failures plus a hash mismatch. The only verdict
 *                   that deletes cached audio.
 *   unplayable    — repeated failures but the hash matches. The bytes are the
 *                   bytes we downloaded and this device still cannot play them,
 *                   so keep everything and keep streaming for this session.
 *   indeterminate — nothing was proven. Keep everything, keep streaming.
 */
export async function classifyLocalChapter(bookId, chapterIndex = 0, options = {}) {
  const failures = suspectChapters.get(suspectKey(bookId, chapterIndex))?.failures || 0;
  const { outcome } = await readOfflineProbe(bookId, chapterIndex, options);

  // Only an explicit, current-version miss is strong enough to edit the
  // manifest. A dropped request, an old worker or a momentary 5xx says nothing
  // about whether the download is intact, and acting on one would throw away a
  // good copy over a transient condition.
  if (outcome === 'miss') {
    await invalidateLocalChapter(bookId, chapterIndex, { deleteBytes: false });
    return 'missing';
  }
  if (outcome !== 'hit') return 'indeterminate';

  // The cheap probe reads two bytes, so it cannot prove a whole chapter is
  // sound. Only once a chapter has repeatedly failed despite passing it do we
  // pay for the full hash — and only then may bytes be deleted.
  if (failures >= SUSPECT_FAILURES_BEFORE_HASH) {
    const intact = await localChapterBodyMatchesManifest(bookId, chapterIndex);
    if (!intact) {
      await invalidateLocalChapter(bookId, chapterIndex, { deleteBytes: true });
      return 'corrupt';
    }
    // A matching hash proves the file is the one we downloaded. It does not
    // prove this device can decode it, and three failures are evidence it
    // cannot. Keep the download — it may play elsewhere, or after an OS update
    // — but stop routing this chapter locally for the rest of the session.
    return 'unplayable';
  }

  trustLocalChapterAgain(bookId, chapterIndex);
  return 'transient';
}

async function localChapterBodyMatchesManifest(bookId, chapterIndex) {
  const entry = offlineEntryForBook(bookId);
  const expected = entry?.chapterEntries?.[chapterIndex];
  if (!expected) return false;
  if (entry?.storageBackend === 'idb') {
    return Boolean(await offlineDevice?.verifyArtifact(expected).catch(() => false));
  }
  try {
    const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE));
    const cached = await cache.match(offlineAudioRequest(bookId, chapterIndex));
    if (!cached) return false;
    if (Array.isArray(expected.blockHashes) && expected.blockSize > 0) {
      // Block-hashed chapters are checked as a stream, one block at a time.
      return await cachedBodyMatchesDescriptor(cached, { ...expected, state: 'ready' });
    }
    const identity = await contentIdentity(cached, { verifyBody: true });
    return canReuseChapter(expected, identity, expected.variantKey);
  } catch {
    return false;
  }
}

/**
 * Durably drop one chapter from the manifest. Bytes are retained unless they
 * are known bad, so a later repair can revalidate them instead of re-fetching.
 */
export async function invalidateLocalChapter(bookId, chapterIndex, { deleteBytes = false } = {}) {
  clearLocalChapterSuspicion(bookId, chapterIndex);
  const manifest = getOfflineManifest();
  const entry = manifest[bookId];
  if (entry?.storageBackend === 'idb') {
    await offlineDevice?.invalidateChapter(bookId, chapterIndex, { deleteBytes });
    return;
  }
  if (deleteBytes && 'caches' in globalThis) {
    const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE));
    await cache.delete(offlineAudioRequest(bookId, chapterIndex)).catch(() => {});
  }
  if (!entry || !Array.isArray(entry.chapterEntries)) return;
  if (!entry.chapterEntries[chapterIndex]) return;
  entry.chapterEntries[chapterIndex] = null;
  entry.bytes = entry.chapterEntries.reduce((sum, chapter) => sum + (Number(chapter?.size) || 0), 0);
  if (entry.mode !== 'rolling') entry.state = 'incomplete';
  saveOfflineManifest(manifest);
}

export function renderOfflineState({ audit = true } = {}) {
  migrateCurrentOfflineEntry();
  void auditCurrentOfflineVariant();
  renderOfflineManager();
  if (audit) void scheduleOfflineManifestAudit();
}

export function reconcileDeletedOfflineBooks() {
  if (!navigator.onLine) return Promise.resolve(false);
  const scope = offlineScopeId();
  if (deletionReconciliations.has(scope)) return deletionReconciliations.get(scope);
  const reconciliation = (async () => {
    const rawCursor = Number(localStorage.getItem(offlineDeletionCursorKey(scope)));
    const cursor = Number.isSafeInteger(rawCursor) && rawCursor >= 0 ? rawCursor : 0;
    const result = await apiSend('GET', `/api/offline/deletions?since=${cursor}`);
    if (offlineScopeId() !== scope) return false;
    const revision = Number(result?.revision);
    if (!Number.isSafeInteger(revision) || revision < cursor || !Array.isArray(result?.deletions)) {
      return false;
    }

    let changed = false;
    for (const tombstone of result.deletions) {
      const id = String(tombstone?.bookId || '');
      const entry = id ? offlineEntryForBook(id) : null;
      if (!entry) continue;
      const deletedAt = Date.parse(tombstone.deletedAt);
      const localChoiceAt = Math.max(
        Date.parse(entry.downloadedAt) || 0,
        entry.mode === 'full' ? (Date.parse(entry.downloadStartedAt) || 0) : 0
      );
      // A title explicitly downloaded after the server deletion is a newer
      // local choice and must not be removed by an older tombstone.
      if (Number.isFinite(deletedAt) && localChoiceAt > deletedAt) {
        continue;
      }
      await removeOfflineBook(id, {
        removePlaybackState: true,
        render: false
      });
      changed = true;
    }
    localStorage.setItem(offlineDeletionCursorKey(scope), String(revision));
    if (changed) renderOfflineState();
    return changed;
  })().catch(error => {
    console.warn('Offline deletion reconciliation failed:', error);
    return false;
  }).finally(() => {
    deletionReconciliations.delete(scope);
  });
  deletionReconciliations.set(scope, reconciliation);
  return reconciliation;
}

function migrateCurrentOfflineEntry() {
  const book = deps.getCurrentBook?.();
  const chapters = deps.getChapters?.() || [];
  if (!book?.id || chapters.length === 0) return false;
  const manifest = getOfflineManifest();
  const entry = manifest[book.id];
  if (entry?.storageBackend === 'idb') return false;
  if (
    entry?.manifestVersion !== 2 ||
    entry?.mode !== 'full' ||
    entry?.state !== 'ready' ||
    !Array.isArray(entry.chapterEntries) ||
    entry.chapterEntries.length !== chapters.length
  ) {
    return false;
  }
  manifest[book.id] = {
    ...entry,
    manifestVersion: OFFLINE_MANIFEST_VERSION,
    titleData: offlineTitleData(book, chapters)
  };
  saveOfflineManifest(manifest);
  return true;
}

function currentVoiceLabel() {
  return document.getElementById('player-voice-name')?.textContent?.trim() || 'Current voice';
}

async function auditCurrentOfflineVariant() {
  const book = deps.getCurrentBook?.();
  if (!book?.id) return;
  const entry = offlineEntryForBook(book.id);
  if (entry?.storageBackend === 'idb') return;
  // A running progressive download checks every chapter against the server
  // descriptor itself and replaces only the chapters that changed.
  if (entry?.autoResume === true) return;
  const sampleChapterIndex = entry?.chapterEntries?.findIndex(Boolean) ?? -1;
  if (
    !isHydratableOfflineEntry(entry) ||
    !entry.variantKey ||
    sampleChapterIndex < 0
  ) return;
  try {
    const status = /:offline-mp3-v\d+:br48k$/.test(entry.variantKey)
      ? await apiSend(
          'GET',
          `/api/offline/preparation/${encodeURIComponent(book.id)}`
        )
      : await getChapterAudioStatus(book.id, sampleChapterIndex, undefined, 'active');
    const currentVariantKey = String(status.packageVariantKey || status.variantKey || '');
    if (!currentVariantKey || !entry.variantKey || currentVariantKey === entry.variantKey) return;
    const latest = offlineEntryForBook(book.id);
    if (latest?.state === entry.state && latest?.variantKey === entry.variantKey) {
      setOfflineEntryState(book.id, 'stale');
    }
  } catch {}
}

export function downloadCurrentBook(options = {}) {
  const book = deps.getCurrentBook?.();
  const chapters = deps.getChapters?.() || [];
  return downloadBookForOffline(book, chapters, options);
}

function preparationEntry(book, chapters, existing = null) {
  const chapterCount = chapters.length;
  const oldEntries = Array.isArray(existing?.chapterEntries) ? existing.chapterEntries : [];
  return {
    ...existing,
    bookId: book.id,
    title: book.title,
    chapters: chapterCount,
    chapterEntries: Array.from({ length: chapterCount }, (_, index) => oldEntries[index] || null),
    titleData: offlineTitleData(book, chapters),
    bytes: Number(existing?.bytes) || 0,
    downloadedAt: existing?.downloadedAt || null,
    preparationRequestedAt: existing?.preparationRequestedAt || new Date().toISOString(),
    preparedChapters: Number(existing?.preparedChapters) || 0,
    packageBytes: Math.max(0, Number(existing?.packageBytes) || 0),
    packageVariantKey: String(existing?.packageVariantKey || ''),
    packageBitrateKbps: Math.max(0, Number(existing?.packageBitrateKbps) || 0),
    progressPercent: Number(existing?.progressPercent) || 0,
    progressPhase: 'Preparing audio',
    manifestVersion: OFFLINE_MANIFEST_VERSION,
    mode: 'full',
    state: 'preparing'
  };
}

function applyPreparationStatus(bookId, status, seed = null, { showReadyToast = true } = {}) {
  const id = String(bookId || '');
  const totalChapters = Math.max(0, Number(status?.totalChapters) || 0);
  if (!id || totalChapters === 0) return false;
  const manifest = getOfflineManifest();
  const current = manifest[id] || seed;
  if (!current) return status?.state === 'ready';
  // The device coordinator owns block transfer state. Server preparation
  // polling may observe the same title, but it cannot replace local progress.
  if (current.storageBackend === 'idb') return offlineState(current) === 'ready';
  if (offlineState(current) === 'ready') return true;
  if (status?.state === 'paused' || status?.state === 'not-requested') {
    const cachedChapters = current.chapterEntries?.filter(Boolean).length || 0;
    if (cachedChapters === 0) delete manifest[id];
    else manifest[id] = { ...current, state: 'incomplete' };
    saveOfflineManifest(manifest);
    return false;
  }
  const readyChapters = Math.max(0, Math.min(
    totalChapters,
    Number(status?.readyChapters) || 0
  ));
  const state = status?.state === 'ready'
    ? 'prepared'
    : status?.state === 'error'
      ? 'preparation-error'
      : status?.state === 'waiting'
        ? 'preparation-waiting'
        : 'preparing';
  manifest[id] = {
    ...current,
    bookId: id,
    chapters: totalChapters,
    chapterEntries: Array.from(
      { length: totalChapters },
      (_, index) => current.chapterEntries?.[index] || null
    ),
    preparedChapters: readyChapters,
    packageBytes: Math.max(0, Number(status?.bytesTotal || status?.bytesPrepared) || 0),
    packageVariantKey: String(status?.packageVariantKey || current.packageVariantKey || ''),
    packageBitrateKbps: Math.max(0, Number(status?.bitrateKbps || current.packageBitrateKbps) || 0),
    progressPercent: state === 'prepared'
      ? 100
      : Math.max(0, Math.min(99, Math.round(Number(status?.percent) || 0))),
    progressPhase: state === 'prepared'
      ? 'Ready to download'
      : state === 'preparation-paused'
        ? 'Offline setup paused'
        : state === 'preparation-waiting'
          ? 'Waiting for audio'
          : 'Preparing audio',
    manifestVersion: OFFLINE_MANIFEST_VERSION,
    mode: 'full',
    state
  };
  saveOfflineManifest(manifest);
  if (
    showReadyToast && !current.autoResume &&
    state === 'prepared' &&
    current.state !== 'prepared' &&
    offlineState(current) !== 'ready'
  ) {
    showToast('Audio is ready to download');
  }
  schedulePreparationPoll();
  return state === 'prepared';
}

let preparationPollDelayMs = PREPARATION_POLL_MIN_MS;
let preparationPollProgress = -1;

/**
 * Delay before the next preparation status check, or null for none.
 *
 * Pure so the cadence can be tested without timers: fast right after a
 * chapter became ready, backing off while nothing changes, and no polling at
 * all while hidden unless this page is actively transferring audio.
 */
export function nextPreparationPollDelay({
  previousDelayMs = PREPARATION_POLL_MIN_MS,
  progressed = false,
  hidden = false,
  transferring = false
} = {}) {
  if (hidden && !transferring) return null;
  if (hidden) return PREPARATION_POLL_MAX_MS;
  if (progressed) return PREPARATION_POLL_MIN_MS;
  return Math.min(
    PREPARATION_POLL_MAX_MS,
    Math.max(PREPARATION_POLL_MIN_MS, Math.round((Number(previousDelayMs) || 0) * PREPARATION_POLL_BACKOFF))
  );
}

function pollablePreparationEntries(manifest = getOfflineManifest()) {
  return Object.values(manifest).filter(entry =>
    entry?.storageBackend !== 'idb' &&
    (['preparing', 'preparation-waiting'].includes(offlineState(entry)) ||
      (entry.autoResume && offlineState(entry) === 'prepared') ||
      // A scheduled transfer retry keeps the poll alive to run it.
      (entry.autoResume && Number(entry.transferRetryAt) > 0))
  );
}

export function transferRetryDelayMs(attempts = 0) {
  const exponent = Math.max(0, Math.min(20, Number(attempts) || 0));
  return Math.min(TRANSFER_RETRY_MAX_MS, TRANSFER_RETRY_MIN_MS * (2 ** exponent));
}

function scheduleTransferRetry(entry) {
  const attempts = Math.max(0, Number(entry.transferRetryAttempts) || 0);
  entry.transferRetryAttempts = attempts + 1;
  entry.transferRetryAt = Date.now() + transferRetryDelayMs(attempts);
}

function clearTransferRetry(entry) {
  delete entry.transferRetryAt;
  delete entry.transferRetryAttempts;
}

function carryTransferRetry(entry, existing) {
  if (Number(existing?.transferRetryAttempts) > 0) {
    entry.transferRetryAttempts = Number(existing.transferRetryAttempts);
  }
  if (Number(existing?.transferRetryAt) > 0) entry.transferRetryAt = Number(existing.transferRetryAt);
}

function transientTransferError(error) {
  if (error?.name === 'AbortError' || error?.message === 'Download cancelled') return false;
  if (['VERIFICATION_FAILED', 'DESCRIPTOR_CHANGED', 'BOOK_CHANGED'].includes(error?.code)) return false;
  return isTransientDownloadError(error);
}

function preparationProgressMark(entries) {
  return entries.reduce((sum, entry) => sum + (Number(entry.preparedChapters) || 0), 0);
}

function schedulePreparationPoll(delayMs = null) {
  watchPreparationVisibility();
  if (
    preparationPollTimer ||
    typeof window.setTimeout !== 'function' ||
    !navigator.onLine
  ) return;
  const entries = pollablePreparationEntries();
  if (entries.length === 0) {
    preparationPollDelayMs = PREPARATION_POLL_MIN_MS;
    preparationPollProgress = -1;
    return;
  }
  const mark = preparationProgressMark(entries);
  const progressed = mark !== preparationPollProgress;
  preparationPollProgress = mark;
  const cadence = nextPreparationPollDelay({
    previousDelayMs: preparationPollDelayMs,
    progressed,
    hidden: Boolean(globalThis.document?.hidden),
    transferring: Boolean(downloadAbort)
  });
  if (cadence === null) {
    // The next visible check starts at the fast cadence.
    preparationPollDelayMs = PREPARATION_POLL_MIN_MS;
    preparationPollProgress = -1;
    return;
  }
  preparationPollDelayMs = cadence;
  const interval = delayMs == null ? cadence : Math.max(0, Number(delayMs) || 0);
  preparationPollTimer = window.setTimeout(() => {
    preparationPollTimer = null;
    void refreshOfflinePreparations({ respectBackoff: true }).finally(() => schedulePreparationPoll());
  }, interval);
}

let preparationVisibilityWatched = false;

/**
 * Hidden pages do not poll. Returning to the app checks at once, so progress
 * is never shown frozen at whatever the last poll saw. Attached on first use
 * rather than at import, because this module is also loaded outside a
 * document.
 */
function watchPreparationVisibility() {
  if (preparationVisibilityWatched || typeof globalThis.document?.addEventListener !== 'function') {
    return;
  }
  preparationVisibilityWatched = true;
  globalThis.document.addEventListener('visibilitychange', () => {
    if (globalThis.document.hidden) {
      if (preparationPollTimer !== null && !downloadAbort) {
        window.clearTimeout?.(preparationPollTimer);
        preparationPollTimer = null;
      }
      return;
    }
    if (preparationPollTimer !== null) window.clearTimeout?.(preparationPollTimer);
    preparationPollTimer = null;
    preparationPollDelayMs = PREPARATION_POLL_MIN_MS;
    schedulePreparationPoll(0);
  });
}

export async function prepareBookForOffline(book, chapters, options = {}) {
  if (!book?.id || !Array.isArray(chapters) || chapters.length === 0) return false;
  if (!navigator.onLine) {
    showToast('Connect to prepare this title for offline use', 'error');
    return false;
  }
  const id = String(book.id);
  const existing = offlineEntryForBook(id);
  if (offlineState(existing) === 'ready') return true;
  const entry = preparationEntry(book, chapters, existing);
  if (options.autoResume) {
    entry.autoResume = true;
    persistWorkingEntry(id, entry);
  }
  try {
    const status = await apiSend(
      'POST',
      `/api/offline/preparation/${encodeURIComponent(id)}`
    );
    if (options.autoResume && !offlineEntryForBook(id)?.autoResume) return false;
    const ready = applyPreparationStatus(id, status, entry, options);
    if (!ready) {
      showToast(
        status?.state === 'error'
          ? 'Audio preparation needs attention'
          : 'Audio preparation started',
        status?.state === 'error' ? 'error' : undefined
      );
    }
    return ready;
  } catch (error) {
    if (options.autoResume && !offlineEntryForBook(id)?.autoResume) return false;
    persistWorkingEntry(id, {
      ...entry,
      state: error?.status === 429 ? 'preparation-capacity' : 'preparation-error'
    });
    if (error?.status === 429) {
      showToast('Offline queue is full. Remove another offline setup and try again.');
      return false;
    }
    throw error;
  }
}

export async function prepareAndDownloadBookForOffline(book, chapters, options = {}) {
  const {
    notificationSetup = Promise.resolve(false),
    ...downloadOptions
  } = options;
  const notificationReady = Promise.resolve(notificationSetup).catch(() => false);
  const blockDownload = await startBlockOfflineDownload(book, chapters, downloadOptions);
  if (blockDownload.handled) {
    const [downloaded] = await Promise.all([blockDownload.completion, notificationReady]);
    return downloaded;
  }
  const ready = await prepareBookForOffline(book, chapters, { showReadyToast: false, autoResume: true });
  // Chapters are saved as each one is prepared, so a running preparation is
  // not a reason to wait. Errors, capacity, pauses and cancellation are.
  const entry = offlineEntryForBook(book.id);
  if (!ready && !(entry?.autoResume && ['preparing', 'preparation-waiting'].includes(offlineState(entry)))) {
    await notificationReady;
    return false;
  }
  return downloadBookForOffline(book, chapters, { ...downloadOptions, confirmForeground: false, requireIntent: true });
}

async function startBlockOfflineDownload(book, chapters, options = {}) {
  const device = await loadOfflineDevice();
  if (!device?.writerEnabled?.()) return { handled: false, completion: null };
  await certifyOfflineWorkerController({ timeoutMs: 1500 }).catch(() => offlineWorkerControllerState());
  if (!device.writerCapable?.()) return { handled: false, completion: null };
  if (!navigator.onLine || document.hidden) {
    showToast('Open Xandrio while connected to start this download', 'error');
    return { handled: true, completion: Promise.resolve(false) };
  }
  const existing = offlineEntryForBook(book.id);
  const entry = {
    ...preparationEntry(book, chapters, existing),
    revision: existing?.revision || `pending-${Date.now()}`,
    state: 'preparing',
    autoResume: true,
    storageBackend: 'idb'
  };
  // Persistence is advisory. Do not let a stuck browser prompt retain the
  // user-owned transfer for more than three seconds.
  void Promise.race([
    requestPersistentOfflineStorage(),
    new Promise(resolve => setTimeout(() => resolve(false), 3000))
  ]).catch(() => false);
  void cacheOfflineCover(book).catch(error => {
    console.warn('Offline cover could not be cached:', error);
    showToast('The cover could not be saved offline. Audio download continues.', 'error');
  });
  const completion = device.startFull(book, chapters, entry);
  if (!completion) return { handled: false, completion: null };
  return {
    handled: true,
    completion: Promise.resolve(completion).then(downloaded => {
      showToast(downloaded ? 'Book downloaded for offline' : 'Offline download paused. Tap Retry to continue.', downloaded ? undefined : 'error');
      renderOfflineState({ audit: false });
      return Boolean(downloaded);
    })
  };
}

function applicationServerKeyBytes(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

export async function enableOfflineReadyNotifications() {
  if (
    typeof Notification === 'undefined' ||
    !('serviceWorker' in navigator) ||
    typeof PushManager === 'undefined'
  ) {
    return false;
  }
  // This call intentionally occurs before any await. Safari and Chromium both
  // require notification permission to originate in the user's prepare tap.
  const permissionRequest = Notification.permission === 'default'
    ? Notification.requestPermission()
    : Promise.resolve(Notification.permission);
  try {
    if (await permissionRequest !== 'granted') return false;
    const config = await apiSend('GET', '/api/offline/notifications');
    if (!config?.enabled || !config.publicKey) return false;
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKeyBytes(config.publicKey)
      });
    }
    await apiSend('POST', '/api/offline/notifications', {
      subscription: subscription.toJSON ? subscription.toJSON() : subscription
    });
    return true;
  } catch (error) {
    console.warn('Offline readiness notifications are unavailable:', error);
    return false;
  }
}

export async function refreshOfflinePreparation(bookId) {
  const id = String(bookId || '');
  if (!id || !navigator.onLine) return false;
  const status = await apiSend(
    'GET',
    `/api/offline/preparation/${encodeURIComponent(id)}`
  );
  const existing = offlineEntryForBook(id);
  const seed = existing || (status?.state === 'ready' ? {
    bookId: id,
    title: '',
    chapters: Number(status.totalChapters) || 0,
    chapterEntries: Array.from({ length: Number(status.totalChapters) || 0 }, () => null),
    bytes: 0,
    downloadedAt: null,
    manifestVersion: OFFLINE_MANIFEST_VERSION,
    mode: 'full',
    state: 'prepared'
  } : null);
  return applyPreparationStatus(id, status, seed);
}

export async function refreshOfflinePreparations(options = {}) {
  if (!navigator.onLine) return false;
  // Event listeners pass an Event here; only the poll asks for backoff.
  const resume = { respectBackoff: options?.respectBackoff === true };
  const preparingIds = Object.values(getOfflineManifest())
    .filter(entry => entry?.storageBackend !== 'idb' &&
      ['preparing', 'preparation-waiting'].includes(offlineState(entry)))
    .map(entry => String(entry.bookId));
  if (preparingIds.length === 0) return resumeInterruptedOfflineDownloads(resume);
  const results = await Promise.allSettled(preparingIds.map(refreshOfflinePreparation));
  await resumeInterruptedOfflineDownloads(resume);
  schedulePreparationPoll();
  return results.some(result => result.status === 'fulfilled' && result.value);
}

export function cancelOfflineDownload(bookId) {
  const entry = offlineEntryForBook(bookId);
  if (entry?.storageBackend === 'idb') {
    void offlineDevice?.pause(bookId);
    return true;
  }
  if (downloadAbort && String(activeDownloadBookId) === String(bookId)) {
    downloadAbort.abort();
    return true;
  }
  return false;
}

export async function cancelOfflinePreparation(bookId) {
  const id = String(bookId || '');
  if (!id || !navigator.onLine) return false;
  if (offlineEntryForBook(id)?.storageBackend === 'idb') {
    await offlineDevice?.remove(id);
  }
  const pending = getOfflineManifest();
  if (pending[id]) {
    pending[id] = { ...pending[id], autoResume: false };
    saveOfflineManifest(pending);
  }
  // A progressive transfer may be saving a chapter of this title right now.
  // Stop it and let its late writes settle before deciding what remains.
  if (downloadAbort && String(activeDownloadBookId) === id) {
    const completion = activeDownloadCompletion;
    downloadAbort.abort();
    await completion;
  }
  await apiSend('DELETE', `/api/offline/preparation/${encodeURIComponent(id)}`);
  const manifest = getOfflineManifest();
  const entry = manifest[id];
  if (entry && [
    'prepared',
    'preparing',
    'preparation-waiting',
    'preparation-error',
    'preparation-capacity',
    'preparation-paused',
    'repairing',
    'incomplete'
  ].includes(offlineState(entry))) {
    if (hasCachedChapter(entry)) {
      // Verified chapters already on the device stay playable as a partial
      // download; they are not counted as Downloaded.
      manifest[id] = {
        ...entry,
        state: 'incomplete',
        autoResume: false,
        progressPhase: 'Cancelled'
      };
    } else {
      delete manifest[id];
    }
    saveOfflineManifest(manifest);
  }
  showToast('Download cancelled');
  return true;
}

let resumingDownload = false;

export async function resumeInterruptedOfflineDownloads(options = {}) {
  if (resumingDownload) return false;
  resumingDownload = true;
  try {
    return await resumeNextOfflineDownload({ respectBackoff: options?.respectBackoff === true });
  } finally {
    resumingDownload = false;
    schedulePreparationPoll();
  }
}

async function resumeNextOfflineDownload({ respectBackoff = false } = {}) {
  if (
    downloadAbort ||
    !navigator.onLine ||
    document.hidden ||
    !offlineDownloadsSupported()
  ) {
    return false;
  }
  const candidate = Object.values(getOfflineManifest())
    .filter(entry =>
      entry?.autoResume === true &&
      entry?.storageBackend !== 'idb' &&
      entry?.mode === 'full' &&
      validTitleData(entry) &&
      (!respectBackoff || !(Number(entry.transferRetryAt) > Date.now())) &&
      (['prepared', 'repairing', 'incomplete'].includes(offlineState(entry)) ||
        (['preparing', 'preparation-waiting'].includes(offlineState(entry)) && hasNewPreparedWork(entry)))
    )
    .sort((left, right) =>
      String(left.downloadStartedAt || '').localeCompare(String(right.downloadStartedAt || ''))
    )[0];
  if (!candidate) return false;
  return downloadBookForOffline(
    candidate.titleData.book,
    candidate.titleData.chapters,
    { confirmForeground: false, showOverlay: false, requireIntent: true }
  );
}

/**
 * Has the server prepared something this device has not yet looked at?
 *
 * The status poll is cheap; the per-chapter descriptor is not. A transfer
 * pass records how many chapters the server had prepared when it last ran,
 * and only a higher count, or a different narration package, starts another.
 */
function hasNewPreparedWork(entry) {
  const checked = Number(entry?.transferCheckedPrepared);
  if (!Number.isFinite(checked)) return true;
  if (
    entry.packageVariantKey && entry.variantKey &&
    entry.packageVariantKey !== entry.variantKey
  ) return true;
  return (Number(entry.preparedChapters) || 0) > checked;
}

async function requestPersistentOfflineStorage() {
  const storage = navigator.storage;
  if (!storage?.persist) return false;
  try {
    if (await storage.persisted?.()) return true;
    return Boolean(await storage.persist());
  } catch {
    // Persistence is an eviction preference, not a prerequisite. Browsers
    // that deny or fail the request must still allow a best-effort download.
    return false;
  }
}

function requestDownloadWakeLock() {
  if (downloadWakeLock) return Promise.resolve(true);
  if (downloadWakeLockRequest) return downloadWakeLockRequest;
  if (!downloadWakeLockActive || !navigator.wakeLock?.request || document.hidden) {
    return Promise.resolve(false);
  }
  const pending = (async () => {
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!downloadWakeLockActive) {
        if (sentinel.release) await sentinel.release().catch(() => {});
        return false;
      }
      downloadWakeLock = sentinel;
      sentinel.addEventListener?.('release', () => {
        if (downloadWakeLock === sentinel) downloadWakeLock = null;
      });
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    if (downloadWakeLockRequest === pending) downloadWakeLockRequest = null;
  });
  downloadWakeLockRequest = pending;
  return pending;
}

async function holdDownloadWakeLock() {
  if (!navigator.wakeLock?.request) return false;
  downloadWakeLockActive = true;
  if (!downloadWakeLockVisibilityHandler) {
    downloadWakeLockVisibilityHandler = () => {
      if (document.hidden) {
        const sentinel = downloadWakeLock;
        downloadWakeLock = null;
        void sentinel?.release?.().catch(() => {});
      } else if (downloadWakeLockActive && !downloadWakeLock) {
        void requestDownloadWakeLock();
      }
    };
    document.addEventListener('visibilitychange', downloadWakeLockVisibilityHandler);
  }
  return requestDownloadWakeLock();
}

async function releaseDownloadWakeLock() {
  downloadWakeLockActive = false;
  if (downloadWakeLockVisibilityHandler) {
    document.removeEventListener('visibilitychange', downloadWakeLockVisibilityHandler);
    downloadWakeLockVisibilityHandler = null;
  }
  await downloadWakeLockRequest?.catch(() => {});
  const sentinel = downloadWakeLock;
  downloadWakeLock = null;
  if (!sentinel?.release) return;
  await sentinel.release().catch(() => {});
}

/**
 * One prepared chapter as the server's transfer descriptor names it. Anything
 * that does not carry a complete identity is treated as not yet prepared:
 * an incomplete descriptor can never authorise a download or a reuse.
 */
function normalizeChapterDescriptor(item, index) {
  if (item?.state === 'empty') return { index, state: 'empty' };
  const size = Number(item?.size);
  const blockSize = Number(item?.blockSize);
  const ready = item?.state === 'ready' &&
    SHA256_IDENTITY.test(String(item.artifactId || '')) &&
    item.contentHash === item.artifactId &&
    Number.isSafeInteger(size) && size > 0 &&
    Number.isSafeInteger(blockSize) && blockSize > 0 &&
    Array.isArray(item.blockHashes) &&
    item.blockHashes.length === Math.ceil(size / blockSize) &&
    item.blockHashes.every(hash => SHA256_IDENTITY.test(String(hash || ''))) &&
    typeof item.variantKey === 'string' && item.variantKey.length > 0;
  if (!ready) return { index, state: item?.state === 'error' ? 'error' : 'pending' };
  return {
    index,
    state: 'ready',
    artifactId: item.artifactId,
    contentHash: item.contentHash,
    etag: typeof item.etag === 'string' && item.etag ? item.etag : `"${item.artifactId}"`,
    size,
    blockSize,
    blockHashes: item.blockHashes.slice(),
    variantKey: item.variantKey,
    url: typeof item.url === 'string' && item.url.startsWith('/api/offline/audio/') ? item.url : ''
  };
}

/**
 * The per-chapter transfer descriptor: which chapters are prepared right now
 * and the exact bytes (size, whole-file and per-block SHA-256) each one is.
 */
async function fetchTransferManifest(bookId) {
  const manifest = await apiSend(
    'GET',
    `/api/offline/preparation/${encodeURIComponent(bookId)}/manifest`
  );
  if (
    manifest?.schemaVersion !== OFFLINE_TRANSFER_SCHEMA_VERSION ||
    String(manifest.bookId) !== String(bookId) ||
    !Array.isArray(manifest.chapters) ||
    Number(manifest.totalChapters) !== manifest.chapters.length
  ) {
    throw new Error('The server described this title’s audio in an unexpected way');
  }
  const chapters = manifest.chapters.map(normalizeChapterDescriptor);
  return {
    state: String(manifest.state || ''),
    packageVariantKey: String(manifest.packageVariantKey || ''),
    bytesPrepared: Math.max(0, Number(manifest.bytesPrepared) || 0),
    bytesTotal: Math.max(0, Number(manifest.bytesTotal) || 0),
    chapters,
    complete: chapters.length > 0 && chapters.every(item => ['ready', 'empty'].includes(item.state))
  };
}

function preparedChapterCount(transfer) {
  return transfer.chapters.filter(item => ['ready', 'empty'].includes(item.state)).length;
}

function chapterIdentityFromDescriptor(descriptor) {
  return {
    size: descriptor.size,
    contentHash: descriptor.contentHash,
    etag: descriptor.etag,
    variantKey: descriptor.variantKey,
    artifactId: descriptor.artifactId,
    blockSize: descriptor.blockSize,
    blockHashes: descriptor.blockHashes.slice(),
    bodyVerificationVersion: OFFLINE_BODY_VERIFICATION_VERSION
  };
}

function storedChapterMatches(stored, descriptor) {
  return Boolean(
    stored && descriptor?.state === 'ready' &&
    stored.contentHash === descriptor.contentHash &&
    stored.size === descriptor.size &&
    stored.variantKey === descriptor.variantKey
  );
}

/**
 * Drop exactly the stored chapters the server no longer stands behind: a
 * chapter whose prepared bytes changed, one that is now empty, or one from a
 * different narration package. Every other verified chapter is kept.
 *
 * @returns {number[]} chapter indexes whose stored bytes must be deleted
 */
function dropChangedChapters(entry, transfer) {
  const dropped = [];
  entry.chapterEntries.forEach((stored, index) => {
    if (!stored) return;
    const descriptor = transfer.chapters[index];
    const stale = !descriptor || descriptor.state === 'empty'
      ? true
      : descriptor.state === 'ready'
        ? !storedChapterMatches(stored, descriptor)
        : Boolean(transfer.packageVariantKey) && stored.variantKey !== transfer.packageVariantKey;
    if (!stale) return;
    entry.chapterEntries[index] = null;
    dropped.push(index);
  });
  entry.bytes = entry.chapterEntries.reduce((sum, chapter) => sum + (Number(chapter?.size) || 0), 0);
  return dropped;
}

/**
 * Stream a stored chapter back out of CacheStorage and check every block
 * against the server's per-block SHA-256. Holds at most one block (1 MiB) in
 * memory, so verification never materialises a whole chapter on iOS.
 */
async function cachedBodyMatchesDescriptor(response, descriptor, signal = null) {
  if (!response || descriptor?.state !== 'ready') return false;
  const declared = Number(response.headers?.get?.('Content-Length'));
  if (Number.isFinite(declared) && declared > 0 && declared !== descriptor.size) return false;
  const block = new Uint8Array(Math.min(descriptor.blockSize, descriptor.size));
  let filled = 0;
  let blockIndex = 0;
  let received = 0;
  const blockLength = () => Math.min(descriptor.blockSize, descriptor.size - (blockIndex * descriptor.blockSize));
  const consume = async chunk => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (blockIndex >= descriptor.blockHashes.length) return false;
      const take = Math.min(blockLength() - filled, chunk.byteLength - offset);
      block.set(chunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === blockLength()) {
        if (await hashBytes(block.subarray(0, filled)) !== descriptor.blockHashes[blockIndex]) return false;
        blockIndex += 1;
        filled = 0;
      }
    }
    return true;
  };
  if (!response.body?.getReader) {
    // Only reached by engines without response streams; none of them is iOS.
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== descriptor.size) return false;
    if (!await consume(bytes)) return false;
    return blockIndex === descriptor.blockHashes.length && filled === 0;
  }
  const reader = response.body.getReader();
  let finished = false;
  try {
    while (true) {
      throwIfDownloadAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      received += chunk.byteLength;
      if (received > descriptor.size || !await consume(chunk)) return false;
    }
  } finally {
    // Not awaited: cancelling one branch of a teed (cloned) body settles only
    // once every branch is cancelled.
    if (!finished) void reader.cancel().catch(() => {});
  }
  return received === descriptor.size && blockIndex === descriptor.blockHashes.length && filled === 0;
}

function descriptorChangedError(chapterIndex) {
  const error = new Error(`The server replaced the audio for chapter ${chapterIndex + 1}`);
  error.code = 'DESCRIPTOR_CHANGED';
  // Not transient: retrying the same descriptor cannot succeed.
  error.status = 409;
  return error;
}

/**
 * Store one chapter so that it is either complete and verified or absent.
 *
 * CacheStorage commits an entry only after its whole body has been read, so
 * an interrupted transfer leaves nothing behind. The stored body is then
 * re-read and checked block by block before the caller may record it. A
 * chapter that a killed run committed but never recorded is verified in
 * place and adopted instead of being downloaded again.
 */
async function storeVerifiedChapter({ bookId, descriptor, cache, signal, onProgress = null }) {
  const chapterIndex = descriptor.index;
  const request = offlineAudioRequest(bookId, chapterIndex);
  const identity = chapterIdentityFromDescriptor(descriptor);
  const leftover = await cache.match(request).catch(() => null);
  if (leftover) {
    const stored = contentIdentityFromHeaders(leftover.headers);
    if (
      stored?.contentHash === descriptor.contentHash &&
      stored.size === descriptor.size &&
      await cachedBodyMatchesDescriptor(leftover, descriptor, signal)
    ) {
      onProgress?.(1, { received: descriptor.size, total: descriptor.size });
      return identity;
    }
    await cache.delete(request).catch(() => {});
  }
  const route = descriptor.url ||
    `/api/offline/audio/${encodeURIComponent(bookId)}/${chapterIndex}` +
    `?variant=${encodeURIComponent(descriptor.variantKey)}&artifact=${encodeURIComponent(descriptor.artifactId)}`;
  return retryDownloadOperation(async () => {
    const response = await fetch(`${API_BASE}${route}`, {
      signal,
      headers: { 'X-Xandrio-Offline-Download': '1' }
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      if (response.status === 409) throw descriptorChangedError(chapterIndex);
      const error = new Error(`Audio download failed for chapter ${chapterIndex + 1}`);
      error.status = response.status;
      throw error;
    }
    const declared = Number(response.headers.get('Content-Length'));
    const served = response.headers.get(OFFLINE_CONTENT_HASH_HEADER);
    if (
      (Number.isFinite(declared) && declared > 0 && declared !== descriptor.size) ||
      (served && served !== descriptor.contentHash)
    ) {
      await response.body?.cancel?.().catch?.(() => {});
      throw descriptorChangedError(chapterIndex);
    }
    // The stored headers carry the descriptor's identity, so later presence
    // checks and audits can compare without reading the body again.
    const headers = new Headers(response.headers);
    headers.set('Content-Length', String(descriptor.size));
    headers.set(OFFLINE_CONTENT_HASH_HEADER, descriptor.contentHash);
    headers.set('ETag', descriptor.etag);
    if (!headers.get('Content-Type')) headers.set('Content-Type', 'audio/mpeg');
    const streamed = responseStreamWithProgress(response, signal, onProgress);
    await cache.put(request, new Response(streamed.body, { status: 200, headers }));
    const saved = await cache.match(request);
    if (!await cachedBodyMatchesDescriptor(saved, descriptor, signal)) {
      await cache.delete(request).catch(() => {});
      throw Object.assign(
        new Error(`Offline cache verification failed for chapter ${chapterIndex + 1}`),
        { code: 'VERIFICATION_FAILED' }
      );
    }
    onProgress?.(1, { received: descriptor.size, total: descriptor.size });
    return identity;
  }, signal);
}

/**
 * Exclusive ownership of the CacheStorage writer across tabs and windows.
 * Resolves to a release function, or null when another page holds it.
 */
function acquireOfflineDownloadLock() {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request !== 'function') return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    locks.request(OFFLINE_DOWNLOAD_LOCK, { ifAvailable: true }, lock => {
      if (!lock) {
        resolve(null);
        return undefined;
      }
      return new Promise(release => resolve(release));
    }).catch(reject);
  });
}

function waitingStateForTransfer(transfer) {
  if (transfer.state === 'error') return 'preparation-error';
  if (transfer.state === 'waiting') return 'preparation-waiting';
  return 'preparing';
}

/**
 * Save a title for offline use, chapter by chapter, as the server prepares it.
 *
 * Each pass reads the transfer descriptor, drops only the stored chapters
 * whose server identity changed, and stores every newly prepared chapter in
 * reading order. When preparation is still running the pass ends with the
 * title in a preparing state that keeps its verified chapters playable; the
 * preparation poll starts the next pass once more chapters are ready. The
 * title becomes Downloaded only after every playable chapter is stored and
 * verified and the scoped worker route has served one of them.
 */
export async function downloadBookForOffline(book, chapters, options = {}) {
  if (!book?.id || !Array.isArray(chapters) || chapters.length === 0) return false;
  if (!offlineDownloadsSupported()) return false;
  const blockDownload = await startBlockOfflineDownload(book, chapters, options);
  if (blockDownload.handled) return blockDownload.completion;
  if (downloadAbort) {
    if (options.requireIntent) return false;
    if (String(activeDownloadBookId) === String(book.id)) {
      downloadAbort.abort();
    } else {
      showToast('Another book is already downloading', 'error');
    }
    return false;
  }
  // An automatic pass that cannot read the descriptor keeps its title
  // pollable and retries on the bounded backoff instead of every poll.
  const deferAutomaticPass = error => {
    const entry = offlineEntryForBook(book.id);
    if (!options.requireIntent || !entry || !transientTransferError(error)) return;
    scheduleTransferRetry(entry);
    try { persistWorkingEntry(book.id, entry); } catch {}
  };
  let transfer;
  try {
    transfer = await fetchTransferManifest(book.id);
  } catch (error) {
    if (!options.requireIntent) showToast('Could not check this book’s audio. Try again.', 'error');
    deferAutomaticPass(error);
    return false;
  }
  if (options.requireIntent && !offlineEntryForBook(book.id)?.autoResume) return false;
  if (downloadAbort) return false;
  if (transfer.chapters.length !== chapters.length) {
    const changed = offlineEntryForBook(book.id);
    if (changed && options.requireIntent) {
      try { persistWorkingEntry(book.id, { ...changed, autoResume: false, state: 'incomplete' }); } catch {}
    }
    showToast('This book changed on the server. Open it and download again.', 'error');
    return false;
  }
  // The server cannot finish without being asked when its intent is ready
  // but a chapter package is missing ('repair-needed'): every pass asks once,
  // and passes are spaced by the transfer backoff. A user asking to finish a
  // partial download also restarts preparation that is no longer running; an
  // automatic pass respects that it stopped.
  const repairNeeded = !transfer.complete && transfer.state === 'repair-needed';
  const restartStopped = !transfer.complete && !options.requireIntent &&
    ['not-requested', 'paused'].includes(transfer.state);
  if (repairNeeded || restartStopped) {
    if (repairNeeded) {
      await apiSend('POST', `/api/offline/preparation/${encodeURIComponent(book.id)}`).catch(() => null);
    } else if (!await prepareBookForOffline(book, chapters, { showReadyToast: false, autoResume: true }).catch(() => false)) {
      const entry = offlineEntryForBook(book.id);
      if (!entry?.autoResume) return false;
    }
    try {
      transfer = await fetchTransferManifest(book.id);
    } catch (error) {
      deferAutomaticPass(error);
      return false;
    }
    if (downloadAbort) return false;
  }
  const existing = offlineEntryForBook(book.id);
  const hasWork = transfer.chapters.some((descriptor, index) =>
    descriptor.state === 'ready' && !storedChapterMatches(existing?.chapterEntries?.[index], descriptor)
  );
  if (!transfer.complete && !hasWork) {
    // Nothing new is prepared yet. Record that and let the poll come back.
    const waiting = createWorkingEntry(book, chapters, existing, options.voiceLabel || existing?.voiceLabel || currentVoiceLabel());
    carryTransferRetry(waiting, existing);
    // A package still awaiting repair is asked again only after the backoff.
    if (transfer.state === 'repair-needed') scheduleTransferRetry(waiting);
    else clearTransferRetry(waiting);
    const dropped = dropChangedChapters(waiting, transfer);
    const prepared = preparedChapterCount(transfer);
    Object.assign(waiting, {
      variantKey: transfer.packageVariantKey || waiting.variantKey,
      packageVariantKey: transfer.packageVariantKey || existing?.packageVariantKey || '',
      preparedChapters: prepared,
      transferCheckedPrepared: prepared,
      progressPercent: Math.min(99, Math.round((prepared / Math.max(1, chapters.length)) * 100)),
      progressPhase: 'Preparing audio',
      autoResume: options.requireIntent ? existing?.autoResume === true : true,
      state: waitingStateForTransfer(transfer)
    });
    if (['not-requested', 'paused'].includes(transfer.state)) {
      waiting.autoResume = false;
      waiting.state = 'incomplete';
    }
    try {
      if (waiting.state === 'incomplete' && !hasCachedChapter(waiting)) {
        const manifest = getOfflineManifest();
        delete manifest[book.id];
        saveOfflineManifest(manifest);
      } else {
        persistWorkingEntry(book.id, waiting);
      }
    } catch {
      showToast('Could not save offline download state', 'error');
      return false;
    }
    await deleteDroppedChapters(book.id, dropped);
    if (!options.requireIntent) {
      showToast(waiting.state === 'incomplete'
        ? 'Audio preparation stopped. Tap Download to start it again.'
        : 'Audio is still preparing. Chapters save as they are ready.');
    }
    schedulePreparationPoll();
    return false;
  }
  if (options.confirmForeground !== false) {
    const packageBytes = transfer.bytesTotal || transfer.bytesPrepared;
    const packageSize = packageBytes >= 1024 * 1024 * 1024
      ? `${(packageBytes / 1024 / 1024 / 1024).toFixed(1)} GB`
      : `${Math.max(1, Math.round(packageBytes / 1024 / 1024))} MB`;
    const sizeNote = transfer.complete ? '' : ' so far, with more as chapters are prepared';
    const dataSaverNote = navigator.connection?.saveData ? ' Data Saver is on.' : '';
    const confirmed = await confirmSheet({
      title: 'Keep Xandrio visible',
      message: `This download is about ${packageSize}${sizeNote} and may use Wi-Fi or mobile data.${dataSaverNote} Do not close Xandrio, switch apps, or lock the screen until it finishes. The system may stop the transfer.`,
      confirmLabel: 'Start download',
      danger: false
    });
    if (!confirmed) return false;
    if (downloadAbort) {
      showToast('Another book is already downloading', 'error');
      return false;
    }
  }
  // Downloads are background activity. Callers may explicitly request the
  // legacy blocking overlay, but the normal surface is the Activity pane.
  const showOverlay = options.showOverlay === true;
  const working = createWorkingEntry(
    book,
    chapters,
    existing,
    options.voiceLabel || currentVoiceLabel()
  );
  working.variantKey = transfer.packageVariantKey || working.variantKey;
  working.packageVariantKey = transfer.packageVariantKey || existing?.packageVariantKey || '';
  working.packageBytes = transfer.bytesTotal || transfer.bytesPrepared;
  working.packageBitrateKbps = Math.max(0, Number(existing?.packageBitrateKbps) || 0);
  working.preparedChapters = preparedChapterCount(transfer);
  carryTransferRetry(working, existing);
  const droppedAtStart = dropChangedChapters(working, transfer);
  const reportProgress = downloadProgressTracker(book, chapters, working, showOverlay);
  downloadAbort = new AbortController();
  activeDownloadBookId = book.id;
  let resolveDownloadCompletion;
  activeDownloadCompletion = new Promise(resolve => { resolveDownloadCompletion = resolve; });
  const signal = downloadAbort.signal;
  let completed = false;
  let releaseLock = null;
  try {
    releaseLock = await acquireOfflineDownloadLock().catch(() => () => {});
    if (!releaseLock) {
      // Another Xandrio page is saving audio. It owns the transfer; this page
      // picks up its verified chapters from the shared manifest.
      return false;
    }
    await holdDownloadWakeLock();
    await requestPersistentOfflineStorage();
    rollingAbort?.abort();
    rollingAbort = null;
    rollingRequestKey = '';
    reportProgress(-1, 0, 'Starting download');
    // Changed chapters leave the manifest before their bytes leave the cache,
    // so no reader can see a pointer to bytes that are about to change.
    persistWorkingEntry(book.id, working);
    renderOfflineState({ audit: false });
    if (showOverlay) {
      deps.showAudioLoading?.('Downloading book for offline', {
        detail: 'Checking storage...',
        percent: 0,
        status: 'generating'
      });
    }
    const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE));
    for (const index of droppedAtStart) {
      await cache.delete(offlineAudioRequest(book.id, index)).catch(() => {});
    }
    const estimate = await navigator.storage?.estimate?.();
    const available = estimate?.quota && estimate?.usage ? Math.max(0, estimate.quota - estimate.usage) : null;
    if (showOverlay && available != null) {
      deps.showAudioLoading?.('Downloading book for offline', {
        detail: `${Math.round(available / 1024 / 1024)} MB storage available`,
        percent: 0,
        status: 'generating'
      });
    }

    let descriptorRefreshes = 0;
    while (true) {
      throwIfDownloadAborted(signal);
      for (let index = 0; index < chapters.length; index++) {
        if (transfer.chapters[index].state !== 'empty' && !chapters[index]?.empty) continue;
        if (working.chapterEntries[index]) working.chapterEntries[index] = null;
        await cache.delete(offlineAudioRequest(book.id, index)).catch(() => {});
        reportProgress(index, 1, `Skipping empty section ${index + 1} of ${working.chapters}`);
      }
      // A recorded chapter must still be in the cache under the same
      // identity. Header metadata answers that without reading the body;
      // anything evicted or replaced is dropped and fetched again.
      let evicted = false;
      for (const descriptor of transfer.chapters) {
        const stored = working.chapterEntries[descriptor.index];
        if (!storedChapterMatches(stored, descriptor)) continue;
        const present = await cache.match(offlineAudioRequest(book.id, descriptor.index)).catch(() => null);
        const identity = present ? contentIdentityFromHeaders(present.headers) : null;
        if (identity && canReuseChapter(stored, identity, stored.variantKey)) continue;
        working.chapterEntries[descriptor.index] = null;
        evicted = true;
      }
      if (evicted) persistWorkingEntry(book.id, working);
      const candidates = transfer.chapters
        .filter(descriptor =>
          descriptor.state === 'ready' &&
          !chapters[descriptor.index]?.empty &&
          !storedChapterMatches(working.chapterEntries[descriptor.index], descriptor)
        )
        .map(descriptor => descriptor.index);
      for (const index of working.chapterEntries.keys()) {
        if (working.chapterEntries[index]) reportProgress(index, 1, 'Downloading');
      }
      let nextCandidate = 0;
      let firstError = null;
      const worker = async () => {
        while (!firstError && nextCandidate < candidates.length) {
          const chapterIndex = candidates[nextCandidate++];
          try {
            await processFullDownloadChapter({
              book,
              descriptor: transfer.chapters[chapterIndex],
              working,
              cache,
              signal,
              reportProgress
            });
          } catch (error) {
            firstError ||= error;
          }
        }
      };
      const workerCount = Math.min(FULL_DOWNLOAD_CONCURRENCY, candidates.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (firstError?.code === 'DESCRIPTOR_CHANGED' && descriptorRefreshes < DESCRIPTOR_REFRESH_LIMIT && !signal.aborted) {
        descriptorRefreshes += 1;
      } else if (firstError) {
        throw firstError;
      } else if (transfer.complete) {
        break;
      } else if (candidates.length === 0) {
        break;
      }
      // Preparation continues on the server. Pick up chapters that became
      // ready (or changed) while this batch transferred.
      transfer = await fetchTransferManifest(book.id);
      throwIfDownloadAborted(signal);
      if (transfer.chapters.length !== chapters.length) {
        throw Object.assign(
          new Error('This book changed on the server. Open it and download again.'),
          { code: 'BOOK_CHANGED' }
        );
      }
      working.preparedChapters = preparedChapterCount(transfer);
      working.packageBytes = transfer.bytesTotal || transfer.bytesPrepared || working.packageBytes;
      const dropped = dropChangedChapters(working, transfer);
      if (dropped.length > 0) {
        persistWorkingEntry(book.id, working);
        for (const index of dropped) {
          await cache.delete(offlineAudioRequest(book.id, index)).catch(() => {});
        }
      }
    }

    if (!transfer.complete) {
      // Every prepared chapter is stored and verified; the rest are still
      // being prepared. Keep the verified chapters playable and wait.
      const prepared = preparedChapterCount(transfer);
      Object.assign(working, {
        preparedChapters: prepared,
        transferCheckedPrepared: prepared,
        progressPercent: Math.min(99, Math.round((prepared / Math.max(1, chapters.length)) * 100)),
        progressPhase: 'Preparing audio',
        state: waitingStateForTransfer(transfer),
        autoResume: true
      });
      if (['not-requested', 'paused'].includes(transfer.state)) {
        working.state = 'incomplete';
        working.autoResume = false;
      }
      if (transfer.state === 'repair-needed') scheduleTransferRetry(working);
      else clearTransferRetry(working);
      persistWorkingEntry(book.id, working);
      return false;
    }

    clearTransferRetry(working);
    reportProgress(-1, 0, 'Verifying download');
    await cacheOfflineCover(book, signal);
    if (signal.aborted) throw new Error('Download cancelled');
    if (!await verifyOfflineEntry(cache, working)) {
      throw Object.assign(new Error('Offline audio verification failed'), { code: 'VERIFICATION_FAILED' });
    }
    if (signal.aborted) throw new Error('Download cancelled');

    // The bytes are right. Now prove the route that will play them is right.
    // A failure here is not a broken download — the audio is stored and
    // verified — so nothing is discarded; the entry waits in `verifying` and
    // re-probes on the next launch or worker change.
    const probeChapter = working.chapterEntries.findIndex(Boolean);
    const routeCheck = probeChapter < 0
      ? { ok: false, swVersion: '', reason: 'no-chapters' }
      : await probeOfflinePlaybackRoute(
        book.id,
        probeChapter,
        working.chapterEntries[probeChapter]?.size
      );
    working.autoResume = false;
    working.progressPercent = 100;
    working.preparedChapters = chapters.length;
    working.downloadedAt = new Date().toISOString();
    working.probedSwVersion = routeCheck.swVersion || '';
    working.probedContractVersion = routeCheck.contractVersion || 0;
    working.state = routeCheck.ok ? 'ready' : 'verifying';
    working.progressPhase = routeCheck.ok ? 'Downloaded' : 'Verifying';
    persistWorkingEntry(book.id, working);
    setDownloadActivity(book, 100, working.progressPhase);
    completed = true;
    showToast(routeCheck.ok
      ? (offlineState(existing) === 'ready' ? 'Offline download repaired' : 'Book downloaded for offline')
      : 'Download saved — reopen Xandrio to finish verifying it');
  } catch (err) {
    const cancelled = err?.name === 'AbortError' || err?.message === 'Download cancelled';
    const transient = !cancelled && transientTransferError(err);
    if (transient) {
      // A network blip or a 5xx is not a failed download. Keep the verified
      // chapters, stay pollable while preparation runs, and retry on the
      // bounded backoff.
      scheduleTransferRetry(working);
      working.state = transfer?.complete ? 'incomplete' : waitingStateForTransfer(transfer);
      working.autoResume = true;
      working.progressPhase = 'Retrying soon';
    } else {
      working.state = 'incomplete';
      working.autoResume = !cancelled;
      working.progressPhase = cancelled ? 'Cancelled' : 'Interrupted';
    }
    try {
      // A title removed while its chapter was in flight stays removed.
      if (offlineEntryForBook(book.id)) persistWorkingEntry(book.id, working);
    } catch {}
    if (!(transient && options.requireIntent)) showToast(err.message || 'Offline download failed', 'error');
  } finally {
    releaseLock?.();
    resolveDownloadCompletion();
    downloadAbort = null;
    activeDownloadBookId = '';
    activeDownloadCompletion = null;
    if (offlineDeviceActivities.size === 0) await releaseDownloadWakeLock();
    clearDownloadActivity();
    if (showOverlay) deps.hideAudioLoading?.();
    renderOfflineState();
    schedulePreparationPoll();
  }
  return completed;
}

async function deleteDroppedChapters(bookId, indexes) {
  if (!indexes.length || !('caches' in globalThis)) return;
  const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE)).catch(() => null);
  for (const index of indexes) {
    await cache?.delete(offlineAudioRequest(bookId, index)).catch(() => {});
  }
}

async function processFullDownloadChapter({
  book,
  descriptor,
  working,
  cache,
  signal,
  reportProgress
}) {
  throwIfDownloadAborted(signal);
  const chapterIndex = descriptor.index;
  reportProgress(chapterIndex, 0.01, 'Downloading');
  const identity = await storeVerifiedChapter({
    bookId: book.id,
    descriptor,
    cache,
    signal,
    onProgress: (fraction, transfer) => reportProgress(chapterIndex, fraction, 'Downloading', transfer)
  });
  throwIfDownloadAborted(signal);
  // The manifest records a chapter only after its stored body has verified.
  working.chapterEntries[chapterIndex] = identity;
  // Progress resets the retry backoff.
  clearTransferRetry(working);
  working.bytes = working.chapterEntries.reduce(
    (total, chapter) => total + (Number(chapter?.size) || 0),
    0
  );
  reportProgress(chapterIndex, 1, 'Downloading');
  if (!offlineEntryForBook(book.id)) throw downloadAbortError();
  persistWorkingEntry(book.id, working);
}

export async function ensureRollingOfflineWindow(book, chapters, chapterIndex, options = {}) {
  if (!options.enabled || !book?.id || !Array.isArray(chapters) || chapters.length === 0) return;
  if (!offlineDownloadsSupported() || !navigator.onLine || navigator.connection?.saveData) return;
  const existing = offlineEntryForBook(book.id);
  if (downloadAbort || (existing && existing.mode !== 'rolling')) return;

  const device = await loadOfflineDevice();
  if (device?.writerEnabled?.()) {
    await certifyOfflineWorkerController({ timeoutMs: 1500 }).catch(() => offlineWorkerControllerState());
    if (device.writerCapable?.()) {
      const cachedChapters = (existing?.chapterEntries || [])
        .map((entry, index) => entry ? index : null)
        .filter(index => index !== null);
      const plan = planRollingOfflineWindow({
        currentChapter: chapterIndex,
        chapterCount: chapters.length,
        cachedChapters
      });
      const entry = {
        ...(existing || {}),
        bookId: book.id,
        title: book.title,
        chapters: chapters.length,
        chapterEntries: Array.from(
          { length: chapters.length },
          (_, index) => existing?.chapterEntries?.[index] || null
        ),
        titleData: offlineTitleData(book, chapters),
        manifestVersion: OFFLINE_MANIFEST_VERSION,
        mode: 'rolling',
        state: 'partial',
        autoResume: true,
        storageBackend: 'idb',
        windowIndexes: plan.retain.slice(0, 4),
        currentChapter: chapterIndex
      };
      await device.startWindow(book, chapters, entry, plan.retain, chapterIndex);
      return;
    }
  }

  const requestKey = `${book.id}:${chapterIndex}:${chapters.length}`;
  if (requestKey === rollingRequestKey) return;
  rollingRequestKey = requestKey;
  rollingAbort?.abort();
  rollingAbort = new AbortController();
  let resolveRollingCompletion;
  const rollingCompletion = new Promise(resolve => { resolveRollingCompletion = resolve; });
  rollingCompletions.set(requestKey, rollingCompletion);
  const signal = rollingAbort.signal;
  const oldEntries = Array.isArray(existing?.chapterEntries) ? existing.chapterEntries : [];
  const working = {
    bookId: book.id,
    title: book.title,
    voiceLabel: currentVoiceLabel(),
    variantKey: existing?.variantKey || '',
    chapters: chapters.length,
    chapterEntries: Array.from({ length: chapters.length }, (_, index) => oldEntries[index] || null),
    titleData: offlineTitleData(book, chapters),
    bytes: Number(existing?.bytes) || 0,
    downloadedAt: existing?.downloadedAt || null,
    manifestVersion: OFFLINE_MANIFEST_VERSION,
    mode: 'rolling',
    state: 'partial'
  };

  try {
    const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE));
    const currentStatus = await getChapterAudioStatus(book.id, chapterIndex, signal, 'active');
    const currentVariantKey = String(currentStatus.variantKey || '');
    const variantChanged = Boolean(working.variantKey && currentVariantKey && working.variantKey !== currentVariantKey);
    const staleChapters = variantChanged
      ? working.chapterEntries.map((entry, index) => entry ? index : null).filter(index => index !== null)
      : [];
    if (variantChanged) {
      working.chapterEntries.fill(null);
      working.variantKey = currentVariantKey;
    }
    const cachedChapters = working.chapterEntries
      .map((entry, index) => entry ? index : null)
      .filter(index => index !== null);
    const plan = planRollingOfflineWindow({
      currentChapter: chapterIndex,
      chapterCount: chapters.length,
      cachedChapters
    });
    for (const index of plan.prepare) {
      if (signal.aborted) return;
      if (chapters[index]?.empty) continue;
      const status = await prepareChapter(book.id, index, signal);
      const variantKey = String(status.variantKey || 'default');
      const url = status.url || `/api/audio/${encodeURIComponent(book.id)}/${index}`;
      working.chapterEntries[index] = {
        ...await downloadAndVerifyChapter(
          cache,
          offlineAudioRequest(book.id, index),
          `${API_BASE}${url}`,
          signal,
          index
        ),
        variantKey
      };
      if (!working.variantKey) working.variantKey = variantKey;
      working.bytes = working.chapterEntries.reduce((sum, entry) => sum + (Number(entry?.size) || 0), 0);
      persistWorkingEntry(book.id, working);
    }
    const retained = new Set(plan.retain);
    const staleOutsideWindow = staleChapters.filter(index => !retained.has(index));
    for (const index of [...new Set([...staleOutsideWindow, ...plan.evict])]) {
      if (signal.aborted) return;
      await cache.delete(offlineAudioRequest(book.id, index));
      working.chapterEntries[index] = null;
    }
    working.bytes = working.chapterEntries.reduce((sum, entry) => sum + (Number(entry?.size) || 0), 0);
    working.downloadedAt = new Date().toISOString();
    persistWorkingEntry(book.id, working);
    renderOfflineManager();
  } catch (error) {
    if (error.name !== 'AbortError' && error.message !== 'Download cancelled') {
      console.warn('Automatic offline cache failed:', error);
      throw error;
    }
  } finally {
    resolveRollingCompletion();
    rollingCompletions.delete(requestKey);
    if (rollingRequestKey === requestKey) {
      rollingAbort = null;
      rollingRequestKey = '';
    }
  }
}

function downloadAbortError() {
  const error = new Error('Download cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfDownloadAborted(signal) {
  if (signal?.aborted) throw downloadAbortError();
}

function isTransientDownloadError(error) {
  const status = Number(error?.status);
  return !Number.isFinite(status) || status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitForDownloadRetry(delayMs, signal) {
  throwIfDownloadAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, delayMs);
    const onAbort = () => done(downloadAbortError());
    function done(error) {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

async function retryDownloadOperation(operation, signal) {
  for (let attempt = 0; ; attempt++) {
    throwIfDownloadAborted(signal);
    try {
      return await operation(attempt);
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw downloadAbortError();
      if (!isTransientDownloadError(error) || attempt >= DOWNLOAD_RETRY_DELAYS_MS.length) throw error;
      await waitForDownloadRetry(DOWNLOAD_RETRY_DELAYS_MS[attempt], signal);
    }
  }
}

async function fetchDownloadResponse(url, signal, errorMessage) {
  return retryDownloadOperation(async () => {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      const error = new Error(errorMessage);
      error.status = response.status;
      throw error;
    }
    return response;
  }, signal);
}

async function prepareChapter(bookId, chapterIndex, signal, onProgress = null, purpose = 'background') {
  const path = `/api/chunks/${encodeURIComponent(bookId)}/${chapterIndex}/prepare-chapter-audio`;
  const requestPreparation = () => apiSend(
    'POST',
    path,
    purpose === 'offline-download' ? { purpose } : null,
    { signal }
  );
  await retryDownloadOperation(requestPreparation, signal);

  const deadline = Date.now() + DOWNLOAD_PREPARE_TIMEOUT_MS;
  let recoveryAttempts = 0;
  const poll = preparePollBackoff();
  while (Date.now() < deadline) {
    throwIfDownloadAborted(signal);
    const status = await getChapterAudioStatus(bookId, chapterIndex, signal, 'active');
    const total = Math.max(0, Number(status.totalChunks) || 0);
    const ready = Math.max(0, Number(status.readyChunks) || 0);
    const progress = { readyChunks: ready, totalChunks: total };
    if (total > 0) onProgress?.(Math.min(1, ready / total), progress);
    if (status.ready) {
      onProgress?.(1, progress);
      return status;
    }
    if (Number(status.errorChunks) > 0 && recoveryAttempts < 2) {
      recoveryAttempts += 1;
      await retryDownloadOperation(requestPreparation, signal);
      continue;
    }
    if (Number(status.errorChunks) > 0) {
      throw new Error(`Audio generation failed for chapter ${chapterIndex + 1}`);
    }
    await waitForDownloadRetry(poll.next(ready), signal);
  }
  throw new Error(`Timed out preparing chapter ${chapterIndex + 1}`);
}

/**
 * Poll interval that stays fast while chunks keep landing and stretches out
 * while they do not. A chapter that is generating steadily is worth watching
 * closely; one that has not moved in a minute is not.
 */
function preparePollBackoff() {
  let delayMs = PREPARE_POLL_MIN_MS;
  let lastReady = -1;
  return {
    next(readyChunks) {
      if (readyChunks !== lastReady) {
        lastReady = readyChunks;
        delayMs = PREPARE_POLL_MIN_MS;
      } else {
        delayMs = Math.min(PREPARE_POLL_MAX_MS, Math.round(delayMs * PREPARE_POLL_BACKOFF));
      }
      return delayMs;
    }
  };
}

async function waitForPreparedChapter(bookId, chapterIndex, signal, onProgress = null) {
  const deadline = Date.now() + DOWNLOAD_PREPARE_TIMEOUT_MS;
  const poll = preparePollBackoff();
  while (Date.now() < deadline) {
    throwIfDownloadAborted(signal);
    const status = await getChapterAudioStatus(bookId, chapterIndex, signal, 'active');
    const total = Math.max(0, Number(status.totalChunks) || 0);
    const ready = Math.max(0, Number(status.readyChunks) || 0);
    const progress = { readyChunks: ready, totalChunks: total };
    if (total > 0) onProgress?.(Math.min(1, ready / total), progress);
    if (status.ready) {
      onProgress?.(1, progress);
      return status;
    }
    if (Number(status.errorChunks) > 0) {
      throw new Error(`Audio generation failed for chapter ${chapterIndex + 1}`);
    }
    await waitForDownloadRetry(poll.next(ready), signal);
  }
  throw new Error(`Timed out preparing chapter ${chapterIndex + 1}`);
}

async function getChapterAudioStatus(bookId, chapterIndex, signal, tier = null) {
  const tierQuery = tier ? `?tier=${encodeURIComponent(tier)}` : '';
  const url = `${API_BASE}/api/chunks/${encodeURIComponent(bookId)}/${chapterIndex}/chapter-audio-status${tierQuery}`;
  return retryDownloadOperation(async () => {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      const error = new Error(`Could not check audio for chapter ${chapterIndex + 1}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }, signal);
}

function createWorkingEntry(book, chapters, existing, voiceLabel) {
  const chapterCount = chapters.length;
  const canReuseExisting = offlineState(existing) !== 'stale';
  const oldEntries = canReuseExisting && Array.isArray(existing?.chapterEntries)
    ? existing.chapterEntries
    : [];
  return {
    bookId: book.id,
    title: book.title,
    voiceLabel,
    variantKey: canReuseExisting ? (existing?.variantKey || '') : '',
    chapters: chapterCount,
    chapterEntries: Array.from({ length: chapterCount }, (_, index) => oldEntries[index] || null),
    titleData: offlineTitleData(book, chapters),
    bytes: canReuseExisting ? (Number(existing?.bytes) || 0) : 0,
    downloadedAt: existing?.downloadedAt || null,
    downloadStartedAt: new Date().toISOString(),
    progressPercent: 0,
    progressPhase: 'Starting',
    autoResume: true,
    manifestVersion: OFFLINE_MANIFEST_VERSION,
    mode: 'full',
    state: 'repairing'
  };
}

function scopedOfflineRequest(route, scopeId = offlineScopeId()) {
  const url = new URL(`${API_BASE}${route}`);
  url.searchParams.set(OFFLINE_SCOPE_PARAM, scopeId);
  return new Request(url);
}

function offlineAudioRequest(bookId, chapterIndex, scopeId = offlineScopeId()) {
  return scopedOfflineRequest(
    `/api/audio/${encodeURIComponent(bookId)}/${chapterIndex}`,
    scopeId
  );
}

function offlineTitleRequest(bookId, scopeId = offlineScopeId()) {
  return scopedOfflineRequest(`/api/cover/${encodeURIComponent(bookId)}`, scopeId);
}

function scopedCopyOfLegacyRequest(request, scopeId) {
  const url = new URL(request.url);
  url.searchParams.set(OFFLINE_SCOPE_PARAM, scopeId);
  return new Request(url, {
    method: request.method,
    headers: request.headers
  });
}

async function matchLocalChapterCache(cache, request, scopeId) {
  const cached = await cache.match(request);
  if (cached) return cached;
  if (localStorage.getItem(OFFLINE_LEGACY_CACHE_OWNER_KEY) !== scopeId) {
    // Bulk migration may have finished since the first lookup.
    return cache.match(request);
  }

  // First Play must not wait for unrelated books or covers. Copy only the
  // requested chapter; the background pass retains ownership of bulk cleanup.
  // Keep the original until the scoped copy is confirmed, including on failure.
  const url = new URL(request.url);
  url.searchParams.delete(OFFLINE_SCOPE_PARAM);
  const legacyRequest = new Request(url);
  const legacy = await caches.open(OFFLINE_AUDIO_CACHE);
  const response = await legacy.match(legacyRequest);
  if (response && offlineScopeId() === scopeId &&
      localStorage.getItem(OFFLINE_LEGACY_CACHE_OWNER_KEY) === scopeId) {
    await cache.put(request, response);
    if (await cache.match(request)) await legacy.delete(legacyRequest);
  }
  // The background migration can have moved this chapter while we looked for
  // its legacy response. Recheck the destination before reporting a cache miss.
  return cache.match(request);
}

async function migrateLegacyCache(baseName, scopeId, manifest) {
  const legacy = await caches.open(baseName);
  if (typeof legacy.keys !== 'function') return;
  const target = await caches.open(offlineCacheName(baseName, scopeId));
  for (const request of await legacy.keys()) {
    const url = new URL(request.url);
    if (url.searchParams.has(OFFLINE_SCOPE_PARAM)) continue;
    const match = url.pathname.match(/^\/api\/(?:audio|cover)\/([^/]+)/);
    const bookId = match ? decodeURIComponent(match[1]) : '';
    if (!bookId || !manifest[bookId]) continue;
    const response = await legacy.match(request);
    if (!response) continue;
    const scopedRequest = scopedCopyOfLegacyRequest(request, scopeId);
    await target.put(scopedRequest, response);
    if (await target.match(scopedRequest)) await legacy.delete(request);
  }
}

function migrateLegacyOfflineCaches() {
  if (!('caches' in window)) return Promise.resolve(false);
  const scope = offlineScopeId();
  if (localStorage.getItem(OFFLINE_LEGACY_CACHE_OWNER_KEY) !== scope) {
    return Promise.resolve(false);
  }
  if (legacyCacheMigrations.has(scope)) return legacyCacheMigrations.get(scope);
  const migration = (async () => {
    const manifest = getOfflineManifest();
    await migrateLegacyCache(OFFLINE_AUDIO_CACHE, scope, manifest);
    await migrateLegacyCache(OFFLINE_TITLE_CACHE, scope, manifest);
    if (offlineScopeId() === scope) {
      localStorage.removeItem(OFFLINE_LEGACY_CACHE_OWNER_KEY);
    }
    return true;
  })().finally(() => legacyCacheMigrations.delete(scope));
  legacyCacheMigrations.set(scope, migration);
  return migration;
}

export function offlinePlaybackUrl(bookId, chapterIndex) {
  const entry = offlineEntryForBook(bookId);
  const localUrl = entry?.storageBackend === 'idb'
    ? entry.chapterEntries?.[chapterIndex]?.localUrl
    : '';
  if (localUrl) return localUrl;
  return offlineAudioRequest(bookId, chapterIndex).url;
}

function persistWorkingEntry(bookId, entry) {
  const manifest = getOfflineManifest();
  manifest[bookId] = entry;
  saveOfflineManifest(manifest);
}

function setOfflineEntryState(bookId, state) {
  const manifest = getOfflineManifest();
  if (!manifest[bookId] || manifest[bookId].storageBackend === 'idb' || manifest[bookId].state === state) return;
  manifest[bookId] = { ...manifest[bookId], state };
  saveOfflineManifest(manifest);
}

function offlineState(entry) {
  if (entry?.manifestVersion !== OFFLINE_MANIFEST_VERSION || !Array.isArray(entry?.chapterEntries)) return 'incomplete';
  if (entry.mode === 'rolling') return 'partial';
  if (
    entry.state === 'preparing' ||
    entry.state === 'prepared' ||
    entry.state === 'preparation-error' ||
    entry.state === 'preparation-waiting' ||
    entry.state === 'preparation-capacity' ||
    entry.state === 'preparation-paused'
  ) return entry.state;
  if (!validTitleData(entry)) return 'incomplete';
  if (
    entry.state === 'repairing' ||
    entry.state === 'stale' ||
    entry.state === 'incomplete' ||
    // Stored and byte-verified, but the scoped worker route has not yet been
    // proven to serve it. Playable-but-unconfirmed, never "Downloaded".
    entry.state === 'verifying'
  ) return entry.state;
  return entry.state === 'ready' ? 'ready' : 'incomplete';
}

function offlineStateLabel(entry) {
  if (entry?.mode === 'rolling') {
    const count = entry.chapterEntries?.filter(Boolean).length || 0;
    return `Auto-cached · ${count} chapter${count === 1 ? '' : 's'}`;
  }
  switch (offlineState(entry)) {
    case 'preparing': {
      const cached = entry.chapterEntries?.filter(Boolean).length || 0;
      const total = Number(entry.chapters) || 0;
      return cached > 0
        ? `${cached}/${total} chapters on this device · Preparing the rest`
        : `Preparing audio · ${Number(entry.preparedChapters) || 0}/${total}`;
    }
    case 'prepared': return 'Ready to download to this device';
    case 'preparation-error': return 'Audio preparation needs attention';
    case 'preparation-waiting': return 'Waiting for audio';
    case 'preparation-capacity': return 'Offline queue is full';
    case 'preparation-paused': return 'Offline setup paused · Resume';
    case 'ready': return `Offline ready · ${entry.voiceLabel || 'Voice'}`;
    case 'repairing': {
      const cached = entry.chapterEntries?.filter(Boolean).length || 0;
      const total = Number(entry.chapters) || 0;
      return `Downloading · ${cached}/${total} chapters`;
    }
    case 'stale': return 'Offline audio · current voice changed';
    case 'verifying': return 'Verifying download · reopen Xandrio to finish';
    default: {
      const cached = entry?.chapterEntries?.filter(Boolean).length || 0;
      const total = Number(entry?.chapters) || 0;
      return cached > 0
        ? `Partial download · ${cached}/${total} chapters`
        : 'Offline audio · repair needed';
    }
  }
}

function isLegacyEntry(entry) {
  return Boolean(entry) && (entry.manifestVersion !== OFFLINE_MANIFEST_VERSION || !Array.isArray(entry.chapterEntries));
}

function canReuseChapter(expected, actual, variantKey) {
  return Boolean(
    expected && expected.variantKey === variantKey &&
    expected.size === actual.size && expected.contentHash === actual.contentHash &&
    (!expected.etag || expected.etag === actual.etag)
  );
}

async function hashBytes(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Offline cache verification requires Web Crypto support');
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return `sha256-${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function contentIdentity(response, { verifyBody = false } = {}) {
  const storedIdentity = contentIdentityFromHeaders(response.headers);
  if (storedIdentity && !verifyBody) return storedIdentity;
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  return contentIdentityForBytes(bytes, response.headers.get('ETag') || '');
}

function contentIdentityFromHeaders(headers) {
  const size = Number(headers.get('Content-Length'));
  const contentHash = headers.get(OFFLINE_CONTENT_HASH_HEADER) || '';
  if (!Number.isInteger(size) || size <= 0 || !/^sha256-[a-f0-9]{64}$/.test(contentHash)) {
    return null;
  }
  return {
    size,
    contentHash,
    etag: headers.get('ETag') || ''
  };
}

async function backfillContentIdentity(cache, request, response, identity) {
  const storedSize = Number(response.headers.get('Content-Length'));
  const storedHash = response.headers.get(OFFLINE_CONTENT_HASH_HEADER) || '';
  if (
    Number.isInteger(storedSize) &&
    storedSize > 0 &&
    /^sha256-[a-f0-9]{64}$/.test(storedHash)
  ) return;
  const headers = new Headers(response.headers);
  headers.set('Content-Length', String(identity.size));
  headers.set(OFFLINE_CONTENT_HASH_HEADER, identity.contentHash);
  await cache.put(request, new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  }));
}

async function contentIdentityForBytes(bytes, etag = '') {
  return {
    size: bytes.byteLength,
    contentHash: await hashBytes(bytes),
    etag
  };
}

async function responseBytesWithProgress(response, signal, onProgress) {
  const total = Math.max(0, Number(response.headers.get('Content-Length')) || 0);
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.(0.75, { received: bytes.byteLength, total: bytes.byteLength });
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    throwIfDownloadAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) {
      onProgress?.(Math.min(0.85, (received / total) * 0.85), { received, total });
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.(0.85, { received, total: total || received });
  return bytes;
}

function responseStreamWithProgress(response, signal, onProgress) {
  if (!response.body?.getReader) return response;
  const total = Math.max(0, Number(response.headers.get('Content-Length')) || 0);
  const reader = response.body.getReader();
  let received = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        throwIfDownloadAborted(signal);
        const { done, value } = await reader.read();
        if (done) {
          if (total > 0 && received !== total) {
            throw new Error('Audio download ended before the expected file size');
          }
          onProgress?.(0.9, { received, total: total || received });
          controller.close();
          return;
        }
        received += value.byteLength;
        if (total > 0) {
          onProgress?.(Math.min(0.9, (received / total) * 0.9), { received, total });
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

async function downloadAndVerifyChapter(cache, cacheRequest, url, signal, chapterIndex, onProgress = null) {
  return retryDownloadOperation(async () => {
    const response = await fetch(url, {
      signal,
      headers: { 'X-Xandrio-Offline-Download': '1' }
    });
    if (!response.ok) {
      const error = new Error(`Audio download failed for chapter ${chapterIndex + 1}`);
      error.status = response.status;
      throw error;
    }
    const serverIdentity = contentIdentityFromHeaders(response.headers);
    if (serverIdentity) {
      await cache.put(cacheRequest, responseStreamWithProgress(response, signal, onProgress));
      const saved = await cache.match(cacheRequest);
      const savedIdentity = saved
        ? await contentIdentity(saved, { verifyBody: true })
        : null;
      if (
        !savedIdentity ||
        savedIdentity.size !== serverIdentity.size ||
        savedIdentity.contentHash !== serverIdentity.contentHash
      ) {
        throw new Error(`Offline cache verification failed for chapter ${chapterIndex + 1}`);
      }
      onProgress?.(1, { received: serverIdentity.size, total: serverIdentity.size });
      return {
        ...serverIdentity,
        bodyVerificationVersion: OFFLINE_BODY_VERIFICATION_VERSION
      };
    }

    const headers = new Headers(response.headers);
    const bytes = await responseBytesWithProgress(response, signal, onProgress);
    const identity = await contentIdentityForBytes(bytes, headers.get('ETag') || '');
    if (identity.size <= 0) throw new Error(`Downloaded audio was empty for chapter ${chapterIndex + 1}`);
    onProgress?.(0.9, { received: identity.size, total: identity.size });
    headers.set('Content-Length', String(identity.size));
    headers.set(OFFLINE_CONTENT_HASH_HEADER, identity.contentHash);
    await cache.put(cacheRequest, new Response(bytes, { status: response.status, headers }));
    const saved = await cache.match(cacheRequest);
    const savedIdentity = saved
      ? await contentIdentity(saved, { verifyBody: true })
      : null;
    if (
      !savedIdentity ||
      savedIdentity.size !== identity.size ||
      savedIdentity.contentHash !== identity.contentHash
    ) {
      throw new Error(`Offline cache verification failed for chapter ${chapterIndex + 1}`);
    }
    onProgress?.(1, { received: identity.size, total: identity.size });
    return {
      ...identity,
      bodyVerificationVersion: OFFLINE_BODY_VERIFICATION_VERSION
    };
  }, signal);
}

async function cacheOfflineCover(book, signal) {
  if (!book?.hasCover) return true;
  const request = offlineTitleRequest(book.id);
  const response = await fetchDownloadResponse(request, signal, 'Could not save this title’s cover for offline use');
  if (!String(response.headers.get('Content-Type') || '').toLowerCase().startsWith('image/')) {
    throw new Error('Could not save this title’s cover for offline use');
  }
  const cache = await caches.open(offlineCacheName(OFFLINE_TITLE_CACHE));
  await cache.put(request, response);
  if (!await cache.match(request)) throw new Error('Offline cover verification failed');
  return true;
}

export async function verifyOfflineEntry(cache, entry, scopeId = offlineScopeId()) {
  if (offlineState(entry) === 'incomplete' || !Array.isArray(entry?.chapterEntries)) return false;
  if (entry.mode === 'full' && !validTitleData(entry)) return false;
  if (entry.chapterEntries.length !== Number(entry.chapters)) return false;
  for (let i = 0; i < entry.chapterEntries.length; i++) {
    const expected = entry.chapterEntries[i];
    if (entry.titleData?.chapters?.[i]?.empty && !expected) continue;
    if (!expected?.variantKey || !expected.contentHash || !Number.isFinite(expected.size) || expected.size <= 0) return false;
    const request = offlineAudioRequest(entry.bookId, i, scopeId);
    const response = await cache.match(request);
    if (!response) return false;
    const identity = await contentIdentity(response, {
      verifyBody: expected.bodyVerificationVersion !== OFFLINE_BODY_VERIFICATION_VERSION
    });
    if (!canReuseChapter(expected, identity, expected.variantKey)) return false;
    expected.bodyVerificationVersion = OFFLINE_BODY_VERIFICATION_VERSION;
    await backfillContentIdentity(cache, request, response, identity).catch(() => {});
  }
  if (entry.titleData?.book?.hasCover) {
    const titleCache = await caches.open(offlineCacheName(OFFLINE_TITLE_CACHE, scopeId));
    if (!await titleCache.match(offlineTitleRequest(entry.bookId, scopeId))) return false;
  }
  return true;
}

async function verifyOfflineEntryPresence(cache, entry, scopeId = offlineScopeId()) {
  if (offlineState(entry) !== 'ready' || !Array.isArray(entry?.chapterEntries)) return false;
  if (entry.mode !== 'full' || !validTitleData(entry)) return false;
  if (entry.chapterEntries.length !== Number(entry.chapters)) return false;
  for (let i = 0; i < entry.chapterEntries.length; i++) {
    if (entry.titleData?.chapters?.[i]?.empty && !entry.chapterEntries[i]) continue;
    if (!entry.chapterEntries[i] || !await cache.match(offlineAudioRequest(entry.bookId, i, scopeId))) {
      return false;
    }
  }
  if (entry.titleData?.book?.hasCover) {
    const titleCache = await caches.open(offlineCacheName(OFFLINE_TITLE_CACHE, scopeId));
    if (!await titleCache.match(offlineTitleRequest(entry.bookId, scopeId))) return false;
  }
  return true;
}

async function pruneUnavailableChapterEntries(
  cache,
  bookId,
  scopeId,
  { presenceOnly = false } = {}
) {
  // A running transfer owns its title's cache entries and checks them itself.
  // An audit that read the manifest before the transfer replaced a chapter
  // would otherwise delete the freshly verified bytes.
  const transferring = () => String(activeDownloadBookId) === String(bookId);
  if (transferring()) return false;
  const manifest = getOfflineManifest(scopeId);
  const entry = manifest[bookId];
  if (!entry || !Array.isArray(entry.chapterEntries)) return false;
  let changed = false;
  for (let index = 0; index < entry.chapterEntries.length; index++) {
    const expected = entry.chapterEntries[index];
    if (!expected) continue;
    const request = offlineAudioRequest(bookId, index, scopeId);
    const response = await cache.match(request);
    const identity = response && !presenceOnly
      ? await contentIdentity(response, {
          verifyBody: expected.bodyVerificationVersion !== OFFLINE_BODY_VERIFICATION_VERSION
        })
      : null;
    if (transferring()) return false;
    if (response && (presenceOnly || canReuseChapter(expected, identity, expected.variantKey))) {
      if (!presenceOnly && expected.bodyVerificationVersion !== OFFLINE_BODY_VERIFICATION_VERSION) {
        expected.bodyVerificationVersion = OFFLINE_BODY_VERIFICATION_VERSION;
        await backfillContentIdentity(cache, request, response, identity).catch(() => {});
        changed = true;
      }
      continue;
    }
    await cache.delete(request).catch(() => {});
    entry.chapterEntries[index] = null;
    changed = true;
  }
  if (!changed) return false;
  entry.bytes = entry.chapterEntries.reduce(
    (sum, chapter) => sum + (Number(chapter?.size) || 0),
    0
  );
  if (entry.mode === 'full' && entry.state === 'ready') entry.state = 'incomplete';
  saveOfflineManifest(manifest, scopeId);
  return true;
}

function scheduleOfflineManifestAudit() {
  if (manifestAudit) return manifestAudit;
  manifestAudit = auditOfflineManifest().catch(() => {}).finally(() => { manifestAudit = null; });
  return manifestAudit;
}

// Cache storage can evict entries independently of localStorage. Audit ready
// manifests on render, but never download from the audit path.
export async function auditOfflineManifest({ presenceOnly = false } = {}) {
  if (!('caches' in window)) return false;
  const scope = offlineScopeId();
  const entries = Object.values(getOfflineManifest(scope))
    .filter(entry =>
      entry?.storageBackend !== 'idb' && (entry?.mode === 'rolling' ||
      (isHydratableOfflineEntry(entry) && hasCachedChapter(entry))
    ));
  if (entries.length === 0) return false;
  const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE, scope));
  let changed = false;
  for (const entry of entries) {
    if (entry.mode === 'rolling' || offlineState(entry) !== 'ready') {
      changed = await pruneUnavailableChapterEntries(
        cache,
        entry.bookId,
        scope,
        { presenceOnly }
      ) || changed;
      continue;
    }
    const needsBodyVerificationUpgrade = entry.chapterEntries.some(
      chapter => chapter?.bodyVerificationVersion !== OFFLINE_BODY_VERIFICATION_VERSION
    );
    const valid = presenceOnly
      ? await verifyOfflineEntryPresence(cache, entry, scope)
      : await verifyOfflineEntry(cache, entry, scope);
    if (valid) {
      if (!presenceOnly && needsBodyVerificationUpgrade) {
        const latestManifest = getOfflineManifest(scope);
        const latest = latestManifest[entry.bookId];
        if (latest?.state === 'ready' && latest.downloadedAt === entry.downloadedAt) {
          latestManifest[entry.bookId] = {
            ...latest,
            chapterEntries: latest.chapterEntries.map((chapter, index) => (
              chapter && entry.chapterEntries[index]?.bodyVerificationVersion === OFFLINE_BODY_VERIFICATION_VERSION
                ? {
                    ...chapter,
                    bodyVerificationVersion: OFFLINE_BODY_VERIFICATION_VERSION
                  }
                : chapter
            ))
          };
          saveOfflineManifest(latestManifest, scope);
          changed = true;
        }
      }
      continue;
    }
    const latestManifest = getOfflineManifest(scope);
    const latest = latestManifest[entry.bookId];
    // Do not overwrite a repair that began after this audit captured the
    // manifest. That repair owns the state transition now.
    if (latest?.state === 'ready' && latest.downloadedAt === entry.downloadedAt) {
      latestManifest[entry.bookId] = { ...latest, state: 'incomplete' };
      saveOfflineManifest(latestManifest, scope);
      changed = true;
      changed = await pruneUnavailableChapterEntries(
        cache,
        entry.bookId,
        scope,
        { presenceOnly }
      ) || changed;
    }
  }
  if (changed) {
    if (offlineScopeId() === scope) renderOfflineManager();
  }
  return changed;
}

function renderOfflineManager() {
  const list = document.getElementById('offline-books-list');
  if (!list) return;
  const entries = Object.values(getOfflineManifest());
  if (entries.length === 0) {
    list.innerHTML = '<p class="settings-hint">No books downloaded on this device.</p>';
    return;
  }
  list.innerHTML = entries.map(entry => `
    <div class="offline-book-row" data-offline-book-id="${escapeHTML(entry.bookId)}">
      <div class="offline-book-copy">
        <strong>${escapeHTML(entry.title || 'Untitled')}</strong>
        <span>${escapeHTML(offlineStateLabel(entry))} · ${entry.bytes ? `${Math.round(entry.bytes / 1024 / 1024)} MB` : 'Size unavailable'} · ${entry.downloadedAt ? relativeTime(entry.downloadedAt) : ''}</span>
      </div>
      <button type="button" class="btn-ghost btn-ghost-danger btn-sm" data-offline-delete="${escapeHTML(entry.bookId)}">Delete</button>
    </div>
  `).join('');
}

function handleOfflineManagerClick(e) {
  const btn = e.target.closest('[data-offline-delete]');
  if (!btn) return;
  deleteOfflineBook(btn.dataset.offlineDelete, btn.closest('.offline-book-row'));
}

function deleteOfflineBook(bookId, rowEl) {
  if (!offlineEntryForBook(bookId)) return;
  // Optimistic UI removal only — the manifest entry and cached audio stay
  // until the commit fires, so Undo restores the row by re-rendering.
  const list = document.getElementById('offline-books-list');
  if (rowEl) {
    rowEl.remove();
    if (list && !list.querySelector('.offline-book-row')) {
      list.innerHTML = '<p class="settings-hint">No books downloaded on this device.</p>';
    }
  } else {
    renderOfflineManager();
  }

  showUndoToast('Offline download deleted', {
    onUndo: () => renderOfflineState(),
    onCommit: async () => {
      await removeOfflineBook(bookId);
    }
  });
}

function requestBelongsToBook(request, route, bookId) {
  try {
    const url = new URL(typeof request === 'string' ? request : request.url);
    const match = url.pathname.match(new RegExp(`^${route}/([^/]+)(?:/\\d+)?$`));
    return Boolean(match) && decodeURIComponent(match[1]) === String(bookId);
  } catch {
    return false;
  }
}

async function deleteMatchingCacheEntries(cacheName, route, bookId, fallbackCount = 0) {
  const cache = await caches.open(offlineCacheName(cacheName));
  let removed = 0;
  if (typeof cache.keys === 'function') {
    const keys = await cache.keys();
    for (const request of keys) {
      if (!requestBelongsToBook(request, route, bookId)) continue;
      if (await cache.delete(request)) removed++;
    }
    return removed;
  }
  for (let index = 0; index < fallbackCount; index++) {
    const request = route === '/api/cover'
      ? offlineTitleRequest(bookId)
      : offlineAudioRequest(bookId, index);
    if (await cache.delete(request)) removed++;
  }
  return removed;
}

export async function removeOfflineBook(bookId, options = {}) {
  const id = String(bookId || '');
  if (!id) return { removed: false, audioEntries: 0, titleEntries: 0 };
  const downloadCompletion = activeDownloadBookId === id ? activeDownloadCompletion : null;
  if (downloadCompletion) downloadAbort?.abort();
  const rollingWaits = [...rollingCompletions.entries()]
    .filter(([key]) => key.startsWith(`${id}:`))
    .map(([, completion]) => completion);
  if (rollingWaits.length > 0) rollingAbort?.abort();
  await Promise.all([downloadCompletion, ...rollingWaits].filter(Boolean));

  const entry = offlineEntryForBook(id);
  if (entry?.storageBackend === 'idb') {
    const removed = await offlineDevice?.remove(id, offlineScopeId());
    const titleEntries = await deleteMatchingCacheEntries(OFFLINE_TITLE_CACHE, '/api/cover', id);
    if (options.removePlaybackState) {
      localStorage.removeItem(`xandrio_book_meta:${id}`);
      localStorage.removeItem(`xandrio_playback_checkpoint:${id}`);
      removePendingPositionsForBook(id);
    }
    if (options.render !== false) renderOfflineState();
    return { removed: Boolean(removed), audioEntries: 0, titleEntries };
  }
  const audioEntries = await deleteMatchingCacheEntries(
    OFFLINE_AUDIO_CACHE,
    '/api/audio',
    id,
    Number(entry?.chapters) || 0
  );
  const titleEntries = await deleteMatchingCacheEntries(OFFLINE_TITLE_CACHE, '/api/cover', id);

  const manifest = getOfflineManifest();
  const removed = Boolean(manifest[id]);
  delete manifest[id];
  saveOfflineManifest(manifest);
  if (options.removePlaybackState) {
    localStorage.removeItem(`xandrio_book_meta:${id}`);
    localStorage.removeItem(`xandrio_playback_checkpoint:${id}`);
    removePendingPositionsForBook(id);
  }
  if (options.render !== false) renderOfflineState();
  return { removed, audioEntries, titleEntries };
}

function pendingPositionsKey(scopeId = offlineScopeId()) {
  return `${PENDING_POSITIONS_KEY}:${scopeId}`;
}

function removePendingPositionsForBook(bookId, scopeId = offlineScopeId()) {
  for (const key of [pendingPositionsKey(scopeId), PENDING_POSITIONS_KEY]) {
    const pending = readJSON(key, []);
    if (Array.isArray(pending)) {
      writeJSON(key, pending.filter(position => String(position?.bookId || '') !== String(bookId)));
    }
  }
}

function readPendingPositions(scopeId) {
  const key = pendingPositionsKey(scopeId);
  const scoped = readJSON(key, null);
  const existing = Array.isArray(scoped) ? scoped : [];

  // The old queue had no account partition. Migrate only records whose saved
  // identity proves they belong to this scope. Unknown and other-account rows
  // stay quarantined instead of being replayed through the active session.
  const legacy = readJSON(PENDING_POSITIONS_KEY, []);
  if (!Array.isArray(legacy) || legacy.length === 0) return existing;
  const owned = legacy.filter(position => String(position?.userId || '') === String(scopeId));
  const quarantined = legacy.filter(position => String(position?.userId || '') !== String(scopeId));
  if (owned.length === 0) return existing;
  const merged = [...existing, ...owned].slice(-100);
  if (!writeJSON(key, merged)) return existing;
  if (quarantined.length > 0) writeJSON(PENDING_POSITIONS_KEY, quarantined.slice(-100));
  else localStorage.removeItem(PENDING_POSITIONS_KEY);
  return merged;
}

function pendingPositionId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

export function queuePendingPosition(payload, scopeId = offlineScopeId()) {
  const scope = String(scopeId || offlineScopeId());
  const pending = readPendingPositions(scope);
  if (!Array.isArray(pending)) return false;
  pending.push({ ...payload, __pendingQueueId: pendingPositionId(), __pendingQueueScope: scope });
  return writeJSON(pendingPositionsKey(scope), pending.slice(-100));
}

export function flushPendingPositions() {
  if (!navigator.onLine) return;
  const scope = offlineScopeId();
  if (pendingPositionFlushes.has(scope)) return pendingPositionFlushes.get(scope);
  const flush = (async () => {
    const key = pendingPositionsKey(scope);
    const pending = readPendingPositions(scope);
    if (!Array.isArray(pending) || pending.length === 0) return;
    const durable = pending.map(position => ({
      ...position,
      __pendingQueueId: position?.__pendingQueueId || pendingPositionId()
    }));
    if (!writeJSON(key, durable)) return;
    const controller = new AbortController();
    pendingPositionFlushControllers.set(scope, controller);
    const eligible = [];
    for (const position of durable) {
      const owner = String(position?.__pendingQueueScope || position?.userId || '');
      if (!owner || owner === scope) eligible.push(position);
    }
    for (const position of eligible) {
      if (offlineScopeId() !== scope || controller.signal.aborted) {
        break;
      }
      try {
        const { __pendingQueueId, __pendingQueueScope, ...payload } = position;
        await apiSend('POST', '/api/position', payload, { signal: controller.signal });
        // Read the current queue after acknowledgement. A new position or
        // removal during the request must retain its own result.
        const current = readJSON(key, []);
        if (Array.isArray(current)) {
          writeJSON(key, current.filter(item => item?.__pendingQueueId !== __pendingQueueId));
        }
      } catch {
        // Failed and aborted requests remain durable for a later retry.
      }
    }
  })().finally(() => {
    pendingPositionFlushControllers.delete(scope);
    pendingPositionFlushes.delete(scope);
  });
  pendingPositionFlushes.set(scope, flush);
  return flush;
}
