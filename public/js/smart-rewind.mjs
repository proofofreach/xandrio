const STORAGE_KEY = 'xandrio_smart_rewind_pause';

export function rewindSecondsForIdle(idleMs) {
  if (!Number.isFinite(idleMs) || idleMs < 30_000) return 0;
  if (idleMs < 2 * 60_000) return 5;
  if (idleMs < 10 * 60_000) return 10;
  if (idleMs < 60 * 60_000) return 20;
  return 30;
}

function parseAnchor(storage) {
  try {
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
    if (!value || typeof value.bookId !== 'string') return null;
    if (!Number.isInteger(value.chapterIndex) || value.chapterIndex < 0) return null;
    if (!Number.isFinite(value.positionSeconds) || value.positionSeconds < 0) return null;
    if (!Number.isFinite(value.pausedAt)) return null;
    return value;
  } catch {
    return null;
  }
}

export function createSmartRewindController(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const now = options.now || Date.now;

  function clear() {
    try { storage?.removeItem(STORAGE_KEY); } catch {}
  }

  return {
    recordPause({ bookId, chapterIndex, positionSeconds }) {
      if (!bookId || !Number.isInteger(chapterIndex) || chapterIndex < 0) return;
      if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return;
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify({
          bookId,
          chapterIndex,
          positionSeconds,
          pausedAt: now()
        }));
      } catch {}
    },

    planResume({ bookId, chapterIndex, positionSeconds }) {
      const anchor = parseAnchor(storage);
      clear();
      if (!anchor || anchor.bookId !== bookId || anchor.chapterIndex !== chapterIndex) return null;
      const idleMs = Math.max(0, now() - anchor.pausedAt);
      const rewindSeconds = rewindSecondsForIdle(idleMs);
      if (!rewindSeconds) return null;
      const current = Number.isFinite(positionSeconds) ? positionSeconds : anchor.positionSeconds;
      if (Math.abs(current - anchor.positionSeconds) > 2) return null;
      return {
        rewindSeconds,
        targetSeconds: Math.max(0, current - rewindSeconds),
        idleMs
      };
    },

    clear
  };
}
