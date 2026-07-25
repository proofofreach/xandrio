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
import { initOffline, renderOfflineState, queuePendingPosition, isChapterAvailableOffline, ensureRollingOfflineWindow, getOfflineBookData } from './js/features/offline.js';
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
import { createPlaybackSession } from './js/playback-session.js';
import { navigateChapterSelection, positionMatchesChapterStructure, shouldAllowBackwardReconciliation } from './js/chapter-navigation.mjs';
import { SingleFileChapterPlayer } from './js/single-file-chapter-player.js';
import { initPlayerUI, paintChapterTimes, paintScrubPreview, toggleTimeDisplayMode, syncTimeDisplayModeFromClientSettings, getPlaybackProgressScope, getBookSeekTarget, syncPlaybackProgressScope, setPlaybackReliabilityState, setResumePromptVisible, maybeShowIphonePlaybackTip, dismissIphonePlaybackTip, handleChunkWaiting, handleChunkPreparing, setChunkOverlayState, displayChapterTitle, updateChapterTrigger, updateBookProgress, updatePlayerAmbient, renderChapterList, openChapterSheet, closeChapterSheet, dismissChapterSheet, showAudioLoading, hideAudioLoading, updateMiniPlayer, syncMiniPlayerInfo, syncMiniPlayerIcon } from './js/views/player-ui.js';
import { findPreferredStartChapterIndex } from './js/util/chapter-labels.mjs';
import { createSmartRewindController } from './js/smart-rewind.mjs';
import { initListeningQueue, loadListeningQueue, addToListeningQueue, advanceListeningQueue, getBookPlaybackSettings, saveBookPlaybackSettings } from './js/features/listening-queue.js';

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
let automaticRecoveryAttempts = 0;
let automaticRecoveryTimer = null;
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
let playbackReliability, iphonePlaybackTipDismiss;
let playbackResumePrompt, playbackResumeBtn;
let startOverModalController = null;
let shortcutOverlayController = null;

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
  iphonePlaybackTipDismiss = document.getElementById('iphone-playback-tip-dismiss');
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
  if (automaticRecoveryTimer !== null) {
    window.clearTimeout?.(automaticRecoveryTimer);
    automaticRecoveryTimer = null;
  }
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
    stablePlaybackTimer = null;
  }, 30000);
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

function offerManualPlaybackRecovery(error, resumeAt) {
  checkpointPlayback({ force: true });
  setResumePromptVisible(true);
  setPlaybackReliabilityState('resume', 'Stream interrupted');
  recordPlaybackEvent({
    type: 'recovery-offered',
    reason: error?.code || 'playback-error',
    chapterIndex: currentChapter,
    chapterTime: resumeAt
  });
  const retry = async () => {
    automaticRecoveryAttempts = 0;
    await loadChapter(currentChapter, {
      seekToSeconds: resumeAt,
      reason: 'manual-recovery'
    });
    await chunkPlayer.play();
    setResumePromptVisible(false);
    updatePlaybackUI(true);
  };
  showToast('Playback was interrupted', 'error', {
    actionLabel: 'Resume',
    onAction: () => retry().catch(retryError => handleChunkError(retryError))
  });
}

