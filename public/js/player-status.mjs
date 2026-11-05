// One playback status for the open book. The player card, the mini player
// and Audio Activity all read it, so a failure is stated once, in plain words,
// with the actions that apply.
//
//   idle            nothing to report (no book, paused, or dismissed)
//   preparing       audio for the current position is being prepared
//   ready           a playable source is loaded
//   failed          the open or the chapter load failed; Retry applies
//   engine-starting the narrator engine is not up yet; Retry applies
//
// The module is DOM-free so it can be tested in Node. app.js owns the
// transitions; views subscribe and only paint.

export const PLAYER_STATUS_STATES = Object.freeze(['idle', 'preparing', 'ready', 'failed', 'engine-starting']);

const FAILURE_STATES = new Set(['failed', 'engine-starting']);

export function isPlayerFailureState(state) {
  return FAILURE_STATES.has(state);
}

function waitPhrase(seconds) {
  const value = Math.ceil(Number(seconds));
  if (!Number.isFinite(value) || value <= 0) return 'Try again shortly.';
  if (value < 60) return `Try again in ${value} seconds.`;
  const minutes = Math.ceil(value / 60);
  return `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

// Turns an error from the book fetch, the chapter preparation or the media
// element into the card's words. `phase` is 'open' when the book itself could
// not be opened, otherwise 'chapter'.
export function describePlaybackFailure(error = {}, { phase = 'chapter', online = true } = {}) {
  const status = Number(error?.status ?? error?.statusCode ?? (typeof error?.code === 'number' ? error.code : NaN));
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = String(error?.message || error?.error || '');
  const subject = phase === 'open' ? "Couldn't open this book" : "Couldn't play this chapter";

  if (online === false || code === 'OFFLINE') {
    return {
      state: 'failed', reason: 'offline', title: "You're offline",
      detail: 'Connect to the internet, or play a downloaded book.', retry: true
    };
  }
  if (status === 429 || code === 'RATE_LIMITED') {
    return {
      state: 'failed', reason: 'rate-limited', title: 'Too many requests',
      detail: waitPhrase(error?.retryAfterSeconds), retry: true,
      retryAfterSeconds: Number(error?.retryAfterSeconds) || null
    };
  }
  if (
    code === 'ENGINE_UNAVAILABLE' || code === 'ENGINE_STARTING' || status === 503
    || /engine (is )?(starting|unavailable|offline)|warming up|starting up|not running/i.test(message)
  ) {
    return {
      state: 'engine-starting', reason: 'engine-starting', title: 'Narrator engine is starting',
      detail: 'Try again in a moment, or use the instant narrator.', retry: true, instant: true
    };
  }
  if (status === 404) {
    return {
      state: 'failed', reason: 'not-found', title: subject,
      detail: 'The server no longer has this book.', retry: false
    };
  }
  if (status === 401 || status === 403) {
    return {
      state: 'failed', reason: 'auth', title: subject,
      detail: 'Sign in again to keep listening.', retry: true
    };
  }
  if (code === 'PLAYBACK_PREPARATION_TIMEOUT' || /timed out/i.test(message)) {
    return {
      state: 'failed', reason: 'timeout', title: 'Narration is taking too long',
      detail: 'The server did not finish this chapter in time.', retry: true, instant: true
    };
  }
  if (
    code === 'GENERATION_QUARANTINED' || /narration generation failed|failed to prepare chapter audio/i.test(message)
    || (status >= 500 && phase !== 'open')
  ) {
    return {
      state: 'failed', reason: 'narration-failed', title: 'Narration failed for this chapter',
      detail: 'The narrator could not prepare this chapter.', retry: true, instant: true
    };
  }
  if (phase === 'open') {
    return {
      state: 'failed', reason: 'open-failed', title: subject,
      detail: status >= 500 ? 'The server had a problem. Try again.' : 'Check your connection and try again.',
      retry: true
    };
  }
  return {
    state: 'failed', reason: 'load-failed', title: subject,
    detail: 'The audio did not load. Check your connection and try again.', retry: true, instant: true
  };
}

// The words compact surfaces (mini player, Audio Activity) use.
export function playerStatusShortLabel(status) {
  if (!status) return '';
  if (status.state === 'engine-starting') return 'Narrator engine is starting';
  if (status.state === 'failed') return status.title || "Couldn't play";
  if (status.state === 'preparing') return 'Preparing audio';
  return '';
}

export function createPlayerStatus({ onChange = null } = {}) {
  let current = Object.freeze({ state: 'idle', bookId: null, chapterIndex: null, revision: 0 });
  const listeners = new Set();
  if (typeof onChange === 'function') listeners.add(onChange);

  function set(next = {}) {
    const state = PLAYER_STATUS_STATES.includes(next.state) ? next.state : 'idle';
    const value = Object.freeze({
      state,
      bookId: next.bookId ?? null,
      chapterIndex: Number.isInteger(next.chapterIndex) ? next.chapterIndex : null,
      title: next.title || '',
      detail: next.detail || '',
      reason: next.reason || '',
      retry: isPlayerFailureState(state) ? next.retry !== false : false,
      instant: isPlayerFailureState(state) ? Boolean(next.instant) : false,
      revision: current.revision + 1
    });
    const changed = value.state !== current.state || value.bookId !== current.bookId
      || value.chapterIndex !== current.chapterIndex || value.title !== current.title
      || value.detail !== current.detail;
    current = value;
    if (changed) for (const listener of listeners) listener(current);
    return current;
  }

  return {
    get: () => current,
    set,
    // True only for the failure recorded: same book and the same chapter
    // (null, a failed open, matches only null). Every open and load intent
    // resets the status first, so a retry is never mistaken for it.
    isFailedFor(bookId, chapterIndex = null) {
      const chapter = Number.isInteger(chapterIndex) ? chapterIndex : null;
      return isPlayerFailureState(current.state)
        && String(current.bookId) === String(bookId)
        && current.chapterIndex === chapter;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
