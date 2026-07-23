// api.js must be first: importing it installs the 401 token interceptor
// before anything else can fetch.
import { API_BASE, apiGet, apiSend, getCurrentUserId, getCurrentDeviceId, getCurrentDeviceName } from './js/api.js';
import { initRouter, navigateTo, syncPlayerHash, clearSheetStack } from './js/router.js';
import { formatDuration, escapeHTML, cleanDisplayText, isIOSLike, coverPlaceholderSrc } from './js/util/format.js';
import { showToast } from './js/ui/toast.js';
import { initKeys, onActivate } from './js/ui/keys.js';
import { registerSheet } from './js/ui/sheets.js';
import { initBookmarks, renderBookmarksSection, addBookmarkAtCurrentPosition } from './js/features/bookmarks.js';
import { initOffline, renderOfflineState, queuePendingPosition, isBookDownloadedForOffline } from './js/features/offline.js';
import { initPronunciationRepair } from './js/features/pronunciations.js';
import { initQueueStatus } from './js/features/queue-status.js';
import { loadClientSettings, getSkipInterval } from './js/client-settings.js';
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
let currentBookFinished = false;
let chunkPlayer = null; // Active playback engine — ChunkPlayer or SingleFileChapterPlayer
let chunkedPlayer = null; // Chunked fallback/first-load engine
let playbackBackend = 'chunked';

// API_BASE and sync identity now live in js/api.js
const PLAYBACK_CHECKPOINT_PREFIX = 'xandrio_playback_checkpoint:';
const CHECKPOINT_SAVE_MIN_INTERVAL_MS = 1000;
let lastCheckpointSaveAt = 0;
let lastServerPositionSaveAt = 0;
let pendingServerPositionTimer = null;
let reliableAudioStatusTimer = null;
let reliableHandoffInProgress = false;
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

function handleChapterEnd() {
  handleAudioEnd();
}


function stopReliableAudioStatusPolling() {
  if (reliableAudioStatusTimer) {
    clearInterval(reliableAudioStatusTimer);
    reliableAudioStatusTimer = null;
  }
}

function startReliableAudioStatusPolling(bookId, chapterIndex) {
  if (!isIOSLike()) return;
  stopReliableAudioStatusPolling();
  const check = async () => {
    if (!currentBook || currentBook.id !== bookId || currentChapter !== chapterIndex) {
      stopReliableAudioStatusPolling();
      return;
    }
    const status = await getChapterAudioStatus(bookId, chapterIndex);
    if (status && status.ready) {
      stopReliableAudioStatusPolling();
      if (playbackBackend === 'single-file') {
        setPlaybackReliabilityState('active', 'Best for lock screen');
      } else {
        setPlaybackReliabilityState('ready', 'Ready for lock screen');
        handoffToReliablePlayback();
      }
    } else if (playbackBackend !== 'single-file') {
      setPlaybackReliabilityState('preparing', 'Preparing lock-screen playback');
    }
  };
  check();
  reliableAudioStatusTimer = setInterval(check, 12000);
}

function handleChunkError(error) {
  console.error('Chunk playback error:', error);
  if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    hideAudioLoading();
    setResumePromptVisible(true);
    return;
  }
  if (isIOSLike()) {
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
  if (isIOSLike() && playbackBackend === 'single-file') setPlaybackReliabilityState('active', 'Best for lock screen');
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
    onPlaybackChange: (isPlaying) => {
      updatePlaybackUI(isPlaying);
      if (isPlaying) {
        setResumePromptVisible(false);
        checkpointPlayback({ throttle: true });
      } else {
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
    ...options
  });
}

function adaptChunkedEngine(engine) {
  engine.backend = 'chunked';
  engine.supportsNativeMediaSession = false;
  engine.dispose = () => engine.destroy();
  return engine;
}

async function getChapterAudioStatus(bookId, chapterIndex) {
  try {
    const clean = isIOSLike() ? '?clean=1' : '';
    return await apiGet(`/api/chunks/${encodeURIComponent(bookId)}/${chapterIndex}/chapter-audio-status${clean}`);
  } catch {
    return null;
  }
}

function prepareReliableChapterAudio(bookId, chapterIndex) {
  if (bookId === currentBook?.id && chapterIndex === currentChapter) {
    setPlaybackReliabilityState('preparing', 'Preparing lock-screen playback');
    startReliableAudioStatusPolling(bookId, chapterIndex);
  }
  fetch(`/api/chunks/${encodeURIComponent(bookId)}/${chapterIndex}/prepare-chapter-audio${isIOSLike() ? '?clean=1' : ''}`, { method: 'POST' })
    .catch(err => console.warn('Reliable chapter audio prepare failed:', err));
}

