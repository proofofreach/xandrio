import { getCurrentUserId } from '../api.js';
import { getDefaultSpeed, getSkipInterval, setClientSetting } from '../client-settings.js';
import { announceToScreenReader, showToast } from '../ui/toast.js';
import { registerSheet } from '../ui/sheets.js';
import { readJSON, writeJSON } from '../util/storage.js';
import { onActivate } from '../ui/keys.js';
import { getBookSpeedSetting } from '../features/listening-queue.js';
import { effectiveSpeed, validSpeed, formatSpeed, formatDuration, bookTimeLeft } from '../util/time-left.mjs';

// Single source of truth for both the cycle button and the sheet's preset
// chips (the chips are rendered from this list in initPlaybackSpeed).
const PLAYBACK_SPEEDS = [0.8, 1.0, 1.25, 1.5, 2.0];
const SPEED_MIN = 0.5;
const SPEED_MAX = 3.0;
const PLAYBACK_SPEED_KEY = 'xandrio_playback_speed';

let deps = {};
let currentPlaybackSpeed = 1.0;
let playbackSpeedRevision = 0;
const pendingBookSaves = new Map();
let speedBtn = null;
let skipBackBtn = null;
let skipForwardBtn = null;
let speedSheet = null;
let speedSheetController = null;
let speedSheetBtn = null;
let closeSpeedSheetBtn = null;
let speedStepperValue = null;
let speedStepperDown = null;
let speedStepperUp = null;
let speedHeroValue = null;
let speedHeroLeft = null;
let speedScopeCaption = null;
// Which speed the sheet is editing: this book's own override, or the default
// every book without an override uses. Derived from the saved override when
// the sheet opens, then driven by the "Applies to" control.
let speedScope = 'all';
let bookSmartRewindControl = null;
let bookRollingOfflineControl = null;

export function initPlaybackSpeed(options = {}) {
  deps = options;
  speedBtn = document.getElementById('speed-btn');
  skipBackBtn = document.getElementById('skip-back-btn');
  skipForwardBtn = document.getElementById('skip-forward-btn');
  speedSheet = document.getElementById('speed-sheet');
  speedSheetBtn = document.getElementById('speed-sheet-btn');
  closeSpeedSheetBtn = document.getElementById('close-speed-sheet-btn');
  speedStepperValue = document.getElementById('speed-stepper-value');
  speedStepperDown = document.getElementById('speed-stepper-down');
  speedStepperUp = document.getElementById('speed-stepper-up');
  speedHeroValue = document.getElementById('speed-hero-value');
  speedHeroLeft = document.getElementById('speed-hero-left');
  speedScopeCaption = document.getElementById('speed-scope-caption');
  bookSmartRewindControl = document.getElementById('book-smart-rewind-control');
  bookRollingOfflineControl = document.getElementById('book-rolling-offline-control');

  speedBtn?.addEventListener('click', cyclePlaybackSpeed);
  onActivate(speedBtn, () => cyclePlaybackSpeed());

  speedSheetController = registerSheet(speedSheet, {
    backdrop: document.getElementById('speed-sheet-backdrop'),
    onOpen: () => {
      speedScope = savedBookSpeed() === null ? 'all' : 'book';
      updateSpeedSheetState();
    },
    initialFocus: el => el.querySelector('#speed-sheet-title')
  });
  speedSheetBtn?.addEventListener('click', () => speedSheetController?.open());
  closeSpeedSheetBtn?.addEventListener('click', () => speedSheetController?.dismiss());
  const presetContainer = speedSheet?.querySelector('.speed-presets');
  if (presetContainer) {
    presetContainer.innerHTML = PLAYBACK_SPEEDS.map(speed =>
      `<button type="button" class="speed-preset" data-speed="${speed}" aria-pressed="false"><svg class="speed-preset-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16 10"/></svg>${formatSpeed(speed)}</button>`
    ).join('');
  }
  speedSheet?.querySelectorAll('.speed-preset').forEach(btn => {
    btn.addEventListener('click', () => chooseSheetSpeed(parseFloat(btn.dataset.speed)));
  });
  speedStepperDown?.addEventListener('click', () => chooseSheetSpeed(currentPlaybackSpeed - 0.05));
  speedStepperUp?.addEventListener('click', () => chooseSheetSpeed(currentPlaybackSpeed + 0.05));
  // "Applies to": This book keeps its own speed; All books clears the book's
  // override and makes the current speed the default.
  speedSheet?.querySelectorAll('[data-speed-scope]').forEach(btn => {
    btn.addEventListener('click', () => {
      speedScope = btn.dataset.speedScope === 'book' ? 'book' : 'all';
      persistSheetSpeed();
      updateSpeedSheetState();
    });
  });
  bookSmartRewindControl?.addEventListener('click', event => {
    const button = event.target.closest('[data-book-smart-rewind]');
    if (!button) return;
    const value = button.dataset.bookSmartRewind;
    void saveBookSetting('smartRewindEnabled', value === 'default' ? null : value === 'on');
  });
  bookRollingOfflineControl?.addEventListener('click', event => {
    const button = event.target.closest('[data-book-rolling-offline]');
    if (!button) return;
    const value = button.dataset.bookRollingOffline;
    void saveBookSetting('rollingOfflineEnabled', value === 'default' ? null : value === 'on');
  });
}

