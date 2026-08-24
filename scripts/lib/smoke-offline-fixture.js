const path = require('path');
const fs = require('fs/promises');
const http = require('http');

function deterministicWav() {
  const sampleRate = 24000;
  const samples = sampleRate * 3;
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 5000);
    wav.writeInt16LE(value, 44 + i * 2);
  }
  return wav;
}

function jsonResponse(res, body, status = 200) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
  res.end(payload);
}

async function startOfflineFixtureServer() {
  const publicRoot = path.join(__dirname, '..', '..', 'public');
  const audio = deterministicWav();
  const book = {
    id: 'smoke-offline', title: 'Offline Smoke Book', author: 'Fixture Author',
    description: 'Exercises the real service worker cache.', language: 'en', chapterCount: 1,
    chapterDurations: [3], totalDuration: 3
  };
  const chapter = {
    title: 'Chapter One', type: 'chapter', estimatedDuration: 3,
    text: 'This deterministic chapter proves cached audio remains playable while the network is unavailable.'
  };
  const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.png': 'image/png'
  };
  const state = {
    missingShellPath: null,
    replacementCacheVersion: null,
    offlinePreparationRequested: false,
    streamingPlaybackRequests: [],
    operatorPolicy: { version: 1, acknowledged: false, acknowledgedAt: null, unverifiedSourcesEnabled: false }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    const pathname = url.pathname;
    if (pathname === '/health') return jsonResponse(res, { status: 'ok' });
    if (pathname === '/api/legal/operator-policy' && req.method === 'GET') {
      return jsonResponse(res, state.operatorPolicy);
    }
    if (pathname === '/api/legal/operator-policy' && req.method === 'PUT') {
      state.operatorPolicy = {
        version: 1,
        acknowledged: true,
        acknowledgedAt: '2026-07-12T12:00:00.000Z',
        unverifiedSourcesEnabled: false
      };
      return jsonResponse(res, state.operatorPolicy);
    }
    if (pathname === '/api/library') return jsonResponse(res, { books: [book], shelf: [book.id] });
    if (pathname === '/api/positions') return jsonResponse(res, { positions: {} });
    if (pathname === '/api/settings/client') return jsonResponse(res, { settings: {} });
    if (pathname === '/api/book/smoke-offline') return jsonResponse(res, { book, chapters: [chapter] });
    if (pathname === '/api/offline/preparation/smoke-offline') {
      if (req.method === 'POST') state.offlinePreparationRequested = true;
      return jsonResponse(res, {
        bookId: book.id,
        state: state.offlinePreparationRequested ? 'ready' : 'not-requested',
        readyChapters: state.offlinePreparationRequested ? 1 : 0,
        totalChapters: 1,
        readyChunks: state.offlinePreparationRequested ? 1 : 0,
        totalChunks: 1,
        errorChapters: 0,
        percent: state.offlinePreparationRequested ? 100 : 0,
        bytesPrepared: state.offlinePreparationRequested ? audio.length : 0,
        bytesTotal: state.offlinePreparationRequested ? audio.length : null,
        packageVariantKey: state.offlinePreparationRequested
          ? 'offline-fixture:offline-mp3-v1:br48k'
          : '',
        bitrateKbps: 48
      }, req.method === 'POST' ? 202 : 200);
    }
    if (pathname === '/api/position/smoke-offline') return jsonResponse(res, { position: null });
    if (pathname === '/api/position') return jsonResponse(res, { success: true });
    if (pathname === '/api/bookmarks/smoke-offline') return jsonResponse(res, { bookmarks: [] });
    if (
      pathname.startsWith('/api/audio-continuous/') ||
      pathname.startsWith('/api/audio-hls/') ||
      pathname.startsWith('/api/audio-ios/')
    ) {
      state.streamingPlaybackRequests.push(req.url);
      res.writeHead(200, {
        'Content-Type': 'audio/wav', 'Content-Length': audio.length,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'
      });
      return res.end(audio);
    }
    if (pathname === '/api/voices') return jsonResponse(res, {
      current: 'edge:andrew', voices: [{ id: 'edge:andrew', name: 'Andrew', provider: 'edge', gender: 'male' }]
    });
    if (pathname === '/api/engines/status') return jsonResponse(res, { engines: { edge: { up: true } } });
    if (pathname.startsWith('/api/voice-cache/')) return jsonResponse(res, { voices: [] });
    if (pathname.startsWith('/api/premium-prep/')) return jsonResponse(res, {}, 404);
    if (pathname === '/api/pronunciations') return jsonResponse(res, { book: [], global: [] });
    if (pathname.endsWith('/prepare-chapter-audio')) return jsonResponse(res, { success: true });
    if (pathname.endsWith('/chapter-audio-status')) return jsonResponse(res, {
      ready: true, variantKey: 'offline-fixture', url: '/api/audio/smoke-offline/0'
    });
    if (pathname === '/api/chunks/smoke-offline/0/manifest') return jsonResponse(res, {
      bookId: 'smoke-offline', chapterIndex: 0, totalChunks: 1, servedTier: 'instant',
      chunks: [{ index: 0, status: 'ready', textLength: chapter.text.length, url: '/api/chunks/smoke-offline/0/0?tier=instant' }]
    });
    if (
      pathname === '/api/chunks/smoke-offline/0/0' ||
      pathname === '/api/audio/smoke-offline/0' ||
      pathname === '/api/offline/audio/smoke-offline/0'
    ) {
      if (req.headers['x-xandrio-offline-download'] !== '1') {
        state.streamingPlaybackRequests.push(req.url);
      }
      if (req.headers['x-xandrio-offline-download'] === '1') {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      res.writeHead(200, {
        'Content-Type': 'audio/wav', 'Content-Length': audio.length,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'
      });
      return res.end(audio);
    }
    if (pathname.startsWith('/api/cover/')) {
      res.writeHead(404);
      return res.end();
    }
    if (pathname.startsWith('/api/')) return jsonResponse(res, {});

    if (pathname === '/smoke-tone.wav') {
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': audio.length,
        'Cache-Control': 'no-store'
      });
      return res.end(audio);
    }

    if (pathname === '/legacy-sw.js') {
      const body = Buffer.from(`
        const AUDIO_CACHE = 'xandrio-offline-audio';
        const SHELL_CACHE = 'xandrio-v120';
        self.addEventListener('install', event => event.waitUntil((async () => {
          const cache = await caches.open(SHELL_CACHE);
          await cache.add('/legacy-playing.html');
          await self.skipWaiting();
        })()));
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', event => {
          const url = new URL(event.request.url);
          if (url.pathname === '/legacy-playing.html') {
            event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request)));
            return;
          }
          const scope = url.searchParams.get('xandrio-offline-scope');
          if (!scope || !url.pathname.startsWith('/api/audio/')) return;
          event.respondWith(fetch(event.request).catch(async () => {
            const cache = await caches.open(AUDIO_CACHE + ':' + scope);
            return (await cache.match(event.request)) || Response.error();
          }));
        });
      `);
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'Service-Worker-Allowed': '/'
      });
      return res.end(body);
    }

    if (pathname === '/legacy-playing.html') {
      const body = Buffer.from(`<!doctype html><meta charset="utf-8"><title>Active legacy tab</title>
        <button id="play">Play</button><audio id="audio" loop src="/smoke-tone.wav"></audio>
        <script>
          window.controllerChanges = 0;
          navigator.serviceWorker.addEventListener('controllerchange', () => { window.controllerChanges += 1; });
          document.getElementById('play').addEventListener('click', () => document.getElementById('audio').play());
        </script>`);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
      });
      return res.end(body);
    }

    if (pathname === '/legacy-worker-bootstrap.html') {
      const body = Buffer.from(`<!doctype html><meta charset="utf-8"><title>Legacy worker bootstrap</title>
        <script>
          const markReady = () => { document.documentElement.dataset.workerReady = '1'; };
          navigator.serviceWorker.addEventListener('controllerchange', markReady, { once: true });
          navigator.serviceWorker.register('/legacy-sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).then(() => {
            if (navigator.serviceWorker.controller) markReady();
          });
        </script>`);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
      });
      return res.end(body);
    }

    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const filePath = path.resolve(publicRoot, relative);
    if (!filePath.startsWith(publicRoot + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    if (state.missingShellPath === pathname) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    try {
      let body = await fs.readFile(filePath);
      if (pathname === '/sw.js' && state.replacementCacheVersion) {
        body = Buffer.from(body.toString('utf8').replace(
          /const CACHE_VERSION = '[^']+';/,
          `const CACHE_VERSION = '${state.replacementCacheVersion}';`
        ));
      }
      res.writeHead(200, {
        'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    audioBytes: audio.length,
    setBrokenUpgrade(cacheVersion, missingShellPath) {
      state.replacementCacheVersion = cacheVersion;
      state.missingShellPath = missingShellPath;
    },
    restoreShell() {
      state.replacementCacheVersion = null;
      state.missingShellPath = null;
    },
    offlinePreparationRequested: () => state.offlinePreparationRequested,
    streamingPlaybackRequests: () => [...state.streamingPlaybackRequests],
    resetStreamingPlaybackRequests() { state.streamingPlaybackRequests.length = 0; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

module.exports = { startOfflineFixtureServer };
