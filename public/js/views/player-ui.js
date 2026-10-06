import { API_BASE, apiGet } from '../api.js';
import { formatDuration, formatTime, escapeHTML, coverImageHTML, isIOSLike, needsReliablePlayback } from '../util/format.js';
import { getProgressDisplayMode, setClientSetting } from '../client-settings.js';
import { bookProgressInfo, normalizedChapterDurations } from './library.js';
import { registerSheet } from '../ui/sheets.js';
import { markInlineStatus, registerInlineStatus, showInlineConfirmation, showToast } from '../ui/toast.js';
import { openRecentSheet } from '../ui/shell.js';
// Namespace import: the per-book setting helpers are optional (the sheets
// work adds them); the ••• menu falls back to deps.saveBookPlaybackSettings.
import * as playbackSpeed from './playback-speed.js';
import { readText, writeText } from '../util/storage.js';
import { getNarrationSummary, getPremiumChapterReadiness, isPremiumVoiceSelected } from './voices.js';
import { bookTimelinePosition, bookTimelineSeekTarget } from '../util/book-timeline.mjs';
import { timeLeftLabel, formatSpeed } from '../util/time-left.mjs';
import { friendlyChapterType, chapterListItemState, chapterListOrdinal, chapterNumbering, chapterPositionLabel, chapterProgressContext, sharedTitlePrefixes, expandNumericChapterTitle, findPreferredStartChapterIndex, firstDisplaySentence } from '../util/chapter-labels.mjs';