// Serialize writes per book so the persisted settings follow click order in
// every browser. Feedback belongs only to the same book instance and its latest
// choice for that setting; other books can save independently.
async function saveBookSetting(key, value, {
  errorMessage = 'Could not save book settings',
  onSaved = updateSpeedSheetState,
  onFailed = null
} = {}) {
  const book = deps.getCurrentBook?.();
  if (!book || !deps.saveBookPlaybackSettings) return;
  const userId = getCurrentUserId();
  const queueKey = `${userId}:${book.id}`;
  let pending = pendingBookSaves.get(queueKey);
  if (!pending) {
    pending = { tail: Promise.resolve(), latest: new Map() };
    pendingBookSaves.set(queueKey, pending);
  }
  const intent = Symbol(key);
  pending.latest.set(key, intent);
  const isCurrent = () => getCurrentUserId() === userId &&
    deps.getCurrentBook?.() === book && pending.latest.get(key) === intent;
  const request = pending.tail.then(() => {
    // Queued work still belongs to the profile that made the choice.
    if (getCurrentUserId() !== userId) return;
    return deps.saveBookPlaybackSettings(book.id, { [key]: value });
  });
  // A failed write must not prevent the next explicit choice from being saved.
  const settled = request.catch(() => undefined);
  pending.tail = settled;
  try {
    await request;
    if (isCurrent()) onSaved();
  } catch {
    if (isCurrent()) {
      showToast(errorMessage, 'error');
      onFailed?.();
    }
  } finally {
    if (pending.tail === settled) pendingBookSaves.delete(queueKey);
  }
}

// Per-book playback settings other views own the controls for (smart rewind and
// automatic cache live in the player's book menu). Same queued, revision-safe
// save path as the speed sheet.
export function setBookPlaybackSetting(key, value, options = {}) {
  return saveBookSetting(key, value, options);
}

// 'default' | 'on' | 'off' for a per-book boolean setting.
export function getBookPlaybackSettingChoice(key) {
  const settings = deps.getCurrentBookPlaybackSettings?.() || {};
  if (!Object.hasOwn(settings, key)) return 'default';
  return settings[key] ? 'on' : 'off';
}

function savedBookSpeed() {
  const settings = deps.getCurrentBookPlaybackSettings?.() || {};
  return validSpeed(settings.playbackSpeed);
}

// A speed picked in the sheet is saved to whatever "Applies to" names.
function chooseSheetSpeed(value) {
  setPlaybackSpeed(value, { remember: speedScope === 'all' });
  persistSheetSpeed();
}

