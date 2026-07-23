import { API_BASE, apiGet } from '../api.js';
import { formatDuration, formatTime, escapeHTML, isIOSLike } from '../util/format.js';
import { getProgressDisplayMode, setClientSetting } from '../client-settings.js';
import { bookProgressInfo, normalizedChapterDurations } from './library.js';
import { registerSheet } from '../ui/sheets.js';
import { readText, writeText } from '../util/storage.js';
import { getPremiumChapterReadiness, isPremiumVoiceSelected } from './voices.js';
import { bookTimelinePosition, bookTimelineSeekTarget } from '../util/book-timeline.mjs';
import { chapterListItemState, chapterListOrdinal, chapterProgressContext, expandNumericChapterTitle, findPreferredStartChapterIndex, firstDisplaySentence } from '../util/chapter-labels.mjs';

const TIME_DISPLAY_KEY = 'xandrio_time_display';
const IPHONE_PLAYBACK_TIP_DISMISSED_KEY = 'xandrio_iphone_playback_tip_dismissed';
const ICON_NOW_PLAYING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="now-playing-mark" aria-hidden="true"><rect x="1.5" y="7" width="3" height="7" rx="1"/><rect x="6.5" y="3" width="3" height="11" rx="1"/><rect x="11.5" y="9" width="3" height="5" rx="1"/></svg>';

let deps = {};
let chapterTriggerTitle = null;
let chapterSheet = null;
let chapterSheetBtn = null;
let chapterSheetBackdrop = null;
let chapterSheetClose = null;
let chapterList = null;
let startOverBtn = null;
let playbackReliability = null;
let playbackReliabilityText = null;
let playbackResumePrompt = null;
let iphonePlaybackTip = null;
let audioLoading = null;
let loadingText = null;
let loadingDetail = null;
let audioLoadingFill = null;
let audioLoadingActions = null;
let playPauseBtn = null;
let chapterSheetController = null;
let narrationPreparingStartedAt = 0;
let playbackProgressScope = 'chapter';
let ambientRequestId = 0;

export function initPlayerUI(options = {}) {
  deps = options;
  chapterTriggerTitle = document.getElementById('chapter-trigger-title');
  chapterSheet = document.getElementById('chapter-sheet');
  chapterSheetBtn = document.getElementById('chapter-sheet-btn');
  chapterSheetBackdrop = document.getElementById('chapter-sheet-backdrop');
  chapterSheetClose = document.getElementById('chapter-sheet-close');
  chapterList = document.getElementById('chapter-list');
  startOverBtn = document.getElementById('start-over-btn');
  playbackReliability = document.getElementById('playback-reliability');
  playbackReliabilityText = document.getElementById('playback-reliability-text');
  playbackResumePrompt = document.getElementById('playback-resume-prompt');
  iphonePlaybackTip = document.getElementById('iphone-playback-tip');
  audioLoading = document.getElementById('audio-loading');
  loadingText = document.getElementById('loading-text');
  loadingDetail = document.getElementById('loading-detail');
  audioLoadingFill = document.getElementById('audio-loading-fill');
  audioLoadingActions = document.getElementById('audio-loading-actions');
  playPauseBtn = document.getElementById('play-pause-btn');
  document.querySelectorAll('[data-progress-scope]').forEach(button => {
    button.addEventListener('click', () => setPlaybackProgressScope(button.dataset.progressScope));
  });
  chapterSheetController = registerSheet(chapterSheet, {
    backdrop: chapterSheetBackdrop,
    closeBtn: chapterSheetClose,
    focusTarget: () => chapterSheet?.querySelector('.chapter-sheet-panel') || chapterSheet
  });
  chapterSheetBtn?.addEventListener('click', openChapterSheet);
  chapterList?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chapter-index]');
    if (!btn) return;
    deps.haptic?.();
    const nextChapter = Number(btn.dataset.chapterIndex);
    deps.selectChapter?.(nextChapter)?.catch?.(error => {
      console.error('Chapter selection failed:', error);
    });
    dismissChapterSheet();
  });
}

let lastChunkTimeData = null;

function completeBookTimeline() {
  return normalizedChapterDurations(deps.getCurrentBook?.(), deps.getChapters?.().length || 0);
}

