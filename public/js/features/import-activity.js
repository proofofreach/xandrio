import { apiGet, getCurrentUserId } from '../api.js';
import { readJSON, writeJSON } from '../util/storage.js';

const jobs = new Map();
let region;
let options = {};
let scope;
let polling = false;
let timer;
const terminal = job => job.status === 'complete' || job.status === 'failed';
const storageKey = () => `xandrio-import-dismissed:${getCurrentUserId()}`;
const dismissed = () => {
  const stored = readJSON(storageKey(), []);
  return new Set(Array.isArray(stored) ? stored : []);
};

function render(job) {
  if (!region || dismissed().has(job.jobId)) return;
  let card = [...region.children].find(node => node.dataset.importJob === job.jobId);
  if (!card) {
    card = document.createElement('article');
    card.className = 'import-activity-card download-progress-panel';
    card.dataset.importJob = job.jobId;
    card.tabIndex = -1;
    card.innerHTML = '<div><strong data-import-title></strong><p data-import-label role="status"></p><p data-import-detail></p></div><div class="import-activity-actions"><button type="button" class="btn-secondary" data-import-open hidden>Open book</button><button type="button" class="btn-secondary" data-import-dismiss hidden>Dismiss</button></div>';
    card.querySelector('[data-import-open]').addEventListener('click', async () => {
      const current = jobs.get(card.dataset.importJob);
      const id = current?.result?.bookId || current?.error?.existingBookId;
      if (id) {
        try { await options.openBook?.(id); }
        catch { card.querySelector('[data-import-detail]').textContent = 'Could not open this book. Try again.'; }
      }
    });
    card.querySelector('[data-import-dismiss]').addEventListener('click', () => {
      const hidden = dismissed();
      hidden.add(card.dataset.importJob);
      writeJSON(storageKey(), [...hidden].slice(-100));
      jobs.delete(card.dataset.importJob);
      card.remove();
      region.hidden = !region.children.length;
    });
    region.append(card);
  }
  card.querySelector('[data-import-title]').textContent = job.title || 'Adding book';
  const done = terminal(job);
  card.classList.toggle('download-progress-panel', !done);
  const duplicate = Boolean(job.error?.existingBookId);
  const label = job.status === 'complete' ? 'Added to library'
    : duplicate ? 'Already in your library'
      : job.status === 'failed' ? 'Could not add book'
        : job.label || 'Connecting to source…';
  const labelNode = card.querySelector('[data-import-label]');
  if (labelNode.textContent !== label) labelNode.textContent = label;
  card.querySelector('[data-import-detail]').textContent = job.status === 'complete'
    ? job.result?.usedAlternative ? 'A different edition was imported because the selected version could not be used reliably.' : ''
    : job.status === 'failed' ? duplicate ? 'Open the existing book to continue.' : job.error?.suggestion || job.error?.error || 'Try again from Search.'
      : job.detail || 'You can keep browsing while this book is added.';
  card.querySelector('[data-import-open]').hidden = !(job.result?.bookId || job.error?.existingBookId);
  card.querySelector('[data-import-dismiss]').hidden = !done;
  card.dataset.status = job.status;
  region.hidden = false;
  return card;
}

function merge(job) {
  const previous = jobs.get(job.jobId);
  if (terminal(previous || {}) && job.status === 'running') return;
  const next = { ...previous, ...job };
  jobs.set(job.jobId, next);
  render(next);
  if (next.status === 'complete' && previous?.status !== 'complete') options.loadLibrary?.().catch(() => {});
}

async function refresh() {
  if (polling || document.hidden || !region) return;
  const account = getCurrentUserId();
  if (scope !== account) {
    jobs.clear();
    region.replaceChildren();
    region.hidden = true;
    scope = account;
  }
  polling = true;
  try {
    const data = await apiGet('/api/imports');
    if (getCurrentUserId() !== account) return;
    for (const job of data.jobs || []) merge(job);
    region.removeAttribute('data-stale');
  } catch {
    region.dataset.stale = 'true';
    for (const job of jobs.values()) {
      if (!terminal(job)) render({ ...job, detail: 'Connection interrupted. Reconnecting to check progress…' });
    }
  } finally {
    polling = false;
  }
}

export function initImportActivity(deps) {
  options = deps;
  region = document.getElementById('import-activity');
  if (!region) return;
  clearInterval(timer);
  timer = setInterval(refresh, 4000);
  document.addEventListener('visibilitychange', refresh);
  refresh();
}

export function beginImport(result) {
  const account = getCurrentUserId();
  let id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let leftSearch = false;
  const onView = event => { if (event.detail?.view !== 'search') leftSearch = true; };
  document.addEventListener('xandrio:viewchange', onView);
  const job = { jobId: id, title: result.title, status: 'running', label: 'Connecting to source…' };
  jobs.set(id, job);
  render(job)?.focus({ preventScroll: true });
  const stop = () => document.removeEventListener('xandrio:viewchange', onView);
  return {
    attach(jobId) {
      const current = jobs.get(id);
      const card = [...(region?.children || [])].find(node => node.dataset.importJob === id);
      jobs.delete(id);
      id = jobId;
      if (card) card.dataset.importJob = id;
      merge({ ...current, jobId: id });
    },
    render(update) { if (getCurrentUserId() === account) merge({ ...update, jobId: id }); },
    complete(result) { if (getCurrentUserId() === account) merge({ jobId: id, status: 'complete', result }); stop(); },
    fail(error) { if (getCurrentUserId() === account) merge({ jobId: id, status: 'failed', error }); stop(); },
    stop,
    shouldOpen() { return getCurrentUserId() === account && !leftSearch && /^#\/search(?:[/?#]|$)/.test(location.hash); }
  };
}