const ICON_PREPARING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="icon" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M7 3h10M7 21h10M8 3v4l4 5-4 5v4M16 3v4l-4 5 4 5v4"/></svg>';
const TIME_DISPLAY_KEY = 'xandrio_time_display';
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
  audioLoading = document.getElementById('audio-loading');
  loadingText = document.getElementById('loading-text');
  loadingDetail = document.getElementById('loading-detail');
  audioLoadingFill = document.getElementById('audio-loading-fill');
  audioLoadingActions = document.getElementById('audio-loading-actions');
  // Inline status areas: a toast repeating what they show is suppressed.
  registerInlineStatus(audioLoading);
  registerInlineStatus(playbackReliability);
  registerInlineStatus(playbackResumePrompt);
  registerInlineStatus(document.getElementById('hq-voice-prep'));
  playPauseBtn = document.getElementById('play-pause-btn');
  document.getElementById('player-recent-btn')?.addEventListener('click', () => openRecentSheet());
  initNarration();
  initMoreMenu();
  initBookSeekSheet();
  initPaneUpNext();
  document.getElementById('progress-slider')?.addEventListener('keydown', handleProgressKey);
  document.querySelectorAll('[data-progress-scope]').forEach(button => {
    button.addEventListener('click', () => setPlaybackProgressScope(button.dataset.progressScope));
  });
  chapterSheetController = registerSheet(chapterSheet, {
    backdrop: chapterSheetBackdrop,
    closeBtn: chapterSheetClose,
    focusTarget: () => chapterSheet?.querySelector('.chapter-sheet-panel') || chapterSheet,
    initialFocus: () => document.getElementById('chapter-sheet-title')
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
let lastNarrationTick = 0;

function completeBookTimeline() {
  return normalizedChapterDurations(deps.getCurrentBook?.(), deps.getChapters?.().length || 0);
}

function paintProgressLabels({ current, total, remaining, percent, context }) {
  const rate = Number(deps.getCurrentPlaybackSpeed?.()) || 1;
  const listeningRemaining = Math.max(0, remaining) / rate;
  const currentEl = document.getElementById('chapter-progress-current');
  const totalEl = document.getElementById('chapter-progress-total');
  const contextEl = document.getElementById('player-progress-context');
  if (currentEl) currentEl.textContent = formatTime(current);
  if (totalEl) {
    // "−31:22": listening time left in the chapter at the current speed.
    totalEl.textContent = getTimeDisplayMode() === 'remaining'
      ? `−${formatTime(listeningRemaining)}`
      : formatTime(total);
    totalEl.setAttribute('aria-label', getTimeDisplayMode() === 'remaining'
      ? `${formatTime(listeningRemaining)} listening time left at ${rate}x. Show total audio time`
      : `${formatTime(total)} total audio time. Show listening time left`);
  }
  if (contextEl) contextEl.textContent = context;
  const slider = document.getElementById('progress-slider');
  if (slider && Number.isFinite(percent)) {
    slider.value = Math.max(0, Math.min(100, percent));
    slider.style.setProperty('--seek-percent', `${slider.value}%`);
    slider.dataset.duration = String(total);
    slider.setAttribute('aria-valuetext', `${formatTime(current)} of ${formatTime(total)}, ${context}. ${formatTime(listeningRemaining)} listening time left at ${rate}x`);
  }
}

function handleProgressKey(event) {
  const seconds = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -30, PageUp: 30 };
  if (!(event.key in seconds) && event.key !== 'Home' && event.key !== 'End') return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  const slider = event.currentTarget;
  const duration = Number(slider.dataset.duration);
  if (!(duration > 0)) return;
  const percent = event.key === 'Home' ? 0 : event.key === 'End' ? 100
    : Number(slider.value) + seconds[event.key] / duration * 100;
  slider.value = Math.max(0, Math.min(100, percent));
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
}

export function refreshPlaybackTimes() {
  paintChapterTimes(lastChunkTimeData);
  updateBookProgress();
}

export function setPlaybackBuffering(buffering) {
  const status = document.getElementById('playback-buffering');
  if (status) status.hidden = !buffering;
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
  syncMiniPlayerTimeLeft();
  // "ready ahead" shrinks as playback moves; refresh it now and then.
  const now = Date.now();
  if (now - lastNarrationTick > 5000) {
    lastNarrationTick = now;
    syncNarration();
  }
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


export function isPlaybackActionRequired(state) {
  return state === 'resume';
}

export function playbackNoticeStateForResumePrompt(visible) {
  return visible ? 'resume' : 'hidden';
}

export function setPlaybackReliabilityState(state, text) {
  if (!playbackReliability || !playbackReliabilityText) return;
  const normalizedState = state || 'hidden';
  const shouldShow = needsReliablePlayback() && isPlaybackActionRequired(normalizedState);
  playbackReliability.dataset.state = normalizedState;
  playbackReliability.hidden = !shouldShow;
  markInlineStatus(playbackReliability, shouldShow && normalizedState === 'resume' ? 'playback-interrupted' : null);
  if (shouldShow) playbackReliabilityText.textContent = text;
  syncMiniPlayerInfo();
}

export function setResumePromptVisible(visible) {
  if (!playbackResumePrompt) return;
  const noticeState = playbackNoticeStateForResumePrompt(visible);
  playbackResumePrompt.hidden = !(visible && needsReliablePlayback());
  setPlaybackReliabilityState(
    noticeState,
    noticeState === 'resume' ? 'Tap to resume' : ''
  );
}


function humanizeWaitingMessage(message) {
  if (message === 'Generating audio…') return 'Jumping ahead — generating this part first';
  return message;
}

export function handleChunkWaiting(message) {
  setPlaybackBuffering(false);
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
  if (!narrationPreparingStartedAt) return 'Play is available when audio is ready.';
  const elapsedSeconds = Math.floor((Date.now() - narrationPreparingStartedAt) / 1000);
  if (elapsedSeconds < 8) return 'Play is available when audio is ready.';
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
  syncNarration();
  const chapters = deps.getChapters?.() || [];
  const index = deps.getCurrentChapter?.() || 0;
  if (!chapterTriggerTitle || !chapters[index]) return;
  const { ordinal, name } = chapterRowLabels(chapters, index);
  const ordinalEl = document.getElementById('chapter-trigger-ordinal');
  if (ordinalEl) ordinalEl.textContent = ordinal;
  chapterTriggerTitle.textContent = name;
  chapterTriggerTitle.hidden = !name;
  chapterSheetBtn?.setAttribute('aria-label', `${[ordinal, name].filter(Boolean).join(', ')}. Open chapter list`);
}

// The chapter row: "Chapter 12 of 50" over the chapter's own name. A name
// that would only repeat the number keeps its full title.
export function chapterRowLabels(chapters, index) {
  const chapter = chapters?.[index];
  if (!chapter) return { ordinal: '', name: '' };
  const title = displayChapterTitle(chapter, index);
  // One numbering rule (chapterNumbering): an unnumbered section (Prologue,
  // Copyright, a part divider) is shown by its own name alone.
  if (!chapterNumbering(chapters).numbers[index]) return { ordinal: title, name: '' };
  const ordinal = chapterPositionLabel(chapters, index);
  let name = title;
  if (/^Chapter \d+ of \d+$/.test(ordinal)) {
    const rest = title.replace(/^(?:chapter|ch\.?)\s+[\w-]+\s*[:.\-–—]?\s*/i, '').trim();
    if (rest && rest !== title) name = rest;
  }
  return { ordinal, name };
}

// The open book's progress at the live player speed. One computation feeds
// the player's book sentence and the mini player.
function currentBookProgress() {
  const book = deps.getCurrentBook?.();
  if (!book || !deps.getChapters?.().length) return null;
  return bookProgressInfo(book, {
    chapterIndex: deps.getCurrentChapter(),
    timestamp: deps.getCurrentChapterTime?.() || 0,
    finished: deps.getCurrentBookFinished()
  }, deps.getCurrentPlaybackSpeed());
}

// "9h 12m left in the book at 1.25×", from the shared time-left helper.
export function bookLineText(progress) {
  if (!progress || progress.timeLeft == null) return '';
  if (progress.timeLeft === 0) return 'Finished';
  return `${timeLeftLabel(progress.timeLeft, progress.speed, { withSpeed: false })} in the book at ${formatSpeed(progress.speed)}`;
}

// Book position is one sentence under the chapter scrubber; book-wide
// seeking lives in the ••• menu (Go to position in book).
let lastBookLine = null;
export function updateBookProgress() {
  syncMiniPlayerTimeLeft();
  const lineEl = document.getElementById('player-book-line');
  const progress = deps.getCurrentBook?.() && deps.getChapters?.().length ? currentBookProgress() : null;
  const text = bookLineText(progress);
  if (lineEl && text !== lastBookLine) {
    lineEl.textContent = text;
    lineEl.hidden = !text;
    lastBookLine = text;
  }
  updateStartOverButton();
}

// Start over sits in the ••• menu behind its confirmation, so it is offered
// for any open book rather than only near the end.
function updateStartOverButton() {
  if (!startOverBtn) return;
  startOverBtn.hidden = !deps.getCurrentBook?.();
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
  // A collection prints its source-work headings above the pieces they cover.
  // Each heading opens an ARIA group so the listbox keeps announcing which work
  // a piece came from, and closes when the next heading starts.
  let openGroup = false;
  const openGroupFor = (heading) => {
    const prefix = openGroup ? '</div>' : '';
    openGroup = true;
    return `${prefix}<div class="chapter-list-group" role="group" aria-label="${escapeHTML(heading)}">`
      + `<p class="chapter-list-heading">${escapeHTML(heading)}</p>`;
  };
  const closeGroup = () => {
    if (!openGroup) return '';
    openGroup = false;
    return '</div>';
  };
  const chapters = deps.getChapters();
  // Without authored headings, rows that all start with the same part name
  // ("Part I: Sick Kids — Chapter 1", "… — Chapter 2") print that name once
  // as a group heading and keep only what differs.
  const derived = chapters.some(chapter => chapter?.groupHeading) ? [] : sharedTitlePrefixes(chapters);
  let derivedHeading = null;
  chapterList.innerHTML = chapters.map((chapter, index) => {
    if (chapter.empty) return '';
    let groupHeading = '';
    const shared = derived[index] || null;
    if (chapter.groupHeading) {
      groupHeading = openGroupFor(chapter.groupHeading);
    } else if (shared && shared.heading !== derivedHeading) {
      groupHeading = openGroupFor(shared.heading);
    } else if (!shared && derivedHeading) {
      groupHeading = closeGroup();
    }
    if (!chapter.groupHeading) derivedHeading = shared?.heading || null;
    const itemState = chapterListItemState(index, deps.getCurrentChapter());
    const isActive = itemState === 'active';
    const title = displayChapterTitle(shared ? { ...chapter, title: shared.rest } : chapter, index);
    const dur = formatDuration(durations?.[index] || chapter.estimatedDuration);
    const friendlyType = chapter.type && chapter.type !== 'content' && chapter.type !== 'chapter'
      ? friendlyChapterType(chapter.type)
      : '';
    // "Copyright / Copyright" says nothing twice.
    const typeLabel = friendlyType.toLowerCase() === title.toLowerCase() ? '' : friendlyType;
    const metaLabel = [isActive ? 'Now playing' : '', typeLabel].filter(Boolean).join(' \u00b7 ');
    const classes = ['chapter-list-item'];
    if (isActive) classes.push('active');
    const premiumDot = premiumMode && premiumReadiness[index]
      ? '<span class="chapter-premium-dot" role="img" aria-label="Premium audio ready"></span>'
      : '';
    const ordinal = chapterListOrdinal(chapters, index);
    return `${groupHeading}
      <button class="${classes.join(' ')}" type="button" role="option" aria-selected="${isActive}" data-chapter-index="${index}">
        <span class="chapter-list-index">${premiumDot}${ordinal}</span>
        <span class="chapter-list-copy">
          <span class="chapter-list-title">${escapeHTML(title)}</span>
          <span class="chapter-list-meta">${escapeHTML(metaLabel)}</span>
        </span>
        <span class="chapter-list-duration">${dur ? escapeHTML(dur) : ''}</span>
        <span class="chapter-list-current" aria-hidden="true">${isActive ? ICON_NOW_PLAYING : ''}</span>
      </button>
    `;
  }).join('') + (openGroup ? '</div>' : '');
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
let unplayableLoadingKey = null;

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
      if (audioLoadingPollKey !== key) return;
      if (data.status === 'unplayable' || data.retryable === false) {
        unplayableLoadingKey = key;
        showAudioLoading('This section has no playable text', {
          status: 'error', detail: 'Select the next section from Contents.'
        });
        return;
      }
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
  const key = `${deps.getCurrentBook?.()?.id}:${deps.getCurrentChapter?.()}`;
  if (unplayableLoadingKey === key) {
    text = 'This section has no playable text';
    options = { status: 'error', detail: 'Select the next section from Contents.' };
  } else {
    unplayableLoadingKey = null;
  }
  if (audioLoading && loadingText) {
    loadingText.textContent = text;
    const status = options.status || 'preparing';
    markInlineStatus(audioLoading, status === 'error' ? (options.toastKey || 'audio-error') : null);
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
    syncPlaybackControls();

    if (status === 'preparing' || status === 'generating') {
      startAudioLoadingPoll();
    } else {
      stopAudioLoadingPoll();
    }
  }
}

export function hideAudioLoading() {
  unplayableLoadingKey = null;
  if (audioLoading) {
    audioLoading.style.display = 'none';
    audioLoading.dataset.status = '';
    markInlineStatus(audioLoading, null);
    audioLoading.classList.remove('is-indeterminate');
    narrationPreparingStartedAt = 0;
    stopAudioLoadingPoll();
    renderOverlayActions(null);
    if (loadingDetail) loadingDetail.textContent = '';
    if (audioLoadingFill) audioLoadingFill.style.width = '0%';
    syncPlaybackControls();
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
    markInlineStatus(audioLoading, options.toastKey || (state === 'error' ? 'audio-error' : null));
    if (loadingText) loadingText.textContent = options.message || 'Narration needs attention';
    if (loadingDetail) loadingDetail.textContent = options.detail || '';
    if (audioLoadingFill) audioLoadingFill.style.width = '0%';
    audioLoading.style.display = 'flex';
    syncPlaybackControls();
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
  dismissBtn.className = 'pl-btn pl-btn-secondary';
  dismissBtn.textContent = options.dismissOnly ? 'OK' : 'Dismiss';
  dismissBtn.addEventListener('click', () => hideAudioLoading());
  if (options.dismissOnly) {
    audioLoadingActions.append(dismissBtn);
    audioLoadingActions.hidden = false;
    return;
  }
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'pl-btn pl-btn-primary';
  retryBtn.textContent = options.retryLabel || 'Retry';
  const retry = () => {
    hideAudioLoading();
    if (typeof options.onRetry === 'function') options.onRetry();
    else deps.loadChapter?.(deps.getCurrentChapter?.());
  };
  retryBtn.addEventListener('click', retry);
  // The second recovery path: switch this book to the instant narrator when
  // one is offered (then retry once the choice is saved), otherwise open the
  // narrator picker.
  const fallback = document.getElementById('narration-fallback');
  const canUseInstant = fallback && !fallback.hidden && fallback.value !== 'instant';
  const altBtn = document.createElement('button');
  altBtn.type = 'button';
  altBtn.className = 'pl-btn pl-btn-secondary';
  altBtn.textContent = canUseInstant ? 'Use instant narrator' : 'Change narrator';
  altBtn.addEventListener('click', () => {
    if (canUseInstant) chooseNarrationFallback('instant').then(retry);
    else document.getElementById('player-voice-status')?.click();
  });
  dismissBtn.className = 'pl-textbtn pl-card-dismiss';
  audioLoadingActions.append(retryBtn, altBtn, dismissBtn);
  audioLoadingActions.hidden = false;
}


// --- Narration line and cards ---
// One line, "Ryan · 2h 10m ready ahead", that opens the narrator picker. It
// expands into a card while the book prepares, while a chapter loads, after
// a failure, or when playback needs a tap. voices.js keeps painting the
// narrator name, the preparation panel (#hq-voice-prep*) and the fallback
// choice; this module only composes them, so every preparation, recovery
// and reliability behaviour stays where it was.
let narrationEl = null;
let narrationLine = null;
let narrationReady = null;
let narrationCache = null;
let hqPrep = null;
let hqPrepBtn = null;
let hqPrepHeading = null;
let hqPrepStretch = null;
let hqPrepDetail = null;
let hqPrepChoice = null;
let hqPrepActions = null;
let hqPrepHeadAction = null;
let narrationSyncQueued = false;

function initNarration() {
  narrationEl = document.getElementById('player-narration');
  narrationLine = document.getElementById('player-voice-status');
  narrationReady = document.getElementById('player-narration-ready');
  narrationCache = document.getElementById('player-voice-cache');
  hqPrep = document.getElementById('hq-voice-prep');
  hqPrepBtn = document.getElementById('hq-voice-prep-btn');
  hqPrepHeading = document.getElementById('hq-prep-heading');
  hqPrepStretch = document.getElementById('hq-prep-stretch');
  hqPrepDetail = document.getElementById('hq-voice-prep-detail');
  hqPrepChoice = document.getElementById('hq-prep-choice');
  hqPrepActions = document.getElementById('hq-prep-actions');
  hqPrepHeadAction = hqPrep?.querySelector('.pl-card-head-action') || null;
  if (!narrationEl) return;

  narrationEl.addEventListener('click', event => {
    const choice = event.target.closest('[data-fallback-choice]');
    if (!choice || choice.disabled) return;
    void chooseNarrationFallback(choice.dataset.fallbackChoice);
  });

  if (typeof MutationObserver !== 'function') return;
  const observer = new MutationObserver(scheduleNarrationSync);
  const watch = (el, options) => { if (el) observer.observe(el, options); };
  watch(hqPrep, { attributes: true, attributeFilter: ['hidden', 'data-state'] });
  for (const id of ['hq-voice-prep-title', 'hq-voice-prep-detail', 'hq-voice-prep-count', 'player-voice-name', 'player-voice-cache']) {
    watch(document.getElementById(id), { childList: true, characterData: true, subtree: true });
  }
  watch(hqPrepBtn, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  watch(document.getElementById('narration-fallback'), {
    attributes: true, attributeFilter: ['hidden', 'disabled'], childList: true, characterData: true, subtree: true
  });
  watch(audioLoading, { attributes: true, attributeFilter: ['style', 'data-status'] });
  watch(playbackReliability, { attributes: true, attributeFilter: ['hidden'] });
  watch(playbackResumePrompt, { attributes: true, attributeFilter: ['hidden'] });
  syncNarration();
}

function scheduleNarrationSync() {
  if (narrationSyncQueued) return;
  narrationSyncQueued = true;
  queueMicrotask(() => {
    narrationSyncQueued = false;
    syncNarration();
  });
}

// Saves the "if a chapter isn't ready" choice through the existing control
// (voices.js persists it on change). Resolves once the save settles.
export function chooseNarrationFallback(value) {
  const select = document.getElementById('narration-fallback');
  if (!select || select.hidden || select.disabled) return Promise.resolve(false);
  if (select.value === value) return Promise.resolve(true);
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  scheduleNarrationSync();
  return new Promise(resolve => {
    const started = Date.now();
    const check = () => {
      if (!select.disabled || Date.now() - started > 8000) resolve(true);
      else setTimeout(check, 100);
    };
    setTimeout(check, 50);
  });
}

// Listening time already prepared from the current position at the current
// speed, from the narration summary voices.js keeps for the player.
function readyAhead(summary) {
  if (summary.readyAheadSeconds === null) return null;
  return {
    seconds: summary.readyAheadSeconds,
    firstUnready: summary.firstUnreadyChapter,
    ready: summary.readyChapters,
    total: summary.totalChapters
  };
}

function readyAheadText(ahead, state) {
  if (state === 'ready' || (ahead && ahead.firstUnready === null && ahead.ready > 0)) return 'All ready';
  if (!ahead) return '';
  if (ahead.seconds >= 60) return `${formatDuration(ahead.seconds)} ready ahead`;
  return state === 'generating' ? 'Preparing' : 'Not ready yet';
}

function isShownEl(el) {
  return Boolean(el && !el.hidden && el.style.display !== 'none');
}

export function syncNarration() {
  if (!narrationEl) return;
  const summary = getNarrationSummary({
    speed: deps.getCurrentPlaybackSpeed?.(),
    chapterTime: deps.getCurrentChapterTime?.() || 0
  });
  const name = summary.name;
  const preparingName = summary.selectedName;
  const hqVisible = Boolean(hqPrep && !hqPrep.hidden);
  const hqState = hqPrep?.dataset.state || 'idle';
  const hqError = hqVisible && hqState === 'error';
  const hqCard = hqVisible && !['ready', 'loading'].includes(hqState);
  const loadingShown = isShownEl(audioLoading);
  const loadingStatus = audioLoading?.dataset.status || '';
  const audioError = loadingShown && loadingStatus === 'error';
  const ahead = hqVisible ? readyAhead(summary) : null;
  const fallback = document.getElementById('narration-fallback');
  const fallbackOffered = Boolean(fallback && !fallback.hidden);

  // Keep the actual narrator and useful readiness on one compact line. The
  // engine remains in its accessible label and narrator-selection sheet.
  const ready = hqVisible && !summary.differsFromSelected ? readyAheadText(ahead, hqState) : '';
  const lineParts = [ready].filter(Boolean);
  if (narrationReady) {
    narrationReady.textContent = lineParts.length ? ` · ${lineParts.join(' · ')}` : '';
    narrationReady.hidden = !lineParts.length;
  }
  if (narrationCache) narrationCache.hidden = !summary.differsFromSelected;
  const spoken = [name, summary.engineLabel, ready, summary.differsFromSelected ? narrationCache?.textContent : ''].filter(Boolean);
  narrationLine?.setAttribute('aria-label', `Narration: ${spoken.join(', ')}. Change narrator`);
  const moreNarrator = document.getElementById('player-more-narrator');
  if (moreNarrator) moreNarrator.textContent = name;

  // The preparation card.
  if (hqPrep) {
    hqPrep.classList.toggle('is-collapsed', !hqCard);
    hqPrep.classList.toggle('is-error', hqError);
    markInlineStatus(hqPrep, hqError ? 'narration-prep-error' : null);
    const chapterNumbers = chapterNumbering(deps.getChapters?.());
    const readiness = getPremiumChapterReadiness();
    const countedChapters = chapterNumbers.numbers.filter(Boolean).length;
    const readyChapters = chapterNumbers.numbers.filter((number, index) => number && readiness[index]).length;
    const counts = ahead && countedChapters ? `${readyChapters} of ${countedChapters} chapters` : '';
    let heading;
    if (hqError) {
      const at = ahead?.firstUnready != null ? ` at ${chapterPositionLabel(deps.getChapters?.(), ahead.firstUnready, { withTotal: false })}` : '';
      heading = `<strong>Narration failed</strong>${escapeHTML(at)} · ${escapeHTML(preparingName)}`;
    } else if (counts) {
      const lead = hqState === 'generating' ? `Preparing with ${preparingName}` : preparingName;
      heading = `<strong>${escapeHTML(lead)}</strong> · ${escapeHTML(counts)}`;
    } else {
      heading = `<strong>${escapeHTML(document.getElementById('hq-voice-prep-title')?.textContent || name)}</strong>`;
    }
    if (hqPrepHeading && hqPrepHeading.innerHTML !== heading) hqPrepHeading.innerHTML = heading;

    const stretchParts = [];
    if (ahead && !hqError) {
      if (ahead.seconds >= 60) stretchParts.push(`${formatDuration(ahead.seconds)} ready ahead`);
      if (ahead.firstUnready !== null) stretchParts.push(`${chapterPositionLabel(deps.getChapters?.(), ahead.firstUnready, { withTotal: false })} not ready yet`);
    }
    const stretch = stretchParts.join(' · ');
    if (hqPrepStretch) {
      if (hqPrepStretch.textContent !== stretch) hqPrepStretch.textContent = stretch;
      hqPrepStretch.hidden = !stretch;
    }
    // voices.js words every state; while preparing runs normally the stretch
    // above already says it, unless the status is stale.
    const detailText = hqPrepDetail?.textContent || '';
    if (hqPrepDetail) hqPrepDetail.hidden = hqState === 'generating' && Boolean(stretch) && !/^Reconnecting/.test(detailText);

    // Pause / Resume / Prepare sit in the head; Retry becomes a full button.
    if (hqPrepBtn) {
      const home = hqError ? hqPrepActions : hqPrepHeadAction;
      if (home && hqPrepBtn.parentElement !== home) home.prepend(hqPrepBtn);
      hqPrepBtn.className = hqError ? 'pl-btn pl-btn-primary' : 'pl-textbtn';
      const label = hqPrepBtn.textContent.trim();
      hqPrepBtn.setAttribute('aria-label', label === 'Pause' ? 'Pause preparation'
        : label === 'Resume' ? 'Resume preparation' : label === 'Retry' ? 'Retry preparation' : label);
    }
    if (hqPrepActions) {
      hqPrepActions.hidden = !hqError;
      const instant = hqPrepActions.querySelector('[data-fallback-choice="instant"]');
      if (instant) instant.hidden = !fallbackOffered || fallback.value === 'instant';
    }
    if (hqPrepChoice) {
      hqPrepChoice.hidden = !fallbackOffered || hqError;
      if (fallbackOffered) {
        hqPrepChoice.querySelectorAll('[data-fallback-choice]').forEach(chip => {
          const value = chip.dataset.fallbackChoice;
          const option = [...fallback.options].find(item => item.value === value);
          const label = value === 'wait' ? (option?.textContent || 'Wait') : 'Instant narrator';
          if (chip.textContent !== label) chip.textContent = label;
          if (value === 'instant' && option) chip.title = option.textContent;
          chip.setAttribute('aria-pressed', String(fallback.value === value));
          chip.disabled = fallback.disabled;
        });
      }
    }
  }

  // The chapter-loading card sets its own glyph from its status (CSS).
  const failed = hqError || audioError;
  narrationEl.dataset.mode = failed ? 'failed' : (hqCard || loadingShown ? 'card' : 'line');
  // The card names the narrator itself, so the line steps aside for it.
  if (narrationLine) narrationLine.hidden = (hqCard || audioError) && !summary.differsFromSelected;
}

// --- ••• menu ---
let moreSheetController = null;
let moreMenuReplaying = false;

function waitForSheetClose() {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('popstate', finish);
      setTimeout(resolve, 0);
    };
    window.addEventListener('popstate', finish);
    setTimeout(finish, 350);
  });
}

function initMoreMenu() {
  const sheet = document.getElementById('player-more-sheet');
  if (!sheet) return;
  moreSheetController = registerSheet(sheet, {
    backdrop: document.getElementById('player-more-backdrop'),
    closeBtn: document.getElementById('player-more-close'),
    focusTarget: () => sheet.querySelector('.player-more-panel'),
    initialFocus: () => document.getElementById('player-more-title'),
    onOpen: syncMoreMenu
  });
  document.getElementById('player-more-btn')?.addEventListener('click', () => moreSheetController.open());

  // A row closes the menu first, then runs its existing action (which may
  // open its own sheet), so the history-backed sheets never interleave.
  // Programmatic clicks while the menu is closed (keyboard shortcuts) pass
  // straight through.
  sheet.addEventListener('click', event => {
    const row = event.target.closest('[data-more-row]');
    if (!row || moreMenuReplaying || !sheet.classList.contains('active')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (row.disabled) return;
    moreSheetController.dismiss();
    waitForSheetClose().then(() => {
      moreMenuReplaying = true;
      try { row.click(); } finally { moreMenuReplaying = false; }
    });
  }, true);

  document.getElementById('player-queue-btn')?.addEventListener('click', () => {
    const book = deps.getCurrentBook?.();
    if (book?.id) deps.addToListeningQueue?.(book.id);
  });
  document.getElementById('player-book-seek-btn')?.addEventListener('click', openBookSeekSheet);

  sheet.querySelectorAll('[data-player-book-setting]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.playerBookSetting;
      const choice = button.dataset.choice;
      void saveBookSettingFromMenu(key, choice);
    });
  });
}

