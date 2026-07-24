const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const port = Number(process.env.SMOKE_PORT || 8391);
const origin = `http://127.0.0.1:${port}`;
const smokeCoverImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function smokeCoverKey(value) {
  return Buffer.from(String(value)).toString('hex').slice(0, 32).padEnd(32, '0');
}

async function assertReferencedPwaAssets() {
  const publicRoot = path.join(__dirname, '..', 'public');
  const [html, manifestText, sw] = await Promise.all([
    fs.readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    fs.readFile(path.join(publicRoot, 'manifest.webmanifest'), 'utf8'),
    fs.readFile(path.join(publicRoot, 'sw.js'), 'utf8')
  ]);
  const manifest = JSON.parse(manifestText);
  const htmlVersions = Object.fromEntries(
    [...html.matchAll(/(?:href|src)=["'][^"']*(style-v3\.css|app\.js|chunk-player\.js)\?v=(\d+)["']/g)]
      .map(match => [match[1], Number(match[2])])
  );
  const swVersions = Object.fromEntries(
    [...sw.matchAll(/['"]\/(?:js\/)?(style-v3\.css|app\.js|chunk-player\.js)['"]:\s*(\d+)/g)]
      .map(match => [match[1], Number(match[2])])
  );
  for (const [asset, version] of Object.entries(htmlVersions)) {
    if (swVersions[asset] !== version) {
      throw new Error(`${asset} version mismatch: index.html=${version}, sw.js=${swVersions[asset] ?? 'missing'}`);
    }
  }
  const references = new Set((manifest.icons || []).map(icon => icon.src));
  for (const match of html.matchAll(/(?:href|src)=["']([^"']*(?:icon|favicon)[^"']*)["']/gi)) references.add(match[1]);
  for (const match of sw.matchAll(/["'](\/[^"']*(?:icon|favicon)[^"']*)["']/gi)) references.add(match[1]);
  if (!references.size) throw new Error('No referenced PWA icons were discovered');
  for (const reference of references) {
    const pathname = new URL(reference, 'http://xandrio.local').pathname;
    await fs.access(path.join(publicRoot, pathname.replace(/^\//, '')));
  }
}

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
  const publicRoot = path.join(__dirname, '..', 'public');
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
    if (pathname === '/api/library') return jsonResponse(res, { books: [book] });
    if (pathname === '/api/positions') return jsonResponse(res, { positions: {} });
    if (pathname === '/api/settings/client') return jsonResponse(res, { settings: {} });
    if (pathname === '/api/book/smoke-offline') return jsonResponse(res, { book, chapters: [chapter] });
    if (pathname === '/api/position/smoke-offline') return jsonResponse(res, { position: null });
    if (pathname === '/api/position') return jsonResponse(res, { success: true });
    if (pathname === '/api/bookmarks/smoke-offline') return jsonResponse(res, { bookmarks: [] });
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
    if (pathname === '/api/chunks/smoke-offline/0/0' || pathname === '/api/audio/smoke-offline/0') {
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
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const response = await fetch(`${origin}/health`);
        if (response.ok) return resolve();
      } catch {}
      if (Date.now() >= deadline) return reject(new Error('Xandrio smoke server did not become healthy'));
      setTimeout(poll, 200);
    };
    poll();
  });
}

async function installBrowserFixtures(page) {
  await page.addInitScript(() => {
    let online = true;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
    window.__setSmokeOnline = value => {
      online = Boolean(value);
      window.dispatchEvent(new Event(online ? 'online' : 'offline'));
    };

    class FakeAudio extends EventTarget {
      constructor(src = '') {
        super();
        this.src = src;
        this.currentTime = 0;
        this.duration = 30;
        this.paused = true;
        this.ended = false;
        this.volume = 1;
        this.playbackRate = 1;
        this.preload = 'auto';
        this.error = null;
        window.__smokeAudios.push(this);
      }
      load() { queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
      async play() {
        this.paused = false;
        this.ended = false;
        this.dispatchEvent(new Event('play'));
        this.dispatchEvent(new Event('playing'));
      }
      pause() {
        const changed = !this.paused;
        this.paused = true;
        if (changed) this.dispatchEvent(new Event('pause'));
      }
      removeAttribute(name) { if (name === 'src') this.src = ''; }
    }
    window.__smokeAudios = [];
    window.Audio = FakeAudio;
  });

  const fixtureState = {
    manifestUrls: [],
    pronunciationRequests: [],
    pronunciationRules: [],
    downloadRequests: [],
    searchRequests: [],
    searchCoverRequests: [],
    operatorPolicy: {
      version: 1,
      acknowledged: false,
      acknowledgedAt: null,
      unverifiedSourcesEnabled: false
    },
    operatorPolicyRequests: []
  };
  const book = {
    id: 'smoke',
    title: 'Smoke Book',
    author: 'Test Author',
    description: 'A deterministic browser verification fixture.',
    language: 'en',
    chapterCount: 2,
    chapterDurations: [60, 45],
    totalDuration: 105
  };
  const chapters = [
    {
      title: 'Chapter One', type: 'chapter', estimatedDuration: 60,
      text: 'Doctor Quinn crossed the quiet room and greeted everyone. The morning began without warning.'
    },
    {
      title: 'Chapter Two', type: 'chapter', estimatedDuration: 45,
      text: 'The second chapter is intentionally unavailable when the browser goes offline.'
    }
  ];

  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body)
  });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname === '/api/legal/operator-policy' && method === 'GET') {
      return json(route, fixtureState.operatorPolicy);
    }
    if (pathname === '/api/legal/operator-policy' && method === 'PUT') {
      const payload = request.postDataJSON();
      fixtureState.operatorPolicyRequests.push(payload);
      fixtureState.operatorPolicy = {
        version: 1,
        acknowledged: payload.acknowledged === true,
        acknowledgedAt: '2026-07-12T12:00:00.000Z',
        unverifiedSourcesEnabled: payload.unverifiedSourcesEnabled === true
      };
      return json(route, fixtureState.operatorPolicy);
    }
    if (pathname === '/api/library') return json(route, { books: [book] });
    if (pathname === '/api/positions') return json(route, { positions: {} });
    if (pathname === '/api/settings/client') return json(route, { settings: {} });
    if (pathname === '/api/search/sources') return json(route, {
      sources: [
        { id: 'standardebooks', label: 'Standard Ebooks', configured: true },
        { id: 'gutenberg', label: 'Project Gutenberg', configured: true },
        { id: 'annas', label: "Anna's Archive", configured: true },
        { id: 'zlibrary', label: 'Z-Library', configured: false },
        { id: 'internetarchive', label: 'Internet Archive', configured: true }
      ]
    });
    if (pathname === '/api/search' && method === 'POST') {
      const searchPayload = request.postDataJSON();
      fixtureState.searchRequests.push(searchPayload);
      const result = (hash, title, author, source, workKey, year, coverUrl = `${origin}/api/search-cover/${smokeCoverKey(hash)}`) => ({
        hash, title, author, source, format: 'EPUB', publisher: 'Smoke Press', _year: year,
        openLibraryWorkKey: workKey, language: 'en', isbn: ['9780141182636'], coverUrl
      });
      const hemingwayVersions = [
        { ...result('search-hemingway', 'Complete Works of Ernest Hemingway', 'Ernest Hemingway', 'zlibrary', '/works/hemingway', 2022), publisher: 'Delphi Classics', fallbackGroupId: 'fallback-hemingway-full' },
        { ...result('search-hemingway-alt', 'Delphi Complete Works of Ernest Hemingway', 'Ernest Hemingway', 'annas', '/works/hemingway', 2019), publisher: 'Delphi Classics', fallbackGroupId: 'fallback-hemingway-full' },
        { ...result('search-hemingway-mobi', 'Complete Works of Ernest Hemingway', 'Ernest Hemingway', 'zlibrary', '/works/hemingway', 2018), format: 'MOBI', publisher: 'Delphi Classics', fallbackGroupId: 'fallback-hemingway-full' },
        { ...result('search-hemingway-azw3', 'Complete Works of Ernest Hemingway (Delphi Classics)', 'Ernest Hemingway', 'annas', '/works/hemingway', 2017), format: 'AZW3', publisher: 'Delphi Classics', fallbackGroupId: 'fallback-hemingway-full' },
        { ...result('search-hemingway-epub-2', 'Delphi Complete Works of Ernest Hemingway (Illustrated)', 'Ernest Hemingway', 'zlibrary', '/works/hemingway', 2016), publisher: 'Delphi Classics', fallbackGroupId: 'fallback-hemingway-full' },
        { ...result('search-hemingway-abridged', 'Complete Works of Ernest Hemingway (Abridged Edition)', 'Ernest Hemingway', 'annas', '/works/hemingway', 2015), publisher: 'Delphi Classics', fallbackGroupId: 'fallback-hemingway-abridged' }
      ];
      const seedWorks = [
        { id: 'work-hemingway', title: 'Complete Works of Ernest Hemingway', author: 'Ernest Hemingway', editions: hemingwayVersions, isBestMatch: false },
        { id: 'work-alpha', title: 'Alpha Book', author: 'Ada Writer', editions: [result('search-alpha', 'Alpha Book', 'Ada Writer', 'standardebooks', '/works/alpha', 2024)], isBestMatch: false },
        { id: 'work-beta', title: 'Beta Book', author: 'Ben Author', editions: [result('search-beta', 'Beta Book', 'Ben Author', 'internetarchive', '/works/beta', 2020, 'https://example.com/untrusted-cover.jpg')], isBestMatch: false }
      ];
      const fillerWorks = Array.from({ length: 23 }, (_, index) => {
        const title = `Fixture Work ${String(index + 1).padStart(2, '0')}`;
        const author = `Fixture Author ${index + 1}`;
        return {
          id: `work-fixture-${index + 1}`,
          title,
          author,
          editions: [result(`search-fixture-${index + 1}`, title, author, 'annas', `/works/fixture-${index + 1}`, 2021)],
          isBestMatch: false
        };
      });
      const works = [...seedWorks, ...fillerWorks].map((work, index) => ({
        ...work,
        bestEdition: work.editions[0],
        editionCount: work.editions.length,
        versionCount: work.editions.length,
        sources: [...new Set(work.editions.map(edition => edition.source))],
        sourceCount: new Set(work.editions.map(edition => edition.source)).size,
        searchGroup: 'results',
        _searchOrder: index
      }));
      const responseWorks = searchPayload.query === 'short smoke' ? works.slice(0, 17) : works;
      const sourceStatus = {
        gutenberg: { id: 'gutenberg', label: 'Project Gutenberg', ok: true, count: 1 },
        annas: { id: 'annas', label: "Anna's Archive", ok: true, count: 25 }
      };
      if (searchPayload.query === 'source issue smoke') {
        sourceStatus.standardebooks = {
          id: 'standardebooks', label: 'Standard Ebooks', ok: false,
          errorCode: 'ZLIB_UNAVAILABLE', error: 'Standard Ebooks search is unavailable right now.'
        };
      }
      return json(route, {
        works: responseWorks,
        totalWorks: responseWorks.length,
        totalEditions: responseWorks.reduce((total, work) => total + work.editionCount, 0),
        sourceStatus,
        ...(searchPayload.query === 'smkoe books' ? {
          searchCorrection: {
            originalQuery: 'smkoe books',
            correctedQuery: 'smoke books',
            kind: 'title',
            source: 'openlibrary',
            confidence: 'high'
          }
        } : {})
      });
    }
    if (pathname === '/api/download' && method === 'POST') {
      const payload = request.postDataJSON();
      fixtureState.downloadRequests.push(payload);
      const firstRecommendedImport = payload.hash === 'search-hemingway' &&
        fixtureState.downloadRequests.filter(item => item.hash === 'search-hemingway').length === 1;
      await new Promise(resolve => setTimeout(resolve, firstRecommendedImport ? 1150 : 120));
      return json(route, { error: 'Fixture import failure', suggestion: 'Expected in browser smoke.' }, 400);
    }
    if (pathname.startsWith('/api/search-cover/')) {
      fixtureState.searchCoverRequests.push({ url: request.url(), requestedAt: Date.now() });
      const isHemingway = pathname.endsWith(smokeCoverKey('search-hemingway'));
      if (isHemingway && url.searchParams.get('retry') !== '1') {
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 200, contentType: 'image/png', body: smokeCoverImage });
    }
    if (pathname === '/api/book/smoke') return json(route, { book, chapters });
    if (pathname === '/api/position/smoke') return json(route, { position: null });
    if (pathname === '/api/position') return json(route, { success: true });
    if (pathname === '/api/bookmarks/smoke') return json(route, { bookmarks: [] });
    if (pathname === '/api/voices') return json(route, {
      current: 'edge:andrew',
      voices: [
        { id: 'edge:andrew', name: 'Andrew', provider: 'edge', gender: 'male', tier: 'edge' },
        { id: 'chatterbox:premium', name: 'Premium', provider: 'chatterbox', gender: 'male', tier: 'chatterbox' }
      ]
    });
    if (pathname === '/api/engines/status') return json(route, {
      engines: { edge: { up: true }, chatterbox: { up: true }, kokoro: { up: true } }
    });
    if (pathname.startsWith('/api/voice-cache/')) return json(route, { voices: [] });
    if (pathname.startsWith('/api/premium-prep/')) return json(route, { premiumActive: false, chapters: [] }, 404);
    if (pathname.endsWith('/chapter-audio-status')) return json(route, { ready: false, variantKey: 'instant-fixture' });
    if (pathname.endsWith('/prepare-chapter-audio')) return json(route, { success: true });
    if (/^\/api\/chunks\/smoke\/\d+\/\d+\/prioritize$/.test(pathname)) return json(route, { success: true });
    if (/^\/api\/chunks\/smoke\/\d+\/manifest$/.test(pathname)) {
      fixtureState.manifestUrls.push(request.url());
      const chapterIndex = Number(pathname.split('/')[4]);
      const tier = url.searchParams.get('tier') || 'instant';
      return json(route, {
        bookId: 'smoke', chapterIndex, totalChunks: 2, servedTier: tier,
        chunks: [0, 1].map(index => ({
          index, status: 'ready', textLength: 45,
          url: `/api/chunks/smoke/${chapterIndex}/${index}?tier=${tier}`
        }))
      });
    }
    if (/^\/api\/chunks\/smoke\/\d+\/\d+$/.test(pathname) || /^\/api\/audio\/smoke\/\d+$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from([0]) });
    }
    if (pathname === '/api/pronunciations' && method === 'GET') {
      return json(route, { book: fixtureState.pronunciationRules, global: [] });
    }
    if (pathname === '/api/pronunciations' && method === 'POST') {
      const payload = request.postDataJSON();
      fixtureState.pronunciationRequests.push({ method, payload });
      const rule = { ...payload, id: 'smoke-rule' };
      fixtureState.pronunciationRules = [rule];
      return json(route, { success: true, rule, affected: [{ bookId: 'smoke', chapterIndex: 0 }] }, 201);
    }
    if (pathname === '/api/pronunciations/smoke-rule' && method === 'PUT') {
      const payload = request.postDataJSON();
      fixtureState.pronunciationRequests.push({ method, payload });
      const rule = { ...payload, id: 'smoke-rule' };
      fixtureState.pronunciationRules = [rule];
      return json(route, { success: true, rule, affected: [{ bookId: 'smoke', chapterIndex: 0 }] });
    }
    if (pathname === '/api/pronunciations/smoke-rule' && method === 'DELETE') {
      fixtureState.pronunciationRequests.push({ method });
      fixtureState.pronunciationRules = [];
      return json(route, { success: true, affected: [{ bookId: 'smoke', chapterIndex: 0 }] });
    }
    if (pathname.startsWith('/api/cover/')) return route.fulfill({ status: 404, body: '' });
    return json(route, {});
  });
  return fixtureState;
}

