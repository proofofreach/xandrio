importScripts('/js/offline-range.js');

const CACHE_VERSION = 'xandrio-v164';
const OFFLINE_ROUTE_CONTRACT_VERSION = 1;
const OFFLINE_AUDIO_CACHE = 'xandrio-offline-audio';
const OFFLINE_TITLE_CACHE = 'xandrio-offline-titles';
const OFFLINE_SCOPE_PARAM = 'xandrio-offline-scope';
// Versioned shell assets are kept in lockstep with index.html by
// scripts/bump-version.mjs. Bump CACHE_VERSION whenever any APP_SHELL entry
// changes, including the un-versioned js/ modules below, which only
// invalidate via CACHE_VERSION.
const ASSET_VERSIONS = {
  '/style-v3.css': 108,
  '/js/ios-focus-zoom.js': 1,
  '/js/lifecycle.js': 1,
  '/app.js': 125
};
const versionedAsset = (path) => `${path}?v=${ASSET_VERSIONS[path]}`;
const APP_SHELL = [
  '/',
  '/index.html',
  versionedAsset('/style-v3.css'),
  versionedAsset('/js/ios-focus-zoom.js'),
  versionedAsset('/js/lifecycle.js'),
  versionedAsset('/app.js'),
  '/js/offline-range.js',
  '/js/deployment-origin.js',
  '/js/router.js',
  '/js/api.js',
  '/js/client-settings.js',
  '/js/playback-session.js',
  '/js/smart-rewind.mjs',
  '/js/single-file-chapter-player.js',
  '/js/util/format.js',
  '/js/ui/toast.js',
  '/js/ui/keys.js',
  '/js/ui/confirm.js',
  '/js/ui/segmented.js',
  '/js/ui/focus-trap.js',
  '/js/ui/sheets.js',
  '/js/util/storage.js',
  '/js/util/chapter-labels.mjs',
  '/js/chapter-navigation.mjs',
  '/js/util/book-timeline.mjs',
  '/js/views/library.js',
  '/js/views/search.js',
  '/js/views/settings.js',
  '/js/views/login.js',
  '/js/views/stats.js',
  '/js/views/voices.js',
  '/js/views/player-ui.js',
  '/js/views/book-guide.js',
  '/js/views/playback-speed.js',
  '/js/views/sleep-timer.js',
  '/js/features/bookmarks.js',
  '/js/features/offline.js',
  '/js/features/rolling-offline.mjs',
  '/js/features/listening-queue.js',
  '/js/features/pronunciations.js',
  '/js/features/queue-status.js',
  '/js/features/sharing.js',
  '/fonts/inter-latin.woff2',
  '/manifest.webmanifest',
  '/icon-xandrio-ankh.png'
];

