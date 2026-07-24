// confirmSheet — a reusable bottom-sheet confirmation dialog.
//
// Built on registerSheet (history-backed close, backdrop dismiss) and the
// shared focus-trap, styled on the existing .voice-sheet bottom-sheet base.
// Escape cancels (via the global keys handler → requestSheetClose), Tab is
// trapped, and the confirm button takes initial focus so Enter confirms.
//
//   confirmSheet({ title, message, confirmLabel, danger = true }) → Promise<boolean>
import { registerSheet } from './sheets.js';

let sheetEl = null;
let controller = null;
let titleEl = null;
let messageEl = null;
let confirmBtn = null;
let cancelBtn = null;
let resolveCurrent = null;

function settle(value) {
  const resolve = resolveCurrent;
  if (!resolve) return;
  resolveCurrent = null;
  resolve(value);
}

function ensureSheet() {
  if (sheetEl) return;
  sheetEl = document.createElement('div');
  sheetEl.id = 'confirm-sheet';
  sheetEl.className = 'voice-sheet confirm-sheet';
  sheetEl.setAttribute('role', 'dialog');
  sheetEl.setAttribute('aria-modal', 'true');
  sheetEl.setAttribute('aria-labelledby', 'confirm-sheet-title');
  sheetEl.setAttribute('aria-hidden', 'true');
  sheetEl.innerHTML = `
    <div class="voice-sheet-backdrop" data-confirm-backdrop></div>
    <div class="voice-sheet-panel confirm-sheet-panel" role="document">
      <div class="voice-sheet-handle"></div>
      <div class="voice-sheet-header">
        <div>
          <h3 id="confirm-sheet-title"></h3>
          <p id="confirm-sheet-message"></p>
        </div>
      </div>
      <div class="confirm-sheet-actions">
        <button type="button" class="btn-secondary" data-confirm-cancel>Cancel</button>
        <button type="button" class="btn-destructive" data-confirm-ok>Delete</button>
      </div>
    </div>`;
  document.body.appendChild(sheetEl);

  titleEl = sheetEl.querySelector('#confirm-sheet-title');
  messageEl = sheetEl.querySelector('#confirm-sheet-message');
  confirmBtn = sheetEl.querySelector('[data-confirm-ok]');
  cancelBtn = sheetEl.querySelector('[data-confirm-cancel]');

  controller = registerSheet(sheetEl, {
    backdrop: sheetEl.querySelector('[data-confirm-backdrop]'),
    // Any close path that isn't the confirm button resolves false.
    onClose: () => settle(false)
  });

  confirmBtn.addEventListener('click', () => {
    settle(true);
    controller.dismiss();
  });
  cancelBtn.addEventListener('click', () => controller.dismiss());
}

export function confirmSheet({ title = 'Are you sure?', message = '', confirmLabel = 'Delete', danger = true } = {}) {
  ensureSheet();
  // If a confirm is somehow already open, cancel it before reusing the sheet.
  if (resolveCurrent) {
    settle(false);
    controller.close();
  }

  return new Promise((resolve) => {
    resolveCurrent = resolve;
    titleEl.textContent = title;
    messageEl.textContent = message;
    messageEl.hidden = !message;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.classList.toggle('btn-destructive', danger);
    confirmBtn.classList.toggle('btn-primary', !danger);
    controller.open();
    // Focus the confirm action (matches the prior delete-modal behavior) so a
    // keyboard user can confirm with Enter; focus-trap still wraps Tab.
    setTimeout(() => confirmBtn.focus({ preventScroll: true }), 60);
  });
}
