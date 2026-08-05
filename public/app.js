// api.js must be first: importing it installs the 401 token interceptor
// before anything else can fetch.
import { API_BASE, apiGet, apiSend, fetchAuthStatus, getCurrentUserId, getCurrentDeviceId, getCurrentDeviceName } from './js/api.js';
import { initLogin, showLoginGate } from './js/views/login.js';
import { initRouter, navigateTo, syncPlayerHash, clearSheetStack } from './js/router.js';
import { formatDuration, escapeHTML, cleanDisplayText, isIOSLike, needsReliablePlayback, coverPlaceholderSrc } from './js/util/format.js';
import { showToast } from './js/ui/toast.js';
import { initKeys, onActivate } from './js/ui/keys.js';
import { registerSheet } from './js/ui/sheets.js';
import { initBookmarks, renderBookmarksSection, addBookmarkAtCurrentPosition } from './js/features/bookmarks.js';
import { initOffline, prepareOfflineStorage, renderOfflineState, queuePendingPosition, ensureRollingOfflineWindow, getOfflineBookData, offlinePlaybackUrl, localChapterSource, markLocalChapterSuspect, classifyLocalChapter, OFFLINE_WORKER_SCRIPT_URL, certifyOfflineWorkerController, offlineWorkerControllerState } from './js/features/offline.js';
import { initPronunciationRepair } from './js/features/pronunciations.js';
import { initQueueStatus } from './js/features/queue-status.js';
import { loadClientSettings, getSkipInterval, isSmartRewindEnabled, isRollingOfflineEnabled } from './js/client-settings.js';
import { initLibrary, loadLibrary, cacheBookMeta } from './js/views/library.js';
import { initSearch } from './js/views/search.js';
import { initSettings } from './js/views/settings.js';
import { initStats } from './js/views/stats.js';
import { initSleepTimer, restoreSleepTimer, isSleepTimerChapterTarget, expireSleepTimer, closeSleepTimerModal } from './js/views/sleep-timer.js';
import { loadVoices, refreshVoicePrepPanel, closeVoiceSheetDirect } from './js/views/voices.js';
import { initPlaybackSpeed, getCurrentPlaybackSpeed, closeSpeedSheet, loadPlaybackSpeed, applyPlaybackSpeed, applySkipIntervalLabels, stepPlaybackSpeed } from './js/views/playback-speed.js';
import { readJSON, writeJSON, readText } from './js/util/storage.js';
import { createPlaybackSession, restorePlaybackPosition } from './js/playback-session.js';
import { navigateChapterSelection, positionMatchesChapterStructure, shouldAllowBackwardReconciliation } from './js/chapter-navigation.mjs';
import { SingleFileChapterPlayer } from './js/single-file-chapter-player.js';
import { initPlayerUI, paintChapterTimes, paintScrubPreview, toggleTimeDisplayMode, syncTimeDisplayModeFromClientSettings, getPlaybackProgressScope, getBookSeekTarget, syncPlaybackProgressScope, setPlaybackReliabilityState, setResumePromptVisible, handleChunkWaiting, handleChunkPreparing, setChunkOverlayState, displayChapterTitle, updateChapterTrigger, updateBookProgress, updatePlayerAmbient, renderChapterList, openChapterSheet, closeChapterSheet, dismissChapterSheet, showAudioLoading, hideAudioLoading, updateMiniPlayer, syncMiniPlayerInfo, syncMiniPlayerIcon } from './js/views/player-ui.js';
import { findPreferredStartChapterIndex } from './js/util/chapter-labels.mjs';
import { applyRewindForResume, createSmartRewindController } from './js/smart-rewind.mjs';
import { initListeningQueue, loadListeningQueue, addToListeningQueue, advanceListeningQueue, getBookPlaybackSettings, saveBookPlaybackSettings } from './js/features/listening-queue.js';
import { initDeploymentGuard } from './js/deployment-origin.js';

// SVG Icon constants
const ICON_PLAY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path fill-rule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.572 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clip-rule="evenodd"/></svg>';
const ICON_PAUSE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path fill-rule="evenodd" d="M6.75 5.25a.75.75 0 01.75-.75H9a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H7.5a.75.75 0 01-.75-.75V5.25zm7.5 0A.75.75 0 0115 4.5h1.5a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H15a.75.75 0 01-.75-.75V5.25z" clip-rule="evenodd"/></svg>';
// Light haptic tick for control taps. Silently no-ops where unsupported.
function haptic(ms = 10) {
  try { navigator.vibrate?.(ms); } catch {}
}

// State
let currentBook = null;
let currentChapter = 0;
let chapters = [];
let currentBookOfflineFallback = false;
let currentBookFinished = false;
let chunkPlayer = null; // Active adapter for the persistent #audio-player element
let chunkedPlayer = null; // Persistent adapter retained under the legacy variable name
let playbackBackend = 'audio-stream';
let currentBookPlaybackSettings = {};
const smartRewind = createSmartRewindController();

// API_BASE and sync identity now live in js/api.js
const PLAYBACK_CHECKPOINT_PREFIX = 'xandrio_playback_checkpoint:';
const PLAYBACK_EVENT_LEDGER_KEY = 'xandrio_playback_event_ledger';
const PLAYBACK_EVENT_LEDGER_LIMIT = 80;
const CHECKPOINT_SAVE_MIN_INTERVAL_MS = 1000;
let lastCheckpointSaveAt = 0;
let lastServerPositionSaveAt = 0;
let pendingServerPositionTimer = null;
const restoredPlaybackEventLedger = loadPlaybackEventLedger();
let playbackEventLedger = restoredPlaybackEventLedger.slice();
let persistedPlaybackEventLedger = restoredPlaybackEventLedger.slice();
// Rollout control for playing a downloaded chapter from this device while the
// network is up. A build-time constant on purpose: the deployment guard is a
// local origin/HTTPS computation, not a server-driven config channel, and this
// change did not warrant inventing one. Set to false and release to fall back
// to streaming while online; offline playback is unaffected either way, and the
// service worker's cache-only contract for scoped URLs is permanent and needs
// no revert. Removing this flag once the rollout has soaked is expected.
const ONLINE_LOCAL_FIRST_ENABLED = true;

let automaticRecoveryAttempts = 0;
let automaticRecoveryTimer = null;
// Recovery ownership. Every attempt captures the token that was current when it
// started; a newer attempt, a chapter change or a book change replaces it, and
// the older attempt then abandons instead of committing a stale source. Without
// this, overlapping attempts each created their own server-side HLS session.
let recoveryToken = { cancelled: false };
// Held for the whole attempt — scheduling *and* the awaited load — so a second
// error arriving mid-load cannot start a parallel recovery.
let automaticRecoveryInFlight = false;
let manualRecoveryInFlight = false;
let manualRecoveryToken = null;
// One canonical transport tuple for the entire interrupted-playback lineage.
// It survives the automatic-to-manual handoff and is cleared only by stable
// playback or real navigation.
let recoverySnapshot = null;
let stablePlaybackTimer = null;
let rollingOfflineTimer = null;
const playbackSession = createPlaybackSession({
  onStateChange: (state) => {
    currentBook = state.book;
    currentChapter = state.chapterIndex;
    chunkPlayer = state.engine;
    playbackBackend = state.backend || playbackBackend;
    currentBookFinished = state.finished;
  }
});

// Formatting/escaping helpers now live in js/util/format.js

// DOM Elements (will be initialized after DOM is ready)
let libraryView, searchView, playerView;
let addBookBtn, backToLibraryBtn, backBtn;
let bookTitle, bookAuthorHeader, bookDetailsText, bookDescription;
let pdfStructureReview, pdfStructureReviewDetail, pdfReprocessBtn;
let bookCover, audioPlayer;
let playPauseBtn, skipBackBtn, skipForwardBtn;
let prevChapterBtn, nextChapterBtn;
let progressSlider, chapterSelect, timerBtnInline, bookmarkBtn;
// True while the user is actively dragging the progress slider. Suppresses the
// engine's timeupdate writes to the slider so the thumb doesn't fight the drag.
let isScrubbing = false;
let languageFilter;
let startOverModal, startOverBtn, startOverConfirmBtn, startOverCancelBtn;
let shortcutOverlay, shortcutOverlayClose;
let playbackReliability;
let playbackResumePrompt, playbackResumeBtn;
let startOverModalController = null;
let shortcutOverlayController = null;
let serviceWorkerReadiness = null;
let serviceWorkerBootWindowOpen = true;
let blockedWorkerOnlineRetry = null;
const OFFLINE_WORKER_RELOAD_KEY = 'xandrio_offline_worker_reload';
const SERVICE_WORKER_BOOT_DEADLINE_MS = 6000;

// Initialize DOM elements after DOM is ready
function initializeDOMElements() {
  libraryView = document.getElementById('library-view');
  searchView = document.getElementById('search-view');
  playerView = document.getElementById('player-view');
  
  addBookBtn = document.getElementById('add-book-btn');
  backToLibraryBtn = document.getElementById('back-to-library-btn');
  backBtn = document.getElementById('back-btn');
  
  bookTitle = document.getElementById('book-title');
  bookAuthorHeader = document.getElementById('book-author-header');
  bookDetailsText = document.getElementById('book-details-text');
  bookDescription = document.getElementById('book-description');
  pdfStructureReview = document.getElementById('pdf-structure-review');
  pdfStructureReviewDetail = document.getElementById('pdf-structure-review-detail');
  pdfReprocessBtn = document.getElementById('pdf-reprocess-btn');
  bookCover = document.getElementById('book-cover');
  audioPlayer = document.getElementById('audio-player');
  playPauseBtn = document.getElementById('play-pause-btn');
  skipBackBtn = document.getElementById('skip-back-btn');
  skipForwardBtn = document.getElementById('skip-forward-btn');
  prevChapterBtn = document.getElementById('prev-chapter-btn');
  nextChapterBtn = document.getElementById('next-chapter-btn');
  progressSlider = document.getElementById('progress-slider');
  chapterSelect = document.getElementById('chapter-select');
  timerBtnInline = document.getElementById('timer-btn-inline');
  bookmarkBtn = document.getElementById('bookmark-btn');
  
  languageFilter = document.getElementById('language-filter');

  startOverModal = document.getElementById('start-over-modal');
  startOverBtn = document.getElementById('start-over-btn');
  startOverConfirmBtn = document.getElementById('confirm-start-over-btn');
  startOverCancelBtn = document.getElementById('cancel-start-over-btn');

  shortcutOverlay = document.getElementById('shortcut-overlay');
  shortcutOverlayClose = document.getElementById('shortcut-overlay-close');
  
  playbackReliability = document.getElementById('playback-reliability');
  playbackResumePrompt = document.getElementById('playback-resume-prompt');
  playbackResumeBtn = document.getElementById('playback-resume-btn');
}

// ChunkPlayer callback handlers
function handleChunkTimeUpdate(data) {
  // data: { currentTime, totalTime, progressPercent, chunk, totalChunks }
  checkpointPlayback({ throttle: true });
  updateMediaSessionPosition(data);

  // While the user is scrubbing, don't let the engine overwrite the slider
  // thumb or the time label — the drag owns them until release.
  if (!isScrubbing) {
    // The player UI owns the slider because it may represent either the
    // current chapter or the complete book timeline.
    paintChapterTimes(data);

    // Mini player progress
    const miniProgress = document.getElementById('mini-player-progress');
    if (miniProgress) miniProgress.style.width = data.progressPercent + '%';
  }
}

function handleChunkChange(chunkIndex) {
  // chunkIndex: integer — the chunk that is now playing
  if (chunkPlayer) {
    console.log(`${playbackBackend} playback position ${chunkIndex + 1}/${chunkPlayer.totalChunks}`);
  }
  checkpointPlayback();
  updatePlaybackUI();
}

function handleChapterEnd(detail = {}) {
  handleAudioEnd(detail);
}

function finitePlaybackNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function loadPlaybackEventLedger() {
  try {
    const parsed = JSON.parse(globalThis.window?.localStorage?.getItem(PLAYBACK_EVENT_LEDGER_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(-PLAYBACK_EVENT_LEDGER_LIMIT) : [];
  } catch {
    return [];
  }
}

function recordPlaybackEvent(detail = {}) {
  const mediaDetail = { ...detail };
  if (audioPlayer) {
    mediaDetail.streamTime ??= audioPlayer.currentTime;
    mediaDetail.chapterTime ??= chunkPlayer?.getCurrentTime?.();
    mediaDetail.readyState ??= audioPlayer.readyState;
    mediaDetail.networkState ??= audioPlayer.networkState;
    mediaDetail.paused ??= audioPlayer.paused;
    mediaDetail.ended ??= audioPlayer.ended;
    if (mediaDetail.bufferRunway === undefined) {
      try {
        for (let index = 0; index < audioPlayer.buffered.length; index++) {
          if (audioPlayer.currentTime <= audioPlayer.buffered.end(index)) {
            mediaDetail.bufferRunway = Math.max(0, audioPlayer.buffered.end(index) - audioPlayer.currentTime);
            break;
          }
        }
      } catch {}
    }
  }
  const entry = {
    at: new Date().toISOString(),
    type: String(mediaDetail.type || 'unknown').slice(0, 40),
    chapterIndex: Number.isInteger(mediaDetail.chapterIndex) ? mediaDetail.chapterIndex : currentChapter,
    visibility: String(mediaDetail.visibility || document?.visibilityState || 'unknown').slice(0, 16)
  };
  for (const key of ['reason', 'sourceKind']) {
    if (mediaDetail[key]) entry[key] = String(mediaDetail[key]).slice(0, 40);
  }
  for (const key of ['streamTime', 'chapterTime', 'bufferRunway']) {
    const value = finitePlaybackNumber(mediaDetail[key]);
    if (value !== null) entry[key] = value;
  }
  for (const key of ['readyState', 'networkState', 'errorCode', 'previousChapterIndex']) {
    if (Number.isInteger(Number(mediaDetail[key]))) entry[key] = Number(mediaDetail[key]);
  }
  for (const key of ['paused', 'ended', 'online']) {
    if (typeof mediaDetail[key] === 'boolean') entry[key] = mediaDetail[key];
  }
  playbackEventLedger = [...playbackEventLedger, entry].slice(-PLAYBACK_EVENT_LEDGER_LIMIT);
  // Timeupdate fires every few hundred milliseconds. Keep those diagnostic
  // samples in memory so playback never synchronously writes storage in the
  // media event hot path; significant lifecycle events still survive reloads.
  if (entry.type !== 'timeupdate') {
    persistedPlaybackEventLedger = [...persistedPlaybackEventLedger, entry].slice(-PLAYBACK_EVENT_LEDGER_LIMIT);
    try {
      globalThis.window?.localStorage?.setItem(
        PLAYBACK_EVENT_LEDGER_KEY,
        JSON.stringify(persistedPlaybackEventLedger)
      );
    } catch {}
  }
  return entry;
}

function estimateChapterPlaybackDuration(chapter, chapterIndex) {
  const measuredDuration = Number(currentBook?.chapterDurations?.[chapterIndex]);
  if (Number.isFinite(measuredDuration) && measuredDuration > 0) return measuredDuration;
  const duration = Number(chapter?.estimatedDuration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const characterCount = String(chapter?.text || '').trim().length;
  // Approximate 180 spoken words/minute and five characters/word. Empty
  // structural chapters remain zero so the continuous mapper skips them.
  return characterCount > 0 ? Math.max(1, characterCount / 15) : 0;
}

function handleContinuousChapterTransition(detail = {}) {
  const chapterIndex = Number(detail.chapterIndex);
  if (!currentBook || !Number.isInteger(chapterIndex) || chapterIndex < 0 || chapterIndex >= chapters.length) return;
  const stopForSleepTimer = isSleepTimerChapterTarget(currentBook.id, detail.previousChapterIndex);
  if (stopForSleepTimer) {
    chunkPlayer?.pause?.('sleep-timer-chapter');
    recordPlaybackEvent({
      type: 'sleep-timer-stop',
      reason: 'chapter-transition',
      previousChapterIndex: detail.previousChapterIndex,
      chapterIndex,
      chapterTime: detail.chapterTime,
      streamTime: detail.streamTime
    });
  }
  playbackSession.setBook(currentBook, {
    chapterIndex,
    finished: false
  });
  if (chapterSelect) chapterSelect.value = String(chapterIndex);
  syncPlaybackProgressScope();
  updateChapterTrigger();
  renderChapterList();
  syncMiniPlayerInfo();
  updateMediaSessionMetadata();
  updateMediaSessionPosition();
  updateBookProgress();
  checkpointPlayback({ force: true });
  scheduleServerPositionSave(0);
  if (stopForSleepTimer) expireSleepTimer('chapter');
}

async function handleSleepTimerChapterTargetChange(target, detail = {}) {
  if (!chunkPlayer?.isContinuous || typeof chunkPlayer.setContinuousEndChapter !== 'function') return;
  // restoreSleepTimer() runs before the incoming book's engine is loaded. Do
  // not retarget an outgoing book; loadChapter() reads the restored target when
  // it constructs the new transport.
  if (chunkPlayer.bookId !== currentBook?.id || chunkPlayer.chapterIndex !== currentChapter) return;
  const endChapterIndex = target &&
    target.bookId === currentBook.id &&
    target.chapterIndex === currentChapter
    ? currentChapter
    : null;
  recordPlaybackEvent({
    type: 'sleep-timer-transport',
    reason: detail.reason || (endChapterIndex === null ? 'cleared' : 'armed'),
    chapterIndex: currentChapter
  });
  await chunkPlayer.setContinuousEndChapter(endChapterIndex);
}

function clearPlaybackRecoveryTimers() {
  // Invalidate the token first: an attempt that is already past its timer and
  // awaiting a load will not be stopped by clearing the handle, and must not
  // commit a source for playback the user has since moved on from.
  cancelPlaybackRecovery();
  if (stablePlaybackTimer !== null) {
    window.clearTimeout?.(stablePlaybackTimer);
    stablePlaybackTimer = null;
  }
}

function markPlaybackStableSoon() {
  if (!window.setTimeout) return;
  if (stablePlaybackTimer !== null) window.clearTimeout(stablePlaybackTimer);
  stablePlaybackTimer = window.setTimeout(() => {
    automaticRecoveryAttempts = 0;
    recoverySnapshot = null;
    stablePlaybackTimer = null;
  }, 30000);
}

function interruptStablePlaybackWindow() {
  if (stablePlaybackTimer === null) return;
  window.clearTimeout?.(stablePlaybackTimer);
  stablePlaybackTimer = null;
}

function scheduleRollingOfflineAfterStablePlayback() {
  if (!window.setTimeout || currentBookOfflineFallback) return;
  const enabled = currentBookPlaybackSettings.rollingOfflineEnabled ?? isRollingOfflineEnabled();
  if (!enabled || !navigator.onLine) return;
  if (rollingOfflineTimer !== null) window.clearTimeout(rollingOfflineTimer);
  rollingOfflineTimer = window.setTimeout(() => {
    rollingOfflineTimer = null;
    if (!chunkPlayer?.isPlaying || (chunkPlayer.getBufferRunway?.() || 0) < 20) {
      scheduleRollingOfflineAfterStablePlayback();
      return;
    }
    void ensureRollingOfflineWindow(currentBook, chapters, currentChapter, { enabled: true })
      .catch(error => console.warn('Automatic chapter cache unavailable:', error));
  }, 60000);
}

/**
 * Hand recovery to the user — but only offer "Resume" once it is truthful.
 *
 * iOS grants audio.play() only during the synchronous turn of the tap that
 * triggered it. A Resume button that first awaits a chapter load has already
 * lost that grant by the time it plays, so the tap does nothing and the user
 * taps again — which is how one interruption became a burst of sessions.
 *
 * So the source is prepared *before* Resume appears. The tap then does nothing
 * but play, synchronously. If preparation fails there is no one-tap resume to
 * offer and we say so: the action is labelled "Try again" and re-prepares.
 */
function offerManualPlaybackRecovery(error, snapshot) {
  const lineageSnapshot = retainRecoverySnapshot(snapshot);
  if (!lineageSnapshot) return;
  checkpointPlayback({ force: true });
  setPlaybackReliabilityState('preparing', 'Preparing to resume…');
  recordPlaybackEvent({
    type: 'recovery-offered',
    reason: error?.code || 'playback-error',
    chapterIndex: lineageSnapshot?.chapterIndex ?? currentChapter,
    chapterTime: lineageSnapshot?.startOffsetSeconds ?? 0
  });
  void prepareManualResume(lineageSnapshot);
}

async function prepareManualResume(snapshot) {
  if (manualRecoveryInFlight) {
    setPlaybackReliabilityState('preparing', 'Preparing to resume…');
    showToast('Still preparing playback…');
    return;
  }
  const lineageSnapshot = retainRecoverySnapshot(snapshot);
  if (!lineageSnapshot) return;
  // The user is taking over; invalidate pending automatic work, but preserve
  // this lineage's tuple and already-spent retry budget.
  stopPendingAutomaticRecovery();
  const token = recoveryToken;
  manualRecoveryInFlight = true;
  manualRecoveryToken = token;
  const chapterIndex = lineageSnapshot?.chapterIndex ?? currentChapter;
  try {
    const prepared = await loadChapter(chapterIndex, {
      reason: 'manual-recovery',
      sourceTuple: lineageSnapshot,
      seekToSeconds: lineageSnapshot?.startOffsetSeconds
    });
    if (prepared?.loaded === false) return;
    if (
      token.cancelled
      || recoverySnapshot !== lineageSnapshot
      || currentBook?.id !== lineageSnapshot.bookId
      || currentChapter !== lineageSnapshot.chapterIndex
    ) return;
  } catch (prepareError) {
    if (token.cancelled || recoverySnapshot !== lineageSnapshot) return;
    console.warn('Could not prepare a resume:', prepareError);
    setResumePromptVisible(false);
    setPlaybackReliabilityState('resume', 'Stream interrupted');
    showToast('Playback was interrupted', 'error', {
      actionLabel: 'Try again',
      onAction: () => { void prepareManualResume(lineageSnapshot); }
    });
    return;
  } finally {
    if (manualRecoveryToken === token) {
      manualRecoveryInFlight = false;
      manualRecoveryToken = null;
    }
  }
  // The source is loaded and positioned, so the next tap can play immediately.
  setResumePromptVisible(true);
  setPlaybackReliabilityState('resume', 'Ready to resume');
  showToast('Playback was interrupted', 'error', {
    actionLabel: 'Resume',
    onAction: () => resumeFromPreparedSource()
  });
}

// Narrow an immutable recovery snapshot down to the fields the engine opens a
// source with, and only when it is for the chapter actually being loaded.
function recoverySourceTuple(snapshot, chapterIndex) {
  if (!snapshot || snapshot.chapterIndex !== chapterIndex) return null;
  if (snapshot.bookId && snapshot.bookId !== currentBook?.id) return null;
  const tuple = {};
  if (Number(snapshot.startOffsetSeconds) > 0) {
    tuple.startOffsetSeconds = Number(snapshot.startOffsetSeconds);
  }
  if (snapshot.servedTier) tuple.servedTier = snapshot.servedTier;
  if (Number.isInteger(snapshot.endChapterIndex)) tuple.endChapterIndex = snapshot.endChapterIndex;
  return Object.keys(tuple).length ? tuple : null;
}

// Runs inside the tap. Nothing may be awaited before play().
function resumeFromPreparedSource() {
  if (!chunkPlayer) return Promise.resolve();
  applySmartRewindForResume();
  const started = Promise.resolve(chunkPlayer.play());
  setResumePromptVisible(false);
  updatePlaybackUI(true);
  return started
    .then(() => markPlaybackStableSoon())
    .catch(playError => {
      updatePlaybackUI(false);
      handleChunkError(playError);
    });
}

// Two attempts, not three. Each attempt loads a chapter, and each load asks the
// server for an HLS session; a third automatic try bought little and tripled the
// session churn a single failed resume could produce.
const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 2;

function stopPendingAutomaticRecovery() {
  recoveryToken.cancelled = true;
  recoveryToken = { cancelled: false };
  if (automaticRecoveryTimer !== null) {
    window.clearTimeout?.(automaticRecoveryTimer);
    automaticRecoveryTimer = null;
  }
  automaticRecoveryInFlight = false;
  try { chunkPlayer?.cancelPendingLoad?.(); } catch {}
}

// Abandon the current recovery lineage entirely. Real navigation and explicit
// cancellation reset both its immutable tuple and its bounded attempt budget;
// the automatic-to-manual handoff deliberately does neither.
function cancelPlaybackRecovery() {
  stopPendingAutomaticRecovery();
  manualRecoveryInFlight = false;
  manualRecoveryToken = null;
  automaticRecoveryAttempts = 0;
  recoverySnapshot = null;
}

// A user-selected position begins a new playback lineage. Keeping the failed
// stream's snapshot here would make a later error jump back to the position
// captured before the seek.
function invalidatePlaybackRecoveryForUserSeek() {
  if (
    recoverySnapshot
    || automaticRecoveryTimer !== null
    || automaticRecoveryInFlight
    || manualRecoveryInFlight
    || automaticRecoveryAttempts > 0
  ) {
    cancelPlaybackRecovery();
  }
}

function retainRecoverySnapshot(snapshot) {
  if (
    snapshot
    && (
      snapshot.bookId !== currentBook?.id
      || snapshot.chapterIndex !== currentChapter
    )
  ) return null;
  if (
    recoverySnapshot
    && recoverySnapshot.bookId === currentBook?.id
    && recoverySnapshot.chapterIndex === currentChapter
  ) {
    return recoverySnapshot;
  }
  if (!snapshot) return null;
  recoverySnapshot = Object.freeze({
    bookId: snapshot.bookId,
    chapterIndex: snapshot.chapterIndex,
    startOffsetSeconds: Math.max(0, Number(snapshot.startOffsetSeconds) || 0),
    servedTier: snapshot.servedTier || null,
    endChapterIndex: Number.isInteger(snapshot.endChapterIndex)
      ? snapshot.endChapterIndex
      : null
  });
  return recoverySnapshot;
}

// Returns whether the failure is *handled* — not whether a timer was created.
// A duplicate error arriving while an attempt is already in flight is handled
// by that attempt; reporting it as unhandled put a manual "Resume" prompt on
// screen on top of a retry that was already running.
function scheduleAutomaticPlaybackRecovery(error, snapshot) {
  const lineageSnapshot = retainRecoverySnapshot(snapshot);
  const resumeAt = lineageSnapshot?.startOffsetSeconds || 0;
  if (!window.setTimeout) return false;

  // A server that is rate-limiting playback sessions will not be helped by
  // retrying sooner, and offering a Resume button just walks the user back into
  // the same limit. Tell them how long to wait. Checked before the in-flight
  // guards so it is reported even when an attempt is already running.
  const retryAfterSeconds = Number(error?.retryAfterSeconds);
  if (error?.status === 429 || error?.code === 429) {
    cancelPlaybackRecovery();
    const wait = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? ` Try again in ${Math.ceil(retryAfterSeconds)}s.`
      : '';
    setPlaybackReliabilityState('resume', 'Too many playback attempts');
    showToast(`Too many playback sessions started.${wait}`, 'error');
    return true;
  }

  if (automaticRecoveryTimer !== null || automaticRecoveryInFlight || manualRecoveryInFlight) return true;
  if (automaticRecoveryAttempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) return false;
  automaticRecoveryAttempts += 1;
  const attempt = automaticRecoveryAttempts;
  // The whole attempt runs under one token and one in-flight flag. Both are
  // taken here, not inside retry(), so nothing can slip in between.
  automaticRecoveryInFlight = true;
  const token = recoveryToken;
  const retry = async () => {
    // Re-scheduling happens strictly after this attempt has released its slot,
    // otherwise the release would wipe the successor's guard the moment it took
    // it — reopening the parallel-recovery hole this token is here to close.
    let followUpError = null;
    try {
      if (token.cancelled) return;
      if (!navigator.onLine) {
        setPlaybackReliabilityState('resume', 'Waiting for connection');
        window.addEventListener('online', () => {
          if (token.cancelled) return;
          if (!scheduleAutomaticPlaybackRecovery(error, lineageSnapshot)) {
            offerManualPlaybackRecovery(error, lineageSnapshot);
          }
        }, { once: true });
        return;
      }
      recordPlaybackEvent({
        type: 'automatic-recovery',
        reason: error?.code || 'playback-error',
        attempt,
        chapterIndex: currentChapter,
        chapterTime: resumeAt
      });
      setPlaybackReliabilityState(
        'preparing',
        `Reconnecting… (${attempt}/${MAX_AUTOMATIC_RECOVERY_ATTEMPTS})`
      );
      try {
        // The snapshot is captured once, at the moment the failure was handled,
        // and replayed verbatim by every attempt. The transport therefore opens
        // *at* the resume position, so each retry requests the byte-identical
        // canonical tuple and joins the session already being prepared instead
        // of opening at zero and relocating into a second one.
        const prepared = await loadChapter(lineageSnapshot?.chapterIndex ?? currentChapter, {
          sourceTuple: lineageSnapshot,
          seekToSeconds: resumeAt,
          reason: 'automatic-recovery'
        });
        if (prepared?.loaded === false) return;
        if (token.cancelled) return;
        await chunkPlayer.play();
        if (token.cancelled) return;
        setResumePromptVisible(false);
        updatePlaybackUI(true);
        markPlaybackStableSoon();
      } catch (retryError) {
        if (!token.cancelled) followUpError = retryError;
      }
    } finally {
      automaticRecoveryTimer = null;
      automaticRecoveryInFlight = false;
    }
    if (!followUpError || token.cancelled) return;
    if (!scheduleAutomaticPlaybackRecovery(followUpError, lineageSnapshot)) {
      offerManualPlaybackRecovery(followUpError, lineageSnapshot);
    }
  };
  automaticRecoveryTimer = window.setTimeout(retry, 250 * (2 ** (attempt - 1)));
  return true;
}


function handleChunkError(error) {
  console.error('Chunk playback error:', error);
  if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    hideAudioLoading();
    setResumePromptVisible(true);
    return;
  }
  if (
    error?.code === 'CONTINUOUS_STREAM_EOF'
    || error?.code === 'MEDIA_PLAY_TIMEOUT'
    || error?.code === 'MEDIA_PROGRESS_TIMEOUT'
    // A rate limit is about the account, not the transport: it must be reported
    // even when the engine that failed had not reached continuous playback.
    || error?.status === 429
    || error?.code === 429
    || chunkPlayer?.isContinuous
  ) {
    interruptStablePlaybackWindow();
    const resumeAt = Math.max(0, Number(error.chapterTime ?? chunkPlayer?.getCurrentTime?.()) || 0);
    checkpointPlayback({ force: true });
    // One immutable snapshot of the canonical request, captured once, here.
    // Every attempt — automatic or manual — replays it verbatim, so all of them
    // resolve to the same server session instead of each minting a new one.
    const snapshot = retainRecoverySnapshot({
      bookId: currentBook?.id,
      chapterIndex: currentChapter,
      startOffsetSeconds: resumeAt,
      servedTier: chunkPlayer?.servedTier || null,
      endChapterIndex: Number.isInteger(chunkPlayer?.endChapterIndex)
        ? chunkPlayer.endChapterIndex
        : null
    });
    if (!scheduleAutomaticPlaybackRecovery(error, snapshot)) {
      offerManualPlaybackRecovery(error, snapshot);
    }
    return;
  }
  if (needsReliablePlayback()) {
    hideAudioLoading();
    setPlaybackReliabilityState('resume', 'Audio needs attention');
    return;
  }
  // Desktop: surface a recoverable failure instead of silently hiding the
  // loader. Retry re-runs chapter preparation for the current chapter.
  const retry = async () => {
    const tier = chunkPlayer?.servedTier;
    const query = tier ? `?tier=${encodeURIComponent(tier)}` : '';
    try {
      await apiSend('POST', `/api/chunks/${encodeURIComponent(currentBook.id)}/${currentChapter}/retry${query}`, {
        targetChunk: chunkPlayer?.currentChunk || 0,
        tier
      });
      await loadChapter(currentChapter);
    } catch (retryError) {
      showToast(retryError.message || 'Chapter retry failed', 'error');
    }
  };
  setChunkOverlayState('error', {
    message: "Couldn't load this chapter",
    detail: 'The audio failed to load. Check your connection and try again.',
    onRetry: retry
  });
  showToast("Couldn't load audio for this chapter", 'error', { actionLabel: 'Retry', onAction: retry });
}

function handleChunkReady() {
  hideAudioLoading();
  updatePlaybackUI();
  updateMediaSessionPosition();
  if (chunkPlayer?.supportsNativeMediaSession) {
    setPlaybackReliabilityState('active', playbackBackend === 'single-file'
      ? 'Playing from this device'
      : 'Streaming');
  }
}

// Engine messages are paint-only input here — we relabel specific known
// strings for honesty without touching where/why the engine sends them.
function makePlaybackCallbacks() {
  return {
    onTimeUpdate: handleChunkTimeUpdate,
    onChunkChange: handleChunkChange,
    onChapterEnd: handleChapterEnd,
    onError: handleChunkError,
    onReady: handleChunkReady,
    onWaiting: handleChunkWaiting,
    onPreparing: handleChunkPreparing,
    onPlaybackChange: (isPlaying, detail = {}) => {
      updatePlaybackUI(isPlaying);
      if (isPlaying) {
        setResumePromptVisible(false);
        markPlaybackStableSoon();
        scheduleRollingOfflineAfterStablePlayback();
        checkpointPlayback({ throttle: true });
        if (detail.reason === 'external') applySmartRewindForResume();
        else retryDeferredSmartRewind();
      } else {
        if (rollingOfflineTimer !== null) {
          window.clearTimeout?.(rollingOfflineTimer);
          rollingOfflineTimer = null;
        }
        if (detail.reason === 'external') recordSmartRewindPause();
        checkpointPlayback();
        scheduleServerPositionSave();
      }
    }
  };
}

function createSingleFileChapterEngine(options = {}) {
  return new SingleFileChapterPlayer(audioPlayer, {
    ...makePlaybackCallbacks(),
    isIOSLike,
    getEstimatedDuration: (_bookId, chapterIndex) => estimateChapterPlaybackDuration(
      chapters[chapterIndex],
      chapterIndex
    ),
    getChapterCount: () => chapters.length,
    getContinuousEndChapter: (bookId, chapterIndex) => (
      isSleepTimerChapterTarget(bookId, chapterIndex) ? chapterIndex : null
    ),
    onChapterTransition: handleContinuousChapterTransition,
    onDiagnosticEvent: recordPlaybackEvent,
    resolveServedTier: async (bookId, chapterIndex) => {
      const status = await apiGet(`/api/chunks/${encodeURIComponent(bookId)}/${chapterIndex}/status`);
      return status?.servedTier || null;
    },
    resolveOfflineAudioUrl: offlinePlaybackUrl,
    ...options
  });
}

async function selectPlaybackEngineForChapter(bookId, chapterIndex, options = {}) {
  // Local availability alone decides this now — not connectivity.
  chunkedPlayer.preferStandardAudio = Boolean(options.offlineChapterAvailable);
  if (options.offlineChapterAvailable) {
    return {
      engine: chunkedPlayer,
      backend: 'single-file',
      reliability: ['active', 'Playing from this device'],
    };
  }
  return {
    engine: chunkedPlayer,
    backend: 'audio-stream',
    reliability: ['active', 'Continuous lock-screen playback']
  };
}

function applyPlaybackSelection(selection) {
  if (selection.reliability) setPlaybackReliabilityState(...selection.reliability);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Xandrio initialized');
  const deployment = await initDeploymentGuard({
    onChange: updated => {
      if (updated.serviceWorkerAllowed) void registerServiceWorker();
    }
  });

  // Sign-in gate. When a session later expires mid-playback (any 401), pause
  // so the local checkpoint survives, then the gate rises over the app.
  initLogin({
    onSessionExpired: () => {
      if (chunkPlayer?.isPlaying) {
        chunkPlayer.pause();
        updatePlaybackUI(false);
      }
      checkpointPlayback();
    }
  });
  let authStatus = null;
  try {
    authStatus = await fetchAuthStatus();
  } catch (err) {
    // Offline or server unreachable: continue booting so downloaded books
    // stay playable; API calls will surface their own errors.
    console.warn('Auth status unavailable:', err);
  }
  if (authStatus?.authenticationRequired && !authStatus.authenticated) {
    // Halt boot behind the gate; a successful sign-in reloads the app.
    serviceWorkerBootWindowOpen = false;
    showLoginGate({ tokenMode: !authStatus.accountsConfigured });
    return;
  }

  // Complete the bounded worker handoff before rendering library data or
  // installing any interactive handlers. This is the only interval in which a
  // controller-changing reload is permitted, so it must be genuinely idle.
  const workerReadiness = deployment.serviceWorkerAllowed
    ? await registerServiceWorker()
    : { ready: false, reason: 'deployment-disallowed' };
  serviceWorkerBootWindowOpen = false;
  if (workerReadiness.reason === 'reloading') return;

  initializeDOMElements();  // Initialize DOM elements first
  await loadClientSettings();
  initPlayerUI({
    getCurrentBook: () => currentBook,
    getCurrentChapter: () => currentChapter,
    getChapters: () => chapters,
    getChunkPlayer: () => chunkPlayer,
    getCurrentPlaybackSpeed,
    getCurrentChapterTime: () => chunkPlayer?.getCurrentTime?.() || 0,
    getCurrentBookFinished: () => currentBookFinished,
    getPlaybackBackend: () => playbackBackend,
    iconPlay: ICON_PLAY,
    iconPause: ICON_PAUSE,
    loadChapter,
    selectChapter,
    checkpointPlayback,
    renderBookmarksSection,
    haptic
  });
  syncTimeDisplayModeFromClientSettings();
  
  // The DOM media element is retained for the entire app lifetime. Online
  // playback keeps one source across the remaining book; explicit navigation
  // and downloaded/offline playback may replace that source.
  chunkedPlayer = createSingleFileChapterEngine();
  playbackSession.adoptEngine(chunkedPlayer, 'audio-stream');
  
  // Restore language preference (check both old and new keys for migration)
  const savedLanguage = readText('xandrio_default_language', 'en');
  if (languageFilter) {
    languageFilter.value = savedLanguage;
  }
  applySkipIntervalLabels();
  
  initLibrary({ openBook, navigateTo, addToListeningQueue, onBookDeleted: clearDeletedBookFromPlayer });
  initListeningQueue({ openBook });
  initSearch({ openBook, navigateTo });
  initSleepTimer({
    getCurrentBook: () => currentBook,
    getCurrentChapter: () => currentChapter,
    getChunkPlayer: () => chunkPlayer,
    updatePlaybackUI,
    savePosition,
    onChapterTargetChange: handleSleepTimerChapterTargetChange
  });
  initPlaybackSpeed({
    getChunkPlayer: () => chunkPlayer,
    getCurrentBook: () => currentBook,
    getCurrentBookPlaybackSettings: () => currentBookPlaybackSettings,
    isSmartRewindEnabled,
    isRollingOfflineEnabled,
    saveBookPlaybackSettings: saveCurrentBookPlaybackSettings,
    onSpeedChange: () => updateMediaSessionPosition()
  });
  initSettings({
    getCurrentBook: () => currentBook,
    getCurrentChapter: () => currentChapter,
    getChapters: () => chapters,
    getChunkPlayer: () => chunkPlayer,
    // Which tier the current chapter is actually playing (instant vs premium)
    getServedTier: () => chunkPlayer?.servedTier || chunkedPlayer?.servedTier || null,
    loadChapter,
    showAudioLoading,
    hideAudioLoading,
    updatePlaybackUI,
    checkpointPlayback,
    loadListeningQueue,
    syncTimeDisplayModeFromClientSettings,
    applySkipIntervalLabels
  });
  initStats({ openBook });
  initQueueStatus();
  await prepareOfflineStorage();
  initOffline({
    getCurrentBook: () => currentBook,
    getChapters: () => chapters,
    showAudioLoading,
    hideAudioLoading
  });
  loadLibrary();
  setupEventListeners();
  setupLifecycleHandlers();
  setupMediaSessionHandlers();
  setupPlaybackReportExport();

  // Hash routing (back button, deep links, reload-into-player). Runs last so
  // every view and listener above is ready before the initial route renders.
  initRouter({
    showView,
    openBook,
    isBookOpen: (bookId) => currentBook?.id === bookId,
  });

  initBookmarks({
    containerId: 'chapter-sheet-bookmarks',
    getCurrentBook: () => currentBook,
    getCurrentChapter: () => currentChapter,
    getCurrentTime: () => {
      const pos = chunkPlayer?.getPosition?.();
      return pos ? (pos.totalEstimatedTime || pos.currentTime || 0) : 0;
    },
    getChapterTitle: (index) => displayChapterTitle(chapters[index], index),
    selectChapter: (index, options) => selectChapter(index, options),
    seek: (seconds) => {
      invalidatePlaybackRecoveryForUserSeek();
      return chunkPlayer?.seek(seconds);
    },
    checkpointPlayback,
    savePosition,
    dismissChapterSheet: () => dismissChapterSheet(),
    onBookmarkAdded: () => {
      const buttons = [bookmarkBtn, document.getElementById('utility-bookmark-btn')].filter(Boolean);
      buttons.forEach(button => button.classList.add('bookmark-saved-flash'));
      setTimeout(() => buttons.forEach(button => button.classList.remove('bookmark-saved-flash')), 900);
    },
  });
  initPronunciationRepair({
    getCurrentBook: () => currentBook,
    getCurrentChapter: () => currentChapter,
    getChapters: () => chapters,
    getProgressPercent: () => chunkPlayer?.getProgressPercent?.() || chunkPlayer?.getPosition?.()?.progressPercent || 0,
    getNarrationPosition: () => {
      const position = chunkPlayer?.getPosition?.() || {};
      return {
        chunkIndex: position.chunkIndex,
        chunkTime: position.chunkTime,
        chunkDuration: position.chunkDuration,
        textLengths: chunkPlayer?.manifest?.chunks?.map(chunk => chunk.textLength) || []
      };
    },
    reloadCurrentChapter: () => loadChapter(currentChapter)
  });

  // Global keyboard shortcuts. Playback-related actions are guarded on
  // currentBook here (via closure) rather than inside keys.js, which stays
  // ignorant of app state.
  initKeys({
    togglePlay: () => { if (currentBook) togglePlayPause(); },
    getSkipInterval,
    skip: (seconds) => { if (currentBook) skip(seconds); },
    chapter: (direction) => { if (currentBook) changeChapter(direction); },
    speed: (direction) => { if (currentBook) stepPlaybackSpeed(direction); },
    chapters: () => { if (currentBook) openChapterSheet(); },
    voices: () => { if (currentBook) document.getElementById('voice-btn')?.click(); },
    bookmark: () => { if (currentBook) addBookmarkAtCurrentPosition(); },
    search: () => document.getElementById('library-search-toggle')?.click(),
    help: () => openShortcutOverlay(),
  });
});


function waitForWorkerState(worker, acceptedStates, timeoutMs = 8000) {
  if (!worker || acceptedStates.includes(worker.state)) return Promise.resolve(worker?.state || '');
  return new Promise(resolve => {
    const timer = window.setTimeout(() => finish(worker.state), timeoutMs);
    const finish = state => {
      window.clearTimeout?.(timer);
      worker.removeEventListener?.('statechange', onStateChange);
      resolve(state);
    };
    const onStateChange = () => {
      if (acceptedStates.includes(worker.state)) finish(worker.state);
    };
    worker.addEventListener?.('statechange', onStateChange);
  });
}

function isExpectedOfflineWorker(worker) {
  if (!worker?.scriptURL) return false;
  try {
    return new URL(worker.scriptURL, window.location.href).href
      === new URL(OFFLINE_WORKER_SCRIPT_URL, window.location.href).href;
  } catch {
    return false;
  }
}

function requestWaitingWorkerActivation(worker, timeoutMs = 2000) {
  if (!worker?.postMessage || typeof MessageChannel === 'undefined') return Promise.resolve(false);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => resolve(false), timeoutMs);
    channel.port1.onmessage = event => {
      window.clearTimeout?.(timer);
      resolve(event.data?.activationRequested === true);
    };
    try {
      worker.postMessage({ type: 'XANDRIO_ACTIVATE_WAITING' }, [channel.port2]);
    } catch {
      window.clearTimeout?.(timer);
      resolve(false);
    }
  });
}