async function cacheContainsCompleteShell(cacheName) {
  const cache = await caches.open(cacheName);
  const entries = await Promise.all(APP_SHELL.map(asset => cache.match(asset)));
  return entries.every(Boolean);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const targetAlreadyExisted = await caches.has(CACHE_VERSION);
    try {
      const cache = await caches.open(CACHE_VERSION);
      await cache.addAll(APP_SHELL);
      if (!await cacheContainsCompleteShell(CACHE_VERSION)) {
        throw new Error(`App shell ${CACHE_VERSION} is incomplete`);
      }
    } catch (err) {
      // A newly-created, partial cache is never eligible for activation. If
      // the name already existed, retain it: it may be the complete cache
      // currently serving the previous worker after a missed version bump.
      if (!targetAlreadyExisted) await caches.delete(CACHE_VERSION);
      throw err;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Never remove the prior complete shell unless this worker's entire shell
    // has been proven present. A failed install therefore leaves the active
    // worker and its cache intact instead of stranding clients between builds.
    if (!await cacheContainsCompleteShell(CACHE_VERSION)) {
      throw new Error(`Refusing to activate incomplete app shell ${CACHE_VERSION}`);
    }
    const keys = await caches.keys();
    const previousShellCache = keys
      .filter(key => key !== CACHE_VERSION && /^xandrio-v\d+$/.test(key))
      .sort((left, right) => Number(right.slice('xandrio-v'.length)) - Number(left.slice('xandrio-v'.length)))[0];
    await Promise.all(keys
      .filter(key =>
        key !== CACHE_VERSION &&
        // Retain the immediately previous complete shell for the narrow race
        // between the other-client check and activation. Long-lived old tabs
        // block activation entirely, so older generations are not in use.
        key !== previousShellCache &&
        key !== OFFLINE_AUDIO_CACHE &&
        key !== OFFLINE_TITLE_CACHE &&
        !key.startsWith(`${OFFLINE_AUDIO_CACHE}:`) &&
        !key.startsWith(`${OFFLINE_TITLE_CACHE}:`)
      )
      .map(key => caches.delete(key)));
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'XANDRIO_ACTIVATE_WAITING') {
    event.waitUntil((async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const otherWindows = windows.filter(client => client.id !== event.source?.id);
      if (otherWindows.length > 0) {
        event.ports?.[0]?.postMessage?.({ activationRequested: false, reason: 'other-clients' });
        return;
      }
      event.ports?.[0]?.postMessage?.({ activationRequested: true, reason: '' });
      await self.skipWaiting();
    })());
    return;
  }
  if (event.data?.type === 'XANDRIO_OFFLINE_CONTRACT_QUERY') {
    event.ports?.[0]?.postMessage?.({
      contractVersion: OFFLINE_ROUTE_CONTRACT_VERSION,
      workerVersion: CACHE_VERSION
    });
  }
});

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data?.json?.() || {};
  } catch {}
  if (payload.type !== 'offline-audio-ready') return;
  const title = String(payload.title || 'Your audiobook').slice(0, 180);
  event.waitUntil(self.registration.showNotification(`${title} is ready`, {
    body: 'Audio preparation is complete. Open Xandrio to download it to this device.',
    icon: '/icon-xandrio-ankh.png',
    badge: '/icon-xandrio-ankh.png',
    tag: `offline-audio-ready:${String(payload.bookId || '').slice(0, 128)}`,
    data: { url: payload.url || '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate?.(target);
      return existing.focus();
    }
    return self.clients.openWindow?.(target);
  })());
});

// Only the explicit shell assets are cached — matching by extension would pull
// arbitrary same-origin files (stray PNGs, one-off pages) into the shell cache.
const APP_SHELL_PATHS = new Set(APP_SHELL.map(entry => entry.split('?')[0]));

function isAppShell(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin && APP_SHELL_PATHS.has(url.pathname);
}

function isOfflineAudioRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  const scope = url.searchParams.get(OFFLINE_SCOPE_PARAM);
  // Do not proxy ordinary online media through the service worker. Mobile
  // Safari can report `playing` while a service-worker-proxied Range response
  // remains stalled at currentTime 0. Downloaded playback is explicitly
  // account-scoped, so only those requests need the cache fallback.
  return url.origin === self.location.origin
    && /^[A-Za-z0-9_-]{1,64}$/.test(scope || '')
    && /^\/api\/audio(?:-ios)?\/[^/]+\/\d+$/.test(url.pathname);
}

function isOfflineTitleRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin && /^\/api\/cover\/[^/]+$/.test(url.pathname);
}

function scopedOfflineCacheName(baseName, request) {
  const scope = new URL(request.url).searchParams.get(OFFLINE_SCOPE_PARAM);
  return scope && /^[A-Za-z0-9_-]{1,64}$/.test(scope)
    ? `${baseName}:${scope}`
    : baseName;
}

async function cachedTitleResponse(request) {
  const cache = await caches.open(scopedOfflineCacheName(OFFLINE_TITLE_CACHE, request));
  return (await cache.match(request.url)) || Response.error();
}

