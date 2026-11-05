import { sheetOpened, requestSheetClose } from '../router.js';
import { trapFocus } from './focus-trap.js';

export function registerSheet(el, options = {}) {
  const {
    onOpen = null,
    onClose = null,
    backdrop = null,
    closeBtn = null,
    focusTarget = null,
    initialFocus = null,
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
    releaseFocus = trapFocus(panel(), { initialFocus: typeof initialFocus === 'function' ? initialFocus(el) : initialFocus });
  }

  function dismiss() {
    if (!history || !requestSheetClose(close)) close();
  }

  backdrop?.addEventListener('click', dismiss);
  closeBtn?.addEventListener('click', dismiss);
  if (el?.hasAttribute?.('data-sheet-drag')) enableDragToDismiss(el, panel, dismiss, activeClass);

  return { open, close, dismiss };
}

// Drag-to-dismiss for sheets that opt in with `data-sheet-drag`. The grab
// area is the handle and the sheet header (not its buttons), so lists inside
// the sheet keep scrolling normally. Release past a quarter of the sheet (or
// 120px), or with a quick downward flick, dismisses through the same
// history-backed path as Done, Escape and Back. Otherwise the sheet returns.
// The CSS `translate` property composes with each sheet's own transform.
const DRAG_INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="tab"], [role="option"]';

function enableDragToDismiss(el, panel, dismiss, activeClass) {
  const root = panel();
  if (!root?.addEventListener) return;
  const grabAreas = [root.querySelector('.voice-sheet-handle'), root.querySelector('.voice-sheet-header')].filter(Boolean);
  if (!grabAreas.length) return;
  el.classList.add('has-sheet-drag');
  const reducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  let drag = null;

  const reset = (animate) => {
    root.style.transition = animate && !reducedMotion() ? 'translate 180ms ease' : 'none';
    root.style.translate = '';
    const settle = () => { root.style.transition = ''; };
    if (animate && !reducedMotion()) setTimeout(settle, 200);
    else requestAnimationFrame(settle);
  };

  const onDown = (event) => {
    if (!el.classList.contains(activeClass) || drag) return;
    if (event.button > 0 || event.target.closest?.(DRAG_INTERACTIVE)) return;
    drag = { id: event.pointerId, startY: event.clientY, startAt: performance.now(), dy: 0, moved: false };
    root.setPointerCapture?.(event.pointerId);
  };
  const onMove = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dy = Math.max(0, event.clientY - drag.startY);
    if (!drag.moved && dy < 4) return;
    drag.moved = true;
    drag.dy = dy;
    root.style.transition = 'none';
    root.style.translate = `0 ${dy}px`;
    event.preventDefault();
  };
  const onEnd = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { dy, startAt, moved } = drag;
    drag = null;
    root.releasePointerCapture?.(event.pointerId);
    if (!moved) return;
    const elapsed = Math.max(1, performance.now() - startAt);
    const threshold = Math.min(120, (root.offsetHeight || 480) * 0.25);
    if (event.type !== 'pointercancel' && (dy > threshold || (dy > 40 && dy / elapsed > 0.6))) {
      dismiss();
      // The sheet's own close transition carries it the rest of the way.
      setTimeout(() => reset(false), reducedMotion() ? 0 : 240);
    } else {
      reset(true);
    }
  };
  for (const area of grabAreas) area.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onEnd);
  root.addEventListener('pointercancel', onEnd);
}
