import { showToast } from '../ui/toast.js';
import { registerSheet } from '../ui/sheets.js';
import { readJSON, writeJSON, readText, writeText, removeStorage } from '../util/storage.js';
import { onActivate } from '../ui/keys.js';

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

function syncUtilityTimer(label = 'Sleep timer', active = false) {
  const utilityButton = document.getElementById('utility-timer-btn');
  if (!utilityButton) return;
  utilityButton.classList.toggle('active', active);
  utilityButton.setAttribute('aria-label', label);
}

export function initSleepTimer(options = {}) {
  deps = options;
  const timerModal = document.getElementById('timer-modal');
  timerBtnInline = document.getElementById('timer-btn-inline');
  closeTimerModalBtn = document.getElementById('close-timer-modal-btn');
  cancelTimerBtn = document.getElementById('cancel-timer-btn');
  extendTimerBtn = document.getElementById('extend-timer-btn');
  timerModalController = registerSheet(timerModal);

  const openTimerModal = () => timerModalController?.open();
  const dismissTimerModal = () => timerModalController?.dismiss();

  timerBtnInline?.addEventListener('click', () => {
    if (sleepTimer || sleepTimerMode === 'chapter') clearSleepTimer();
    else openTimerModal();
  });
  onActivate(timerBtnInline, () => {
    if (sleepTimer || sleepTimerMode === 'chapter') clearSleepTimer();
    else openTimerModal();
  });
  closeTimerModalBtn?.addEventListener('click', dismissTimerModal);
  cancelTimerBtn?.addEventListener('click', () => {
    clearSleepTimer();
    dismissTimerModal();
  });
  document.querySelectorAll('.timer-option').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === 'chapter') setSleepTimerToChapterEnd();
      else setSleepTimer(parseInt(btn.dataset.minutes));
      dismissTimerModal();
    });
  });
  extendTimerBtn?.addEventListener('click', () => extendSleepTimer(5));
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
  clearSleepTimer();
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
  clearSleepTimer();
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

  showToast('Sleep timer set for end of chapter');
}

export function clearSleepTimer() {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }

  if (sleepTimerInterval) {
    clearInterval(sleepTimerInterval);
    sleepTimerInterval = null;
  }

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
  if (!extendTimerBtn) return;
  extendTimerBtn.hidden = !(sleepTimerMode === 'time' && sleepTimerEndTime);
}

function extendSleepTimer(minutes) {
  if (sleepTimerMode !== 'time' || !sleepTimerEndTime) return;
  const remainingMinutes = Math.max(0, sleepTimerEndTime - Date.now()) / 60000;
  setSleepTimer(remainingMinutes + minutes);
  showToast(`Sleep timer extended by ${minutes} min`);
}

export function expireSleepTimer(reason = 'time') {
  // Fade to silence
  if (deps.getChunkPlayer()) {
    deps.getChunkPlayer().setVolume(0);
    setTimeout(() => {
      deps.getChunkPlayer().pause();
      deps.getChunkPlayer().setVolume(1.0); // Reset volume for next play
    }, 100);
  }

  deps.updatePlaybackUI(false);
  deps.savePosition();

  // Show toast notification
  showToast(reason === 'chapter' ? 'Sleep timer stopped at end of chapter' : 'Sleep timer expired - sweet dreams!');

  clearSleepTimer();
}

export function restoreSleepTimer() {
  const savedMode = readText('xandrio_sleep_timer_mode', '');
  if (savedMode === 'chapter') {
    const target = readJSON('xandrio_sleep_timer_chapter_target', null);
    if (target && target.bookId === deps.getCurrentBook()?.id && Number.isInteger(target.chapterIndex)) {
      sleepTimerMode = 'chapter';
      sleepTimerChapterTarget = target;
      timerBtnInline.classList.add('active');
      updateTimerDisplay();
    } else {
      clearSleepTimer();
    }
    return;
  }

  const savedEndTime = readText('xandrio_sleep_timer_end', '');
  if (savedEndTime) {
    const endTime = parseInt(savedEndTime);
    const remaining = endTime - Date.now();

    if (remaining > 0) {
      // Restore timer
      sleepTimerEndTime = endTime;

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
