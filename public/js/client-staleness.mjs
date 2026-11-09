// Version skew between this running shell and the server.
//
// A resumed installed app can keep running an old shell for days. Two signals
// move it forward: the server refusing this build (409 CLIENT_STALE, see
// api.js), and /api/deployment reporting a different build when the app
// comes back to the foreground. A refusal updates at once unless audio is
// playing; everything else asks first, because the update restarts the page.
// Pure enough to test: every browser object is passed in.

const RECHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
// A refusal that persists after an automatic update must not reload forever.
const AUTOMATIC_UPDATE_COOLDOWN_MS = 60 * 1000;
const AUTOMATIC_UPDATE_KEY = 'xandrio_client_stale_update_at';
const BUILD_PATTERN = /^xandrio-v\d+$/;

export function createClientStalenessMonitor({
  clientBuild,
  fetchDeployment,
  isPlaying = () => false,
  applyUpdate,
  promptUpdate,
  storage = globalThis.sessionStorage,
  now = () => Date.now(),
  minIntervalMs = RECHECK_MIN_INTERVAL_MS
}) {
  let lastCheckAt = -Infinity;
  let pendingCheck = null;
  let updating = false;
  // Throttled by the caller's signals: api.js reports a refusal once per page,
  // and a moved build is re-announced at most once per recheck interval.
  const prompt = reason => promptUpdate(reason);

  function recentlyUpdatedAutomatically() {
    try {
      const at = Number(storage?.getItem(AUTOMATIC_UPDATE_KEY));
      return Number.isFinite(at) && at > 0 && now() - at < AUTOMATIC_UPDATE_COOLDOWN_MS;
    } catch {
      return false;
    }
  }

  async function handleClientStale() {
    if (updating) return { updated: false, reason: 'pending' };
    if (isPlaying() || recentlyUpdatedAutomatically()) {
      prompt('stale');
      return { updated: false, reason: 'prompted' };
    }
    updating = true;
    try {
      storage?.setItem(AUTOMATIC_UPDATE_KEY, String(now()));
    } catch {}
    try {
      const result = await applyUpdate();
      if (result?.ok) return { updated: true };
    } catch {}
    updating = false;
    prompt('stale');
    return { updated: false, reason: 'failed' };
  }

  async function recheckDeployment({ force = false } = {}) {
    if (pendingCheck) return pendingCheck;
    if (!force && now() - lastCheckAt < minIntervalMs) return { checked: false };
    lastCheckAt = now();
    pendingCheck = (async () => {
      try {
        const serverBuild = (await fetchDeployment())?.appBuild;
        if (!BUILD_PATTERN.test(serverBuild || '')) return { checked: false };
        const moved = serverBuild !== clientBuild;
        if (moved) prompt('moved');
        return { checked: true, moved, serverBuild };
      } catch {
        return { checked: false };
      } finally {
        pendingCheck = null;
      }
    })();
    return pendingCheck;
  }

  function handleVisibilityChange(visibilityState) {
    if (visibilityState !== 'visible') return Promise.resolve({ checked: false });
    return recheckDeployment();
  }

  return { handleClientStale, recheckDeployment, handleVisibilityChange };
}