async function verifyPlayback(page, fixtureState) {
  await page.goto(`${origin}/#/player/smoke`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#player-view.active');
  await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none');
  await page.waitForSelector('#operator-notice-dialog.active');
  await page.check('#operator-notice-ack');
  await page.click('#operator-notice-continue');
  await page.waitForSelector('#operator-notice-dialog', { state: 'hidden' });
  if (fixtureState.operatorPolicyRequests.length !== 1 ||
      fixtureState.operatorPolicyRequests[0]?.acknowledged !== true ||
      fixtureState.operatorPolicyRequests[0]?.unverifiedSourcesEnabled !== false) {
    throw new Error('First-run operator acknowledgement did not persist the expected instance policy');
  }
  if (await page.textContent('#book-title') !== 'Smoke Book') throw new Error('Mock book did not open');
  if (!await page.isVisible('[data-progress-scope="book"]')) throw new Error('Measured book timeline did not enable book seeking');
  await page.click('[data-progress-scope="book"]');
  if (await page.getAttribute('[data-progress-scope="book"]', 'aria-pressed') !== 'true') {
    throw new Error('Book progress mode did not activate');
  }
  await page.click('[data-progress-scope="chapter"]');

  await page.waitForFunction(() => window.__smokeAudios.length >= 2);
  await page.click('#play-pause-btn');
  await page.waitForFunction(() => window.__smokeAudios.some(audio => !audio.paused));
  await page.click('#skip-forward-btn');
  await page.waitForFunction(() => window.__smokeAudios.some(audio => audio.currentTime >= 14));
  await page.click('#play-pause-btn');
  await page.waitForFunction(() => window.__smokeAudios.every(audio => audio.paused));

  await page.waitForTimeout(100);
  const chapterZeroManifests = fixtureState.manifestUrls.filter(value => value.includes('/smoke/0/manifest'));
  if (chapterZeroManifests.length < 2 || !chapterZeroManifests.slice(1).some(value => value.includes('tier=instant'))) {
    throw new Error(`Playback tier was not pinned on manifest refresh: ${chapterZeroManifests.join(', ')}`);
  }

  await page.evaluate(() => window.__setSmokeOnline(false));
  await page.waitForFunction(() => !document.getElementById('offline-banner').hidden);
  await page.selectOption('#chapter-select', '1');
  await page.waitForFunction(() => document.getElementById('audio-loading')?.dataset.status === 'offline');
  const offlineMessage = await page.textContent('#loading-text');
  if (!offlineMessage.includes("You're offline")) throw new Error('Offline chapter state was not surfaced');
}

async function verifyPronunciations(page, fixtureState) {
  await page.evaluate(() => window.__setSmokeOnline(true));
  await page.selectOption('#chapter-select', '0');
  await page.waitForFunction(() => document.getElementById('chapter-trigger-title')?.textContent.includes('Chapter One'));
  await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const selector of ['#utility-timer-btn', '#utility-chapters-btn', '#utility-bookmark-btn', '#utility-speed-btn']) {
    if (!await page.isVisible(selector)) throw new Error(`Mobile playback tool is not visible: ${selector}`);
  }
  if (!await page.isVisible('#pronunciation-repair-btn')) {
    throw new Error('Pronunciation repair is not discoverable in the mobile player');
  }
  await page.evaluate(() => document.getElementById('pronunciation-repair-btn').click());
  await page.waitForSelector('#pronunciation-repair-dialog.active');
  await page.evaluate(() => {
    const context = document.getElementById('pronunciation-repair-context');
    const text = context.firstChild;
    const start = text.data.indexOf('Doctor Quinn');
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + 'Doctor Quinn'.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    context.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  if (await page.inputValue('#pronunciation-source') !== 'Doctor Quinn') {
    throw new Error('Selecting narration context did not seed the source phrase');
  }
  await page.fill('#pronunciation-replacement', 'Doctor Kwin');
  await page.click('#pronunciation-repair-submit');
  await page.waitForFunction(() => document.getElementById('pronunciation-repair-dialog')?.getAttribute('aria-hidden') === 'true');
  if (fixtureState.pronunciationRequests[0]?.method !== 'POST') throw new Error('Pronunciation create was not submitted');

  await page.evaluate(() => document.getElementById('pronunciation-repair-btn').click());
  await page.waitForSelector('[data-pronunciation-edit="smoke-rule"]');
  await page.click('[data-pronunciation-edit="smoke-rule"]');
  await page.fill('#pronunciation-replacement', 'Doctor Quin');
  await page.click('#pronunciation-repair-submit');
  await page.waitForFunction(() => document.getElementById('pronunciation-repair-dialog')?.getAttribute('aria-hidden') === 'true');
  if (fixtureState.pronunciationRequests[1]?.method !== 'PUT' || fixtureState.pronunciationRequests[1]?.payload.replacement !== 'Doctor Quin') {
    throw new Error('Pronunciation edit was not submitted with the updated replacement');
  }

  await page.evaluate(() => document.getElementById('pronunciation-repair-btn').click());
  await page.waitForSelector('[data-pronunciation-rule-id="smoke-rule"]');
  await page.click('[data-pronunciation-rule-id="smoke-rule"]');
  await page.waitForFunction(() => document.getElementById('pronunciation-existing-rules')?.textContent.includes('No saved pronunciations'));
  if (fixtureState.pronunciationRequests[2]?.method !== 'DELETE') throw new Error('Pronunciation delete was not submitted');
}

async function verifySearchWorkspace(page, fixtureState) {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(`${origin}/#/search`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#search-view.active');
  await page.waitForSelector('[data-search-source]', { state: 'attached' });
  if (await page.getAttribute('#search-filter-toggle', 'aria-expanded') !== 'false' ||
      !await page.locator('#search-filter-panel').evaluate(panel => panel.hidden)) {
    throw new Error('Search filters are not closed on initial page load');
  }
  await page.click('#search-filter-toggle');
  await page.waitForSelector('#search-filter-panel:not([hidden])');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#search-view.active');
  await page.waitForSelector('[data-search-source]', { state: 'attached' });
  if (await page.getAttribute('#search-filter-toggle', 'aria-expanded') !== 'false' ||
      !await page.locator('#search-filter-panel').evaluate(panel => panel.hidden)) {
    throw new Error('Search filters remained open after a page refresh');
  }
  await page.click('#search-filter-toggle');
  await page.waitForSelector('#search-filter-panel:not([hidden])');
  const filterAlignment = await page.evaluate(() => {
    const languageLabel = document.querySelector('.search-language-filter > span')?.getBoundingClientRect();
    const sourceLabel = document.querySelector('.search-source-shelf-header')?.getBoundingClientRect();
    const languageControl = document.getElementById('language-filter')?.getBoundingClientRect();
    // Pills sit below their group's overline label, so the column alignment
    // guard measures the group cluster, not the first pill.
    const sourceControl = document.querySelector('.search-source-group')?.getBoundingClientRect();
    return {
      labelOffset: Math.abs((languageLabel?.top || 0) - (sourceLabel?.top || 0)),
      controlOffset: Math.abs((languageControl?.top || 0) - (sourceControl?.top || 0))
    };
  });
  if (filterAlignment.labelOffset > 1 || filterAlignment.controlOffset > 1) {
    throw new Error(`Language and source filters are not aligned: ${JSON.stringify(filterAlignment)}`);
  }
  await page.click('#search-filter-toggle');
  for (const width of [360, 390, 412, 480]) {
    await page.setViewportSize({ width, height: width === 412 ? 915 : 844 });
    await page.click('#search-filter-toggle');
    await page.waitForSelector('#search-filter-panel:not([hidden])');
    const sourcePillHeights = await page.locator('[data-search-source]').evaluateAll(buttons =>
      buttons.filter(button => !button.disabled).map(button => button.getBoundingClientRect().height)
    );
    if (sourcePillHeights.some(height => height < 44)) {
      throw new Error(`Search source pill is below the 44px touch target at ${width}px: ${sourcePillHeights.join(', ')}`);
    }
    const filterSheet = await page.locator('#search-filter-panel').evaluate(panel => {
      const bounds = panel.getBoundingClientRect();
      return {
        position: getComputedStyle(panel).position,
        left: Math.round(bounds.left),
        right: Math.round(bounds.right),
        bottom: Math.round(bounds.bottom),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };
    });
    if (filterSheet.position !== 'fixed' || filterSheet.left < 0 ||
        filterSheet.right > filterSheet.viewportWidth || filterSheet.bottom > filterSheet.viewportHeight) {
      throw new Error(`Mobile search filters are not a viewport-contained sheet at ${width}px: ${JSON.stringify(filterSheet)}`);
    }
    if (!await page.isVisible('#search-filter-scrim') || !await page.isVisible('#search-filter-close') ||
        !await page.isVisible('#search-filter-apply')) {
      throw new Error(`Mobile search filter sheet is missing its scrim or controls at ${width}px`);
    }
    await page.waitForFunction(() => document.activeElement?.id === 'search-filter-close');
    if (!await page.locator('body').evaluate(body => body.classList.contains('search-filters-open'))) {
      throw new Error(`Mobile search filter sheet did not lock background scrolling at ${width}px`);
    }
    await page.click('#search-filter-close');
    if (await page.getAttribute('#search-filter-toggle', 'aria-expanded') !== 'false') {
      throw new Error(`Mobile search filter sheet did not close at ${width}px`);
    }
    if (await page.evaluate(() => document.activeElement?.id) !== 'search-filter-toggle' ||
        await page.locator('body').evaluate(body => body.classList.contains('search-filters-open'))) {
      throw new Error(`Mobile search filter sheet did not restore focus and scrolling at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 412, height: 915 });
  await page.fill('#search-input', 'smoke books');
  if (!await page.isVisible('#search-clear-btn')) throw new Error('Search clear action did not appear for a query');
  await page.click('#search-btn');
  await page.waitForSelector('.result-card:not(.skeleton-result)');

  const cardCount = await page.locator('.result-card:not(.skeleton-result)').count();
  if (cardCount !== 20) throw new Error(`Search progressive rendering showed ${cardCount} cards; expected the first 20-work batch`);
  const mobileCardGeometry = await page.locator('.result-card:not(.skeleton-result)').first().evaluate(card => {
    const cover = card.querySelector('.result-cover-shell').getBoundingClientRect();
    const copy = card.querySelector('.result-card-copy').getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    return {
      cardHeight: Math.round(bounds.height),
      coverWidth: Math.round(cover.width),
      coverHeight: Math.round(cover.height),
      copyStartsBesideCover: copy.left >= cover.right - 1
    };
  });
  if (mobileCardGeometry.cardHeight > 220 || mobileCardGeometry.coverWidth > 120 ||
      !mobileCardGeometry.copyStartsBesideCover) {
    throw new Error(`Mobile search results are not compact shelf rows: ${JSON.stringify(mobileCardGeometry)}`);
  }
  const mobilePageWidth = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  if (mobilePageWidth.document > mobilePageWidth.viewport) {
    throw new Error(`Mobile search introduces horizontal scrolling: ${JSON.stringify(mobilePageWidth)}`);
  }
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(50);
  const stickySearchGeometry = await page.locator('.search-workspace').evaluate(workspace => ({
    position: getComputedStyle(workspace).position,
    top: Math.round(workspace.getBoundingClientRect().top),
    viewportTop: Math.round(parseFloat(getComputedStyle(workspace).top) || 0)
  }));
  if (stickySearchGeometry.position !== 'sticky' ||
      Math.abs(stickySearchGeometry.top - stickySearchGeometry.viewportTop) > 1) {
    throw new Error(`Mobile search controls do not remain reachable while scanning results: ${JSON.stringify(stickySearchGeometry)}`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  const resultColumnCount = await page.locator('.search-results-list').evaluate(element =>
    getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
  );
  if (resultColumnCount !== 1) throw new Error(`Mobile search results use ${resultColumnCount} columns instead of one`);
  if (await page.locator('.source-rights-badge, .search-source-rights').count() !== 0) {
    throw new Error('Search repeats rights-status tags even though the instance source checkbox is authoritative');
  }
  if (await page.textContent('#search-results-count') !== '26 works · 31 versions') {
    throw new Error(`Search work/version count is incorrect: ${await page.textContent('#search-results-count')}`);
  }
  const coverUrls = await page.locator('[data-result-cover]').evaluateAll(images => images.map(image => image.src));
  if (coverUrls.length !== 19 || coverUrls.some(src => new URL(src).origin !== origin)) {
    throw new Error(`Search rendered an untrusted or unexpected cover URL: ${coverUrls.join(', ')}`);
  }
  const hemingwayCoverKey = smokeCoverKey('search-hemingway');
  await page.waitForFunction(key => {
    const image = document.querySelector('article[data-work-id="work-hemingway"] [data-result-cover]');
    const imageUrl = image && new URL(image.currentSrc || image.src);
    return image && !image.hidden && imageUrl.searchParams.get('retry') === '1' && imageUrl.pathname.endsWith(key);
  }, hemingwayCoverKey, { timeout: 7000 });
  const hemingwayCoverRequests = fixtureState.searchCoverRequests
    .map(request => ({ ...request, parsedUrl: new URL(request.url) }))
    .filter(request => request.parsedUrl.pathname.endsWith(hemingwayCoverKey));
  if (hemingwayCoverRequests.length !== 2 ||
      hemingwayCoverRequests.some(request => request.parsedUrl.origin !== origin) ||
      hemingwayCoverRequests[0].parsedUrl.searchParams.has('retry') ||
      hemingwayCoverRequests[1].parsedUrl.searchParams.get('retry') !== '1' ||
      !hemingwayCoverRequests[1].parsedUrl.searchParams.has('cachebuster') ||
      hemingwayCoverRequests[1].requestedAt - hemingwayCoverRequests[0].requestedAt < 2800) {
    throw new Error(`Search-cover retry was not one delayed same-origin cache-busted retry: ${hemingwayCoverRequests.map(request => request.url).join(', ')}`);
  }
  if (await page.getAttribute('#search-filter-toggle', 'aria-expanded') !== 'false') {
    throw new Error('Mobile search filters did not collapse after results loaded');
  }
  if (!await page.isVisible('#search-sort-wrap')) throw new Error('Search sort control is not visible with results');

  const hemingwayCard = page.locator('article[data-work-id="work-hemingway"]');
  if (await hemingwayCard.locator('.result-card-title').textContent() !== 'Complete Works of Ernest Hemingway') {
    throw new Error('Resolved work did not use the clean Hemingway display title');
  }
  if (await hemingwayCard.locator('.format-badge, .source-badge').count() !== 0) {
    throw new Error('Search result cards still render colored format or provider badges');
  }
  if (await hemingwayCard.locator('.result-card-edition-meta').count() !== 1 ||
      !(await hemingwayCard.locator('.result-card-edition-meta').textContent()).includes('EPUB') ||
      !(await hemingwayCard.locator('.result-card-edition-meta').textContent()).includes('Z-Library')) {
    throw new Error('Search result cards do not render quiet format/source metadata');
  }
  if (await hemingwayCard.locator('.download-btn, .edition-add-btn').count() !== 0) {
    throw new Error('Search result cards still render separate Add buttons');
  }
  const hemingwayCoverAction = hemingwayCard.locator('.result-cover-action[data-work-add]');
  if (await hemingwayCoverAction.count() !== 1 ||
      await hemingwayCoverAction.evaluate(element => element.tagName) !== 'BUTTON') {
    throw new Error('Search result cover is not the semantic recommended-version action');
  }
  const coverActionLabel = await hemingwayCoverAction.getAttribute('aria-label');
  if (!coverActionLabel?.includes('Add Complete Works of Ernest Hemingway to library') ||
      !coverActionLabel.includes('recommended EPUB from Z-Library')) {
    throw new Error(`Search result cover action has an unclear accessible name: ${coverActionLabel}`);
  }
  const hemingwayVersions = hemingwayCard.locator('.edition-disclosure');
  if (await hemingwayVersions.locator('summary').textContent() !== '6 versions · 2 sources') {
    throw new Error(`Merged work summary is unclear: ${await hemingwayVersions.locator('summary').textContent()}`);
  }
  await hemingwayVersions.locator('summary').focus();
  await page.keyboard.press('Enter');
  if (await hemingwayVersions.locator('[data-edition-choice]').count() !== 6) {
    throw new Error('Version chooser did not expose every provider version');
  }
  if (await hemingwayVersions.locator('[data-edition-choice]').evaluateAll(elements =>
    elements.some(element => element.tagName !== 'BUTTON')
  )) {
    throw new Error('Version chooser rows are not semantic full-row buttons');
  }
  if (await hemingwayVersions.locator('.edition-list').getAttribute('aria-label') !== 'Available versions of Complete Works of Ernest Hemingway') {
    throw new Error('Version chooser does not expose an accurate accessible label');
  }
  if ((await hemingwayVersions.locator('.edition-option-copy strong').allTextContents()).includes('Edition')) {
    throw new Error('Version chooser still repeats the generic Edition label');
  }
  for (const selector of ['summary', '[data-edition-choice="1"]']) {
    const height = await hemingwayVersions.locator(selector).evaluate(element => element.getBoundingClientRect().height);
    if (height < 44) throw new Error(`Version chooser control is below the 44px touch target: ${selector} is ${height}px`);
  }
  if (await hemingwayCard.getAttribute('role')) {
    throw new Error('Search result card is incorrectly exposed as a nested interactive control');
  }

  await hemingwayCard.locator('[data-edition-choice="1"]').click();
  await page.waitForFunction(() => document.querySelector('#download-error .error-box'));
  if (fixtureState.downloadRequests[0]?.hash !== 'search-hemingway-alt') {
    throw new Error(`Version chooser did not add the chosen version: ${JSON.stringify(fixtureState.downloadRequests[0])}`);
  }
  if (fixtureState.downloadRequests[0]?.alternatives?.length !== 4 ||
      fixtureState.downloadRequests[0].alternatives[0].hash !== 'search-hemingway' ||
      fixtureState.downloadRequests[0].alternatives.some(item => item.hash === 'search-hemingway-abridged')) {
    throw new Error(`Automatic fallback crossed version compatibility groups: ${JSON.stringify(fixtureState.downloadRequests[0]?.alternatives)}`);
  }
  if (fixtureState.downloadRequests[0]?.publisher !== 'Delphi Classics' ||
      fixtureState.downloadRequests[0]?.language !== 'en' ||
      fixtureState.downloadRequests[0]?.openLibraryWorkKey !== '/works/hemingway') {
    throw new Error(`Selected version identity metadata was not submitted: ${JSON.stringify(fixtureState.downloadRequests[0])}`);
  }
  await page.waitForSelector('article[data-work-id="work-hemingway"]');
  if (await page.locator('#download-error .error-box').evaluate(error => document.activeElement !== error)) {
    throw new Error('Failed version import did not focus its announced error');
  }

  for (const activation of ['click', 'Enter', 'Space']) {
    const requestsBefore = fixtureState.downloadRequests.length;
    const coverAction = page.locator('article[data-work-id="work-hemingway"] .result-cover-action');
    if (activation === 'click') {
      await coverAction.click();
    } else {
      await coverAction.focus();
      await page.keyboard.press(activation);
    }
    await page.waitForSelector('.download-progress-panel');
    if (await page.locator('.download-progress-panel').evaluate(panel => document.activeElement !== panel)) {
      throw new Error(`Book import progress did not receive focus after cover ${activation}`);
    }
    if (activation === 'click') {
      await page.evaluate(() => { window.__smokeProgressPanel = document.querySelector('.download-progress-panel'); });
      await page.waitForTimeout(1050);
      if (!await page.evaluate(() => window.__smokeProgressPanel?.isConnected &&
          window.__smokeProgressPanel === document.querySelector('.download-progress-panel'))) {
        throw new Error('Book import progress panel was recreated during an elapsed-time update');
      }
    }
    await page.waitForSelector('article[data-work-id="work-hemingway"]');
    if (fixtureState.downloadRequests.length !== requestsBefore + 1 ||
        fixtureState.downloadRequests.at(-1)?.hash !== 'search-hemingway') {
      throw new Error(`Cover ${activation} did not add exactly the recommended version: ${JSON.stringify(fixtureState.downloadRequests)}`);
    }
    if (await page.locator('#download-error .error-box').evaluate(error => document.activeElement !== error)) {
      throw new Error(`Failed cover ${activation} import did not focus its announced error`);
    }
  }

  await page.click('[data-search-load-more]');
  await page.waitForFunction(() => document.querySelectorAll('.result-card:not(.skeleton-result)').length === 26);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const miniPlayerClearance = await page.evaluate(() => {
    const miniPlayer = document.getElementById('mini-player');
    const lastResult = [...document.querySelectorAll('.result-card')].at(-1);
    if (!miniPlayer || getComputedStyle(miniPlayer).display === 'none' || !lastResult) return null;
    return {
      resultBottom: Math.round(lastResult.getBoundingClientRect().bottom),
      playerTop: Math.round(miniPlayer.getBoundingClientRect().top)
    };
  });
  if (miniPlayerClearance && miniPlayerClearance.resultBottom > miniPlayerClearance.playerTop) {
    throw new Error(`The mini-player obscures the last mobile search action: ${JSON.stringify(miniPlayerClearance)}`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.selectOption('#search-sort', 'title');
  if (await page.textContent('.result-card:first-child .result-card-title') !== 'Alpha Book') {
    throw new Error('Search title sort did not reorder the result grid');
  }
  await page.selectOption('#search-sort', 'source');
  const sourceSortedIds = await page.locator('.result-card').evaluateAll(cards => cards.map(card => card.dataset.workId));
  if (sourceSortedIds.indexOf('work-hemingway') > sourceSortedIds.indexOf('work-alpha') ||
      sourceSortedIds.indexOf('work-hemingway') > sourceSortedIds.indexOf('work-beta')) {
    throw new Error(`Source sorting ignored the merged work source set: ${sourceSortedIds.join(', ')}`);
  }

  await page.fill('#search-input', 'short smoke');
  await page.click('#search-btn');
  await page.waitForFunction(() => document.getElementById('search-results-count')?.textContent === '17 works · 22 versions');
  if (await page.locator('[data-search-load-more]').isVisible()) {
    throw new Error('Load-more control is exposed when every work fits in the first batch');
  }

  await page.fill('#search-input', 'smkoe books');
  await page.click('#search-btn');
  await page.waitForSelector('.search-correction');
  if (await page.textContent('.search-correction') !== 'Showing results for smoke books') {
    throw new Error(`Applied query correction was not disclosed: ${await page.textContent('.search-correction')}`);
  }

  await page.click('#search-clear-btn');
  if (await page.locator('.result-card').count() !== 0 || await page.inputValue('#search-input') !== '') {
    throw new Error('Search clear action did not reset the query and results');
  }
  if (await page.getAttribute('#search-filter-toggle', 'aria-expanded') !== 'false') {
    throw new Error('Clearing search unexpectedly opened the mobile filter sheet');
  }

  await page.fill('#search-input', 'source issue smoke');
  await page.click('#search-btn');
  await page.waitForFunction(() => document.getElementById('search-source-message')?.textContent.includes('Standard:'));
  const standardSource = page.locator('[data-search-source="standardebooks"]');
  if (await standardSource.locator('.source-status-dot.is-issue').count() !== 1) {
    throw new Error('Unavailable source is not represented by a subtle source-status dot');
  }
  if ((await standardSource.innerText()).includes('unavailable right now')) {
    throw new Error('Verbose source errors are still expanding source pills');
  }
  const requestsBeforeApply = fixtureState.searchRequests.length;
  await page.click('#search-filter-toggle');
  await page.click('#search-filter-apply');
  await page.waitForSelector('.result-card:not(.skeleton-result)');
  if (fixtureState.searchRequests.length !== requestsBeforeApply + 1 ||
      fixtureState.searchRequests.at(-1)?.query !== 'source issue smoke') {
    throw new Error(`Applying mobile filters did not rerun the current query: ${JSON.stringify(fixtureState.searchRequests.at(-1))}`);
  }
  if (await page.getAttribute('#search-filter-toggle', 'aria-expanded') !== 'false') {
    throw new Error('Applying mobile filters did not close the filter sheet');
  }
}

async function verifyAtomicServiceWorkerUpgrade(page, fixture) {
  const oldCache = await page.evaluate(async () => {
    const source = await (await fetch('/sw.js', { cache: 'no-store' })).text();
    return source.match(/const CACHE_VERSION = '([^']+)'/)?.[1] || '';
  });
  if (!oldCache) throw new Error('Could not discover the current service-worker cache version');
  const brokenCache = `${oldCache}-broken-smoke`;
  const initialKeys = await page.evaluate(() => caches.keys());
  if (!initialKeys.includes(oldCache)) throw new Error(`Initial complete shell cache is missing: ${initialKeys.join(', ')}`);

  fixture.setBrokenUpgrade(brokenCache, '/js/ui/confirm.js');
  try {
    const result = await page.evaluate(async ({ oldCache, brokenCache }) => {
      const registration = await navigator.serviceWorker.ready;
      const found = new Promise(resolve => registration.addEventListener('updatefound', () => resolve(registration.installing), { once: true }));
      await registration.update().catch(() => {});
      const worker = registration.installing || await Promise.race([
        found,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Broken service-worker update was not discovered')), 5000))
      ]);
      if (worker.state !== 'redundant') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Broken worker remained ${worker.state}`)), 8000);
          worker.addEventListener('statechange', () => {
            if (worker.state === 'redundant' || worker.state === 'activated') {
              clearTimeout(timer);
              resolve();
            }
          });
        });
      }
      const keys = await caches.keys();
      return {
        workerState: worker.state,
        oldCachePresent: keys.includes(oldCache),
        brokenCachePresent: keys.includes(brokenCache),
        controllerState: navigator.serviceWorker.controller?.state || null
      };
    }, { oldCache, brokenCache });
    if (result.workerState !== 'redundant' || !result.oldCachePresent || result.brokenCachePresent || result.controllerState !== 'activated') {
      throw new Error(`Broken shell upgrade was not atomic: ${JSON.stringify(result)}`);
    }
  } finally {
    fixture.restoreShell();
  }
}