function syncMoreMenu() {
  const hasTimeline = Boolean(completeBookTimeline());
  const seekBtn = document.getElementById('player-book-seek-btn');
  if (seekBtn) seekBtn.disabled = !hasTimeline;
  const note = document.getElementById('player-book-seek-note');
  if (note) note.hidden = hasTimeline;
  syncBookSettingControls();
  syncNarration();
}

function bookSettingChoice(key) {
  if (typeof playbackSpeed.getBookPlaybackSettingChoice === 'function') {
    return playbackSpeed.getBookPlaybackSettingChoice(key);
  }
  const settings = deps.getCurrentBookPlaybackSettings?.() || {};
  return Object.hasOwn(settings, key) ? (settings[key] ? 'on' : 'off') : 'default';
}

function paintBookSettingChoice(key, choice) {
  document.querySelectorAll(`[data-player-book-setting="${key}"]`).forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.choice === choice));
  });
}

function syncBookSettingControls() {
  for (const key of ['smartRewindEnabled', 'rollingOfflineEnabled']) paintBookSettingChoice(key, bookSettingChoice(key));
}

// Per-book Smart rewind and Automatic cache. Uses the speed module's
// serialized per-book save when it is available, otherwise the same
// saveBookPlaybackSettings path in order.
let menuSettingChain = Promise.resolve();
async function saveBookSettingFromMenu(key, choice) {
  const book = deps.getCurrentBook?.();
  if (!book) return;
  const value = choice === 'default' ? null : choice === 'on';
  paintBookSettingChoice(key, choice);
  let request;
  if (typeof playbackSpeed.setBookPlaybackSetting === 'function') {
    request = Promise.resolve(playbackSpeed.setBookPlaybackSetting(key, value));
  } else {
    if (!deps.saveBookPlaybackSettings) return;
    request = menuSettingChain.then(() => deps.saveBookPlaybackSettings(book.id, { [key]: value }));
    menuSettingChain = request.catch(() => undefined);
    request = request.catch(error => {
      showToast('Could not save book settings', 'error');
      throw error;
    });
  }
  try { await request; } catch {}
  if (deps.getCurrentBook?.() === book) syncBookSettingControls();
}