function settleBeforeDeadline(promise, deadlineAt, fallback = null) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return Promise.resolve(fallback);
  return new Promise(resolve => {
    const timer = window.setTimeout(() => resolve(fallback), remainingMs);
    Promise.resolve(promise).then(
      value => {
        window.clearTimeout?.(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout?.(timer);
        resolve(fallback);
      }
    );
  });
}

async function prepareServiceWorkerForRouting() {
  if (!('serviceWorker' in navigator)) return { ready: false, reason: 'unsupported' };
  const deadlineAt = Date.now() + SERVICE_WORKER_BOOT_DEADLINE_MS;
  const initial = offlineWorkerControllerState();
  const current = initial.compatible
    ? initial
    : await certifyOfflineWorkerController({
      timeoutMs: Math.min(1500, Math.max(50, deadlineAt - Date.now()))
    }).catch(() => offlineWorkerControllerState());
  if (current.compatible && isExpectedOfflineWorker(navigator.serviceWorker.controller)) {
    window.sessionStorage?.removeItem?.(OFFLINE_WORKER_RELOAD_KEY);
    return { ready: true, reason: '' };
  }

  const registration = await settleBeforeDeadline(
    navigator.serviceWorker.register(OFFLINE_WORKER_SCRIPT_URL),
    deadlineAt
  );
  if (!registration) return { ready: false, reason: 'registration-timeout' };
  await settleBeforeDeadline(Promise.resolve(registration.update?.()), deadlineAt);
  if (Date.now() >= deadlineAt) return { ready: false, reason: 'registration-timeout' };
  let candidate = registration.waiting || registration.installing;
  if (candidate?.state === 'installing') {
    const state = await waitForWorkerState(
      candidate,
      ['installed', 'redundant'],
      Math.max(50, deadlineAt - Date.now())
    );
    if (state === 'redundant') candidate = null;
  }
  candidate = registration.waiting || candidate;
  if (
    candidate?.state === 'installed'
    && Date.now() < deadlineAt
    && serviceWorkerBootWindowOpen
  ) {
    const activationRequested = await requestWaitingWorkerActivation(
      candidate,
      Math.min(2000, Math.max(50, deadlineAt - Date.now()))
    );
    if (activationRequested) {
      await waitForWorkerState(
        candidate,
        ['activated', 'redundant'],
        Math.max(50, deadlineAt - Date.now())
      );
    }
  }

  // The waiting worker refuses activation while another window client exists:
  // skipWaiting itself would switch that tab's controller. Once this is the
  // only still-idle page, it reloads once so navigation starts under the active
  // compatible worker before the hash router can select a media source.
  const afterActivation = Date.now() < deadlineAt
    ? await certifyOfflineWorkerController({
      timeoutMs: Math.min(1500, Math.max(50, deadlineAt - Date.now()))
    }).catch(() => offlineWorkerControllerState())
    : offlineWorkerControllerState();
  if (afterActivation.compatible) {
    window.sessionStorage?.removeItem?.(OFFLINE_WORKER_RELOAD_KEY);
    return { ready: true, reason: '' };
  }
  // A first install can finish activation before `registration.waiting` or
  // `registration.installing` is observed. It is still safe to reload this
  // idle boot page when the registration's active worker is the exact script
  // requested by this build.
  const expectedActiveWorker = candidate?.state === 'activated'
    ? candidate
    : registration.active;
  if (isExpectedOfflineWorker(expectedActiveWorker) && expectedActiveWorker.state === 'activated') {
    const alreadyReloaded = window.sessionStorage?.getItem?.(OFFLINE_WORKER_RELOAD_KEY)
      === OFFLINE_WORKER_SCRIPT_URL;
    if (!alreadyReloaded && serviceWorkerBootWindowOpen) {
      window.sessionStorage?.setItem?.(OFFLINE_WORKER_RELOAD_KEY, OFFLINE_WORKER_SCRIPT_URL);
      window.location.reload();
      return { ready: false, reason: 'reloading' };
    }
  }
  return { ready: false, reason: 'worker-update-required' };
}

