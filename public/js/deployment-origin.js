function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

const DEPLOYMENT_ORIGIN_KEY = 'xandrio_deployment_origin';

export function deploymentGuard({
  currentUrl,
  isSecureContext,
  canonicalOrigin = ''
}) {
  const current = new URL(currentUrl);
  if (canonicalOrigin) {
    const canonical = new URL(canonicalOrigin);
    if (current.origin !== canonical.origin) {
      return {
        serviceWorkerAllowed: false,
        message: 'This address has separate offline downloads and sign-in state. Continue at the configured Xandrio address.',
        href: `${canonical.origin}${current.pathname}${current.search}${current.hash}`
      };
    }
  }

  const secureEnough = Boolean(isSecureContext) ||
    current.protocol === 'https:' ||
    (current.protocol === 'http:' && isLoopbackHostname(current.hostname));
  if (!secureEnough) {
    return {
      serviceWorkerAllowed: false,
      message: 'Install, offline playback, and lock-screen features require HTTPS on this device.',
      href: ''
    };
  }

  return {
    serviceWorkerAllowed: true,
    message: '',
    href: ''
  };
}

function readStoredDeployment(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(DEPLOYMENT_ORIGIN_KEY) || 'null');
    if (parsed && typeof parsed.canonicalOrigin === 'string') return parsed;
  } catch {}
  return null;
}

function storeDeployment(storage, canonicalOrigin) {
  try {
    storage?.setItem(DEPLOYMENT_ORIGIN_KEY, JSON.stringify({ canonicalOrigin }));
  } catch {}
}

function unverifiedDeploymentGuard() {
  return {
    serviceWorkerAllowed: false,
    message: 'Reconnect to verify this Xandrio address before installing or downloading. Existing offline books remain available.',
    href: ''
  };
}

async function resolveDeploymentGuard({
  fetchImpl,
  currentUrl,
  isSecureContext,
  storage,
  requireFresh = false
}) {
  let deployment = readStoredDeployment(storage);
  let verifiedFresh = false;
  try {
    const response = await fetchImpl('/api/deployment', { cache: 'no-store' });
    if (response.ok) {
      const payload = await response.json();
      const canonicalOrigin = String(payload?.canonicalOrigin || '');
      deployment = { canonicalOrigin };
      storeDeployment(storage, canonicalOrigin);
      verifiedFresh = true;
    }
  } catch {
    // A previously verified result keeps a cold offline launch usable.
  }

  if (requireFresh && !verifiedFresh) return unverifiedDeploymentGuard();
  if (!deployment) return unverifiedDeploymentGuard();
  try {
    return deploymentGuard({
      currentUrl,
      isSecureContext,
      canonicalOrigin: deployment.canonicalOrigin
    });
  } catch {
    return unverifiedDeploymentGuard();
  }
}

function renderDeploymentGuard(result) {
  const banner = globalThis.document?.getElementById('deployment-banner');
  if (!banner) return;
  banner.replaceChildren();
  if (!result.message) {
    banner.hidden = true;
    return;
  }

  const message = globalThis.document.createElement('span');
  message.textContent = result.message;
  banner.append(message);
  if (result.href) {
    const link = globalThis.document.createElement('a');
    link.href = result.href;
    link.textContent = 'Open Xandrio';
    banner.append(link);
  }
  banner.hidden = false;
}

export async function initDeploymentGuard({
  fetchImpl = globalThis.fetch,
  currentUrl = globalThis.location?.href,
  isSecureContext = globalThis.isSecureContext,
  storage = globalThis.window?.localStorage,
  onChange = null
} = {}) {
  const apply = result => {
    if (globalThis.document?.documentElement?.dataset) {
      globalThis.document.documentElement.dataset.pwaStorageAllowed = String(result.serviceWorkerAllowed);
    }
    renderDeploymentGuard(result);
  };
  const resolve = (requireFresh = false) => resolveDeploymentGuard({
    fetchImpl,
    currentUrl,
    isSecureContext,
    storage,
    requireFresh
  });

  const result = await resolve();
  apply(result);
  globalThis.addEventListener?.('online', async () => {
    apply(unverifiedDeploymentGuard());
    const updated = await resolve(true);
    apply(updated);
    onChange?.(updated);
  });
  return result;
}
