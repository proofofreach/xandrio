import { apiGet, apiSend, getCurrentUserId } from '../api.js';
import { escapeHTML, safeAttr } from '../util/format.js';
import { showToast } from '../ui/toast.js';

let deps = {};
let state = { queue: { bookIds: [], autoContinue: true, bookSettings: {} }, books: [] };
let stateUserId = null;
let stateLoadedAt = 0;
const BOOK_SETTINGS_CACHE_MS = 30_000;
let queueLoadGeneration = 0;
const bookSettingsRevisions = new Map();

function bookMap() {
  return new Map((state.books || []).map(book => [book.id, book]));
}

function renderListeningQueue() {
  const rail = document.getElementById('up-next-rail');
  if (!rail) return;
  const books = bookMap();
  const ids = state.queue?.bookIds || [];
  if (!ids.length) {
    rail.hidden = true;
    rail.innerHTML = '';
    return;
  }
  rail.hidden = false;
  rail.innerHTML = `
    <div class="up-next-header">
      <h2 class="rail-heading">Up Next</h2>
      <button type="button" class="btn-ghost btn-sm" data-queue-auto>
        Auto-continue: ${state.queue.autoContinue === false ? 'Off' : 'On'}
      </button>
    </div>
    <div class="up-next-track">
      ${ids.map((id, index) => {
        const book = books.get(id) || { id, title: 'Untitled', author: '' };
        return `
          <div class="up-next-item" data-queue-book-id="${safeAttr(id)}">
            <button type="button" class="up-next-open" data-queue-open="${safeAttr(id)}">
              <span>${index + 1}</span>
              <strong>${escapeHTML(book.title || 'Untitled')}</strong>
              <small>${escapeHTML(book.author || '')}</small>
            </button>
            <div class="up-next-actions">
              <button type="button" data-queue-up="${safeAttr(id)}" ${index === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
              <button type="button" data-queue-down="${safeAttr(id)}" ${index === ids.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
              <button type="button" data-queue-remove="${safeAttr(id)}" aria-label="Remove from Up Next">×</button>
            </div>
          </div>`;
      }).join('')}
    </div>
  `;
}

// The queued books in order, for read-only views (the docked player's Up
// Next list). Changes are announced with the xandrio:listeningqueue event.
export function getListeningQueueBooks() {
  if (stateUserId !== getCurrentUserId()) return [];
  const books = bookMap();
  return (state.queue?.bookIds || []).map(id => books.get(id) || { id, title: 'Untitled', author: '' });
}

export async function loadListeningQueue() {
  const userId = getCurrentUserId();
  const generation = ++queueLoadGeneration;
  const revisions = new Map(bookSettingsRevisions);
  try {
    const loaded = await apiGet('/api/listening-queue', { timeoutMs: 3000 });
    if (userId !== getCurrentUserId() || generation !== queueLoadGeneration) return state;
    // A queue refresh that started before a per-book edit cannot restore the
    // old speed after the save has completed.
    if (stateUserId === userId) {
      for (const [bookId, revision] of bookSettingsRevisions) {
        if (revision !== revisions.get(bookId)) {
          loaded.queue.bookSettings = loaded.queue.bookSettings || {};
          loaded.queue.bookSettings[bookId] = state.queue.bookSettings?.[bookId] || {};
        }
      }
    }
    state = loaded;
    stateUserId = userId;
    stateLoadedAt = Date.now();
    renderListeningQueue();
    // Per-book speeds live in this state; the library re-states each row's
    // time left at its own speed once they arrive.
    document.dispatchEvent?.(new CustomEvent('xandrio:listeningqueue'));
  } catch (error) {
    console.warn('Listening queue unavailable:', error);
  }
  return state;
}

export async function addToListeningQueue(bookId, position = 'last') {
  try {
    await apiSend('POST', '/api/listening-queue/items', { bookId, position });
    await loadListeningQueue();
    showToast(position === 'next' ? 'Playing next' : 'Added to Up Next');
  } catch (error) {
    showToast('Could not update Up Next', 'error');
  }
}

export async function advanceListeningQueue(finishedBookId) {
  const result = await apiSend('POST', '/api/listening-queue/advance', { finishedBookId });
  await loadListeningQueue();
  return result;
}

// Saved per-book speed from the loaded queue state, or null.
export function getBookSpeedSetting(bookId) {
  if (bookId == null || stateUserId !== getCurrentUserId()) return null;
  const value = Number(state.queue?.bookSettings?.[String(bookId)]?.playbackSpeed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function getBookPlaybackSettings(bookId, options = {}) {
  const userId = getCurrentUserId();
  if (stateUserId === userId && Date.now() - stateLoadedAt < BOOK_SETTINGS_CACHE_MS) {
    return { ...(state.queue?.bookSettings?.[bookId] || {}) };
  }
  const revision = bookSettingsRevisions.get(bookId);
  try {
    const result = await apiGet(`/api/listening-queue/books/${encodeURIComponent(bookId)}/settings`, { timeoutMs: 1500, ...options });
    if (userId !== getCurrentUserId() || options.signal?.aborted) return {};
    if (revision !== bookSettingsRevisions.get(bookId)) {
      return stateUserId === userId ? { ...(state.queue?.bookSettings?.[bookId] || {}) } : {};
    }
    return result.settings || {};
  } catch {
    return userId === getCurrentUserId() && stateUserId === userId
      ? { ...(state.queue?.bookSettings?.[bookId] || {}) }
      : {};
  }
}

export async function saveBookPlaybackSettings(bookId, settings) {
  if (!bookId) return {};
  const userId = getCurrentUserId();
  bookSettingsRevisions.set(bookId, (bookSettingsRevisions.get(bookId) || 0) + 1);
  const result = await apiSend('PUT', `/api/listening-queue/books/${encodeURIComponent(bookId)}/settings`, { settings });
  if (getCurrentUserId() === userId && (!stateUserId || stateUserId === userId)) {
    bookSettingsRevisions.set(bookId, (bookSettingsRevisions.get(bookId) || 0) + 1);
    state.queue.bookSettings = state.queue.bookSettings || {};
    state.queue.bookSettings[bookId] = { ...(result.settings || {}) };
  }
  return result.settings || {};
}

async function removeItem(bookId) {
  await apiSend('DELETE', `/api/listening-queue/items/${encodeURIComponent(bookId)}`);
  await loadListeningQueue();
}

async function moveItem(bookId, delta) {
  const current = state.queue.bookIds.indexOf(bookId);
  if (current < 0) return;
  await apiSend('PATCH', `/api/listening-queue/items/${encodeURIComponent(bookId)}`, {
    toIndex: current + delta
  });
  await loadListeningQueue();
}

export function initListeningQueue(options = {}) {
  deps = options;
  const rail = document.getElementById('up-next-rail');
  rail?.addEventListener('click', async event => {
    const open = event.target.closest('[data-queue-open]');
    const remove = event.target.closest('[data-queue-remove]');
    const up = event.target.closest('[data-queue-up]');
    const down = event.target.closest('[data-queue-down]');
    const auto = event.target.closest('[data-queue-auto]');
    try {
      if (open) return deps.openBook?.(open.dataset.queueOpen);
      if (remove) return removeItem(remove.dataset.queueRemove);
      if (up) return moveItem(up.dataset.queueUp, -1);
      if (down) return moveItem(down.dataset.queueDown, 1);
      if (auto) {
        await apiSend('PUT', '/api/listening-queue', {
          queue: {
            bookIds: state.queue.bookIds,
            autoContinue: state.queue.autoContinue === false
          }
        });
        await loadListeningQueue();
      }
    } catch {
      showToast('Could not update Up Next', 'error');
    }
  });
  void loadListeningQueue();
}