function registerServiceWorker() {
  if (serviceWorkerReadiness) return serviceWorkerReadiness;
  if (!('serviceWorker' in navigator)) {
    return Promise.resolve({ ready: false, reason: 'unsupported' });
  }
  const attempt = prepareServiceWorkerForRouting().catch(err => {
    console.warn('Service worker registration failed:', err);
    return { ready: false, reason: 'registration-failed' };
  });
  serviceWorkerReadiness = attempt;
  void attempt.then(result => {
    if (
      serviceWorkerReadiness === attempt
      && result?.ready !== true
      && result?.reason !== 'reloading'
    ) {
      serviceWorkerReadiness = null;
    }
  });
  return attempt;
}

function playbackReport() {
  const checkpoint = currentBook ? getLocalPlaybackCheckpoint(currentBook.id) : null;
  return {
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    isIOSLike: isIOSLike(),
    needsReliablePlayback: needsReliablePlayback(),
    standalone: window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)')?.matches,
    backend: playbackBackend,
    currentBook: currentBook ? { id: currentBook.id, title: currentBook.title, author: currentBook.author } : null,
    currentChapter,
    isPlaying: Boolean(chunkPlayer?.isPlaying),
    position: chunkPlayer?.getPosition?.() || null,
    checkpoint,
    reliabilityState: playbackReliability?.dataset?.state || null,
    mediaSessionSupported: 'mediaSession' in navigator,
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    offlineWorker: offlineWorkerControllerState(),
    events: playbackEventLedger.slice()
  };
}