function paintProgressLabels({ current, total, remaining, percent, context }) {
  const currentEl = document.getElementById('chapter-progress-current');
  const totalEl = document.getElementById('chapter-progress-total');
  const contextEl = document.getElementById('player-progress-context');
  if (currentEl) currentEl.textContent = formatTime(current);
  if (totalEl) {
    totalEl.textContent = getTimeDisplayMode() === 'remaining'
      ? `-${formatTime(Math.max(0, remaining))}`
      : formatTime(total);
  }
  if (contextEl) contextEl.textContent = context;
  const slider = document.getElementById('progress-slider');
  if (slider && Number.isFinite(percent)) slider.value = Math.max(0, Math.min(100, percent));
}

export function getPlaybackProgressScope() {
  return playbackProgressScope;
}

export function getBookSeekTarget(percent) {
  return bookTimelineSeekTarget(completeBookTimeline(), percent);
}

export function syncPlaybackProgressScope() {
  const scopeControl = document.getElementById('player-progress-scope');
  const durations = completeBookTimeline();
  const bookButton = document.querySelector('[data-progress-scope="book"]');
  const hasBookTimeline = Boolean(durations);

  if (!hasBookTimeline && playbackProgressScope === 'book') playbackProgressScope = 'chapter';
  if (scopeControl) scopeControl.hidden = !hasBookTimeline;
  if (bookButton) {
    bookButton.disabled = !hasBookTimeline;
    bookButton.title = hasBookTimeline ? '' : 'Book seeking needs a duration for every chapter';
  }
  document.querySelectorAll('[data-progress-scope]').forEach(button => {
    const active = button.dataset.progressScope === playbackProgressScope;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('active', active);
  });
  const slider = document.getElementById('progress-slider');
  slider?.setAttribute('aria-label', playbackProgressScope === 'book' ? 'Book progress' : 'Chapter progress');
  document.getElementById('chapter-progress-total')?.setAttribute(
    'aria-label',
    `Toggle ${playbackProgressScope === 'book' ? 'book' : 'chapter'} time display`
  );
}

export function setPlaybackProgressScope(scope) {
  const next = scope === 'book' && completeBookTimeline() ? 'book' : 'chapter';
  if (next === playbackProgressScope) return;
  playbackProgressScope = next;
  syncPlaybackProgressScope();
  paintChapterTimes(lastChunkTimeData);
  updateBookProgress();
}

function getTimeDisplayMode() {
  const localMode = readText(TIME_DISPLAY_KEY, '');
  if (localMode) return localMode === 'remaining' ? 'remaining' : 'total';
  return getProgressDisplayMode() === 'remaining' ? 'remaining' : 'total';
}

// Paints the split chapter time labels. Called from the engine's time-update
// callback and from the label's own tap handler (using the last known
// times), so toggling feels instant without waiting for the next tick.
export function paintChapterTimes(data) {
  if (data) lastChunkTimeData = data;
  if (!data) return;
  syncPlaybackProgressScope();
  const durations = completeBookTimeline();
  if (playbackProgressScope === 'book' && durations) {
    const position = bookTimelinePosition(durations, deps.getCurrentChapter(), data.currentTime);
    if (position) {
      paintProgressLabels({
        current: position.elapsed,
        total: position.total,
        remaining: position.remaining,
        percent: position.percent,
        context: `${Math.round(position.percent)}% of book`
      });
      return;
    }
  }

  const total = data.totalTime || 0;
  const current = data.currentTime || 0;
  paintProgressLabels({
    current,
    total,
    remaining: total - current,
    percent: data.progressPercent,
    context: chapterProgressContext(deps.getChapters(), deps.getCurrentChapter())
  });
}

// Scrub preview — while the user drags the progress slider we paint the time
// label locally from the slider percent and the last known chapter duration.
// No engine seek and no network; the real seek runs on release ('change').
export function paintScrubPreview(percent) {
  if (!lastChunkTimeData) return;
  const clamped = Math.max(0, Math.min(100, percent));
  if (playbackProgressScope === 'book') {
    const target = getBookSeekTarget(clamped);
    if (target) {
      paintProgressLabels({
        current: target.elapsed,
        total: target.total,
        remaining: target.total - target.elapsed,
        percent: clamped,
        context: `${Math.round(clamped)}% of book`
      });
      return;
    }
  }
  const totalTime = lastChunkTimeData.totalTime || 0;
  paintChapterTimes({ ...lastChunkTimeData, progressPercent: clamped, currentTime: (clamped / 100) * totalTime });
}

