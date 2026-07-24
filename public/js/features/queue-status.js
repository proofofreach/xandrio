import { apiGet } from '../api.js';

const { DisposableScope } = globalThis.XandrioLifecycle || {};
let queueStatusEl = null;
let pollScope = null;
let lastVisible = false;

function renderQueueStatus(status) {
  if (!queueStatusEl) return;
  const active = Number(status?.active || 0);
  const queued = Number(status?.queued || 0);
  const hasWork = active > 0 || queued > 0;

  queueStatusEl.hidden = !hasWork;
  if (!hasWork) {
    lastVisible = false;
    return;
  }

  const label = active > 0 ? 'Generating audio' : 'Audio queued';
  const detail = queued > 0 ? `${active} active, ${queued} queued` : `${active} active`;
  queueStatusEl.dataset.state = active > 0 ? 'active' : 'queued';
  queueStatusEl.innerHTML = `
    <span class="queue-status-dot" aria-hidden="true"></span>
    <span class="queue-status-label">${label}</span>
    <span class="queue-status-detail">${detail}</span>
  `;
  lastVisible = true;
}

async function pollQueueStatus(scope = pollScope) {
  try {
    const status = await apiGet('/api/queue/status');
    if (scope !== pollScope || scope?.closed) return;
    renderQueueStatus(status);
  } catch {
    if (scope !== pollScope || scope?.closed) return;
    if (queueStatusEl && lastVisible) queueStatusEl.hidden = true;
    lastVisible = false;
  }
}

export function initQueueStatus(options = {}) {
  // Re-initialising (view remount) must stop the previous poller even when
  // the replacement view does not render a queue-status element.
  stopQueueStatus();

  queueStatusEl = document.getElementById('queue-status');
  if (!queueStatusEl) return;

  const intervalMs = Math.max(2000, Number(options.intervalMs || 4000));
  const scope = new DisposableScope();
  pollScope = scope;
  pollQueueStatus(scope);
  scope.interval(() => pollQueueStatus(scope), intervalMs, window);
  scope.listen(document, 'visibilitychange', () => {
    if (!document.hidden) pollQueueStatus(scope);
  });
}

export function stopQueueStatus() {
  pollScope?.dispose();
  pollScope = null;
}