function setupPlaybackReportExport() {
  window.xandrioPlaybackReport = playbackReport;
  window.exportXandrioPlaybackReport = () => {
    const text = JSON.stringify(playbackReport(), null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xandrio-playback-report-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

// Event Listeners
function setupEventListeners() {
  addBookBtn.addEventListener('click', () => navigateTo('search'));
  backToLibraryBtn.addEventListener('click', () => navigateTo('library'));
  backBtn.addEventListener('click', () => {
    savePosition();
    navigateTo('library');
  });

  playPauseBtn.addEventListener('click', () => { haptic(); togglePlayPause(); });
  playbackResumeBtn?.addEventListener('click', resumePlaybackFromPrompt);
  skipBackBtn.addEventListener('click', () => { haptic(); skip(-getSkipInterval()); });
  skipForwardBtn.addEventListener('click', () => { haptic(); skip(getSkipInterval()); });
  prevChapterBtn.addEventListener('click', () => { haptic(); changeChapter(-1); });
  nextChapterBtn.addEventListener('click', () => { haptic(); changeChapter(1); });

  // Mini player
  const miniPlayBtn = document.getElementById('mini-player-play');
  const miniBackBtn = document.getElementById('mini-player-back');
  const miniForwardBtn = document.getElementById('mini-player-forward');
  const miniTap = document.getElementById('mini-player-tap');
  const miniPlayerEl = document.getElementById('mini-player');
  if (miniPlayBtn) {
    miniPlayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlayPause();
    });
  }
  if (miniBackBtn) {
    miniBackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      skip(-getSkipInterval());
    });
  }
  if (miniForwardBtn) {
    miniForwardBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      skip(getSkipInterval());
    });
  }
  if (miniTap) {
    miniTap.addEventListener('click', (e) => {
      // Don't navigate if they clicked a mini-player button
      if (e.target.closest('.mini-player-btn')) return;
      if (currentBook) navigateTo('player', currentBook.id);
    });
  }

  // Swipe up on the mini-player opens the full player
  if (miniPlayerEl) {
    const SWIPE_THRESHOLD = 40;
    const SWIPE_CAP = 24;
    let swipeStartY = null;
    let swipeDragging = false;

    miniPlayerEl.addEventListener('touchstart', (e) => {
      if (e.target.closest('.mini-player-btn')) return;
      if (e.touches.length !== 1) return;
      swipeStartY = e.touches[0].clientY;
      swipeDragging = true;
      miniPlayerEl.style.transition = 'none';
    }, { passive: true });

    miniPlayerEl.addEventListener('touchmove', (e) => {
      if (!swipeDragging || swipeStartY === null) return;
      const dy = swipeStartY - e.touches[0].clientY;
      if (dy > 0) {
        e.preventDefault();
        miniPlayerEl.style.transform = `translateY(-${Math.min(dy, SWIPE_CAP)}px)`;
      }
    }, { passive: false });

    const endSwipe = (dy) => {
      swipeDragging = false;
      swipeStartY = null;
      miniPlayerEl.style.transition = '';
      miniPlayerEl.style.transform = '';
      if (dy >= SWIPE_THRESHOLD && currentBook) navigateTo('player', currentBook.id);
    };

    miniPlayerEl.addEventListener('touchend', (e) => {
      if (!swipeDragging || swipeStartY === null) return;
      const endY = e.changedTouches[0]?.clientY ?? swipeStartY;
      endSwipe(swipeStartY - endY);
    });

    miniPlayerEl.addEventListener('touchcancel', () => {
      if (!swipeDragging) return;
      endSwipe(0);
    });
  }

  // Chapter time label — tap to toggle total/remaining display
  const chapterProgressTotalEl = document.getElementById('chapter-progress-total');
  if (chapterProgressTotalEl) {
    chapterProgressTotalEl.addEventListener('click', toggleTimeDisplayMode);
    onActivate(chapterProgressTotalEl, () => toggleTimeDisplayMode());
  }

  // Progress slider — commit the seek on release, not on every input.
  // 'input' (dragging): update the thumb + time label locally only. No seek,
  // no network. 'change' (release): perform the seek exactly as before.
  progressSlider.addEventListener('input', (e) => {
    isScrubbing = true;
    paintScrubPreview(parseFloat(e.target.value));
  });
  progressSlider.addEventListener('change', (e) => {
    isScrubbing = false;
    if (chunkPlayer && getPlaybackProgressScope() === 'book') {
      seekAcrossBook(parseFloat(e.target.value)).catch(err => {
        console.error('Book seek failed:', err);
        paintChapterTimes({
          currentTime: chunkPlayer?.getCurrentTime?.() || 0,
          totalTime: chunkPlayer?.getTotalTime?.() || 0,
          progressPercent: chunkPlayer?.getProgressPercent?.() || 0
        });
      });
    } else if (chunkPlayer) {
      invalidatePlaybackRecoveryForUserSeek();
      const before = chunkPlayer.getCurrentTime?.() || 0;
      chunkPlayer.seekToPercent(parseFloat(e.target.value)).finally(() => {
        const after = chunkPlayer.getCurrentTime?.() || 0;
        checkpointPlayback();
        savePosition({ allowBackward: after < before });
        updateMediaSessionPosition();
      });
    }
  });

  // The persistent <audio id="audio-player"> element owns every playback
  // source, including online streams and downloaded chapters.

  chapterSelect.addEventListener('change', (e) => {
    const nextChapter = parseInt(e.target.value);
    selectChapter(nextChapter).catch(error => console.error('Chapter selection failed:', error));
  });
  // Bookmark button — bookmarks the current playback position.
  bookmarkBtn?.addEventListener('click', () => {
    if (currentBook) addBookmarkAtCurrentPosition();
  });
  pdfReprocessBtn?.addEventListener('click', async () => {
    if (!currentBook?.id || !currentBook.pdfReprocessable) return;
    const bookId = currentBook.id;
    pdfReprocessBtn.disabled = true;
    pdfReprocessBtn.textContent = 'Reprocessing…';
    try {
      await apiSend('POST', `/api/book/${encodeURIComponent(bookId)}/reprocess-pdf`);
      showToast('PDF chapters were rebuilt. Existing audio was cleared.', 'success');
      await openBook(bookId);
    } catch (error) {
      showToast(error.suggestion || error.message || 'Could not reprocess this PDF.', 'error');
    } finally {
      pdfReprocessBtn.disabled = false;
      pdfReprocessBtn.textContent = 'Reprocess chapters';
    }
  });

  document.getElementById('utility-timer-btn')?.addEventListener('click', () => timerBtnInline?.click());
  document.getElementById('utility-chapters-btn')?.addEventListener('click', openChapterSheet);
  document.getElementById('utility-bookmark-btn')?.addEventListener('click', () => {
    if (currentBook) addBookmarkAtCurrentPosition();
  });
  document.getElementById('utility-speed-btn')?.addEventListener('click', () => {
    document.getElementById('speed-sheet-btn')?.click();
  });

  startOverModalController = registerSheet(startOverModal, { bodyClass: '' });
  startOverBtn?.addEventListener('click', openStartOverModal);
  startOverConfirmBtn?.addEventListener('click', confirmStartOver);
  startOverCancelBtn?.addEventListener('click', closeStartOverModal);
  startOverModal?.addEventListener('click', (e) => {
    if (e.target === startOverModal) closeStartOverModal();
  });

  shortcutOverlayController = registerSheet(shortcutOverlay, { bodyClass: '' });
  shortcutOverlayClose?.addEventListener('click', closeShortcutOverlay);
  shortcutOverlay?.addEventListener('click', (e) => {
    if (e.target === shortcutOverlay) closeShortcutOverlay();
  });
}

// View Management
function showView(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  if (viewName !== 'player') closeTransientSheets();

  switch(viewName) {
    case 'library':
      libraryView.classList.add('active');
      break;
    case 'search':
      searchView.classList.add('active');
      document.getElementById('search-input')?.focus();
      break;
    case 'player':
      playerView.classList.add('active');
      break;
    case 'settings':
      document.getElementById('settings-view')?.classList.add('active');
      break;
    case 'stats':
      document.getElementById('stats-view')?.classList.add('active');
      break;
  }

  // Mini player: show on non-player views when a book is loaded
  updateMiniPlayer(viewName);

  // Let feature modules react to navigation (settings loads its data on entry).
  document.dispatchEvent(new CustomEvent('xandrio:viewchange', { detail: { view: viewName } }));
}

function closeTransientSheets() {
  closeChapterSheet();
  closeVoiceSheetDirect();
  if (shortcutOverlay) shortcutOverlay.classList.remove('active');
  if (startOverModal) startOverModal.classList.remove('active');
  closeSleepTimerModal();
  closeSpeedSheet();
  startOverModalController?.close();
  shortcutOverlayController?.close();
  document.body.classList.remove('sheet-open');
  // These sheets were closed outside the back-button path; drop their
  // history-backed closers so a later back press doesn't re-run them.
  clearSheetStack();
}