export function toggleTimeDisplayMode() {
  const next = getTimeDisplayMode() === 'total' ? 'remaining' : 'total';
  writeText(TIME_DISPLAY_KEY, next);
  setClientSetting('progressDisplayMode', next === 'remaining' ? 'remaining' : 'elapsed');
  paintChapterTimes(lastChunkTimeData);
}

export function syncTimeDisplayModeFromClientSettings() {
  const mode = getProgressDisplayMode() === 'remaining' ? 'remaining' : 'total';
  writeText(TIME_DISPLAY_KEY, mode);
  paintChapterTimes(lastChunkTimeData);
}


export function setPlaybackReliabilityState(state, text) {
  if (!playbackReliability || !playbackReliabilityText) return;
  const shouldShow = isIOSLike() && state && state !== 'hidden';
  playbackReliability.hidden = !shouldShow;
  if (!shouldShow) return;
  playbackReliability.dataset.state = state;
  playbackReliabilityText.textContent = text;
  syncMiniPlayerInfo();
}

export function setResumePromptVisible(visible) {
  if (!playbackResumePrompt) return;
  playbackResumePrompt.hidden = !(visible && isIOSLike());
  if (visible) setPlaybackReliabilityState('resume', 'Tap to resume');
}

export function maybeShowIphonePlaybackTip() {
  if (!iphonePlaybackTip || !isIOSLike()) return;
  const dismissed = readText(IPHONE_PLAYBACK_TIP_DISMISSED_KEY, '') === '1';
  iphonePlaybackTip.hidden = dismissed;
}

export function dismissIphonePlaybackTip() {
  writeText(IPHONE_PLAYBACK_TIP_DISMISSED_KEY, '1');
  if (iphonePlaybackTip) iphonePlaybackTip.hidden = true;
}


function humanizeWaitingMessage(message) {
  if (message === 'Generating audio…') return 'Jumping ahead — generating this part first';
  return message;
}

export function handleChunkWaiting(message) {
  if (!narrationPreparingStartedAt) narrationPreparingStartedAt = Date.now();
  showAudioLoading(humanizeWaitingMessage(message) || 'Preparing narration…', {
    detail: narrationPreparationDetail(),
    percent: 0,
    indeterminate: true,
    status: 'preparing'
  });
}

export function handleChunkPreparing(info) {
  const target = (info.targetChunk ?? 0) + 1;
  const isOpeningAudio = target === 1;
  if (info.targetStatus === 'ready' || info.targetStatus === 'error') {
    narrationPreparingStartedAt = 0;
  } else if (!narrationPreparingStartedAt) {
    narrationPreparingStartedAt = Date.now();
  }

  let title = isOpeningAudio ? 'Preparing narration…' : 'Preparing next audio…';
  let detail = narrationPreparationDetail();
  let indeterminate = true;
  let percent = 0;

  if (info.targetStatus === 'ready') {
    title = isOpeningAudio ? 'Starting playback…' : 'Audio ready…';
    detail = 'Ready to play.';
    indeterminate = false;
    percent = 100;
  } else if (info.targetStatus === 'generating') {
    detail = isOpeningAudio ? narrationPreparationDetail() : 'Finishing the next audio.';
  } else if (info.targetStatus === 'queued') {
    detail = isOpeningAudio ? narrationPreparationDetail() : 'Preparing the next audio.';
  } else if (info.targetStatus === 'error') {
    // Route failures through the overlay error state so the spinner is replaced
    // by Retry/Dismiss controls instead of spinning next to failure copy.
    setChunkOverlayState('error', {
      message: 'Narration needs attention',
      detail: isOpeningAudio
        ? 'Narration failed before playback could start.'
        : 'Narration failed for this part of the chapter.'
    });
    return;
  }

  showAudioLoading(title, {
    detail,
    percent,
    indeterminate,
    allowControls: info.targetStatus === 'ready',
    status: info.targetStatus === 'ready' ? 'ready' : (info.targetStatus === 'generating' ? 'generating' : 'preparing')
  });
  if (info.targetStatus === 'ready') {
    setTimeout(() => {
      if (audioLoading?.dataset.status === 'ready') hideAudioLoading();
    }, 1200);
  }
}

