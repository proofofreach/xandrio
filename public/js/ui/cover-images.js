let initialized = false;

export function initCoverImages() {
  if (initialized) return;
  initialized = true;
  const retried = new WeakSet();

  // Image errors do not bubble. Capture also covers cards inserted after startup.
  document.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const fallback = image.dataset.coverFallback;
    const source = image.getAttribute('src');
    if (!fallback || !source || source === fallback) return;
    image.src = fallback;
    if (retried.has(image)) return;
    retried.add(image);

    // Retry once after transient failures, then retain the placeholder on error.
    // Preserve the exact URL so account-scoped offline cache entries still match.
    setTimeout(() => {
      if (!image.isConnected || image.getAttribute('src') !== fallback) return;
      image.src = source;
    }, 1000);
  }, true);
}