async function clearDeletedBookFromPlayer(bookId) {
  if (!currentBook || String(currentBook.id) !== String(bookId)) return;
  loadChapterToken++;
  clearTimeout(pendingServerPositionTimer);
  pendingServerPositionTimer = null;
  const retiredEngines = new Set([chunkPlayer, chunkedPlayer].filter(Boolean));
  for (const engine of retiredEngines) {
    try { engine.cancelPendingLoad?.(); } catch {}
    try { engine.pause?.(); } catch {}
    try { engine.dispose?.(); } catch {}
  }

  chunkedPlayer = createSingleFileChapterEngine();
  playbackSession.setBook(null);
  playbackSession.adoptEngine(chunkedPlayer, 'audio-stream');
  chapters = [];
  currentBookPlaybackSettings = {};
  currentBookOfflineFallback = false;
  currentBookFinished = false;
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = null; } catch {}
    try { navigator.mediaSession.playbackState = 'none'; } catch {}
  }
  updateMiniPlayer('library');
  updatePlaybackUI(false);
}

// Player Functions
async function openBook(bookId) {
  // Keep the address bar/history in sync no matter who called us (router,
  // library tap, post-download/upload flow).
  syncPlayerHash(bookId);
  try {
    let data;
    let usedOfflineFallback = false;
    try {
      data = await apiGet(`/api/book/${encodeURIComponent(bookId)}`);
    } catch (error) {
      // A full offline download includes the title/chapter snapshot needed to
      // rebuild the player after a cold launch. Do not mask authoritative
      // server errors (404/401) while online with an obsolete local copy.
      const localData = (!navigator.onLine || !error?.status)
        ? getOfflineBookData(bookId)
        : null;
      if (!localData) throw error;
      data = localData;
      usedOfflineFallback = true;
    }

    currentBook = data.book;
    chapters = data.chapters;
    currentBookOfflineFallback = usedOfflineFallback;
    if (usedOfflineFallback && !navigator.onLine) {
      const fallbackBookId = String(currentBook.id);
      window.addEventListener('online', () => {
        if (String(currentBook?.id || '') === fallbackBookId) currentBookOfflineFallback = false;
      }, { once: true });
    }
    currentBookFinished = false;
    currentBookPlaybackSettings = await getBookPlaybackSettings(bookId);

    // Cache chapter count for library progress bars (see bookProgressInfo)
    if (Array.isArray(chapters) && chapters.length > 0) {
      cacheBookMeta(bookId, { chapterCount: chapters.length });
    }

    // Display book title
    bookTitle.textContent = currentBook.title;

    // Display author in header (compact)
    if (currentBook.author) {
      bookAuthorHeader.textContent = `by ${currentBook.author}`;
    } else {
      bookAuthorHeader.textContent = '';
    }

    // Display description if available
    const cleanDescription = cleanDisplayText(currentBook.description);
    if (cleanDescription) {
      bookDescription.textContent = cleanDescription;
    } else if (currentBook.subjects && currentBook.subjects.length > 0) {
      bookDescription.textContent = currentBook.subjects.slice(0, 5).join(' • ');
    } else {
      bookDescription.textContent = 'No description available from this source.';
    }

    // Display additional details (publisher, year, etc.)
    const detailsParts = [];
    if (currentBook.publishedDate) {
      detailsParts.push(`Published: ${currentBook.publishedDate}`);
    }
    if (currentBook.publisher) {
      detailsParts.push(`Publisher: ${currentBook.publisher}`);
    }
    if (currentBook.language) {
      detailsParts.push(`Language: ${currentBook.language.toUpperCase()}`);
    }
    if (currentBook.sourceFormat) {
      detailsParts.push(`Source: ${currentBook.sourceFormat}`);
    }
    const pdfStructure = currentBook.pdfExtraction?.structure;
    if (pdfStructure?.mode) {
      const modeLabel = {
        outline: 'bookmarks',
        toc: 'table of contents',
        'detected-headings': 'detected headings',
        'page-groups': 'page groups'
      }[pdfStructure.mode] || pdfStructure.mode;
      const confidence = Number(pdfStructure.confidence);
      detailsParts.push(`PDF chapters: ${modeLabel}${Number.isFinite(confidence) ? ` (${Math.round(confidence * 100)}%)` : ''}`);
    }
    const pdfNeedsReview = currentBook.pdfExtraction?.status === 'review-needed';
    if (pdfStructureReview) {
      pdfStructureReview.hidden = !pdfNeedsReview;
      if (pdfNeedsReview) {
        pdfStructureReviewDetail.textContent = currentBook.pdfExtraction.statusReason ||
          'Authored chapter boundaries could not be confirmed.';
        pdfReprocessBtn.hidden = !currentBook.pdfReprocessable;
      }
    }
    
    if (detailsParts.length > 0) {
      bookDetailsText.textContent = detailsParts.join(' • ');
    } else {
      bookDetailsText.textContent = '';
    }
    
    // Load book cover
    const coverUrl = `${API_BASE}/api/cover/${encodeURIComponent(bookId)}`;
    bookCover.src = coverUrl;
    bookCover.alt = `Cover of ${currentBook.title} by ${currentBook.author}`;

    // Handle cover load error gracefully — fall back to a lettered placeholder
    // instead of hiding the cover entirely.
    bookCover.onerror = () => {
      bookCover.onerror = null;
      bookCover.src = coverPlaceholderSrc(currentBook.title);
      console.log('No cover available for this book');
    };
    updatePlayerAmbient(coverUrl);

    // Populate chapter select
    chapterSelect.innerHTML = chapters.map((ch, i) => {
      // Skip empty dividers/covers in the dropdown
      if (ch.empty) return '';
      // Dim non-content types (backmatter, etc.)
      const prefix = ch.type === 'divider' ? '── ' : '';
      const dur = formatDuration(ch.estimatedDuration);
      const durSuffix = dur ? ` (${dur})` : '';
      return `<option value="${i}">${escapeHTML(prefix + displayChapterTitle(ch, i) + durSuffix)}</option>`;
    }).join('');
    
    const storedLocalCheckpoint = getLocalPlaybackCheckpoint(bookId);
    const localCheckpoint = positionMatchesChapterStructure(storedLocalCheckpoint, currentBook)
      ? storedLocalCheckpoint
      : null;
    let positionData = {};
    try {
      positionData = await apiGet(`/api/position/${encodeURIComponent(bookId)}`);
    } catch (err) {
      console.warn('Failed to load server position:', err);
    }

    const serverCheckpoint = normalizeServerPosition(positionData.position);
    const restorePosition = chooseFreshestPosition(localCheckpoint, serverCheckpoint);
    const reconcileBackward = restorePosition === localCheckpoint &&
      shouldAllowBackwardReconciliation(localCheckpoint, serverCheckpoint);
    currentBookFinished = Boolean(restorePosition?.finished);
    let chapterToLoad = 0;

    if (restorePosition) {
      chapterToLoad = restorePosition.chapterIndex;
    } else {
      const firstChapterIndex = findPreferredStartChapterIndex(chapters);
      console.log(`Starting at chapter ${firstChapterIndex}: "${chapters[firstChapterIndex].title}" (type: ${chapters[firstChapterIndex].type})`);
      chapterToLoad = firstChapterIndex;
    }

    chapterToLoad = Math.max(0, Math.min(chapters.length - 1, Number(chapterToLoad) || 0));

    currentChapter = chapterToLoad;
    playbackSession.setBook(currentBook, {
      chapterIndex: chapterToLoad,
      finished: currentBookFinished
    });
    chapterSelect.value = currentChapter;
    updateChapterTrigger();
    renderChapterList();
    syncMiniPlayerInfo();
    renderOfflineState();
    updateMediaSessionMetadata();

    showView('player');
    loadVoices();
    
    // Load saved playback speed
    loadPlaybackSpeed(currentBookPlaybackSettings.playbackSpeed);
    
    // Restore sleep timer if active
    restoreSleepTimer();

    const chapterLoad = await loadChapter(chapterToLoad);
    if (chapterLoad?.loaded !== true) {
      updatePlaybackUI(false);
      return true;
    }
    // Seek to the saved chapter position on the persistent media element.
    await restorePlaybackPosition(chunkPlayer, restorePosition);
    checkpointPlayback();
    updatePlaybackUI();
    if (reconcileBackward) {
      await savePosition({ allowBackward: true, force: true });
    }
    
    return true;
  } catch (err) {
    console.error('Failed to open book:', err);
    showToast("Couldn't open book", 'error');
    return false;
  }
}

let loadChapterToken = 0;

function clearBlockedWorkerOnlineRetry() {
  if (!blockedWorkerOnlineRetry) return;
  window.removeEventListener('online', blockedWorkerOnlineRetry);
  blockedWorkerOnlineRetry = null;
}

