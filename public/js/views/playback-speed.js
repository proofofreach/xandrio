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
    btn.addEventListener('click', () => setSpeedFromSheet(parseFloat(btn.dataset.speed)));
  });
  speedStepperDown?.addEventListener('click', () => setSpeedFromSheet(currentPlaybackSpeed - 0.05));
  speedStepperUp?.addEventListener('click', () => setSpeedFromSheet(currentPlaybackSpeed + 0.05));
  setDefaultSpeedBtn?.addEventListener('click', () => {
    setClientSetting('defaultSpeed', currentPlaybackSpeed);
    showToast(`Default speed set to ${currentPlaybackSpeed.toFixed(2)}x`);
  });
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

export function loadPlaybackSpeed() {
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
  let currentIndex = PLAYBACK_SPEEDS.indexOf(currentPlaybackSpeed);
  if (currentIndex === -1) {
    currentIndex = PLAYBACK_SPEEDS.findIndex(speed => speed > currentPlaybackSpeed) - 1;
    if (currentIndex < 0) currentIndex = 0;
  }
  currentIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length;
  currentPlaybackSpeed = PLAYBACK_SPEEDS[currentIndex];
  applyPlaybackSpeed();
  updateSpeedButton();
  writeJSON(PLAYBACK_SPEED_KEY, currentPlaybackSpeed);
  announceToScreenReader(`Playback speed set to ${currentPlaybackSpeed} times normal`);
}

export function applyPlaybackSpeed() {
  deps.getChunkPlayer?.()?.setSpeed?.(currentPlaybackSpeed);
  deps.onSpeedChange?.(currentPlaybackSpeed);
}

export function stepPlaybackSpeed(direction) {
  let currentIndex = PLAYBACK_SPEEDS.indexOf(currentPlaybackSpeed);
  if (currentIndex === -1) {
    currentIndex = PLAYBACK_SPEEDS.reduce((best, speed, index) =>
      Math.abs(speed - currentPlaybackSpeed) < Math.abs(PLAYBACK_SPEEDS[best] - currentPlaybackSpeed) ? index : best, 0);
  }
  const nextIndex = Math.min(PLAYBACK_SPEEDS.length - 1, Math.max(0, currentIndex + direction));
  if (nextIndex === currentIndex) return;
  currentPlaybackSpeed = PLAYBACK_SPEEDS[nextIndex];
  applyPlaybackSpeed();
  updateSpeedButton();
  writeJSON(PLAYBACK_SPEED_KEY, currentPlaybackSpeed);
  announceToScreenReader(`Playback speed set to ${currentPlaybackSpeed} times normal`);
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
}

function setSpeedFromSheet(value) {
  currentPlaybackSpeed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(value * 100) / 100));
  applyPlaybackSpeed();
  updateSpeedButton();
  writeJSON(PLAYBACK_SPEED_KEY, currentPlaybackSpeed);
  announceToScreenReader(`Playback speed set to ${currentPlaybackSpeed} times normal`);
  updateSpeedSheetState();
}