function narrationPreparationDetail() {
  if (!narrationPreparingStartedAt) return 'Playback starts automatically.';
  const elapsedSeconds = Math.floor((Date.now() - narrationPreparingStartedAt) / 1000);
  if (elapsedSeconds < 8) return 'Playback starts automatically.';
  return `Still preparing. ${formatElapsed(elapsedSeconds)} elapsed.`;
}

function formatElapsed(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes <= 0) return `${remainder}s`;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function displayChapterTitle(chapter, fallbackIndex = 0) {
  const raw = String(chapter?.title || `Chapter ${fallbackIndex + 1}`)
    .replace(/\s+/g, ' ')
    .trim();
  const expandedNumericTitle = expandNumericChapterTitle(raw);
  if (expandedNumericTitle !== raw) return expandedNumericTitle;

  const chapterMatch = raw.match(/^(chapter\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|the\s+first)\b|ch\.?\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b)/i);
  if (chapterMatch) {
    const prefix = chapterMatch[1].replace(/\s+/g, ' ').trim();
    const suffix = raw.slice(chapterMatch[0].length).trim().replace(/^[:.\-–—]\s*/, '');
    const subtitle = extractTitleLikeSubtitle(suffix);
    return subtitle ? `${prefix} ${subtitle}` : prefix;
  }

  const numberedMatch = raw.match(/^((?:\d+|[ivxlcdm]+)[.:\-–—]?)(?:\s+|$)/i);
  if (numberedMatch) {
    const suffix = raw.slice(numberedMatch[0].length).trim();
    if (/[.!?]\s+[A-Z"']/.test(suffix)) {
      const subtitle = extractTitleLikeSubtitle(suffix);
      return subtitle ? `${numberedMatch[1].trim()} ${subtitle}` : numberedMatch[1].trim();
    }
  }

  const sentenceBreak = firstDisplaySentence(raw, { minLength: 12, maxLength: 80 });
  if (sentenceBreak) return sentenceBreak;

  if (raw.length <= 80) return raw;

  return `${raw.slice(0, 77).trim()}...`;
}

function extractTitleLikeSubtitle(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const firstSentence = firstDisplaySentence(raw, { minLength: 1, maxLength: 80 });
  const candidate = (firstSentence ? firstSentence.slice(0, -1) : raw).trim();
  if (!candidate || candidate.length > 60) return '';

  const words = candidate.split(/\s+/);
  if (words.length > 8) return '';
  if (/^(it|this|that|there|he|she|they|we|i|you)\b/i.test(candidate)) return '';
  if (/\b(was|were|is|are|am|had|has|have|said|says|went|came|looked|thought)\b/i.test(candidate) && words.length > 3) return '';

  return candidate.replace(/[:.\-–—]+$/, '').trim();
}

export function updateChapterTrigger() {
  updateBookProgress();
  if (!chapterTriggerTitle || !deps.getChapters()[deps.getCurrentChapter()]) return;
  const chapter = deps.getChapters()[deps.getCurrentChapter()];
  const title = displayChapterTitle(chapter, deps.getCurrentChapter());
  const dur = formatDuration(chapter.estimatedDuration);
  chapterTriggerTitle.textContent = dur ? `${title} (${dur})` : title;
}

// Book-level progress line under the chapter scrubber. Chapter granularity
// only (per-chapter durations aren't reliably known client-side); reuses the
// same bookProgressInfo() math as the library progress bars.
export function updateBookProgress() {
  const wrapEl = document.getElementById('player-book-progress');
  const fillEl = document.getElementById('player-book-progress-fill');
  const textEl = document.getElementById('book-progress-text');
  if (!wrapEl) return;

  if (!deps.getCurrentBook() || !deps.getChapters().length) {
    wrapEl.hidden = true;
    updateStartOverButton(null);
    return;
  }

  const progress = bookProgressInfo(deps.getCurrentBook(), {
    chapterIndex: deps.getCurrentChapter(),
    timestamp: deps.getCurrentChapterTime?.() || 0,
    playbackRate: deps.getCurrentPlaybackSpeed(),
    finished: deps.getCurrentBookFinished()
  });

  if (!progress || progress.percent == null) {
    wrapEl.hidden = true;
    updateStartOverButton(null);
    return;
  }

  wrapEl.hidden = playbackProgressScope === 'book';
  if (fillEl) fillEl.style.width = `${progress.percent}%`;
  if (textEl) {
    const parts = [`${progress.percent}%`];
    if (progress.timeLeft != null) parts.push(`${formatDuration(progress.timeLeft)} left`);
    textEl.textContent = parts.join(' · ');
    wrapEl.setAttribute('aria-valuenow', String(progress.percent));
    wrapEl.setAttribute('aria-valuetext', `Book ${parts.join(', ')}`);
  }
  updateStartOverButton(progress);
}