// --- Go to position in book ---
let bookSeekController = null;
let bookSeekSlider = null;

function initBookSeekSheet() {
  const sheet = document.getElementById('book-seek-sheet');
  if (!sheet) return;
  bookSeekSlider = document.getElementById('book-seek-slider');
  bookSeekController = registerSheet(sheet, {
    backdrop: document.getElementById('book-seek-backdrop'),
    closeBtn: document.getElementById('book-seek-close'),
    focusTarget: () => sheet.querySelector('.book-seek-panel'),
    initialFocus: () => document.getElementById('book-seek-title'),
    onOpen: syncBookSeekSheet
  });
  bookSeekSlider?.addEventListener('input', paintBookSeekPreview);
  bookSeekSlider?.addEventListener('keydown', event => {
    // Arrow keys move one minute; Page keys ten.
    const total = completeBookTimeline()?.reduce((sum, value) => sum + Number(value), 0) || 0;
    const step = { ArrowLeft: -60, ArrowDown: -60, ArrowRight: 60, ArrowUp: 60, PageDown: -600, PageUp: 600 }[event.key];
    if (!step || !(total > 0) || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    bookSeekSlider.value = Math.max(0, Math.min(100, Number(bookSeekSlider.value) + step / total * 100));
    paintBookSeekPreview();
  });
  document.getElementById('book-seek-cancel')?.addEventListener('click', () => bookSeekController.dismiss());
  document.getElementById('book-seek-go')?.addEventListener('click', () => {
    const percent = Number(bookSeekSlider?.value) || 0;
    bookSeekController.dismiss();
    waitForSheetClose().then(() => {
      Promise.resolve(deps.seekAcrossBook?.(percent)).catch(error => console.error('Book seek failed:', error));
    });
  });
}

export function openBookSeekSheet() {
  if (!completeBookTimeline()) return;
  bookSeekController?.open();
}

function syncBookSeekSheet() {
  const position = bookTimelinePosition(completeBookTimeline(), deps.getCurrentChapter?.(), deps.getCurrentChapterTime?.() || 0);
  if (bookSeekSlider) bookSeekSlider.value = position ? position.percent : 0;
  paintBookSeekPreview();
}

function paintBookSeekPreview() {
  const percent = Number(bookSeekSlider?.value) || 0;
  const target = getBookSeekTarget(percent);
  const preview = document.getElementById('book-seek-preview');
  bookSeekSlider?.style.setProperty('--seek-percent', `${percent}%`);
  if (!target) {
    if (preview) preview.textContent = 'Book seeking needs a duration for every chapter';
    return;
  }
  const chapters = deps.getChapters?.() || [];
  const { ordinal, name } = chapterRowLabels(chapters, target.chapterIndex);
  const where = [ordinal, name].filter(Boolean).join(' · ');
  const text = `${where} · ${formatTime(target.chapterTime)} into the chapter`;
  if (preview) preview.textContent = text;
  const elapsed = document.getElementById('book-seek-elapsed');
  const total = document.getElementById('book-seek-total');
  if (elapsed) elapsed.textContent = formatTime(target.elapsed);
  if (total) total.textContent = `−${formatTime(Math.max(0, target.total - target.elapsed))}`;
  bookSeekSlider?.setAttribute('aria-valuetext', `${formatTime(target.elapsed)} of ${formatTime(target.total)}. ${where}`);
}

// --- Bookmark confirmation ---
// Confirms on the Bookmark tool ("Saved · 12:04") instead of a toast when
// the tool is on screen. Returns false otherwise so the caller can toast.
export function confirmBookmarkSaved(timestamp) {
  const tool = document.getElementById('utility-bookmark-btn');
  if (!tool || !tool.isConnected || tool.getClientRects().length === 0) return false;
  showInlineConfirmation(tool, `Saved · ${formatTime(timestamp)}`);
  return true;
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
  } else {
    mini.style.display = 'none';
    document.body.classList.remove('has-mini-player');
  }
}

