import { API_BASE, apiSend, canClaimLegacyOfflineStorage, getOfflineStorageScopeId } from '../api.js';
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
export const EXPECTED_OFFLINE_SW_VERSION = 'xandrio-v137';
export const MINIMUM_OFFLINE_ROUTE_CONTRACT = 1;
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
// Cadence for on-screen preparation progress once nobody is looking at it.
const PREPARATION_POLL_HIDDEN_MS = 30000;

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
let certifiedOfflineController = null;
let certifiedOfflineContract = 0;

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
  }
  return offlineWorkerControllerState();
}

export function offlineDownloadsSupported() {
  return typeof window !== 'undefined' &&
    globalThis.document?.documentElement?.dataset?.pwaStorageAllowed !== 'false' &&
    'caches' in window &&
    typeof window.caches?.open === 'function';
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
  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);
  // A download can finish while the page is uncontrolled (first install) or
  // while an older worker is still in charge. Both resolve on their own, so
  // re-check at startup and whenever the controlling worker changes rather than
  // leaving the user with a book stuck in "Verifying".
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
  const manifest = getOfflineManifest();
  const scope = offlineScopeId();
  if (
    'caches' in window &&
    localStorage.getItem(OFFLINE_LEGACY_CACHE_OWNER_KEY) === scope
  ) {
    await migrateLegacyCache(OFFLINE_TITLE_CACHE, scope, manifest).catch(error => {
      console.warn('Offline cover migration failed:', error);
    });
  }
  // Audio can be large. Keep the first render responsive; playback awaits
  // this same migration promise before declaring a chapter unavailable.
  const audioMigration = migrateLegacyOfflineCaches().catch(error => {
    console.warn('Offline cache migration failed:', error);
  });
  if (waitForAudio) await audioMigration;
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
}

export function getOfflineManifest(scopeId = offlineScopeId()) {
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

function saveOfflineManifest(manifest, scopeId = offlineScopeId()) {
  if (!writeJSON(offlineManifestKey(scopeId), manifest)) {
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
    const textLength = String(chapter?.text || '').length;
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
    text: text.slice(0, 256)
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
  return ['ready', 'repairing', 'incomplete', 'verifying'].includes(offlineState(entry));
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
    label: 'Make available offline',
    downloaded: false,
    cachedChapters,
    totalChapters
  };
}

export function offlineStatusForBook(bookId) {
  const entry = offlineEntryForBook(bookId);
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
      label: `Preparing audio · ${Number(entry.preparedChapters) || 0} of ${totalChapters} · Safe to close`,
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  if (state === 'preparation-waiting') {
    return {
      kind: 'preparation-waiting',
      label: `Waiting for audio · ${Number(entry.preparedChapters) || 0} of ${totalChapters}`,
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
      label: 'Audio prepared · Download to this device',
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
  await migrateLegacyOfflineCaches().catch(() => false);
  if (!isBookDownloadedForOffline(bookId, chapterIndex) || !('caches' in window)) return false;
  const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE));
  const manifest = getOfflineManifest();
  const entry = manifest[bookId];
  const request = offlineAudioRequest(bookId, chapterIndex);
  const cached = await cache.match(request);
  const expected = entry?.chapterEntries?.[chapterIndex];
  if (cached && expected) {
    if (expected.bodyVerificationVersion === OFFLINE_BODY_VERIFICATION_VERSION) return true;
    const identity = await contentIdentity(cached, { verifyBody: true }).catch(() => null);
    if (identity && canReuseChapter(expected, identity, expected.variantKey)) {
      expected.bodyVerificationVersion = OFFLINE_BODY_VERIFICATION_VERSION;
      saveOfflineManifest(manifest);
      await backfillContentIdentity(cache, request, cached, identity).catch(() => {});
      return true;
    }
    await cache.delete(request).catch(() => {});
  }

  if (!entry || !Array.isArray(entry.chapterEntries) || !entry.chapterEntries[chapterIndex]) return false;
  entry.chapterEntries[chapterIndex] = null;
  entry.bytes = entry.chapterEntries.reduce((sum, chapter) => sum + (Number(chapter?.size) || 0), 0);
  if (entry.mode !== 'rolling') entry.state = 'incomplete';
  saveOfflineManifest(manifest);
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
      offlineAudioRequest(bookId, chapterIndex),
      { headers: { Range: 'bytes=0-1' } }
    ));
  } catch {
    return { outcome: 'indeterminate', swVersion: '', contractVersion: 0, reason: 'probe-failed' };
  }

  // A worker from another build may implement different cache semantics, so
  // nothing it says is evidence about this contract — in either direction.
  const swVersion = response?.headers?.get?.(OFFLINE_SW_VERSION_MARKER) || '';
  const contractVersion = Number(response?.headers?.get?.(OFFLINE_CONTRACT_MARKER)) || 0;
  if (contractVersion < MINIMUM_OFFLINE_ROUTE_CONTRACT) {
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
  if (!('caches' in globalThis)) return unavailable;
  await migrateLegacyOfflineCaches().catch(() => false);
  if (!isBookDownloadedForOffline(bookId, chapterIndex)) {
    return { ...unavailable, reason: 'not-downloaded' };
  }

  const entry = offlineEntryForBook(bookId);
  const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE));
  const cached = await cache.match(offlineAudioRequest(bookId, chapterIndex));
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
    url: offlinePlaybackUrl(bookId, chapterIndex),
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
  try {
    const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE));
    const cached = await cache.match(offlineAudioRequest(bookId, chapterIndex));
    if (!cached) return false;
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
    showReadyToast &&
    state === 'prepared' &&
    current.state !== 'prepared' &&
    offlineState(current) !== 'ready'
  ) {
    showToast('Audio is ready to download');
  }
  schedulePreparationPoll();
  return state === 'prepared';
}