async function loadChapter(index, options = {}) {
  if (!Number.isInteger(index) || index < 0 || index >= chapters.length) {
    return { loaded: false, reason: 'invalid-chapter' };
  }
  clearBlockedWorkerOnlineRetry();
  if (!['automatic-recovery', 'manual-recovery'].includes(options.reason)) {
    clearPlaybackRecoveryTimers();
    automaticRecoveryAttempts = 0;
  }
  // Latest-wins: rapid chapter switches invoke this concurrently; only the
  // most recent call may keep mutating player state after its awaits.
  const token = ++loadChapterToken;
  const previousChapter = currentChapter;

  const wasPlaying = chunkPlayer ? chunkPlayer.isPlaying : false;
  recordPlaybackEvent({
    type: 'load-chapter',
    reason: options.reason || (index === currentChapter ? 'reload' : 'navigation'),
    chapterIndex: index,
    online: navigator.onLine
  });
  if (chunkPlayer) chunkPlayer.pause();
  updatePlaybackUI(false);
  checkpointPlayback();

  playbackSession.setBook(currentBook, {
    chapterIndex: index,
    finished: currentBookFinished
  });
  if (options.provisionalForward) playbackSession.markProvisionalForward(previousChapter, index);
  else if (options.commitImmediately) playbackSession.clearProvisionalForward();
  const chapter = chapters[currentChapter];
  refreshVoicePrepPanel();

  chapterSelect.value = currentChapter;
  syncPlaybackProgressScope();
  updateChapterTrigger();
  renderChapterList();
  syncMiniPlayerInfo();
  updateMediaSessionMetadata();

  // Show loading indicator immediately
  showAudioLoading(`Loading: ${displayChapterTitle(chapter, currentChapter)}...`);

  // Local-first: a chapter that is already on this device is played from this
  // device whether or not there is a network. Connectivity used to gate this
  // check, so a fully downloaded book streamed anyway whenever the phone had
  // signal — the download was verified, stored and then ignored.
  //
  // The check is presence-only and therefore cheap enough for the load path;
  // see localChapterSource in js/features/offline.js.
  const offlineMode = !navigator.onLine || currentBookOfflineFallback;
  const local = options.bypassLocalSource
    ? { available: false, reason: 'explicit-stream' }
    : ONLINE_LOCAL_FIRST_ENABLED || offlineMode
    ? await localChapterSource(currentBook.id, index)
    : { available: false };
  if (token !== loadChapterToken) return { loaded: false, reason: 'stale' };
  const offlineChapterAvailable = local.available;
  recordPlaybackEvent({
    type: 'local-source-decision',
    reason: offlineChapterAvailable ? 'cache-hit' : (local.reason || 'not-cached'),
    chapterIndex: index,
    online: navigator.onLine
  });
  if (local.reason === 'worker-update-required' && local.cached) {
    const workerState = offlineWorkerControllerState();
    const canStreamInstead = navigator.onLine === true;
    hideAudioLoading();
    setPlaybackReliabilityState('resume', 'Finishing offline playback update');
    setChunkOverlayState('error', {
      message: workerState.controlled
        ? 'Xandrio needs to finish updating'
        : 'Downloaded audio needs the offline player',
      detail: canStreamInstead
        ? 'Your download is still safe. Close other Xandrio tabs and reload, or stream this chapter now.'
        : 'Your download is still safe. Reconnect, close other Xandrio tabs, and reload Xandrio.',
      retryLabel: canStreamInstead ? 'Stream instead' : 'Reload',
      onRetry: canStreamInstead
        ? () => {
            clearBlockedWorkerOnlineRetry();
            void loadChapter(index, {
              ...options,
              reason: 'explicit-stream',
              bypassLocalSource: true
            });
          }
        : () => window.location.reload()
    });
    showToast(
      canStreamInstead
        ? 'Downloaded audio is safe — local playback is waiting for the update'
        : 'Downloaded audio is safe — reconnect to finish the update',
      'error'
    );
    recordPlaybackEvent({
      type: 'local-source-blocked',
      reason: local.reason,
      chapterIndex: index
    });
    clearBlockedWorkerOnlineRetry();
    if (!canStreamInstead) {
      const blockedBookId = currentBook?.id || '';
      blockedWorkerOnlineRetry = () => {
        blockedWorkerOnlineRetry = null;
        if (currentBook?.id === blockedBookId && currentChapter === index) {
          void loadChapter(index, options);
        }
      };
      window.addEventListener('online', blockedWorkerOnlineRetry, { once: true });
    }
    return { loaded: false, reason: local.reason };
  }
  clearBlockedWorkerOnlineRetry();
  // navigator.onLine can remain true through a transient metadata failure. If
  // that local snapshot points at an evicted chapter, let normal network
  // playback recover instead of pinning the player to an offline error.
  if (offlineMode && !offlineChapterAvailable && navigator.onLine) {
    currentBookOfflineFallback = false;
  }
  if (!navigator.onLine && !offlineChapterAvailable) {
    setChunkOverlayState('offline', {
      message: "You're offline",
      detail: 'This book isn’t downloaded. It will start when you’re back online.'
    });
    updatePlaybackUI(false);
    const resumeWhenOnline = () => {
      currentBookOfflineFallback = false;
      if (currentBook?.id && currentChapter === index) loadChapter(index);
    };
    window.addEventListener('online', resumeWhenOnline, { once: true });
    return { loaded: false, reason: 'offline-unavailable' };
  }

  const selection = await selectPlaybackEngineForChapter(currentBook.id, index, {
    offlineChapterAvailable,
    offlineMode
  });
  if (token !== loadChapterToken) return { loaded: false, reason: 'stale' };
  let transition;
  try {
    transition = await playbackSession.transitionTo({
      book: currentBook,
      chapterIndex: index,
      engine: selection.engine,
      backend: selection.backend,
      // Only a streamed source can be opened at an offset; a local chapter is a
      // finite, freely seekable file and needs no tuple.
      sourceTuple: offlineChapterAvailable ? null : recoverySourceTuple(options.sourceTuple, index),
      play: false,
      preservePosition: false,
      disposePrevious: false,
      commitImmediately: options.commitImmediately
    });
  } catch (error) {
    // Local playback failed. Hand off to the network exactly once, and say so:
    // silently streaming a book the user downloaded is how this stopped being
    // noticed in the first place. Nothing durable is written here — Safari
    // raises transient media errors often enough that acting on one would
    // destroy good downloads. classifyLocalChapter decides that, off this path.
    const recoverable = offlineChapterAvailable
      && !options.localFallbackUsed
      && navigator.onLine
      && !error?.cancelled;
    if (!recoverable) throw error;
    if (token !== loadChapterToken) return { loaded: false, reason: 'stale' };
    markLocalChapterSuspect(currentBook.id, index);
    const bookId = currentBook.id;
    void classifyLocalChapter(bookId, index)
      .then(verdict => {
        if (verdict !== 'transient') renderOfflineState({ audit: false });
      })
      .catch(() => {});
    setPlaybackReliabilityState('active', 'Streaming · checking your download');
    return await loadChapter(index, { ...options, localFallbackUsed: true });
  }
  if (transition.stale) return { loaded: false, reason: 'stale' };
  applyPlaybackSelection(selection);
  chunkPlayer?.setSpeed?.(getCurrentPlaybackSpeed());
  if (token !== loadChapterToken) return { loaded: false, reason: 'stale' };
  // A continuous source opened directly at the resume position needs no seek,
  // and issuing one can undo the work: seek() clamps to the *estimated* chapter
  // duration, so an underestimate drags the target out of the buffered range and
  // relocates the stream — a second session to reach where it already was.
  // Finite sources (local files, chapter fallback) still seek normally.
  if (
    Number.isFinite(options.seekToSeconds)
    && !chunkPlayer.openedAtOffset?.(index, options.seekToSeconds)
  ) {
    await chunkPlayer.seek(Math.max(0, options.seekToSeconds));
    if (token !== loadChapterToken) return { loaded: false, reason: 'stale' };
  }
  // Never compete with first-play streaming for bandwidth or storage. Offline
  // downloads remain available only through the user's explicit action.
  checkpointPlayback();
  // The media adapter calls onReady/onWaiting callbacks.

  if (wasPlaying) {
    try {
      await chunkPlayer.play();
      if (token !== loadChapterToken) return { loaded: false, reason: 'stale' };
      updatePlaybackUI(true);
    } catch (err) {
      if (token !== loadChapterToken) return { loaded: false, reason: 'stale' };
      try { chunkPlayer.pause?.(); } catch {}
      console.warn('Chapter playback could not resume:', err);
      updatePlaybackUI(false);
    }
  }
  return { loaded: true, reason: '' };
}

async function selectChapter(nextChapter, options = {}) {
  return navigateChapterSelection({
    nextChapter,
    chapterCount: chapters.length,
    getCurrentChapter: () => currentChapter,
    checkpointPlayback,
    savePosition,
    loadChapter,
    ...options
  });
}

async function seekAcrossBook(percent) {
  const target = getBookSeekTarget(percent);
  if (!target || !chunkPlayer) return;
  invalidatePlaybackRecoveryForUserSeek();

  const fromChapter = currentChapter;
  const before = chunkPlayer.getCurrentTime?.() || 0;
  if (target.chapterIndex === currentChapter) {
    await chunkPlayer.seek(target.chapterTime);
    checkpointPlayback();
    savePosition({ allowBackward: target.chapterTime < before, force: true });
    updateMediaSessionPosition();
    return;
  }

  savePosition({ allowBackward: target.chapterIndex < fromChapter, force: true });
  const loaded = await loadChapter(target.chapterIndex, {
    provisionalForward: target.chapterIndex > fromChapter,
    seekToSeconds: target.chapterTime
  });
  if (loaded?.loaded !== true) return;
  checkpointPlayback();
  savePosition({ allowBackward: target.chapterIndex < fromChapter, force: true });
  updateMediaSessionPosition();
}

async function resumePlaybackFromPrompt() {
  setResumePromptVisible(false);
  await togglePlayPause(true);
}

function smartRewindIsEnabled() {
  return currentBookPlaybackSettings.smartRewindEnabled ?? isSmartRewindEnabled();
}

async function saveCurrentBookPlaybackSettings(bookId, settings) {
  const saved = await saveBookPlaybackSettings(bookId, settings);
  if (currentBook?.id === bookId) {
    currentBookPlaybackSettings = { ...saved };
  }
  return saved;
}

function recordSmartRewindPause() {
  if (!currentBook || !chunkPlayer || !smartRewindIsEnabled()) return;
  smartRewind.recordPause({
    bookId: currentBook.id,
    chapterIndex: currentChapter,
    positionSeconds: chunkPlayer.getCurrentTime?.() || 0
  });
}

// A rewind that could not be applied yet, kept so it can be retried once the
// stream has buffered the target. Never retried by reloading the source.
let deferredSmartRewind = null;

// Synchronous by contract: every caller runs inside an iOS user-activation
// window and must reach audio.play() without awaiting. See applyRewindForResume.
function applySmartRewindForResume() {
  deferredSmartRewind = null;
  if (!currentBook || !chunkPlayer) {
    smartRewind.clear();
    return;
  }
  const outcome = applyRewindForResume({
    controller: smartRewind,
    player: chunkPlayer,
    bookId: currentBook.id,
    chapterIndex: currentChapter,
    positionSeconds: chunkPlayer.getCurrentTime?.() || 0,
    enabled: smartRewindIsEnabled()
  });
  if (outcome.status === 'applied') {
    showToast(`Smart rewind · ${outcome.rewindSeconds} seconds`);
  } else if (outcome.status === 'deferred') {
    // Only claim a rewind that actually happened.
    deferredSmartRewind = {
      bookId: currentBook.id,
      chapterIndex: currentChapter,
      ...outcome
    };
  }
}

// Retried after playback starts, when the target may have become buffered.
// Silently abandoned otherwise — resuming matters more than the rewind.
function retryDeferredSmartRewind() {
  const pending = deferredSmartRewind;
  if (!pending || !chunkPlayer || !currentBook) return;
  if (pending.bookId !== currentBook.id || pending.chapterIndex !== currentChapter) {
    deferredSmartRewind = null;
    return;
  }
  if (chunkPlayer.trySeekSync?.(pending.targetSeconds)) {
    deferredSmartRewind = null;
    showToast(`Smart rewind · ${pending.rewindSeconds} seconds`);
  }
}

async function togglePlayPause(forcePlay = false) {
  forcePlay = forcePlay === true;
  if (!currentBook || !chunkPlayer) return;
  try {
    if (forcePlay || !chunkPlayer.isPlaying) {
      // Nothing may be awaited between here and play(): iOS revokes the user
      // activation from the tap at the first await.
      applySmartRewindForResume();
      await chunkPlayer.play();
      setResumePromptVisible(false);
      updatePlaybackUI(true);
    } else {
      recordSmartRewindPause();
      chunkPlayer.pause();
      updatePlaybackUI(false);
    }
    checkpointPlayback();
    scheduleServerPositionSave();
  } catch (err) {
    updatePlaybackUI(false);
    if (needsReliablePlayback() && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      console.error('Playback error:', err);
      setResumePromptVisible(true);
    } else {
      handleChunkError(err);
    }
  }
}


function updatePlaybackUI(forcePlaying = null) {
  let isPlaying = forcePlaying !== null ? forcePlaying : Boolean(chunkPlayer && chunkPlayer.isPlaying);
  if (chunkPlayer?.supportsNativeMediaSession && audioPlayer) {
    isPlaying = forcePlaying !== null ? forcePlaying : !audioPlayer.paused;
  }
  if (playPauseBtn) playPauseBtn.innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY;
  syncMiniPlayerIcon();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
}

function setCurrentBookFinished(finished) {
  playbackSession.setFinished(finished);
}



