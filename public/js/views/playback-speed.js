import { getCurrentUserId } from '../api.js';
import { getDefaultSpeed, getSkipInterval, setClientSetting } from '../client-settings.js';
import { announceToScreenReader, showToast } from '../ui/toast.js';
import { registerSheet } from '../ui/sheets.js';
import { readJSON, writeJSON } from '../util/storage.js';
import { onActivate } from '../ui/keys.js';

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
let setDefaultSpeedBtn = null;
let setBookSpeedBtn = null;
let clearBookSpeedBtn = null;
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
  setDefaultSpeedBtn = document.getElementById('set-default-speed-btn');
  setBookSpeedBtn = document.getElementById('set-book-speed-btn');
  clearBookSpeedBtn = document.getElementById('clear-book-speed-btn');
  bookSmartRewindControl = document.getElementById('book-smart-rewind-control');
  bookRollingOfflineControl = document.getElementById('book-rolling-offline-control');

  speedBtn?.addEventListener('click', cyclePlaybackSpeed);
  onActivate(speedBtn, () => cyclePlaybackSpeed());

  speedSheetController = registerSheet(speedSheet, { onOpen: updateSpeedSheetState });
  speedSheetBtn?.addEventListener('click', () => speedSheetController?.open());
  closeSpeedSheetBtn?.addEventListener('click', () => speedSheetController?.dismiss());
  const presetContainer = speedSheet?.querySelector('.speed-presets');
  if (presetContainer) {
    presetContainer.innerHTML = PLAYBACK_SPEEDS.map(speed =>
      `<button type="button" class="speed-preset" data-speed="${speed}">${speed}x</button>`
    ).join('');
  }
  speedSheet?.querySelectorAll('.speed-preset').forEach(btn => {
    btn.addEventListener('click', () => setPlaybackSpeed(parseFloat(btn.dataset.speed)));
  });
  speedStepperDown?.addEventListener('click', () => setPlaybackSpeed(currentPlaybackSpeed - 0.05));
  speedStepperUp?.addEventListener('click', () => setPlaybackSpeed(currentPlaybackSpeed + 0.05));
  setDefaultSpeedBtn?.addEventListener('click', () => {
    setClientSetting('defaultSpeed', currentPlaybackSpeed);
    showToast(`Default speed set to ${currentPlaybackSpeed.toFixed(2)}x`);
  });
  setBookSpeedBtn?.addEventListener('click', () => {
    const speed = currentPlaybackSpeed;
    void saveBookSetting('playbackSpeed', speed, {
      errorMessage: 'Could not save book speed',
      onSaved: () => showToast(`Using ${speed.toFixed(2)}x for this book`)
    });
  });
  clearBookSpeedBtn?.addEventListener('click', () => {
    const revision = playbackSpeedRevision;
    void saveBookSetting('playbackSpeed', null, {
      errorMessage: 'Could not reset book speed',
      onSaved: () => {
        // A later speed choice or book load owns the player now.
        if (revision !== playbackSpeedRevision) return;
        loadPlaybackSpeed();
        updateSpeedSheetState();
        showToast('Using global speed for this book');
      }
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
  onSaved = updateSpeedSheetState
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
    if (isCurrent()) showToast(errorMessage, 'error');
  } finally {
    if (pending.tail === settled) pendingBookSaves.delete(queueKey);
  }
}

export function getCurrentPlaybackSpeed() {
  return currentPlaybackSpeed;
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
  const label = `${currentPlaybackSpeed}x`;
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
  if (speedStepperValue) speedStepperValue.textContent = `${currentPlaybackSpeed.toFixed(2)}x`;
  speedSheet?.querySelectorAll('.speed-preset').forEach(btn => {
    btn.classList.toggle('active', Math.abs(parseFloat(btn.dataset.speed) - currentPlaybackSpeed) < 0.001);
  });
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

function setPlaybackSpeed(value) {
  playbackSpeedRevision += 1;
  currentPlaybackSpeed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(value * 100) / 100));
  applyPlaybackSpeed();
  updateSpeedButton();
  writeJSON(PLAYBACK_SPEED_KEY, currentPlaybackSpeed);
  announceToScreenReader(`Playback speed set to ${currentPlaybackSpeed} times normal`);
  updateSpeedSheetState();
}
