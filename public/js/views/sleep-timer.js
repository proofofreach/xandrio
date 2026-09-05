import { normalizeAutoSleepSchedule, autoSleepWindowKey } from '../auto-sleep-schedule.mjs';
import { showToast } from '../ui/toast.js';
import { registerSheet } from '../ui/sheets.js';
import { readJSON, writeJSON, readText, writeText, removeStorage } from '../util/storage.js';
import { onActivate } from '../ui/keys.js';

const { DisposableScope } = globalThis.XandrioLifecycle || {};
const ICON_CLOCK = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="icon-inline"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';

let deps = {};
let sleepTimer = null;
let sleepTimerInterval = null;
let sleepTimerEndTime = null;
let sleepTimerMode = null;
let sleepTimerChapterTarget = null;
let timerBtnInline = null;
let closeTimerModalBtn = null;
let cancelTimerBtn = null;
let extendTimerBtn = null;
let timerModalController = null;
let initScope = null;
const AUTO_SLEEP_KEY = 'xandrio_auto_sleep_schedule';
const AUTO_SLEEP_SKIP_KEY = 'xandrio_auto_sleep_skip';
let autoSleepSchedule = normalizeAutoSleepSchedule(readJSON(AUTO_SLEEP_KEY, {}));
let stopAutoSleepWatch = null;
let autoSleepSkipKey = readText(AUTO_SLEEP_SKIP_KEY, '');

export function checkAutomaticSleepTimer(now = new Date()) {
  const windowKey = autoSleepWindowKey(autoSleepSchedule, now);
  if (!windowKey || sleepTimerMode || !deps.getCurrentBook?.() || !deps.getChunkPlayer?.()?.isPlaying) return;
  if (autoSleepSkipKey === windowKey || readText(AUTO_SLEEP_SKIP_KEY, '') === windowKey) return;
  if (autoSleepSchedule.mode === 'chapter') setSleepTimerToChapterEnd();
  else {
    setSleepTimer(autoSleepSchedule.minutes);
    showToast(`Automatic sleep timer · ${autoSleepSchedule.minutes} minutes`);
  }
}

function initAutomaticSleepSettings() {
  const enabled = document.getElementById('auto-sleep-enabled');
  const start = document.getElementById('auto-sleep-start');
  const end = document.getElementById('auto-sleep-end');
  const duration = document.getElementById('auto-sleep-duration');
  const status = document.getElementById('auto-sleep-status');
  if (!enabled || !start || !end || !duration) return;
  autoSleepSchedule = normalizeAutoSleepSchedule(readJSON(AUTO_SLEEP_KEY, {}));
  const render = () => {
    enabled.checked = autoSleepSchedule.enabled;
    start.value = autoSleepSchedule.start;
    end.value = autoSleepSchedule.end;
    duration.value = autoSleepSchedule.mode === 'chapter' ? 'chapter' : String(autoSleepSchedule.minutes);
    start.disabled = end.disabled = duration.disabled = !autoSleepSchedule.enabled;
  };
  const watch = () => {
    stopAutoSleepWatch?.();
    stopAutoSleepWatch = autoSleepSchedule.enabled ? initScope.interval(() => checkAutomaticSleepTimer(), 15000) : null;
  };
  const save = () => {
    if (enabled.checked && (!start.value || !end.value || start.value === end.value)) {
      if (status) status.textContent = 'Choose different start and end times.';
      return;
    }
    autoSleepSchedule = normalizeAutoSleepSchedule({ enabled: enabled.checked, start: start.value, end: end.value,
      mode: duration.value === 'chapter' ? 'chapter' : 'time', minutes: Number(duration.value) });
    const saved = writeJSON(AUTO_SLEEP_KEY, autoSleepSchedule);
    autoSleepSkipKey = '';
    removeStorage(AUTO_SLEEP_SKIP_KEY);
    render();
    watch();
    if (status) status.textContent = saved ? 'Saved on this device.' : 'Storage is unavailable. This change will last until you reload.';
    checkAutomaticSleepTimer();
  };
  render();
  watch();
  [enabled, start, end, duration].forEach(input => initScope.listen(input, 'change', save));
  initScope.listen(document, 'visibilitychange', () => checkAutomaticSleepTimer());
}

function notifyChapterTargetChange(reason) {
  if (typeof deps.onChapterTargetChange !== 'function') return;
  const target = sleepTimerMode === 'chapter' && sleepTimerChapterTarget
    ? { ...sleepTimerChapterTarget }
    : null;
  Promise.resolve(deps.onChapterTargetChange(target, { reason })).catch(error => {
    console.warn('Sleep timer transport update failed:', error);
  });
}

function syncUtilityTimer(label = 'Sleep timer', active = false) {
  const utilityButton = document.getElementById('utility-timer-btn');
  if (!utilityButton) return;
  utilityButton.classList.toggle('active', active);
  utilityButton.setAttribute('aria-label', label);
}

