import { sheetOpened, requestSheetClose } from '../router.js';
import { trapFocus } from './focus-trap.js';

export function registerSheet(el, options = {}) {
  const {
    onOpen = null,
    onClose = null,
    backdrop = null,
    closeBtn = null,
    focusTarget = null,
    bodyClass = 'sheet-open',
    activeClass = 'active',
    history = true
  } = options;
  let releaseFocus = null;

  function panel() {
    if (typeof focusTarget === 'function') return focusTarget(el);
    if (focusTarget) return focusTarget;
    return el?.querySelector?.('.modal-content, .chapter-sheet-panel, .voice-sheet-panel') || el;
  }

  function close() {
    if (!el) return;
    el.classList.remove(activeClass);
    el.setAttribute('aria-hidden', 'true');
    if (bodyClass) document.body.classList.remove(bodyClass);
    releaseFocus?.();
    releaseFocus = null;
    onClose?.();
  }

  function open() {
    if (!el) return;
    onOpen?.();
    el.classList.add(activeClass);
    el.setAttribute('aria-hidden', 'false');
    if (bodyClass) document.body.classList.add(bodyClass);
    if (history) sheetOpened(close);
    releaseFocus = trapFocus(panel());
  }

  function dismiss() {
    if (!history || !requestSheetClose(close)) close();
  }

  backdrop?.addEventListener('click', dismiss);
  closeBtn?.addEventListener('click', dismiss);

  return { open, close, dismiss };
}