function updateStartOverButton(progress = null) {
  if (!startOverBtn) return;
  const shouldShow = Boolean(deps.getCurrentBookFinished()) || Boolean(progress && Number.isFinite(progress.percent) && progress.percent >= 95);
  startOverBtn.hidden = !shouldShow;
}

// Samples a tiny cover image and turns it into a restrained solid player tint.
// The dark clamp protects text contrast even when the cover is very bright.
export function updatePlayerAmbient(coverUrl) {
  const playerView = document.getElementById('player-view');
  if (!playerView) return;
  const requestId = ++ambientRequestId;
  playerView.style.removeProperty('--player-cover-tint');
  if (!coverUrl) return;

  const img = new Image();
  img.onload = () => {
    if (requestId !== ambientRequestId) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 16) {
        if (pixels[i + 3] < 128) continue;
        red += pixels[i];
        green += pixels[i + 1];
        blue += pixels[i + 2];
        count += 1;
      }
      if (!count) return;
      const base = [13, 15, 18];
      const channels = [red / count, green / count, blue / count].map((value, index) =>
        Math.round(Math.max(12, Math.min(48, base[index] * 0.72 + value * 0.18)))
      );
      playerView.style.setProperty('--player-cover-tint', `rgb(${channels.join(' ')})`);
    } catch {
      playerView.style.removeProperty('--player-cover-tint');
    }
  };
  img.onerror = () => {
    if (requestId === ambientRequestId) playerView.style.removeProperty('--player-cover-tint');
  };
  img.src = coverUrl;
}

export function renderChapterList() {
  if (!chapterList) return;
  const durations = normalizedChapterDurations(deps.getCurrentBook(), deps.getChapters().length);
  // Premium mode: chapters whose premium audio is fully rendered get a
  // leading dot (text alternative via aria-label; color is never the sole
  // indicator — the dot itself is supplementary to the readiness copy in
  // the prep panel).
  const premiumMode = isPremiumVoiceSelected();
  const premiumReadiness = premiumMode ? getPremiumChapterReadiness() : [];
  chapterList.innerHTML = deps.getChapters().map((chapter, index) => {
    if (chapter.empty) return '';
    const itemState = chapterListItemState(index, deps.getCurrentChapter());
    const isActive = itemState === 'active';
    const title = displayChapterTitle(chapter, index);
    const dur = formatDuration(durations?.[index] || chapter.estimatedDuration);
    const typeLabel = chapter.type && chapter.type !== 'content' && chapter.type !== 'chapter'
      ? chapter.type
      : '';
    const classes = ['chapter-list-item'];
    if (isActive) classes.push('active');
    const premiumDot = premiumMode && premiumReadiness[index]
      ? '<span class="chapter-premium-dot" role="img" aria-label="Premium audio ready"></span>'
      : '';
    const ordinal = chapterListOrdinal(deps.getChapters(), index);
    return `
      <button class="${classes.join(' ')}" type="button" role="option" aria-selected="${isActive}" data-chapter-index="${index}">
        <span class="chapter-list-index">${premiumDot}${ordinal}</span>
        <span class="chapter-list-copy">
          <span class="chapter-list-title">${escapeHTML(title)}</span>
          <span class="chapter-list-meta">${escapeHTML(typeLabel)}</span>
        </span>
        <span class="chapter-list-duration">${dur ? escapeHTML(dur) : ''}</span>
        <span class="chapter-list-current" aria-hidden="true">${isActive ? ICON_NOW_PLAYING : ''}</span>
      </button>
    `;
  }).join('');
}

export function openChapterSheet() {
  if (!chapterSheet) return;
  renderChapterList();
  deps.renderBookmarksSection?.();
  // Auto-scroll to the current chapter, but only after the sheet's own
  // slide-up transition finishes — scrolling mid-transition looks janky.
  const panel = chapterSheet.querySelector('.chapter-sheet-panel');
  let scrolled = false;
  const scrollToActive = () => {
    if (scrolled) return;
    scrolled = true;
    const activeItem = chapterList?.querySelector('.chapter-list-item.active');
    activeItem?.scrollIntoView({ block: 'center' });
  };
  panel?.addEventListener('transitionend', scrollToActive, { once: true });
  setTimeout(scrollToActive, 250);
  chapterSheetController?.open();
}

