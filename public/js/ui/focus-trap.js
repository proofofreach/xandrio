// Focus trap for modal sheets/dialogs.
//
// trapFocus(container) moves focus into `container`, wraps Tab/Shift+Tab
// navigation so it can't escape while active, and returns a release() that
// restores focus to whatever was focused before activation.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function getFocusable(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

export function trapFocus(container) {
  if (!container) return () => {};
  const previouslyFocused = document.activeElement;

  const initial = getFocusable(container)[0];
  initial?.focus({ preventScroll: true });

  function onKeydown(e) {
    if (e.key !== 'Tab') return;
    const items = getFocusable(container);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  container.addEventListener('keydown', onKeydown);

  return function release() {
    container.removeEventListener('keydown', onKeydown);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
  };
}
