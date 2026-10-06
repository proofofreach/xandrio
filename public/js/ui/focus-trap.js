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
  const items = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter(el => el.tabIndex >= 0 && !el.matches(':disabled')
      && !el.closest('[hidden], [inert], [aria-hidden="true"]')
      && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
  // A named radio group has one Tab stop; native arrows select its options.
  return items.filter(el => {
    if (el.tagName !== 'INPUT' || el.type !== 'radio' || !el.name) return true;
    const group = items.filter(item => item.tagName === 'INPUT' && item.type === 'radio'
      && item.name === el.name && item.form === el.form);
    return el === (group.find(item => item.checked) || group[0]);
  });
}

// options.initialFocus: an element to focus first (for example a sheet title
// with tabindex="-1") instead of the first control, so a sheet does not open
// with a ring on its close button.
export function trapFocus(container, { initialFocus = null } = {}) {
  if (!container) return () => {};
  const previouslyFocused = document.activeElement;
  const originalTabIndex = container.getAttribute('tabindex');
  if (originalTabIndex === null) container.tabIndex = -1;

  const initial = initialFocus || getFocusable(container)[0] || container;
  initial?.focus({ preventScroll: true });

  function onKeydown(e) {
    if (e.key !== 'Tab') return;
    // Safari's native Tab preference can skip buttons. Advance explicitly so
    // every visible sheet control, including Cancel, stays reachable.
    e.preventDefault();
    const items = getFocusable(container);
    if (!items.length) {
      (initialFocus?.isConnected && container.contains(initialFocus) ? initialFocus : container).focus();
      return;
    }
    const index = items.indexOf(document.activeElement);
    const next = index < 0
      ? (e.shiftKey ? items.length - 1 : 0)
      : (index + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  }

  container.addEventListener('keydown', onKeydown);

  return function release() {
    container.removeEventListener('keydown', onKeydown);
    if (originalTabIndex === null) container.removeAttribute('tabindex');
    if (previouslyFocused?.isConnected && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
  };
}