function persistSheetSpeed() {
  const speed = currentPlaybackSpeed;
  if (speedScope === 'book') {
    void saveBookSetting('playbackSpeed', speed, {
      errorMessage: 'Could not save book speed',
      onFailed: () => {
        speedScope = savedBookSpeed() === null ? 'all' : 'book';
        updateSpeedSheetState();
      }
    });
    return;
  }
  writeJSON(PLAYBACK_SPEED_KEY, speed);
  setClientSetting('defaultSpeed', speed);
  if (savedBookSpeed() !== null) {
    void saveBookSetting('playbackSpeed', null, {
      errorMessage: 'Could not reset book speed',
      onFailed: () => {
        speedScope = savedBookSpeed() === null ? 'all' : 'book';
        updateSpeedSheetState();
      }
    });
  }
}

export function getCurrentPlaybackSpeed() {
  return currentPlaybackSpeed;
}

// The speed a book starts at when nothing book-specific is saved: the last
// chosen speed, else the Settings default.
export function getGlobalPlaybackSpeed() {
  return effectiveSpeed(readJSON(PLAYBACK_SPEED_KEY, null), getDefaultSpeed());
}

// The one source for "time left at current effective speed". The open book
// uses the live player speed; any other book uses its saved per-book speed,
// else the global speed it would open at.
export function effectiveSpeedForBook(bookId) {
  const current = deps.getCurrentBook?.();
  if (current && bookId != null && String(current.id) === String(bookId)) {
    return effectiveSpeed(currentPlaybackSpeed);
  }
  return effectiveSpeed(getBookSpeedSetting(bookId), getGlobalPlaybackSpeed());
}

// The speed the library states once ("Time left at 1.25×"): the live speed
// while a book is open, else the global speed.
export function getReferencePlaybackSpeed() {
  return deps.getCurrentBook?.() ? effectiveSpeed(currentPlaybackSpeed) : getGlobalPlaybackSpeed();
}

export function closeSpeedSheet() {
  speedSheetController?.close();
}

export function applySkipIntervalLabels() {
  const interval = getSkipInterval();
  document.querySelectorAll('.skip-label, .mini-skip-label').forEach(el => {
    el.textContent = String(interval);
  });
  skipBackBtn?.setAttribute('aria-label', `Skip back ${interval} seconds`);
  skipForwardBtn?.setAttribute('aria-label', `Skip forward ${interval} seconds`);
  document.getElementById('mini-player-back')?.setAttribute('aria-label', `Back ${interval} seconds`);
  document.getElementById('mini-player-forward')?.setAttribute('aria-label', `Forward ${interval} seconds`);
}

export function loadPlaybackSpeed(bookSpeed = null) {
  playbackSpeedRevision += 1;
  const preferredBookSpeed = Number(bookSpeed);
  if (Number.isFinite(preferredBookSpeed) && preferredBookSpeed >= SPEED_MIN && preferredBookSpeed <= SPEED_MAX) {
    currentPlaybackSpeed = preferredBookSpeed;
    applyPlaybackSpeed();
    updateSpeedButton();
    return;
  }
  const savedSpeed = readJSON(PLAYBACK_SPEED_KEY, null);
  if (savedSpeed !== null) {
    const parsed = parseFloat(savedSpeed);
    currentPlaybackSpeed = (Number.isFinite(parsed) && parsed >= SPEED_MIN && parsed <= SPEED_MAX)
      ? parsed
      : 1.0;
  } else {
    const defaultSpeed = getDefaultSpeed();
    currentPlaybackSpeed = (Number.isFinite(defaultSpeed) && defaultSpeed >= SPEED_MIN && defaultSpeed <= SPEED_MAX)
      ? defaultSpeed
      : 1.0;
  }
  applyPlaybackSpeed();
  updateSpeedButton();
}

function cyclePlaybackSpeed() {
  const next = PLAYBACK_SPEEDS.find(speed => speed > currentPlaybackSpeed) ?? PLAYBACK_SPEEDS[0];
  setPlaybackSpeed(next);
}

export function applyPlaybackSpeed() {
  deps.getChunkPlayer?.()?.setSpeed?.(currentPlaybackSpeed);
  deps.onSpeedChange?.(currentPlaybackSpeed);
}

export function stepPlaybackSpeed(direction) {
  const next = direction > 0
    ? PLAYBACK_SPEEDS.find(speed => speed > currentPlaybackSpeed)
    : direction < 0
      ? PLAYBACK_SPEEDS.findLast(speed => speed < currentPlaybackSpeed)
      : undefined;
  if (next !== undefined) setPlaybackSpeed(next);
}

