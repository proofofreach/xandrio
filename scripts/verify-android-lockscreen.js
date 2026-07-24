/**
 * Android/GrapheneOS lock-screen playback verification.
 *
 * Drives the real app shell in Chromium with a Vanadium (GrapheneOS) Android
 * user agent and real WAV audio, and verifies the three behaviors that make
 * locked-screen listening survive:
 *
 *  1. Android selects the single-file chapter engine when concatenated
 *     chapter audio is ready (previously iOS-only), so lock-screen playback
 *     runs through one continuous native <audio> element.
 *  2. The chunked engine crosses a chunk boundary even when timers are
 *     throttled to 60s (Chromium's locked-screen behavior) because the
 *     boundary path is fetch-driven, not timer-driven.
 *  3. While the chunked engine plays, the app hands off mid-play to the
 *     single-file engine as soon as the chapter file is ready.
 */
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const { chromium } = require('playwright');

const VANADIUM_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36';

function wavBuffer(durationSeconds) {
  const sampleRate = 24000;
  const samples = Math.round(sampleRate * durationSeconds);
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
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 330 * i / sampleRate) * 4000), 44 + i * 2);
  }
  return wav;
}

function jsonResponse(res, body, status = 200) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
  res.end(payload);
}

async function startFixtureServer() {
  const publicRoot = path.join(__dirname, '..', 'public');
  const chapterWav = wavBuffer(65); // covers the 2×30s long-chunk chapter so handoff seeks stay in range
  const chunkWav = wavBuffer(6);
  const longChunkWav = wavBuffer(30);
  const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.png': 'image/png'
  };
  const state = {
    // Per-scenario switches, driven from the test.
    chapterAudioReady: false,
    chunkOneStatus: 'ready',
    longChunks: false,
    requests: []
  };
  const book = {
    id: 'lockscreen', title: 'Lock Screen Book', author: 'Fixture Author',
    description: 'Android lock-screen verification fixture.', language: 'en',
    chapterCount: 2, chapterDurations: [6, 6], totalDuration: 12
  };
  const chapters = [
    { title: 'Chapter One', type: 'chapter', estimatedDuration: 6, text: 'First chapter fixture text for lock screen verification purposes.' },
    { title: 'Chapter Two', type: 'chapter', estimatedDuration: 6, text: 'Second chapter fixture text for lock screen verification purposes.' }
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    const pathname = url.pathname;
    state.requests.push(pathname + url.search);
    if (pathname === '/health') return jsonResponse(res, { status: 'ok' });
    if (pathname === '/api/legal/operator-policy') {
      return jsonResponse(res, { version: 1, acknowledged: true, acknowledgedAt: '2026-07-01T00:00:00.000Z', unverifiedSourcesEnabled: false });
    }
    if (pathname === '/api/auth/status') return jsonResponse(res, { authenticationRequired: false, authenticated: true });
    if (pathname === '/api/library') return jsonResponse(res, { books: [book] });
    if (pathname === '/api/positions') return jsonResponse(res, { positions: {} });
    if (pathname === '/api/settings/client') return jsonResponse(res, { settings: {} });
    if (pathname === '/api/book/lockscreen') return jsonResponse(res, { book, chapters });
    if (pathname === '/api/position/lockscreen') return jsonResponse(res, { position: null });
    if (pathname === '/api/position') return jsonResponse(res, { success: true });
    if (pathname === '/api/bookmarks/lockscreen') return jsonResponse(res, { bookmarks: [] });
    if (pathname === '/api/voices') return jsonResponse(res, {
      current: 'edge:andrew', voices: [{ id: 'edge:andrew', name: 'Andrew', provider: 'edge', gender: 'male' }]
    });
    if (pathname === '/api/engines/status') return jsonResponse(res, { engines: { edge: { up: true } } });
    if (pathname.startsWith('/api/voice-cache/')) return jsonResponse(res, { voices: [] });
    if (pathname.startsWith('/api/premium-prep/')) return jsonResponse(res, {}, 404);
    if (pathname === '/api/pronunciations') return jsonResponse(res, { book: [], global: [] });
    if (pathname.endsWith('/prepare-chapter-audio')) return jsonResponse(res, { success: true });
    if (pathname.endsWith('/chapter-audio-status')) {
      return jsonResponse(res, state.chapterAudioReady
        ? { ready: true, variantKey: 'fixture', url: '/api/audio/lockscreen/0' }
        : { ready: false, variantKey: 'fixture' });
    }
    if (/^\/api\/chunks\/lockscreen\/\d+\/\d+\/prioritize$/.test(pathname)) return jsonResponse(res, { success: true });
    if (/^\/api\/chunks\/lockscreen\/\d+\/manifest$/.test(pathname)) {
      const chapterIndex = Number(pathname.split('/')[4]);
      const tier = url.searchParams.get('tier') || 'instant';
      return jsonResponse(res, {
        bookId: 'lockscreen', chapterIndex, totalChunks: 2, servedTier: tier,
        chunks: [
          { index: 0, status: 'ready', textLength: 40, url: `/api/chunks/lockscreen/${chapterIndex}/0?tier=${tier}` },
          { index: 1, status: state.chunkOneStatus, textLength: 40, url: `/api/chunks/lockscreen/${chapterIndex}/1?tier=${tier}` }
        ]
      });
    }
    const audioFor = (body) => {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': body.length, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (/^\/api\/chunks\/lockscreen\/\d+\/\d+$/.test(pathname)) {
      return audioFor(state.longChunks ? longChunkWav : chunkWav);
    }
    if (/^\/api\/audio\/lockscreen\/\d+$/.test(pathname)) return audioFor(chapterWav);
    if (pathname.startsWith('/api/cover/')) { res.writeHead(404); return res.end(); }
    if (pathname.startsWith('/api/')) return jsonResponse(res, {});

    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const filePath = path.resolve(publicRoot, relative);
    if (!filePath.startsWith(publicRoot + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      const body = await fs.readFile(filePath);
      res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
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
  return {
    state,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function newAndroidPage(browser, origin, { waitForLoadingHidden = true } = {}) {
  const context = await browser.newContext({
    userAgent: VANADIUM_UA,
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  // Locked-screen simulation: Chromium clamps background timers to coarse
  // 60s ticks. Anything that needs a timer to advance playback will stall,
  // exactly as on a locked GrapheneOS phone.
  await page.addInitScript(() => {
    window.__lockScreen = false;
    const realSetTimeout = window.setTimeout.bind(window);
    const realSetInterval = window.setInterval.bind(window);
    window.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, window.__lockScreen ? Math.max(Number(ms) || 0, 60000) : ms, ...args);
    window.setInterval = (fn, ms, ...args) => realSetInterval(fn, window.__lockScreen ? Math.max(Number(ms) || 0, 60000) : ms, ...args);
  });
  await page.goto(`${origin}/#/player/lockscreen`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#player-view.active');
  await page.waitForFunction(() => typeof window.xandrioPlaybackReport === 'function');
  if (waitForLoadingHidden) {
    await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none', null, { timeout: 20000 });
  } else {
    // While upcoming chunks are still generating the app keeps a preparing
    // overlay up; wait for the engine itself to be ready instead.
    await page.waitForFunction(() => {
      const r = window.xandrioPlaybackReport();
      return r.position && r.position.totalChunks > 0;
    }, null, { timeout: 20000 });
  }
  return { context, page, pageErrors };
}

function report(page) {
  return page.evaluate(() => window.xandrioPlaybackReport());
}

async function scenarioSingleFileSelection(browser, fixture) {
  fixture.state.chapterAudioReady = true;
  fixture.state.chunkOneStatus = 'ready';
  fixture.state.longChunks = false;
  const { context, page, pageErrors } = await newAndroidPage(browser, fixture.origin);
  try {
    const initial = await report(page);
    if (!initial.needsReliablePlayback) throw new Error(`Android UA did not enable reliable playback: ${JSON.stringify(initial)}`);
    if (initial.backend !== 'single-file') throw new Error(`Android did not select the single-file engine with chapter audio ready: backend=${initial.backend}`);
    await page.click('#play-pause-btn');
    await page.waitForFunction(() => {
      const audio = document.getElementById('audio-player');
      return audio && !audio.paused && audio.currentTime > 0.2 && audio.src.includes('/api/audio/lockscreen/0');
    }, null, { timeout: 10000 });
    // Lock the screen: a single continuous file needs no JS to keep playing.
    await page.evaluate(() => { window.__lockScreen = true; });
    await page.waitForFunction(() => document.getElementById('audio-player').currentTime > 2, null, { timeout: 10000 });
    if (pageErrors.length) throw new Error(`Page errors:\n${pageErrors.join('\n')}`);
    console.log('PASS Android selects single-file engine and native audio keeps playing under 60s timer throttle');
  } finally {
    await context.close();
  }
}

async function scenarioChunkBoundaryUnderThrottle(browser, fixture) {
  fixture.state.chapterAudioReady = false;
  fixture.state.longChunks = false;
  // Chunk 1 reports "generating" during initial load, so the standby preload
  // parks in its timer-driven wait loop — which the lock-screen throttle then
  // freezes for 60s. The boundary must recover via the fetch-driven path.
  fixture.state.chunkOneStatus = 'generating';
  const { context, page, pageErrors } = await newAndroidPage(browser, fixture.origin, { waitForLoadingHidden: false });
  try {
    const initial = await report(page);
    if (initial.backend !== 'chunked') throw new Error(`Expected the chunked interim engine, got: ${initial.backend}`);
    await page.evaluate(() => document.getElementById('play-pause-btn').click());
    await page.waitForFunction(() => {
      const r = window.xandrioPlaybackReport();
      return r.isPlaying && r.position && r.position.chunkTime > 0.2;
    }, null, { timeout: 10000 });
    await page.evaluate(() => { window.__lockScreen = true; });
    // Let every pre-throttle preload cycle observe "generating"; once the
    // throttle owns all timers, the preload loop is 60s away from its next
    // manifest check. Only then does the chunk become ready server-side —
    // the boundary can recover solely through the fetch-driven ended path.
    await page.waitForFunction(() => window.xandrioPlaybackReport().position.chunkTime > 4.5, null, { timeout: 15000 });
    fixture.state.chunkOneStatus = 'ready';
    // Chunk 0 ends at 6s; the transition must not wait for a 60s timer tick.
    await page.waitForFunction(() => {
      const r = window.xandrioPlaybackReport();
      return r.isPlaying && r.position && r.position.chunkIndex === 1;
    }, null, { timeout: 12000 });
    if (pageErrors.length) throw new Error(`Page errors:\n${pageErrors.join('\n')}`);
    console.log('PASS chunked engine crosses a chunk boundary with timers throttled to 60s');
  } finally {
    await context.close();
  }
}

async function scenarioMidPlayHandoff(browser, fixture) {
  fixture.state.chapterAudioReady = false;
  fixture.state.chunkOneStatus = 'ready';
  fixture.state.longChunks = true; // 30s chunks: the chapter keeps playing during the handoff window
  const { context, page, pageErrors } = await newAndroidPage(browser, fixture.origin);
  try {
    const initial = await report(page);
    if (initial.backend !== 'chunked') throw new Error(`Expected the chunked interim engine, got: ${initial.backend}`);
    await page.click('#play-pause-btn');
    await page.waitForFunction(() => {
      const r = window.xandrioPlaybackReport();
      return r.isPlaying && r.position && r.position.chunkTime > 0.5;
    }, null, { timeout: 10000 });
    // Concatenated chapter audio finishes rendering server-side.
    fixture.state.chapterAudioReady = true;
    // The reliable-audio status poll runs every 12s while audible (audible
    // pages are exempt from intensive throttling, so it fires on time).
    await page.waitForFunction(() => {
      const r = window.xandrioPlaybackReport();
      return r.backend === 'single-file' && r.isPlaying;
    }, null, { timeout: 25000 });
    // Position must carry over: the chunked engine was several seconds in,
    // so the native element resumes well past zero and keeps advancing.
    await page.waitForFunction(() => {
      const audio = document.getElementById('audio-player');
      return audio && !audio.paused && audio.src.includes('/api/audio/lockscreen/0') && audio.currentTime > 2;
    }, null, { timeout: 10000 });
    if (pageErrors.length) throw new Error(`Page errors:\n${pageErrors.join('\n')}`);
    console.log('PASS Android hands off mid-play from chunked to single-file once chapter audio is ready');
  } finally {
    await context.close();
  }
}

async function main() {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  try {
    await scenarioSingleFileSelection(browser, fixture);
    await scenarioChunkBoundaryUnderThrottle(browser, fixture);
    await scenarioMidPlayHandoff(browser, fixture);
    console.log('Android lock-screen verification passed.');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close();
  }
}

module.exports = { startFixtureServer, wavBuffer };

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