export function initSleepTimer(options = {}) {
  initScope?.dispose();
  initScope = new DisposableScope();
  deps = options;
  const timerModal = document.getElementById('timer-modal');
  timerBtnInline = document.getElementById('timer-btn-inline');
  closeTimerModalBtn = document.getElementById('close-timer-modal-btn');
  cancelTimerBtn = document.getElementById('cancel-timer-btn');
  extendTimerBtn = document.getElementById('extend-timer-btn');
  timerModalController = registerSheet(timerModal);

  const openTimerModal = () => {
    updateTimerExtendButtonVisibility();
    timerModalController?.open();
  };
  const dismissTimerModal = () => timerModalController?.dismiss();

  initScope.listen(timerBtnInline, 'click', openTimerModal);
  initScope.add(onActivate(timerBtnInline, openTimerModal));
  initScope.listen(closeTimerModalBtn, 'click', dismissTimerModal);
  initScope.listen(cancelTimerBtn, 'click', () => {
    clearSleepTimer();
    dismissTimerModal();
  });
  document.querySelectorAll('.timer-option').forEach(btn => {
    initScope.listen(btn, 'click', () => {
      if (btn.dataset.mode === 'chapter') setSleepTimerToChapterEnd();
      else setSleepTimer(parseInt(btn.dataset.minutes));
      dismissTimerModal();
    });
  });
  initScope.listen(extendTimerBtn, 'click', () => extendSleepTimer(5));
  initAutomaticSleepSettings();
}

export function closeSleepTimerModal() {
  timerModalController?.close();
}

export function isSleepTimerChapterTarget(bookId, chapterIndex) {
  return sleepTimerMode === 'chapter' &&
    sleepTimerChapterTarget &&
    sleepTimerChapterTarget.bookId === bookId &&
    sleepTimerChapterTarget.chapterIndex === chapterIndex;
}

// Sleep Timer
function setSleepTimer(minutes) {
  clearSleepTimer('replace');
  sleepTimerMode = 'time';
  sleepTimerChapterTarget = null;

  const milliseconds = minutes * 60 * 1000;
  sleepTimerEndTime = Date.now() + milliseconds;

  writeText('xandrio_sleep_timer_end', sleepTimerEndTime);
  writeText('xandrio_sleep_timer_mode', 'time');

  updateTimerDisplay();
  timerBtnInline.classList.add('active');
  syncUtilityTimer(`Sleep timer: ${minutes} minutes`, true);

  // Start countdown update interval
  sleepTimerInterval = setInterval(updateTimerDisplay, 1000);

  // Set the actual timer
  sleepTimer = setTimeout(() => {
    // Start fade out (last 30 seconds handled by interval)
    expireSleepTimer('time');
  }, milliseconds);
}

function setSleepTimerToChapterEnd() {
  clearSleepTimer('replace', false);
  sleepTimerMode = 'chapter';
  sleepTimerEndTime = null;
  sleepTimerChapterTarget = {
    bookId: deps.getCurrentBook()?.id || null,
    chapterIndex: deps.getCurrentChapter()
  };

  removeStorage('xandrio_sleep_timer_end');
  writeText('xandrio_sleep_timer_mode', 'chapter');
  writeJSON('xandrio_sleep_timer_chapter_target', sleepTimerChapterTarget);

  if (timerBtnInline) {
    timerBtnInline.classList.add('active', 'timer-armed');
    timerBtnInline.setAttribute('aria-label', 'Sleep timer: end of chapter');
    const countdownEl = document.getElementById('timer-countdown');
    if (countdownEl) {
      countdownEl.textContent = 'End of chapter';
      countdownEl.hidden = false;
    }
  }
  syncUtilityTimer('Sleep timer: end of chapter', true);
  notifyChapterTargetChange('armed');

  showToast('Sleep timer set for end of chapter');
}

// Drops the live countdown/expiry handles without touching persisted state,
// so an arming path can re-arm safely. clearSleepTimer() is the full reset.
function clearSleepTimerHandles() {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }

  if (sleepTimerInterval) {
    clearInterval(sleepTimerInterval);
    sleepTimerInterval = null;
  }
}

export function clearSleepTimer(reason = 'cancelled', notify = true) {
  if (reason === 'cancelled' && autoSleepSchedule.enabled) {
    const key = autoSleepWindowKey(autoSleepSchedule, new Date());
    if (key) {
      autoSleepSkipKey = key;
      writeText(AUTO_SLEEP_SKIP_KEY, key);
    }
  }
  const clearedChapterTarget = sleepTimerMode === 'chapter' && sleepTimerChapterTarget;
  clearSleepTimerHandles();

  sleepTimerEndTime = null;
  sleepTimerMode = null;
  sleepTimerChapterTarget = null;
  removeStorage('xandrio_sleep_timer_end');
  removeStorage('xandrio_sleep_timer_mode');
  removeStorage('xandrio_sleep_timer_chapter_target');

  if (timerBtnInline) {
    timerBtnInline.classList.remove('active', 'timer-armed');
    timerBtnInline.setAttribute('aria-label', 'Sleep timer');
    const countdownEl = document.getElementById('timer-countdown');
    if (countdownEl) {
      countdownEl.textContent = '';
      countdownEl.hidden = true;
    }
  }
  syncUtilityTimer('Sleep timer', false);

  if (deps.getChunkPlayer()) {
    deps.getChunkPlayer().setVolume(1.0);
  }
  updateTimerExtendButtonVisibility();
  if (notify && clearedChapterTarget) notifyChapterTargetChange(reason);
}