export function closeChapterSheet() {
  chapterSheetController?.close();
}

// UI-driven close (backdrop, ✕, chapter selection): consume the history entry
// pushed by openChapterSheet; fall back to a direct close if none exists.
export function dismissChapterSheet() {
  chapterSheetController?.dismiss();
}



// Audio loading UI helpers
// Segment-count polling for the loading overlay — owned entirely by this
// overlay (started on show, cleared on hide), independent of any engine
// timer. Paints "Preparing audio · N of M segments" with a determinate fill
// when the manifest is available; silently no-ops on fetch failure so the
// existing generic copy stays put.
let audioLoadingPollTimer = null;
let audioLoadingPollKey = null;

function stopAudioLoadingPoll() {
  if (audioLoadingPollTimer) {
    clearInterval(audioLoadingPollTimer);
    audioLoadingPollTimer = null;
  }
  audioLoadingPollKey = null;
}

function startAudioLoadingPoll() {
  if (!deps.getCurrentBook()) return;
  const bookId = deps.getCurrentBook().id;
  const chapterIndex = deps.getCurrentChapter();
  const key = `${bookId}:${chapterIndex}`;
  if (audioLoadingPollTimer && audioLoadingPollKey === key) return; // already polling this chapter
  stopAudioLoadingPoll();
  audioLoadingPollKey = key;

  const poll = async () => {
    const stillRelevant = deps.getCurrentBook() && deps.getCurrentBook().id === bookId && deps.getCurrentChapter() === chapterIndex &&
      audioLoading && audioLoading.style.display !== 'none';
    if (!stillRelevant) {
      stopAudioLoadingPoll();
      return;
    }
    try {
      const data = await apiGet(`/api/chunks/${encodeURIComponent(bookId)}/${chapterIndex}/status`);
      if (!Number.isFinite(data.totalChunks) || data.totalChunks <= 0) return;
      if (loadingDetail) {
        loadingDetail.textContent = `Preparing audio · ${data.readyChunks} of ${data.totalChunks} segments`;
      }
      if (audioLoadingFill) {
        const percent = Math.min(100, Math.max(0, Math.round(100 * data.readyChunks / data.totalChunks)));
        audioLoadingFill.style.width = `${percent}%`;
      }
    } catch {
      // Fall back to whatever generic text is already painted.
    }
  };
  poll();
  audioLoadingPollTimer = setInterval(poll, 1500);
}

export function showAudioLoading(text, options = {}) {
  if (audioLoading && loadingText) {
    loadingText.textContent = text;
    const status = options.status || 'preparing';
    audioLoading.dataset.status = status;
    audioLoading.classList.toggle('is-indeterminate', Boolean(options.indeterminate));
    if (loadingDetail) {
      loadingDetail.textContent = options.detail || '';
    }
    if (audioLoadingFill) {
      const percent = Number.isFinite(options.percent)
        ? Math.min(100, Math.max(0, options.percent))
        : 0;
      audioLoadingFill.style.width = `${percent}%`;
    }
    audioLoading.style.display = 'flex';
    if (playPauseBtn) {
      playPauseBtn.disabled = false;
      playPauseBtn.style.opacity = '1';
    }

    if (status === 'preparing' || status === 'generating') {
      startAudioLoadingPoll();
    } else {
      stopAudioLoadingPoll();
    }
  }
}

export function hideAudioLoading() {
  if (audioLoading) {
    audioLoading.style.display = 'none';
    audioLoading.dataset.status = '';
    audioLoading.classList.remove('is-indeterminate');
    narrationPreparingStartedAt = 0;
    stopAudioLoadingPoll();
    renderOverlayActions(null);
    if (loadingDetail) loadingDetail.textContent = '';
    if (audioLoadingFill) audioLoadingFill.style.width = '0%';
    if (playPauseBtn) {
      playPauseBtn.disabled = false;
      playPauseBtn.style.opacity = '1';
    }
  }
}

