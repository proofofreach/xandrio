// Global keyboard shortcuts for Xandrio.
//
// Ignored while typing in a form field/contenteditable, or while any of
// Cmd/Ctrl/Alt is held (so OS and browser shortcuts still work). `actions` is
// a plain object of callbacks supplied by app.js — this module never reaches
// into app state directly.
import { requestSheetClose } from '../router.js';

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function isButtonLike(el) {
  return Boolean(el) && (el.tagName === 'BUTTON' || el.tagName === 'A');
}

// Shared Enter/Space "activate" handler for custom interactive elements
// (role="button" divs, etc). Attaches directly to `el`; works for both
// direct listeners and container-delegated listeners, since the raw event
// is passed through to `handler` for any closest()-based target lookup.
export function onActivate(el, handler) {
  el?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handler(e);
  });
}

export function initKeys(actions = {}) {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        // Let native Enter/Space activation of a focused button/link happen
        // instead of also toggling playback.
        if (isButtonLike(e.target)) return;
        e.preventDefault();
        actions.togglePlay?.();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) actions.chapter?.(-1);
        else actions.skip?.(-Math.abs(actions.getSkipInterval?.() || 15));
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) actions.chapter?.(1);
        else actions.skip?.(Math.abs(actions.getSkipInterval?.() || 15));
        break;
      case 'ArrowUp':
        e.preventDefault();
        actions.speed?.(1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        actions.speed?.(-1);
        break;
      case 'c':
      case 'C':
        actions.chapters?.();
        break;
      case 'v':
      case 'V':
        actions.voices?.();
        break;
      case 'b':
      case 'B':
        actions.bookmark?.();
        break;
      case '/':
        e.preventDefault();
        actions.search?.();
        break;
      case '?':
        e.preventDefault();
        actions.help?.();
        break;
      case 'Escape':
        requestSheetClose();
        break;
      default:
        break;
    }
  });
}