function updateTimerDisplay() {
  if (sleepTimerMode === 'chapter') {
    if (timerBtnInline) {
      timerBtnInline.classList.add('timer-armed');
      timerBtnInline.setAttribute('aria-label', 'Sleep timer: end of chapter');
      const countdownEl = document.getElementById('timer-countdown');
      if (countdownEl) {
        countdownEl.textContent = 'End of chapter';
        countdownEl.hidden = false;
      }
    }
    syncUtilityTimer('Sleep timer: end of chapter', true);
    updateTimerExtendButtonVisibility();
    return;
  }
  if (!sleepTimerEndTime) return;

  const remaining = sleepTimerEndTime - Date.now();

  if (remaining <= 0) {
    expireSleepTimer();
    return;
  }

  // Format remaining time as mm:ss
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  const displayTime = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  // The moon icon stays put; only the adjacent countdown text updates.
  if (timerBtnInline) {
    timerBtnInline.classList.add('timer-armed');
    timerBtnInline.setAttribute('aria-label', `Sleep timer: ${minutes} minutes ${seconds} seconds remaining`);
    const countdownEl = document.getElementById('timer-countdown');
    if (countdownEl) {
      countdownEl.textContent = displayTime;
      countdownEl.hidden = false;
    }
  }
  syncUtilityTimer(`Sleep timer: ${minutes} minutes ${seconds} seconds remaining`, true);
  updateTimerExtendButtonVisibility();

  // Handle fade out in last 30 seconds
  if (remaining <= 30000 && deps.getChunkPlayer() && deps.getChunkPlayer().isPlaying) {
    const fadeVolume = remaining / 30000; // 1.0 to 0.0 over 30 seconds
    deps.getChunkPlayer().setVolume(Math.max(0.1, fadeVolume)); // Keep minimum volume until end
  }
}

function updateTimerExtendButtonVisibility() {
  if (extendTimerBtn) extendTimerBtn.hidden = !(sleepTimerMode === 'time' && sleepTimerEndTime);
  if (cancelTimerBtn) cancelTimerBtn.hidden = !sleepTimerMode;
}

function extendSleepTimer(minutes) {
  if (sleepTimerMode !== 'time' || !sleepTimerEndTime) return;
  const remainingMinutes = Math.max(0, sleepTimerEndTime - Date.now()) / 60000;
  setSleepTimer(remainingMinutes + minutes);
  showToast(`Sleep timer extended by ${minutes} min`);
}

export function expireSleepTimer(reason = 'time') {
  const player = deps.getChunkPlayer();
  if (player) {
    // Expiry must cancel recovery as well as pause the media element.
    if (deps.pausePlayback) deps.pausePlayback();
    else player.pause();
    player.setVolume(1.0);
  }

  deps.updatePlaybackUI(false);
  deps.savePosition();

  // Show toast notification
  showToast(reason === 'chapter' ? 'Sleep timer stopped at end of chapter' : 'Sleep timer expired - sweet dreams!');

  clearSleepTimer('expired');
}

export function restoreSleepTimer() {
  const savedMode = readText('xandrio_sleep_timer_mode', '');
  if (savedMode === 'chapter') {
    const target = readJSON('xandrio_sleep_timer_chapter_target', null);
    if (target && target.bookId === deps.getCurrentBook()?.id && Number.isInteger(target.chapterIndex)) {
      clearSleepTimerHandles();
      sleepTimerMode = 'chapter';
      sleepTimerChapterTarget = target;
      timerBtnInline.classList.add('active');
      updateTimerDisplay();
      notifyChapterTargetChange('restored');
    } else {
      clearSleepTimer('restore-invalid');
    }
    return;
  }

  const savedEndTime = readText('xandrio_sleep_timer_end', '');
  if (savedEndTime) {
    const endTime = parseInt(savedEndTime, 10);
    const remaining = endTime - Date.now();

    if (remaining > 0) {
      // Restore timer. Restoring twice (view remount) must replace the
      // handles rather than stack a second countdown and expiry on top.
      clearSleepTimerHandles();
      sleepTimerEndTime = endTime;
      sleepTimerMode = 'time';
      sleepTimerChapterTarget = null;

      // Update display
      timerBtnInline.classList.add('active');
      updateTimerDisplay();

      // Start countdown interval
      sleepTimerInterval = setInterval(updateTimerDisplay, 1000);

      // Set timeout for remaining time
      sleepTimer = setTimeout(() => {
        expireSleepTimer('time');
      }, remaining);
    } else {
      // Timer expired while away
      removeStorage('xandrio_sleep_timer_end');
    }
  }
}