// Markers on every scoped offline audio response. `hit`/`miss` lets the page
// tell a deterministic cache miss (invalidate the manifest entry) from a
// transient media error (never invalidate — Safari emits those routinely). The
// worker version stops a stale-but-controlling worker from satisfying a
// post-download verification probe under semantics it does not implement.
const OFFLINE_CACHE_MARKER = 'X-Xandrio-Offline-Cache';
const OFFLINE_SW_VERSION_MARKER = 'X-Xandrio-SW';
const OFFLINE_CONTRACT_MARKER = 'X-Xandrio-Offline-Contract';

function markOfflineResponse(response, state) {
  const headers = new Headers(response.headers);
  headers.set(OFFLINE_CACHE_MARKER, state);
  headers.set(OFFLINE_SW_VERSION_MARKER, CACHE_VERSION);
  headers.set(OFFLINE_CONTRACT_MARKER, String(OFFLINE_ROUTE_CONTRACT_VERSION));
  return new Response(
    response.status === 204 || response.status === 304 ? null : response.body,
    { status: response.status, statusText: response.statusText, headers }
  );
}

function offlineCacheMiss() {
  return markOfflineResponse(new Response(null, { status: 504 }), 'miss');
}

async function cachedAudioResponse(request) {
  const response = await lookupCachedAudio(request);
  return response ? markOfflineResponse(response, 'hit') : offlineCacheMiss();
}

async function lookupCachedAudio(request) {
  const cache = await caches.open(scopedOfflineCacheName(OFFLINE_AUDIO_CACHE, request));
  // Offline downloads are stored under /api/audio/ (see offline.js). The iOS
  // single-file player requests /api/audio-ios/ — same chapter audio, different
  // encode — so fall back to the stored playback audio when the AAC path isn't cached.
  let cacheKey = request.url;
  let cached = await cache.match(cacheKey);
  if (!cached) {
    cacheKey = request.url.replace('/api/audio-ios/', '/api/audio/');
    cached = await cache.match(cacheKey);
  }
  if (!cached) return null;
  const range = request.headers.get('Range');
  if (!range) return cached;

  const streamed = await self.XandrioOfflineRange.createRangeResponse(cached.clone(), range);
  if (streamed) return streamed;

  // Legacy entries can lack Content-Length. Keep them playable until a
  // manifest repair rewrites the cache entry with streaming metadata.
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  const buffer = await cached.arrayBuffer();
  const size = buffer.byteLength;
  const legacyHeaders = new Headers(cached.headers);
  legacyHeaders.set('Content-Length', String(size));
  await cache.put(cacheKey, new Response(buffer, {
    status: cached.status,
    statusText: cached.statusText,
    headers: legacyHeaders
  })).catch(() => {});
  const rangeError = () => new Response(null, {
    status: 416,
    headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }
  });
  if (!match || (match[1] === '' && match[2] === '')) return rangeError();
  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return rangeError();
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return rangeError();
  const clampedEnd = Math.min(end, size - 1);
  return new Response(buffer.slice(start, clampedEnd + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Length': String(clampedEnd - start + 1),
      'Content-Range': `bytes ${start}-${clampedEnd}/${size}`,
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (isOfflineAudioRequest(request)) {
    // Cache-only, permanently. This URL is emitted only for a chapter the app
    // has already established is on this device, and the server route behind it
    // serves a different encode from the downloaded offline package — so a
    // network fall-through would quietly stream the wrong artifact (and re-run
    // TTS) instead of playing the download. The one-time fallback to streaming
    // belongs to the app, which owns the visible status that goes with it.
    event.respondWith(cachedAudioResponse(request));
  } else if (isOfflineTitleRequest(request)) {
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => cachedTitleResponse(request)));
  } else if (isAppShell(request)) {
    const networkResponse = fetch(request);
    event.respondWith(networkResponse.catch(() => caches.match(request)));
    event.waitUntil(networkResponse.then(async response => {
        if (response.ok) {
          const cache = await caches.open(CACHE_VERSION);
          await cache.put(request, response.clone());
        }
      }).catch(() => {}));
  }
});