function checkpointUpdatedAtMs(position) {
  if (!position) return 0;
  if (typeof position.updatedAt === 'number') return position.updatedAt;
  if (typeof position.updatedAtMs === 'number') return position.updatedAtMs;
  const parsed = Date.parse(position.updatedAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeServerPosition(position) {
  if (!position) return null;
  return {
    ...position,
    updatedAt: checkpointUpdatedAtMs(position),
    chunkIndex: Number.isInteger(position.chunkIndex) ? position.chunkIndex : undefined,
    chunkTime: Number.isFinite(Number(position.chunkTime)) ? Number(position.chunkTime) : 0
  };
}

function chooseFreshestPosition(localPosition, serverPosition) {
  if (!localPosition) return serverPosition;
  if (!serverPosition) return localPosition;
  return checkpointUpdatedAtMs(localPosition) >= checkpointUpdatedAtMs(serverPosition) ? localPosition : serverPosition;
}

function checkpointKey(bookId = currentBook?.id) {
  return bookId ? `${PLAYBACK_CHECKPOINT_PREFIX}${bookId}` : null;
}

function buildPlaybackCheckpoint(options = {}) {
  const checkpoint = playbackSession.buildCheckpoint({
    ...options,
    playbackRate: getCurrentPlaybackSpeed()
  });
  if (!checkpoint || !currentBook?.chapterStructureKey) return checkpoint;
  return { ...checkpoint, chapterStructureKey: currentBook.chapterStructureKey };
}

function checkpointPlayback(options = {}) {
  const now = Date.now();
  if (options.throttle && now - lastCheckpointSaveAt < CHECKPOINT_SAVE_MIN_INTERVAL_MS) return;
  const checkpoint = buildPlaybackCheckpoint(options);
  const key = checkpointKey(checkpoint?.bookId);
  if (!checkpoint || !key) return;
  try {
    writeJSON(key, checkpoint);
    lastCheckpointSaveAt = now;
  } catch (err) {
    console.warn('Failed to checkpoint playback:', err);
  }
}

function getLocalPlaybackCheckpoint(bookId) {
  const key = checkpointKey(bookId);
  if (!key) return null;
  try {
    const parsed = readJSON(key, null);
    if (!parsed || parsed.bookId !== bookId) return null;
    if (!Number.isInteger(parsed.chapterIndex) || parsed.chapterIndex < 0) return null;
    if (Number.isInteger(parsed.chunk) && !Number.isInteger(parsed.chunkIndex)) parsed.chunkIndex = parsed.chunk;
    if (!Number.isFinite(parsed.chunkTime)) parsed.chunkTime = 0;
    if (typeof parsed.updatedAt === 'number' && Date.now() - parsed.updatedAt > 1000 * 60 * 60 * 24 * 30) return null;
    return parsed;
  } catch {
    return null;
  }
}

function scheduleServerPositionSave(delay = 800) {
  clearTimeout(pendingServerPositionTimer);
  pendingServerPositionTimer = setTimeout(() => savePosition(), delay);
}

function updateMediaSessionMetadata() {
  if (!('mediaSession' in navigator) || !('MediaMetadata' in window) || !currentBook) return;
  const chapter = chapters[currentChapter];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: chapter ? displayChapterTitle(chapter, currentChapter) : currentBook.title,
    artist: currentBook.author || 'Unknown Author',
    album: currentBook.title || 'Xandrio',
    artwork: [{ src: `${API_BASE}/api/cover/${encodeURIComponent(currentBook.id)}`, sizes: '512x512', type: 'image/jpeg' }]
  });
}

function updateMediaSessionPosition(data = null) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !chunkPlayer) return;
  const duration = data?.totalTime || chunkPlayer.getTotalTime?.() || 0;
  const position = data?.currentTime || chunkPlayer.getCurrentTime?.() || 0;
  if (duration > 0) {
    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate: getCurrentPlaybackSpeed(), position: Math.min(position, duration) });
    } catch {}
  }
}

function isNativeSingleFileReady() {
  return Boolean(
    audioPlayer &&
    audioPlayer.src &&
    chunkPlayer?.supportsNativeMediaSession
  );
}

async function resumeNativeSingleFileFromMediaSession() {
  if (!isNativeSingleFileReady()) return false;
  try {
    // Same activation contract as togglePlayPause: the lock screen and Control
    // Center grant activation for exactly one synchronous play() call.
    applySmartRewindForResume();
    await chunkPlayer.play();
    setResumePromptVisible(false);
    updatePlaybackUI(true);
    checkpointPlayback();
    scheduleServerPositionSave();
    return true;
  } catch (err) {
    chunkPlayer.pause();
    updatePlaybackUI(false);
    console.warn('Lock-screen native resume failed:', err);
    return false;
  }
}

function pauseNativeSingleFileFromMediaSession() {
  if (!isNativeSingleFileReady()) return false;
  recordSmartRewindPause();
  chunkPlayer.pause();
  navigator.mediaSession.playbackState = 'paused';
  updatePlaybackUI(false);
  checkpointPlayback();
  scheduleServerPositionSave();
  return true;
}

function setupMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: async () => {
      if (await resumeNativeSingleFileFromMediaSession()) return;
      if (chunkPlayer) await togglePlayPause(true);
    },
    pause: async () => {
      if (!chunkPlayer) return;
      if (pauseNativeSingleFileFromMediaSession()) return;
      if (chunkPlayer.isPlaying) {
        await togglePlayPause();
      } else if (chunkPlayer.supportsNativeMediaSession && audioPlayer && !audioPlayer.paused) {
        recordSmartRewindPause();
        audioPlayer.pause();
        updatePlaybackUI(false);
      }
    },
    seekbackward: () => skip(-getSkipInterval()),
    seekforward: () => skip(getSkipInterval()),
    previoustrack: () => changeChapter(-1),
    nexttrack: () => changeChapter(1),
    seekto: async (details) => {
      if (!chunkPlayer || typeof details.seekTime !== 'number') return;
      invalidatePlaybackRecoveryForUserSeek();
      await chunkPlayer.seek(details.seekTime);
      checkpointPlayback();
      savePosition({ allowBackward: true });
      updateMediaSessionPosition();
    }
  };
  Object.entries(handlers).forEach(([action, handler]) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
  });
  updatePlaybackUI();
}

function setupLifecycleHandlers() {
  document.addEventListener('visibilitychange', () => {
    recordPlaybackEvent({
      type: 'visibilitychange',
      visibility: document.visibilityState,
      online: navigator.onLine
    });
    checkpointPlayback();
    if (document.visibilityState === 'hidden' && !beaconSavePosition()) savePosition();
    updatePlaybackUI();
  });
  window.addEventListener('pagehide', () => {
    recordPlaybackEvent({ type: 'pagehide', online: navigator.onLine });
    checkpointPlayback();
    if (!beaconSavePosition()) savePosition();
  });
  window.addEventListener('pageshow', () => {
    recordPlaybackEvent({ type: 'pageshow', online: navigator.onLine });
    updatePlaybackUI();
    updateMediaSessionMetadata();
    updateMediaSessionPosition();
  });
}

async function skip(seconds) {
  if (chunkPlayer) {
    invalidatePlaybackRecoveryForUserSeek();
    await chunkPlayer.skip(seconds);
    checkpointPlayback();
    savePosition({ allowBackward: seconds < 0 });
    updateMediaSessionPosition();
  }
}

function changeChapter(direction) {
  const newChapter = currentChapter + direction;
  if (newChapter >= 0 && newChapter < chapters.length) {
    selectChapter(newChapter).catch(error => console.error('Chapter change failed:', error));
  }
}

async function handleAudioEnd(detail = {}) {
  checkpointPlayback();
  if (detail.reason === 'continuous-limit') {
    recordPlaybackEvent({
      type: 'sleep-timer-stop',
      reason: 'server-end-chapter-limit',
      chapterIndex: currentChapter,
      streamTime: audioPlayer?.currentTime
    });
    expireSleepTimer('chapter');
    return;
  }
  if (isSleepTimerChapterTarget(currentBook?.id, currentChapter)) {
    if (currentChapter >= chapters.length - 1) {
      setCurrentBookFinished(true);
      checkpointPlayback({ force: true, finished: true });
      await savePosition({ force: true, finished: true });
      updateBookProgress();
    }
    expireSleepTimer('chapter');
    return;
  }
  // Continuous online playback advances chapters inside one native resource;
  // `ended` is the end of the remaining book, never a chapter handoff.
  if (chunkPlayer?.isContinuous && currentChapter < chapters.length - 1) return;
  // Auto-advance to next chapter
  if (currentChapter < chapters.length - 1) {
    if (chunkPlayer?.supportsNativeMediaSession && audioPlayer) {
      // Let the already-authorized native element continue when its source
      // changes. Calling play() here is rejected by mobile browsers once the
      // PWA is backgrounded, even though the listener started playback.
      const clearAutoplay = () => {
        audioPlayer.autoplay = false;
        audioPlayer.removeEventListener('playing', clearAutoplay);
      };
      audioPlayer.autoplay = true;
      audioPlayer.addEventListener('playing', clearAutoplay, { once: true });
      try {
        const loaded = await loadChapter(currentChapter + 1, { commitImmediately: true });
        if (loaded?.loaded !== true) {
          clearAutoplay();
          updatePlaybackUI(false);
          return;
        }
      } catch (err) {
        clearAutoplay();
        console.error('Native auto-advance failed:', err);
        updatePlaybackUI(false);
      }
    } else {
      const loaded = await loadChapter(currentChapter + 1, { commitImmediately: true });
      if (loaded?.loaded !== true) {
        updatePlaybackUI(false);
        return;
      }
      try {
        await chunkPlayer.play();
        updatePlaybackUI(true);
      } catch (err) {
        console.error('Auto-advance play failed:', err);
        updatePlaybackUI(false);
      }
    }
  } else {
    setCurrentBookFinished(true);
    updatePlaybackUI(false);
    checkpointPlayback({ force: true, finished: true });
    await savePosition({ force: true, finished: true });
    updateBookProgress();
    try {
      const result = await advanceListeningQueue(currentBook.id);
      if (result.nextBookId) {
        const opened = await openBook(result.nextBookId);
        if (opened) await togglePlayPause(true);
      } else {
        await loadListeningQueue();
      }
    } catch (error) {
      console.warn('Up Next could not continue:', error);
    }
    return;
  }
  checkpointPlayback();
  savePosition({ force: currentBookFinished, finished: currentBookFinished });
  updateBookProgress();
}

// Position Saving
function positionPayload(options = {}) {
  const checkpoint = buildPlaybackCheckpoint(options);
  if (!checkpoint) return null;
  return {
    ...checkpoint,
    userId: getCurrentUserId(),
    deviceId: getCurrentDeviceId(),
    allowBackward: Boolean(options.allowBackward)
  };
}

async function savePosition(options = {}) {
  if (!currentBook || !chunkPlayer) return;
  checkpointPlayback();
  const payload = positionPayload(options);
  if (!payload) return;
  lastServerPositionSaveAt = Date.now();

  try {
    await apiSend('POST', '/api/position', payload);
  } catch (err) {
    console.error('Failed to save position:', err);
    queuePendingPosition(payload);
  }
}

function beaconSavePosition(options = {}) {
  if (!navigator.sendBeacon) return false;
  checkpointPlayback();
  const payload = positionPayload(options);
  if (!payload) return false;
  try {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    return navigator.sendBeacon(`${API_BASE}/api/position`, blob);
  } catch {
    return false;
  }
}

// Aggressive local checkpointing; server sync remains throttled.
setInterval(() => {
  if (currentBook && chunkPlayer) checkpointPlayback();
  if (currentBook && chunkPlayer && chunkPlayer.isPlaying && Date.now() - lastServerPositionSaveAt > 7000) {
    savePosition();
  }
}, 5000);

// Helper function for screen reader announcements
// Save position before page unload
window.addEventListener('beforeunload', () => {
  recordPlaybackEvent({ type: 'beforeunload', online: navigator.onLine });
  checkpointPlayback();
  if (!beaconSavePosition()) savePosition();
  clearPlaybackRecoveryTimers();
  if (rollingOfflineTimer !== null) window.clearTimeout?.(rollingOfflineTimer);
  playbackSession.dispose();
});



// Start-over modal
function openStartOverModal() {
  if (!startOverModal || !currentBook) return;
  startOverModalController?.open();
  setTimeout(() => startOverConfirmBtn?.focus(), 100);
}

function closeStartOverModal() {
  startOverModalController?.dismiss();
}

async function confirmStartOver() {
  if (!currentBook) return;
  closeStartOverModal();
  if (chunkPlayer?.isPlaying) {
    chunkPlayer.pause();
    updatePlaybackUI(false);
  }
  setCurrentBookFinished(false);
  const startChapter = findPreferredStartChapterIndex(chapters);
  const loaded = await loadChapter(startChapter, { commitImmediately: true });
  if (loaded?.loaded !== true) return;
  if (chunkPlayer) await chunkPlayer.seek(0);
  checkpointPlayback({ force: true, finished: false });
  await savePosition({ allowBackward: true, force: true, finished: false });
  updateBookProgress();
  updatePlaybackUI(false);
  showToast('Book reset to the beginning');
  loadLibrary();
}

// Shortcut help overlay (opened by '?' — see initKeys wiring below)
function openShortcutOverlay() {
  if (!shortcutOverlay) return;
  shortcutOverlayController?.open();
}

function closeShortcutOverlay() {
  shortcutOverlayController?.dismiss();
}