function scheduleAutomaticPlaybackRecovery(error, resumeAt) {
  if (!window.setTimeout || automaticRecoveryTimer !== null || automaticRecoveryAttempts >= 3) {
    return false;
  }
  automaticRecoveryAttempts += 1;
  const attempt = automaticRecoveryAttempts;
  const retry = async () => {
    automaticRecoveryTimer = null;
    if (!navigator.onLine) {
      setPlaybackReliabilityState('resume', 'Waiting for connection');
      window.addEventListener('online', () => {
        if (!scheduleAutomaticPlaybackRecovery(error, resumeAt)) {
          offerManualPlaybackRecovery(error, resumeAt);
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
    setPlaybackReliabilityState('preparing', `Reconnecting… (${attempt}/3)`);
    try {
      await loadChapter(currentChapter, {
        seekToSeconds: resumeAt,
        reason: 'automatic-recovery'
      });
      await chunkPlayer.play();
      setResumePromptVisible(false);
      updatePlaybackUI(true);
      markPlaybackStableSoon();
    } catch (retryError) {
      if (!scheduleAutomaticPlaybackRecovery(retryError, resumeAt)) {
        offerManualPlaybackRecovery(retryError, resumeAt);
      }
    }
  };
  automaticRecoveryTimer = window.setTimeout(retry, 250 * (2 ** (attempt - 1)));
  return true;
}


function handleChunkError(error) {
  console.error('Chunk playback error:', error);
  if (
    error?.code === 'CONTINUOUS_STREAM_EOF'
    || error?.code === 'MEDIA_PLAY_TIMEOUT'
    || chunkPlayer?.isContinuous
  ) {
    const resumeAt = Math.max(0, Number(error.chapterTime ?? chunkPlayer?.getCurrentTime?.()) || 0);
    checkpointPlayback({ force: true });
    if (!scheduleAutomaticPlaybackRecovery(error, resumeAt)) {
      offerManualPlaybackRecovery(error, resumeAt);
    }
    return;
  }
  if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    hideAudioLoading();
    setResumePromptVisible(true);
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
      ? 'Playing downloaded audio'
      : 'Continuous lock-screen playback');
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
        if (detail.reason === 'external') {
          void applySmartRewindBeforeResume()
            .catch(error => console.warn('Smart rewind after interruption failed:', error));
        }
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
    ...options
  });
}

async function selectPlaybackEngineForChapter(bookId, chapterIndex, options = {}) {
  chunkedPlayer.preferStandardAudio = Boolean(options.offlineMode && options.offlineChapterAvailable);
  if (options.offlineMode && options.offlineChapterAvailable) {
    return {
      engine: chunkedPlayer,
      backend: 'single-file',
      reliability: ['active', 'Playing downloaded audio'],
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
    showLoginGate({ tokenMode: !authStatus.accountsConfigured });
    return;
  }

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
  loadLibrary();
  setupEventListeners();
  setupLifecycleHandlers();
  setupMediaSessionHandlers();
  registerServiceWorker();
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
    seek: (seconds) => chunkPlayer?.seek(seconds),
    checkpointPlayback,
    savePosition,
    dismissChapterSheet: () => dismissChapterSheet(),
    onBookmarkAdded: () => {
      const buttons = [bookmarkBtn, document.getElementById('utility-bookmark-btn')].filter(Boolean);
      buttons.forEach(button => button.classList.add('bookmark-saved-flash'));
      setTimeout(() => buttons.forEach(button => button.classList.remove('bookmark-saved-flash')), 900);
    },
  });
  initOffline({
    getCurrentBook: () => currentBook,
    getChapters: () => chapters,
    showAudioLoading,
    hideAudioLoading
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


function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // An activated worker controls future requests immediately, but the current
  // page keeps its already-loaded code and native media resource. Reloading on
  // controllerchange would tear down lock-screen playback mid-chapter.
  navigator.serviceWorker.register('/sw.js')
    .then(registration => registration?.update?.().catch(() => {}))
    .catch(err => console.warn('Service worker registration failed:', err));
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
  iphonePlaybackTipDismiss?.addEventListener('click', dismissIphonePlaybackTip);
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
    let seekTo = 0;

    if (restorePosition) {
      chapterToLoad = restorePosition.chapterIndex;
      seekTo = restorePosition.timestamp || 0;
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

    await loadChapter(chapterToLoad);
    // Seek to the saved chapter position on the persistent media element.
    if (chunkPlayer && restorePosition && typeof chunkPlayer.seekToChunk === 'function' && Number.isInteger(restorePosition.chunkIndex)) {
      await chunkPlayer.seekToChunk(restorePosition.chunkIndex, restorePosition.chunkTime || 0);
    } else if (chunkPlayer && seekTo) {
      await chunkPlayer.seek(seekTo);
    }
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

async function loadChapter(index, options = {}) {
  if (!Number.isInteger(index) || index < 0 || index >= chapters.length) return;
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

  // Offline + not downloaded: skip the doomed network fetch and surface a
  // calm situational state. No retry button — retrying can't succeed without a
  // connection, so the chapter reloads itself the moment the network returns.
  let offlineMode = !navigator.onLine || currentBookOfflineFallback;
  const offlineChapterAvailable = offlineMode
    ? await isChapterAvailableOffline(currentBook.id, index)
    : false;
  if (token !== loadChapterToken) return;
  // navigator.onLine can remain true through a transient metadata failure. If
  // that local snapshot points at an evicted chapter, let normal network
  // playback recover instead of pinning the player to an offline error.
  if (offlineMode && !offlineChapterAvailable && navigator.onLine) {
    currentBookOfflineFallback = false;
    offlineMode = false;
  }
  if (offlineMode && !offlineChapterAvailable) {
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
    return;
  }

  const selection = await selectPlaybackEngineForChapter(currentBook.id, index, {
    offlineChapterAvailable,
    offlineMode
  });
  if (token !== loadChapterToken) return;
  const transition = await playbackSession.transitionTo({
    book: currentBook,
    chapterIndex: index,
    engine: selection.engine,
    backend: selection.backend,
    play: false,
    preservePosition: false,
    disposePrevious: false,
    commitImmediately: options.commitImmediately
  });
  if (transition.stale) return;
  applyPlaybackSelection(selection);
  chunkPlayer?.setSpeed?.(getCurrentPlaybackSpeed());
  if (token !== loadChapterToken) return;
  if (Number.isFinite(options.seekToSeconds)) {
    await chunkPlayer.seek(Math.max(0, options.seekToSeconds));
    if (token !== loadChapterToken) return;
  }
  // Never compete with first-play streaming for bandwidth or storage. Offline
  // downloads remain available only through the user's explicit action.
  checkpointPlayback();
  // The media adapter calls onReady/onWaiting callbacks.

  if (wasPlaying) {
    try {
      await chunkPlayer.play();
      if (token !== loadChapterToken) return;
      updatePlaybackUI(true);
    } catch (err) {
      if (token !== loadChapterToken) return;
      try { chunkPlayer.pause?.(); } catch {}
      console.warn('Chapter playback could not resume:', err);
      updatePlaybackUI(false);
    }
  }
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
  await loadChapter(target.chapterIndex, {
    provisionalForward: target.chapterIndex > fromChapter,
    seekToSeconds: target.chapterTime
  });
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

async function applySmartRewindBeforeResume() {
  if (!currentBook || !chunkPlayer || !smartRewindIsEnabled()) {
    smartRewind.clear();
    return;
  }
  const plan = smartRewind.planResume({
    bookId: currentBook.id,
    chapterIndex: currentChapter,
    positionSeconds: chunkPlayer.getCurrentTime?.() || 0
  });
  if (!plan) return;
  await chunkPlayer.seek(plan.targetSeconds);
  showToast(`Smart rewind · ${plan.rewindSeconds} seconds`);
}

async function togglePlayPause(forcePlay = false) {
  forcePlay = forcePlay === true;
  if (!currentBook || !chunkPlayer) return;
  try {
    if (forcePlay || !chunkPlayer.isPlaying) {
      await applySmartRewindBeforeResume();
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
    console.error('Playback error:', err);
    updatePlaybackUI(false);
    if (needsReliablePlayback() && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      setResumePromptVisible(true);
    } else {
      setPlaybackReliabilityState('resume', 'Audio needs attention');
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
    await applySmartRewindBeforeResume();
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
        await loadChapter(currentChapter + 1, { commitImmediately: true });
      } catch (err) {
        clearAutoplay();
        console.error('Native auto-advance failed:', err);
        updatePlaybackUI(false);
      }
    } else {
      await loadChapter(currentChapter + 1, { commitImmediately: true });
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
  await loadChapter(startChapter, { commitImmediately: true });
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