export function syncMiniPlayerInfo() {
  if (!deps.getCurrentBook()) return;
  const titleEl = document.getElementById('mini-player-title');
  const coverEl = document.getElementById('mini-player-cover');
  if (titleEl) titleEl.textContent = deps.getCurrentBook().title;
  syncMiniPlayerTimeLeft();
  if (coverEl) {
    coverEl.src = `${API_BASE}/api/cover/${encodeURIComponent(deps.getCurrentBook().id)}`;
    coverEl.alt = deps.getCurrentBook().title;
    coverEl.onerror = () => { coverEl.style.display = 'none'; };
    coverEl.onload = () => { coverEl.style.display = 'block'; };
  }
}

// Mini player status line: "Ch 12 of 50 · 9h 12m left at 1.25×", and the
// book-progress hairline. Runs on every time update, so it writes only when
// the visible text or width changes.
let lastMiniLine = '';
let lastMiniPercent = '';
export function syncMiniPlayerTimeLeft() {
  const chapterEl = document.getElementById('mini-player-chapter');
  const progressEl = document.getElementById('mini-player-progress');
  const book = deps.getCurrentBook?.();
  const chapters = deps.getChapters?.() || [];
  if (!book || !chapters[deps.getCurrentChapter()]) return;
  const context = chapterPositionLabel(chapters, deps.getCurrentChapter(), { short: true })
    || displayChapterTitle(chapters[deps.getCurrentChapter()], deps.getCurrentChapter());
  const progress = currentBookProgress();
  // The speed is stated only when it differs from the one the library's
  // sort line already states.
  const timeLeft = progress?.timeLeft != null
    ? timeLeftLabel(progress.timeLeft, progress.speed, { referenceSpeed: playbackSpeed.getReferencePlaybackSpeed?.() ?? null })
    : '';
  const line = [context, timeLeft].filter(Boolean).join(' · ');
  if (chapterEl && line !== lastMiniLine) {
    chapterEl.textContent = line;
    lastMiniLine = line;
  }
  const percent = progress?.percent != null ? `${progress.percent}%` : '0%';
  if (progressEl && percent !== lastMiniPercent) {
    progressEl.style.width = percent;
    lastMiniPercent = percent;
  }
  document.getElementById('mini-player-open')
    ?.setAttribute('aria-label', `Now playing: ${book.title || 'Untitled'}. ${line}. Open the player`);
}