// Single source of truth for the chunk-prep overlay.
//   'preparing' — spinner + progress, no action buttons
//   'error'     — spinner hidden, message + Retry/Dismiss buttons
//   'hidden'    — overlay dismissed
// options: { message, detail, onRetry }. When onRetry is omitted, Retry
// re-invokes chapter preparation for the current chapter via deps.loadChapter.
export function setChunkOverlayState(state, options = {}) {
  if (!audioLoading) return;
  if (state === 'hidden') {
    hideAudioLoading();
    return;
  }
  // 'offline' is a situation, not a failure: neutral surface, no retry button
  // (a retry is guaranteed to fail with no connection — the caller auto-resumes
  // on the 'online' event instead).
  if (state === 'error' || state === 'offline') {
    stopAudioLoadingPoll();
    audioLoading.dataset.status = state;
    audioLoading.classList.remove('is-indeterminate');
    if (loadingText) loadingText.textContent = options.message || 'Narration needs attention';
    if (loadingDetail) loadingDetail.textContent = options.detail || '';
    if (audioLoadingFill) audioLoadingFill.style.width = '0%';
    audioLoading.style.display = 'flex';
    if (playPauseBtn) {
      playPauseBtn.disabled = false;
      playPauseBtn.style.opacity = '1';
    }
    renderOverlayActions(state === 'offline' ? { dismissOnly: true } : options);
    return;
  }
  // 'preparing' (default)
  showAudioLoading(options.message || 'Preparing narration…', {
    detail: options.detail || '',
    indeterminate: options.indeterminate !== false,
    status: 'preparing'
  });
  renderOverlayActions(null);
}

function renderOverlayActions(options) {
  if (!audioLoadingActions) return;
  audioLoadingActions.innerHTML = '';
  if (!options) {
    audioLoadingActions.hidden = true;
    return;
  }
  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'btn-ghost btn-sm';
  dismissBtn.textContent = options.dismissOnly ? 'OK' : 'Dismiss';
  dismissBtn.addEventListener('click', () => hideAudioLoading());
  if (options.dismissOnly) {
    audioLoadingActions.append(dismissBtn);
    audioLoadingActions.hidden = false;
    return;
  }
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn-secondary btn-sm';
  retryBtn.textContent = 'Try again';
  retryBtn.addEventListener('click', () => {
    hideAudioLoading();
    if (typeof options.onRetry === 'function') options.onRetry();
    else deps.loadChapter?.(deps.getCurrentChapter?.());
  });
  audioLoadingActions.append(retryBtn, dismissBtn);
  audioLoadingActions.hidden = false;
}


// --- Mini Player ---
export function updateMiniPlayer(viewName) {
  const mini = document.getElementById('mini-player');
  if (!mini) return;
  const shouldShow = deps.getCurrentBook() && viewName !== 'player';
  if (shouldShow) {
    mini.style.display = 'block';
    document.body.classList.add('has-mini-player');
    syncMiniPlayerInfo();
    syncMiniPlayerIcon();
    maybeShowIphonePlaybackTip();
  } else {
    mini.style.display = 'none';
    document.body.classList.remove('has-mini-player');
  }
}

export function syncMiniPlayerInfo() {
  if (!deps.getCurrentBook()) return;
  const titleEl = document.getElementById('mini-player-title');
  const chapterEl = document.getElementById('mini-player-chapter');
  const coverEl = document.getElementById('mini-player-cover');
  if (titleEl) titleEl.textContent = deps.getCurrentBook().title;
  if (chapterEl && deps.getChapters()[deps.getCurrentChapter()]) {
    const reliability = isIOSLike() && deps.getPlaybackBackend() === 'single-file'
      ? ' · Best for lock screen'
      : (isIOSLike() ? ' · Preparing lock-screen playback' : '');
    chapterEl.textContent = `${displayChapterTitle(deps.getChapters()[deps.getCurrentChapter()], deps.getCurrentChapter())}${reliability}`;
  }
  if (coverEl) {
    coverEl.src = `${API_BASE}/api/cover/${encodeURIComponent(deps.getCurrentBook().id)}`;
    coverEl.alt = deps.getCurrentBook().title;
    coverEl.onerror = () => { coverEl.style.display = 'none'; };
    coverEl.onload = () => { coverEl.style.display = 'block'; };
  }
}

export function syncMiniPlayerIcon() {
  const btn = document.getElementById('mini-player-play');
  if (!btn) return;
  btn.innerHTML = (deps.getChunkPlayer() && deps.getChunkPlayer().isPlaying) ? deps.iconPause : deps.iconPlay;
}