async function selectPlaybackEngineForChapter(bookId, chapterIndex) {
  if (!navigator.onLine && isBookDownloadedForOffline(bookId, chapterIndex)) {
    return {
      engine: createSingleFileChapterEngine({ preferStandardAudio: true }),
      backend: 'single-file',
      reliability: ['active', 'Playing downloaded audio'],
      stopPolling: true
    };
  }
  if (!isIOSLike()) {
    return { engine: chunkedPlayer, backend: 'chunked' };
  }
  const status = await getChapterAudioStatus(bookId, chapterIndex);
  if (status && status.ready) {
    return {
      engine: createSingleFileChapterEngine(),
      backend: 'single-file',
      reliability: ['active', 'Best for lock screen'],
      stopPolling: true
    };
  } else {
    return {
      engine: chunkedPlayer,
      backend: 'chunked',
      reliability: ['preparing', 'Preparing lock-screen playback'],
      prepareReliable: true
    };
  }
}

function applyPlaybackSelection(selection, bookId, chapterIndex) {
  if (selection.stopPolling) stopReliableAudioStatusPolling();
  if (selection.reliability) setPlaybackReliabilityState(...selection.reliability);
  if (selection.prepareReliable) prepareReliableChapterAudio(bookId, chapterIndex);
}


async function handoffToReliablePlayback(options = {}) {
  if (!isIOSLike() || playbackBackend === 'single-file' || reliableHandoffInProgress || !currentBook || !chunkPlayer) return;
  reliableHandoffInProgress = true;
  const oldPlayer = chunkPlayer;
  try {
    const nextPlayer = createSingleFileChapterEngine();
    nextPlayer.setSpeed(getCurrentPlaybackSpeed());
    const result = await playbackSession.handoffTo({
      engine: nextPlayer,
      backend: 'single-file',
      play: options.play,
      disposePrevious: false
    });
    if (result.stale) return;
    setResumePromptVisible(false);
    setPlaybackReliabilityState('active', 'Best for lock screen');
    checkpointPlayback();
    updatePlaybackUI(Boolean(chunkPlayer?.isPlaying));
  } catch (err) {
    console.warn('Reliable playback handoff failed:', err);
    playbackSession.adoptEngine(oldPlayer, 'chunked');
    setPlaybackReliabilityState('ready', 'Ready for lock screen');
  } finally {
    reliableHandoffInProgress = false;
  }
}


async function switchToReliableIfReadyForPause() {
  if (!isIOSLike() || playbackBackend === 'single-file' || !currentBook || !chunkPlayer) return false;
  const status = await getChapterAudioStatus(currentBook.id, currentChapter);
  if (!status || !status.ready) return false;
  await handoffToReliablePlayback({ play: false });
  return playbackBackend === 'single-file';
}