export function syncPlaybackControls(forcePlaying = null) {
  const state = deps.getPlaybackControlState?.() || {};
  const isPlaying = forcePlaying ?? state.isPlaying ?? Boolean(deps.getChunkPlayer?.()?.isPlaying);
  const preparing = !isPlaying && Boolean(state.preparing);
  for (const button of [playPauseBtn, document.getElementById('mini-player-play')]) {
    if (!button) continue;
    button.disabled = preparing;
    button.setAttribute('aria-busy', String(preparing));
    button.setAttribute('aria-label', preparing ? 'Preparing audio' : isPlaying ? 'Pause' : 'Play');
    button.title = preparing ? 'Preparing audio' : isPlaying ? 'Pause' : 'Play';
    button.style.opacity = preparing ? '0.55' : '1';
    button.innerHTML = preparing ? ICON_PREPARING : isPlaying ? deps.iconPause : deps.iconPlay;
  }
}

export function syncMiniPlayerIcon() {
  syncPlaybackControls();
}

// --- Docked pane: Up Next ---
// At >= 1200px the player is a pane beside the library (player.css). Below
// its tools it lists the listening queue (Up Next) so the next book is one
// click away. Read-only: the library's Up Next rail keeps reordering and
// removal. Hidden on narrower layouts by CSS.
let paneUpNext = null;

