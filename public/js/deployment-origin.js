function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

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

function renderDeploymentGuard(result) {
  const banner = document.getElementById('deployment-banner');
  if (!banner) return;
  banner.replaceChildren();
  if (!result.message) {
    banner.hidden = true;
    return;
  }

  const message = document.createElement('span');
  message.textContent = result.message;
  banner.append(message);
  if (result.href) {
    const link = document.createElement('a');
    link.href = result.href;
    link.textContent = 'Open Xandrio';
    banner.append(link);
  }
  banner.hidden = false;
}

export async function initDeploymentGuard({
  fetchImpl = globalThis.fetch,
  currentUrl = globalThis.location?.href,
  isSecureContext = globalThis.isSecureContext
} = {}) {
  let canonicalOrigin = '';
  try {
    const response = await fetchImpl('/api/deployment', { cache: 'no-store' });
    if (response.ok) {
      const deployment = await response.json();
      canonicalOrigin = String(deployment?.canonicalOrigin || '');
    }
  } catch {
    // The app shell can boot offline. Local secure-context checks still apply
    // when deployment metadata is temporarily unavailable.
  }

  let result;
  try {
    result = deploymentGuard({ currentUrl, isSecureContext, canonicalOrigin });
  } catch {
    result = deploymentGuard({ currentUrl, isSecureContext });
  }
  if (document.documentElement?.dataset) {
    document.documentElement.dataset.pwaStorageAllowed = String(result.serviceWorkerAllowed);
  }
  renderDeploymentGuard(result);
  return result;
}