function maybePrepareUpcomingReliableAudio() {
  if (!currentBook || !isIOSLike()) return;
  prepareReliableChapterAudio(currentBook.id, currentChapter);
  if (currentChapter + 1 < chapters.length) prepareReliableChapterAudio(currentBook.id, currentChapter + 1);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Xandrio initialized');
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
  
  // Initialize chunked playback. iOS may switch per chapter to reliable single-file audio when ready.
  chunkedPlayer = adaptChunkedEngine(new ChunkPlayer(makePlaybackCallbacks()));
  playbackSession.adoptEngine(chunkedPlayer, 'chunked');
  
  // Restore language preference (check both old and new keys for migration)
  const savedLanguage = readText('xandrio_default_language', 'en');
  if (languageFilter) {
    languageFilter.value = savedLanguage;
  }
  applySkipIntervalLabels();
  
  initLibrary({ openBook, navigateTo });
  initSearch({ openBook, navigateTo });
  initSleepTimer({
    getCurrentBook: () => currentBook,
    getCurrentChapter: () => currentChapter,
    getChunkPlayer: () => chunkPlayer,
    updatePlaybackUI,
    savePosition
  });
  initPlaybackSpeed({
    getChunkPlayer: () => chunkPlayer,
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
  let refreshing = false;
  // On the very first visit clients.claim() fires controllerchange too —
  // only reload when an existing controller was replaced by an update.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });
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
    standalone: window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)')?.matches,
    backend: playbackBackend,
    currentBook: currentBook ? { id: currentBook.id, title: currentBook.title, author: currentBook.author } : null,
    currentChapter,
    isPlaying: Boolean(chunkPlayer?.isPlaying),
    position: chunkPlayer?.getPosition?.() || null,
    checkpoint,
    reliabilityState: playbackReliability?.dataset?.state || null,
    mediaSessionSupported: 'mediaSession' in navigator,
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller)
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

  // NOTE: ChunkPlayer handles chunked playback via its callback system; the
  // <audio id="audio-player"> element is the output for SingleFileChapterPlayer
  // (iOS reliable/offline playback), which attaches its own listeners.

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

// Player Functions
async function openBook(bookId) {
  // Keep the address bar/history in sync no matter who called us (router,
  // library tap, post-download/upload flow).
  syncPlayerHash(bookId);
  try {
    const data = await apiGet(`/api/book/${encodeURIComponent(bookId)}`);

    currentBook = data.book;
    chapters = data.chapters;
    currentBookFinished = false;

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
    loadPlaybackSpeed();
    
    // Restore sleep timer if active
    restoreSleepTimer();

    await loadChapter(chapterToLoad);
    // Seek to saved position (cross-chunk seek via ChunkPlayer)
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
    
    // NOTE: Pre-generation no longer needed — ChunkPlayer handles chunk look-ahead
  } catch (err) {
    console.error('Failed to open book:', err);
    showToast("Couldn't open book", 'error');
  }
}

let loadChapterToken = 0;

async function loadChapter(index, options = {}) {
  if (!Number.isInteger(index) || index < 0 || index >= chapters.length) return;
  // Latest-wins: rapid chapter switches invoke this concurrently; only the
  // most recent call may keep mutating player state after its awaits.
  const token = ++loadChapterToken;
  const previousChapter = currentChapter;

  const wasPlaying = chunkPlayer ? chunkPlayer.isPlaying : false;
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
  if (!navigator.onLine && !isBookDownloadedForOffline(currentBook.id, index)) {
    setChunkOverlayState('offline', {
      message: "You're offline",
      detail: 'This book isn’t downloaded. It will start when you’re back online.'
    });
    updatePlaybackUI(false);
    const resumeWhenOnline = () => {
      if (currentBook?.id && currentChapter === index) loadChapter(index);
    };
    window.addEventListener('online', resumeWhenOnline, { once: true });
    return;
  }

  const selection = await selectPlaybackEngineForChapter(currentBook.id, index);
  if (token !== loadChapterToken) return;
  const transition = await playbackSession.transitionTo({
    book: currentBook,
    chapterIndex: index,
    engine: selection.engine,
    backend: selection.backend,
    play: false,
    preservePosition: false,
    disposePrevious: Boolean(chunkPlayer && chunkPlayer !== chunkedPlayer),
    commitImmediately: options.commitImmediately
  });
  if (transition.stale) return;
  applyPlaybackSelection(selection, currentBook.id, index);
  if (token !== loadChapterToken) return;
  if (Number.isFinite(options.seekToSeconds)) {
    await chunkPlayer.seek(Math.max(0, options.seekToSeconds));
    if (token !== loadChapterToken) return;
  }
  maybePrepareUpcomingReliableAudio();
  checkpointPlayback();
  // ChunkPlayer will call onReady/onWaiting callbacks

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

async function togglePlayPause(forcePlay = false) {
  forcePlay = forcePlay === true;
  if (!chunkPlayer) return;
  try {
    if (forcePlay || !chunkPlayer.isPlaying) {
      await chunkPlayer.play();
      setResumePromptVisible(false);
      updatePlaybackUI(true);
    } else {
      await switchToReliableIfReadyForPause();
      chunkPlayer.pause();
      updatePlaybackUI(false);
    }
    checkpointPlayback();
    scheduleServerPositionSave();
  } catch (err) {
    console.error('Playback error:', err);
    updatePlaybackUI(false);
    if (isIOSLike() && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      setResumePromptVisible(true);
    } else {
      setPlaybackReliabilityState('resume', 'Audio needs attention');
    }
  }
}


function updatePlaybackUI(forcePlaying = null) {
  let isPlaying = forcePlaying !== null ? forcePlaying : Boolean(chunkPlayer && chunkPlayer.isPlaying);
  if (isIOSLike() && playbackBackend === 'single-file' && audioPlayer) {
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
  if (isIOSLike() && duration > 0 && position / duration > 0.7) maybePrepareUpcomingReliableAudio();
}

function isNativeSingleFileReady() {
  return isIOSLike() &&
    playbackBackend === 'single-file' &&
    audioPlayer &&
    audioPlayer.src &&
    Boolean(chunkPlayer?.supportsNativeMediaSession);
}

async function resumeNativeSingleFileFromMediaSession() {
  if (!isNativeSingleFileReady()) return false;
  try {
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
      } else if (playbackBackend === 'single-file' && audioPlayer && !audioPlayer.paused) {
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
    checkpointPlayback();
    if (document.visibilityState === 'hidden' && !beaconSavePosition()) savePosition();
    updatePlaybackUI();
  });
  window.addEventListener('pagehide', () => { checkpointPlayback(); if (!beaconSavePosition()) savePosition(); });
  window.addEventListener('pageshow', () => { updatePlaybackUI(); updateMediaSessionMetadata(); updateMediaSessionPosition(); });
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

async function handleAudioEnd() {
  checkpointPlayback();
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
  // Auto-advance to next chapter
  if (currentChapter < chapters.length - 1) {
    await loadChapter(currentChapter + 1, { commitImmediately: true });
    try {
      await chunkPlayer.play();
      updatePlaybackUI(true);
    } catch (err) {
      console.error('Auto-advance play failed:', err);
      updatePlaybackUI(false);
    }
  } else {
    setCurrentBookFinished(true);
    updatePlaybackUI(false);
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
  checkpointPlayback();
  if (!beaconSavePosition()) savePosition();
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