async function verifyRealServiceWorkerOffline(browser) {
  const fixture = await startOfflineFixtureServer();
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  try {
    await page.goto(`${fixture.origin}/#/player/smoke-offline`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#player-view.active');
    await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none');
    await page.waitForSelector('#operator-notice-dialog.active');
    await page.check('#operator-notice-ack');
    await page.click('#operator-notice-continue');
    await page.waitForSelector('#operator-notice-dialog', { state: 'hidden' });
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) return;
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
      throw new Error('Real Xandrio service worker did not control the fixture page');
    }
    await verifyAtomicServiceWorkerUpgrade(page, fixture);

    // Exercise the product's actual Download for Offline control. It prepares
    // chapter audio, fetches it, and stores it in xandrio-offline-audio.
    await page.evaluate(() => document.getElementById('download-book-btn').click());
    await page.waitForFunction(() => {
      const manifest = JSON.parse(localStorage.getItem('xandrio_offline_books') || '{}');
      return manifest['smoke-offline']?.chapters === 1;
    });
    const cachedBytes = await page.evaluate(async () => {
      const cache = await caches.open('xandrio-offline-audio');
      const response = await cache.match(`${location.origin}/api/audio/smoke-offline/0`);
      return response ? (await response.arrayBuffer()).byteLength : 0;
    });
    if (cachedBytes !== fixture.audioBytes) {
      throw new Error(`Offline UI cached ${cachedBytes} audio bytes; expected ${fixture.audioBytes}`);
    }

    // Browser-level network loss is deliberate here: navigator.onLine and
    // media are native. Only the real public/sw.js can satisfy these requests.
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await page.waitForFunction(() => !document.getElementById('offline-banner').hidden);
    await page.evaluate(() => {
      const select = document.getElementById('chapter-select');
      select.value = '0';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('audio-player')?.src.includes('/api/audio/smoke-offline/0'));
    await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none');
    await page.click('#play-pause-btn');
    await page.waitForFunction(() => {
      const audio = document.getElementById('audio-player');
      return audio && !audio.paused && audio.currentTime > 0;
    });
    await page.evaluate(() => {
      const slider = document.getElementById('progress-slider');
      slider.value = '60';
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('audio-player')?.currentTime >= 1.5);

    const range = await page.evaluate(async () => {
      const response = await fetch('/api/audio/smoke-offline/0', { headers: { Range: 'bytes=100-199' } });
      return {
        status: response.status,
        contentRange: response.headers.get('Content-Range'),
        contentLength: response.headers.get('Content-Length'),
        acceptRanges: response.headers.get('Accept-Ranges'),
        bytes: (await response.arrayBuffer()).byteLength
      };
    });
    const expectedRange = `bytes 100-199/${fixture.audioBytes}`;
    if (range.status !== 206 || range.contentRange !== expectedRange || range.contentLength !== '100' ||
        range.acceptRanges !== 'bytes' || range.bytes !== 100) {
      throw new Error(`Service-worker range regression: ${JSON.stringify(range)}, expected ${expectedRange}`);
    }

    const unsatisfied = await page.evaluate(async () => {
      const response = await fetch('/api/audio/smoke-offline/0', { headers: { Range: 'bytes=999999-' } });
      return { status: response.status, contentRange: response.headers.get('Content-Range') };
    });
    if (unsatisfied.status !== 416 || unsatisfied.contentRange !== `bytes */${fixture.audioBytes}`) {
      throw new Error(`Service-worker unsatisfied range regression: ${JSON.stringify(unsatisfied)}`);
    }

    const malformed = await page.evaluate(async () => {
      const response = await fetch('/api/audio/smoke-offline/0', { headers: { Range: 'bytes=broken' } });
      return {
        status: response.status,
        contentRange: response.headers.get('Content-Range'),
        acceptRanges: response.headers.get('Accept-Ranges')
      };
    });
    if (malformed.status !== 416 || malformed.contentRange !== `bytes */${fixture.audioBytes}` || malformed.acceptRanges !== 'bytes') {
      throw new Error(`Service-worker malformed range regression: ${JSON.stringify(malformed)}`);
    }

    const suffix = await page.evaluate(async () => {
      const response = await fetch('/api/audio/smoke-offline/0', { headers: { Range: 'bytes=-64' } });
      return {
        status: response.status,
        contentLength: response.headers.get('Content-Length'),
        bytes: (await response.arrayBuffer()).byteLength
      };
    });
    if (suffix.status !== 206 || suffix.contentLength !== '64' || suffix.bytes !== 64) {
      throw new Error(`Service-worker suffix range regression: ${JSON.stringify(suffix)}`);
    }
    if (pageErrors.length) throw new Error(`Offline service-worker page errors:\n${pageErrors.join('\n')}`);
  } finally {
    await context.close();
    await fixture.close();
  }
}

async function main() {
  await assertReferencedPwaAssets();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      KOKORO_AUTO_START: 'false', CHATTERBOX_AUTO_START: 'false',
      XANDRIO_TOKEN: 'browser-smoke-token'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });

  let browser;
  try {
    await waitForHealth();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    const fixtureState = await installBrowserFixtures(page);
    await verifyPlayback(page, fixtureState);
    await verifyPronunciations(page, fixtureState);
    await verifySearchWorkspace(page, fixtureState);
    if (pageErrors.length) throw new Error(`Browser page errors:\n${pageErrors.join('\n')}`);
    await verifyRealServiceWorkerOffline(browser);
    console.log('Browser smoke passed: playback/tier/pronunciation, search workspace, atomic shell upgrade failure, PWA icons, and real offline Range 206/416.');
  } catch (err) {
    if (serverOutput) process.stderr.write(`\nServer output:\n${serverOutput}\n`);
    throw err;
  } finally {
    await browser?.close().catch(() => {});
    server.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