function updateSpeedButton() {
  const label = formatSpeed(currentPlaybackSpeed);
  if (speedBtn) {
    speedBtn.innerHTML = `<span style="font-size:13px;font-weight:700;">${label}</span>`;
    speedBtn.setAttribute('aria-label', `Playback speed: ${currentPlaybackSpeed} times normal`);
    speedBtn.classList.toggle('active', currentPlaybackSpeed !== 1.0);
  }
  const utilityButton = document.getElementById('utility-speed-btn');
  const utilityValue = document.getElementById('utility-speed-value');
  if (utilityValue) utilityValue.textContent = label;
  if (utilityButton) {
    utilityButton.setAttribute('aria-label', `Playback speed: ${currentPlaybackSpeed} times normal`);
    utilityButton.classList.toggle('active', currentPlaybackSpeed !== 1.0);
  }
}

function updateSpeedSheetState() {
  const label = formatSpeed(currentPlaybackSpeed);
  if (speedStepperValue) speedStepperValue.textContent = label;
  if (speedHeroValue) speedHeroValue.textContent = label;
  if (speedHeroLeft) speedHeroLeft.textContent = speedSheetTimeLeft();
  speedSheet?.querySelectorAll('.speed-preset').forEach(btn => {
    const on = Math.abs(parseFloat(btn.dataset.speed) - currentPlaybackSpeed) < 0.001;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  speedSheet?.querySelectorAll('[data-speed-scope]').forEach(btn => {
    const on = btn.dataset.speedScope === speedScope;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  if (speedScopeCaption) {
    const base = formatSpeed(getGlobalPlaybackSpeed());
    speedScopeCaption.textContent = speedScope === 'book'
      ? `This book keeps ${label} even if you change the default. Books without their own speed use the default, ${base}.`
      : `Every book without its own speed plays at ${base}.`;
  }
  const bookSettings = deps.getCurrentBookPlaybackSettings?.() || {};
  const smartRewindChoice = Object.hasOwn(bookSettings, 'smartRewindEnabled')
    ? (bookSettings.smartRewindEnabled ? 'on' : 'off')
    : 'default';
  const rollingOfflineChoice = Object.hasOwn(bookSettings, 'rollingOfflineEnabled')
    ? (bookSettings.rollingOfflineEnabled ? 'on' : 'off')
    : 'default';
  bookSmartRewindControl?.querySelectorAll('[data-book-smart-rewind]').forEach(button => {
    button.classList.toggle('active', smartRewindChoice === button.dataset.bookSmartRewind);
  });
  bookRollingOfflineControl?.querySelectorAll('[data-book-rolling-offline]').forEach(button => {
    button.classList.toggle('active', rollingOfflineChoice === button.dataset.bookRollingOffline);
  });
}

// "9h 12m left in this book at this speed".
function speedSheetTimeLeft() {
  const book = deps.getCurrentBook?.();
  if (!book) return '';
  const count = Number(deps.getChapterCount?.()) || book.chapterCount;
  const timing = bookTimeLeft(book, {
    chapterIndex: deps.getCurrentChapter?.() ?? 0,
    timestamp: deps.getCurrentChapterTime?.() || 0,
    finished: Boolean(deps.getCurrentBookFinished?.())
  }, currentPlaybackSpeed, count);
  if (!timing) return '';
  if (timing.timeLeft === 0) return 'Finished';
  const left = formatDuration(timing.timeLeft);
  return left ? `${left} left in this book at this speed` : '';
}

function setPlaybackSpeed(value, { remember = true } = {}) {
  playbackSpeedRevision += 1;
  currentPlaybackSpeed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(value * 100) / 100));
  applyPlaybackSpeed();
  updateSpeedButton();
  if (remember) writeJSON(PLAYBACK_SPEED_KEY, currentPlaybackSpeed);
  announceToScreenReader(`Playback speed set to ${currentPlaybackSpeed} times normal`);
  updateSpeedSheetState();
}