function schedulePreparationPoll(delayMs = 5000) {
  if (
    preparationPollTimer ||
    typeof window.setTimeout !== 'function' ||
    !navigator.onLine ||
    !Object.values(getOfflineManifest()).some(entry =>
      ['preparing', 'preparation-waiting'].includes(offlineState(entry))
    )
  ) return;
  // Server-side preparation continues whether or not anyone is looking at it,
  // and its only consumer is on-screen progress. Backgrounded, this poll was
  // pure overhead competing with the playback it was preparing for.
  const interval = globalThis.document?.hidden
    ? PREPARATION_POLL_HIDDEN_MS
    : Math.max(1000, Number(delayMs) || 5000);
  watchPreparationVisibility();
  preparationPollTimer = window.setTimeout(() => {
    preparationPollTimer = null;
    void refreshOfflinePreparations().finally(() => schedulePreparationPoll());
  }, interval);
}

let preparationVisibilityWatched = false;

/**
 * Resume the visible cadence the moment the screen comes back, so returning to
 * the app never shows progress frozen at whatever the slow poll last saw.
 * Attached on first use rather than at import, because this module is also
 * loaded outside a document.
 */
function watchPreparationVisibility() {
  if (preparationVisibilityWatched || typeof globalThis.document?.addEventListener !== 'function') {
    return;
  }
  preparationVisibilityWatched = true;
  globalThis.document.addEventListener('visibilitychange', () => {
    if (globalThis.document.hidden || preparationPollTimer === null) return;
    window.clearTimeout(preparationPollTimer);
    preparationPollTimer = null;
    schedulePreparationPoll(1000);
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
  try {
    const status = await apiSend(
      'POST',
      `/api/offline/preparation/${encodeURIComponent(id)}`
    );
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
  if (!await prepareBookForOffline(book, chapters, { showReadyToast: false })) {
    await notificationReady;
    return false;
  }
  return downloadBookForOffline(book, chapters, downloadOptions);
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

export async function refreshOfflinePreparations() {
  if (!navigator.onLine) return false;
  const preparingIds = Object.values(getOfflineManifest())
    .filter(entry => ['preparing', 'preparation-waiting'].includes(offlineState(entry)))
    .map(entry => String(entry.bookId));
  if (preparingIds.length === 0) return false;
  const results = await Promise.allSettled(preparingIds.map(refreshOfflinePreparation));
  schedulePreparationPoll();
  return results.some(result => result.status === 'fulfilled' && result.value);
}

export function cancelOfflineDownload(bookId) {
  if (downloadAbort && String(activeDownloadBookId) === String(bookId)) {
    downloadAbort.abort();
    return true;
  }
  return false;
}

export async function cancelOfflinePreparation(bookId) {
  const id = String(bookId || '');
  if (!id || !navigator.onLine) return false;
  await apiSend('DELETE', `/api/offline/preparation/${encodeURIComponent(id)}`);
  const manifest = getOfflineManifest();
  const entry = manifest[id];
  if (entry && [
    'preparing',
    'preparation-waiting',
    'preparation-error',
    'preparation-capacity',
    'preparation-paused'
  ].includes(offlineState(entry))) {
    delete manifest[id];
    saveOfflineManifest(manifest);
  }
  showToast('Offline setup removed');
  return true;
}

export async function resumeInterruptedOfflineDownloads() {
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
      entry?.mode === 'full' &&
      validTitleData(entry) &&
      (offlineState(entry) === 'repairing' || offlineState(entry) === 'incomplete')
    )
    .sort((left, right) =>
      String(left.downloadStartedAt || '').localeCompare(String(right.downloadStartedAt || ''))
    )[0];
  if (!candidate) return false;
  return downloadBookForOffline(
    candidate.titleData.book,
    candidate.titleData.chapters,
    { confirmForeground: false, showOverlay: false }
  );
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
      if (!document.hidden && downloadAbort && !downloadWakeLock) {
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

function discardWorkingAudioForChangedVariant(existing, working, packageVariantKey) {
  if (!existing?.variantKey || existing.variantKey === packageVariantKey) return false;
  working.variantKey = packageVariantKey;
  working.chapterEntries.fill(null);
  working.bytes = 0;
  working.downloadedAt = null;
  return true;
}

export async function downloadBookForOffline(book, chapters, options = {}) {
  if (!book?.id || !Array.isArray(chapters) || chapters.length === 0) return false;
  if (!offlineDownloadsSupported()) return false;
  if (downloadAbort) {
    if (String(activeDownloadBookId) === String(book.id)) {
      downloadAbort.abort();
    } else {
      showToast('Another book is already downloading', 'error');
    }
    return false;
  }
  const preparation = await apiSend(
    'GET',
    `/api/offline/preparation/${encodeURIComponent(book.id)}`
  );
  let preparationReady = false;
  try {
    preparationReady = applyPreparationStatus(
      book.id,
      preparation,
      preparationEntry(book, chapters, offlineEntryForBook(book.id))
    );
  } catch {
    showToast('Could not save offline download state', 'error');
    return false;
  }
  if (!preparationReady || !preparation?.packageVariantKey) {
    showToast('Audio is still preparing. You can safely close Xandrio.', 'error');
    return false;
  }
  if (options.confirmForeground !== false) {
    const packageBytes = Math.max(0, Number(preparation.bytesTotal) || 0);
    const packageSize = packageBytes >= 1024 * 1024 * 1024
      ? `${(packageBytes / 1024 / 1024 / 1024).toFixed(1)} GB`
      : `${Math.max(1, Math.round(packageBytes / 1024 / 1024))} MB`;
    const dataSaverNote = navigator.connection?.saveData ? ' Data Saver is on.' : '';
    const confirmed = await confirmSheet({
      title: 'Keep Xandrio visible',
      message: `This download is about ${packageSize} and may use Wi-Fi or mobile data.${dataSaverNote} Do not close Xandrio, switch apps, or lock the screen until it finishes. iOS may stop the transfer.`,
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
  const existing = offlineEntryForBook(book.id);
  const working = createWorkingEntry(
    book,
    chapters,
    existing,
    options.voiceLabel || currentVoiceLabel()
  );
  working.variantKey = String(preparation.packageVariantKey);
  working.packageBytes = Math.max(0, Number(preparation.bytesTotal) || 0);
  working.packageBitrateKbps = Math.max(0, Number(preparation.bitrateKbps) || 0);
  discardWorkingAudioForChangedVariant(existing, working, working.variantKey);
  const reportProgress = downloadProgressTracker(book, chapters, working, showOverlay);
  downloadAbort = new AbortController();
  activeDownloadBookId = book.id;
  let resolveDownloadCompletion;
  activeDownloadCompletion = new Promise(resolve => { resolveDownloadCompletion = resolve; });
  const signal = downloadAbort.signal;
  let completed = false;
  try {
    await holdDownloadWakeLock();
    await requestPersistentOfflineStorage();
    rollingAbort?.abort();
    rollingAbort = null;
    rollingRequestKey = '';
    reportProgress(-1, 0, 'Starting download');
    const manifest = getOfflineManifest();
    manifest[book.id] = working;
    saveOfflineManifest(manifest);
    renderOfflineState();
    if (showOverlay) {
      deps.showAudioLoading?.('Downloading book for offline', {
        detail: 'Checking storage...',
        percent: 0,
        status: 'generating'
      });
    }
    const cache = await caches.open(offlineCacheName(OFFLINE_AUDIO_CACHE));
    const estimate = await navigator.storage?.estimate?.();
    const available = estimate?.quota && estimate?.usage ? Math.max(0, estimate.quota - estimate.usage) : null;
    if (showOverlay && available != null) {
      deps.showAudioLoading?.('Downloading book for offline', {
        detail: `${Math.round(available / 1024 / 1024)} MB storage available`,
        percent: 0,
        status: 'generating'
      });
    }

    let nextChapterIndex = 0;
    let firstError = null;
    const worker = async () => {
      while (!firstError && nextChapterIndex < chapters.length) {
        const chapterIndex = nextChapterIndex++;
        try {
          await processFullDownloadChapter({
            book,
            chapterIndex,
            chapter: chapters[chapterIndex],
            existing,
            working,
            cache,
            signal,
            reportProgress
          });
        } catch (error) {
          firstError ||= error;
          downloadAbort?.abort();
        }
      }
    };
    const workerCount = Math.min(FULL_DOWNLOAD_CONCURRENCY, chapters.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (firstError) throw firstError;

    reportProgress(-1, 0, 'Verifying download');
    await cacheOfflineCover(book, signal);
    if (signal.aborted) throw new Error('Download cancelled');
    if (!await verifyOfflineEntry(cache, working)) {
      throw new Error('Offline audio verification failed');
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
    working.downloadedAt = new Date().toISOString();
    working.probedSwVersion = routeCheck.swVersion || '';
    working.probedContractVersion = routeCheck.contractVersion || 0;
    working.state = routeCheck.ok ? 'ready' : 'verifying';
    working.progressPhase = routeCheck.ok ? 'Downloaded' : 'Verifying';
    persistWorkingEntry(book.id, working);
    setDownloadActivity(book, 100, working.progressPhase);
    completed = true;
    showToast(routeCheck.ok
      ? (existing ? 'Offline download repaired' : 'Book downloaded for offline')
      : 'Download saved — reopen Xandrio to finish verifying it');
  } catch (err) {
    const cancelled = err?.name === 'AbortError' || err?.message === 'Download cancelled';
    working.state = 'incomplete';
    working.autoResume = !cancelled;
    working.progressPhase = cancelled ? 'Cancelled' : 'Interrupted';
    try {
      persistWorkingEntry(book.id, working);
    } catch {}
    showToast(err.message || 'Offline download failed', 'error');
  } finally {
    resolveDownloadCompletion();
    await releaseDownloadWakeLock();
    downloadAbort = null;
    activeDownloadBookId = '';
    activeDownloadCompletion = null;
    clearDownloadActivity();
    if (showOverlay) deps.hideAudioLoading?.();
    renderOfflineState();
  }
  return completed;
}

async function processFullDownloadChapter({
  book,
  chapterIndex,
  chapter,
  existing,
  working,
  cache,
  signal,
  reportProgress
}) {
  throwIfDownloadAborted(signal);
  const cacheRequest = offlineAudioRequest(book.id, chapterIndex);
  if (chapter?.empty) {
    await cache.delete(cacheRequest);
    working.chapterEntries[chapterIndex] = null;
    reportProgress(
      chapterIndex,
      1,
      `Skipping empty section ${chapterIndex + 1} of ${working.chapters}`
    );
    persistWorkingEntry(book.id, working);
    return;
  }
  reportProgress(chapterIndex, 0.01, 'Preparing download');
  const previous = working.chapterEntries[chapterIndex];
  const cached = await cache.match(cacheRequest);
  const cachedIdentity = cached
    ? await contentIdentity(cached, {
        verifyBody: previous?.bodyVerificationVersion !== OFFLINE_BODY_VERIFICATION_VERSION
      })
    : null;
  if (cachedIdentity) {
    cachedIdentity.bodyVerificationVersion = OFFLINE_BODY_VERIFICATION_VERSION;
  }
  const cacheIsValid = cachedIdentity && canReuseChapter(previous, cachedIdentity, previous?.variantKey);
  const variantKey = String(working.variantKey || '');
  const legacyCacheIsUsable = cachedIdentity &&
    isLegacyEntry(existing) &&
    !previous?.contentHash &&
    cachedIdentity.size > 0 &&
    existing?.variantKey === variantKey &&
    /:offline-mp3-v\d+:br48k$/.test(variantKey);

  if (cacheIsValid || legacyCacheIsUsable) {
    if (!variantKey && cacheIsValid) working.variantKey = previous.variantKey;
  }

  if (cacheIsValid && variantKey && variantKey === previous.variantKey) {
    working.chapterEntries[chapterIndex] = { ...previous, ...cachedIdentity, variantKey };
  } else if (legacyCacheIsUsable && variantKey) {
    working.chapterEntries[chapterIndex] = { ...cachedIdentity, variantKey };
  } else {
    if (!variantKey) throw new Error('Offline audio package identity is missing');
    const url = `/api/offline/audio/${encodeURIComponent(book.id)}/${chapterIndex}` +
      `?variant=${encodeURIComponent(variantKey)}`;
    const identity = await downloadAndVerifyChapter(
      cache,
      cacheRequest,
      `${API_BASE}${url}`,
      signal,
      chapterIndex,
      (fraction, transfer) => reportProgress(chapterIndex, fraction, 'Downloading', transfer)
    );
    throwIfDownloadAborted(signal);
    working.chapterEntries[chapterIndex] = { ...identity, variantKey };
  }

  throwIfDownloadAborted(signal);
  if (chapterIndex === 0) working.variantKey = variantKey;
  working.bytes = working.chapterEntries.reduce(
    (total, chapter) => total + (Number(chapter?.size) || 0),
    0
  );
  reportProgress(chapterIndex, 1, 'Downloading');
  persistWorkingEntry(book.id, working);
}

export async function ensureRollingOfflineWindow(book, chapters, chapterIndex, options = {}) {
  if (!options.enabled || !book?.id || !Array.isArray(chapters) || chapters.length === 0) return;
  if (!offlineDownloadsSupported() || !navigator.onLine || navigator.connection?.saveData) return;
  const existing = offlineEntryForBook(book.id);
  if (downloadAbort || (existing && existing.mode !== 'rolling')) return;

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
  return offlineAudioRequest(bookId, chapterIndex).url;
}

function persistWorkingEntry(bookId, entry) {
  const manifest = getOfflineManifest();
  manifest[bookId] = entry;
  saveOfflineManifest(manifest);
}

function setOfflineEntryState(bookId, state) {
  const manifest = getOfflineManifest();
  if (!manifest[bookId] || manifest[bookId].state === state) return;
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
    case 'preparing': return `Preparing audio · ${Number(entry.preparedChapters) || 0}/${Number(entry.chapters) || 0}`;
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
      entry?.mode === 'rolling' ||
      (isHydratableOfflineEntry(entry) && hasCachedChapter(entry))
    );
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
    const pending = readJSON('xandrio_pending_positions', []);
    if (Array.isArray(pending)) {
      writeJSON('xandrio_pending_positions', pending.filter(position => String(position?.bookId || '') !== id));
    }
  }
  if (options.render !== false) renderOfflineState();
  return { removed, audioEntries, titleEntries };
}

export function queuePendingPosition(payload) {
  const pending = readJSON('xandrio_pending_positions', []);
  if (!Array.isArray(pending)) return;
  pending.push(payload);
  writeJSON('xandrio_pending_positions', pending.slice(-100));
}

export async function flushPendingPositions() {
  if (!navigator.onLine) return;
  const pending = readJSON('xandrio_pending_positions', []);
  if (!Array.isArray(pending) || pending.length === 0) return;
  const remaining = [];
  for (const payload of pending) {
    try {
      await apiSend('POST', '/api/position', payload);
    } catch {
      remaining.push(payload);
    }
  }
  writeJSON('xandrio_pending_positions', remaining);
}
