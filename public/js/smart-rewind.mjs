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

/**
 * Apply a pending Smart Rewind synchronously, or report that it could not be.
 *
 * A resume triggered by a tap or a lock-screen control must reach
 * `audio.play()` inside the user-activation window iOS opened for it. Anything
 * that awaits first — most importantly reloading a nonseekable HLS source so it
 * can be repositioned — closes that window and the resume fails outright.
 * Rewinding is a comfort; resuming is the point. So this never awaits, never
 * reloads, and hands the caller back a verdict it can report honestly:
 *
 *   applied  — the position moved.
 *   deferred — the source cannot be repositioned right now (nonseekable, or
 *              nothing buffered at the target). Play now; a caller may retry
 *              once the target is buffered.
 *   skipped  — nothing to do.
 *
 * The pause anchor is consumed either way, so a rewind is never re-applied.
 *
 * @returns {{status: 'applied'|'deferred'|'skipped', rewindSeconds: number, targetSeconds: number|null}}
 */
export function applyRewindForResume({
  controller,
  player,
  bookId,
  chapterIndex,
  positionSeconds,
  enabled
}) {
  const nothingToDo = { status: 'skipped', rewindSeconds: 0, targetSeconds: null };
  if (!controller || !enabled) {
    controller?.clear();
    return nothingToDo;
  }
  const plan = controller.planResume({ bookId, chapterIndex, positionSeconds });
  if (!plan) return nothingToDo;
  if (typeof player?.trySeekSync !== 'function') return nothingToDo;
  return {
    status: player.trySeekSync(plan.targetSeconds) ? 'applied' : 'deferred',
    rewindSeconds: plan.rewindSeconds,
    targetSeconds: plan.targetSeconds
  };
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
