import { apiGet } from '../api.js';

let queueStatusEl = null;
let pollTimer = null;
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

async function pollQueueStatus() {
  try {
    renderQueueStatus(await apiGet('/api/queue/status'));
  } catch {
    if (queueStatusEl && lastVisible) queueStatusEl.hidden = true;
    lastVisible = false;
  }
}

export function initQueueStatus(options = {}) {
  queueStatusEl = document.getElementById('queue-status');
  if (!queueStatusEl) return;

  const intervalMs = Math.max(2000, Number(options.intervalMs || 4000));
  pollQueueStatus();
  pollTimer = window.setInterval(pollQueueStatus, intervalMs);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollQueueStatus();
  });
}

export function stopQueueStatus() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
}