function initPaneUpNext() {
  const main = document.querySelector('#player-view .pl-main');
  if (!main || paneUpNext) return;
  paneUpNext = document.createElement('section');
  paneUpNext.id = 'player-up-next';
  paneUpNext.className = 'pl-up-next';
  paneUpNext.setAttribute('aria-labelledby', 'player-up-next-title');
  paneUpNext.hidden = true;
  main.append(paneUpNext);
  paneUpNext.addEventListener('click', event => {
    const row = event.target.closest('[data-up-next-book]');
    if (row) void deps.resumeBook?.(row.dataset.upNextBook);
  });
  document.addEventListener('xandrio:listeningqueue', renderPaneUpNext);
  document.addEventListener('xandrio:libraryloaded', renderPaneUpNext);
  document.addEventListener('xandrio:viewchange', renderPaneUpNext);
}

export function renderPaneUpNext() {
  if (!paneUpNext) return;
  const currentId = String(deps.getCurrentBook?.()?.id ?? '');
  const queued = (deps.getListeningQueueBooks?.() || []).filter(book => String(book.id) !== currentId);
  if (!queued.length) {
    paneUpNext.hidden = true;
    paneUpNext.innerHTML = '';
    return;
  }
  const inProgress = new Map((deps.getRecentBooks?.(50) || []).map(entry => [String(entry.book.id), entry.progress]));
  const reference = playbackSpeed.getReferencePlaybackSpeed?.() ?? null;
  paneUpNext.hidden = false;
  paneUpNext.innerHTML = `
    <h2 id="player-up-next-title" class="pl-up-next-title">Up Next</h2>
    <ul class="pl-up-next-list">${queued.slice(0, 5).map(book => {
      const progress = inProgress.get(String(book.id)) || bookProgressInfo(book, { chapterIndex: 0, timestamp: 0 });
      const left = progress?.timeLeft != null ? timeLeftLabel(progress.timeLeft, progress.speed, { referenceSpeed: reference }) : '';
      const sub = [book.author, left].filter(Boolean).join(' · ');
      return `<li>
        <button type="button" class="pl-up-next-row" data-up-next-book="${escapeHTML(String(book.id))}" aria-label="${escapeHTML(`Play ${book.title || 'Untitled'}${sub ? `, ${sub}` : ''}`)}">
          ${coverImageHTML(book, 'pl-up-next-cover')}
          <span class="pl-up-next-text">
            <span class="pl-up-next-name">${escapeHTML(book.title || 'Untitled')}</span>
            <span class="pl-up-next-sub num">${escapeHTML(sub)}</span>
          </span>
        </button>
      </li>`;
    }).join('')}</ul>`;
}
