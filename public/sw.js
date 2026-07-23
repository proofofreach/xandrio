const APP_RELEASE = '1.1.0';
const CACHE_VERSION = 'xandrio-v76';
const OFFLINE_AUDIO_CACHE = 'xandrio-offline-audio';
// Single source of truth for the versioned shell assets. The <link>/<script>
// tags in index.html must carry the SAME ?v= values — update both together,
// and bump CACHE_VERSION whenever any APP_SHELL entry changes (including the
// un-versioned js/ modules below, which only invalidate via CACHE_VERSION).
const ASSET_VERSIONS = {
  '/style-v3.css': 74,
  '/js/chunk-player.js': 17,
  '/app.js': 87
};
const versionedAsset = (path) => `${path}?v=${ASSET_VERSIONS[path]}`;
const APP_SHELL = [
  '/',
  '/index.html',
  versionedAsset('/style-v3.css'),
  versionedAsset('/js/chunk-player.js'),
  versionedAsset('/app.js'),
  '/js/router.js',
  '/js/api.js',
  '/js/client-settings.js',
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
  '/js/views/playback-speed.js',
  '/js/views/sleep-timer.js',
  '/js/features/bookmarks.js',
  '/js/features/offline.js',
  '/js/features/pronunciations.js',
  '/js/features/queue-status.js',
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
      await self.skipWaiting();
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
    await Promise.all(keys
      .filter(key => key !== CACHE_VERSION && key !== OFFLINE_AUDIO_CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
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
  // Both audio endpoints: /api/audio/ (chunked concat) and /api/audio-ios/
  // (clean AAC used by SingleFileChapterPlayer on iOS).
  return /^\/api\/audio(?:-ios)?\/[^/]+\/\d+$/.test(url.pathname);
}

async function cachedAudioResponse(request) {
  const cache = await caches.open(OFFLINE_AUDIO_CACHE);
  // Offline downloads are stored under /api/audio/ (see offline.js). The iOS
  // single-file player requests /api/audio-ios/ — same chapter audio, different
  // encode — so fall back to the stored playback audio when the AAC path isn't cached.
  let cached = await cache.match(request.url);
  if (!cached) cached = await cache.match(request.url.replace('/api/audio-ios/', '/api/audio/'));
  if (!cached) return Response.error();
  const range = request.headers.get('Range');
  if (!range) return cached;

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  const buffer = await cached.arrayBuffer();
  const size = buffer.byteLength;
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
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => cachedAudioResponse(request)));
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
