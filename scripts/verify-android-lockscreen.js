/**
 * First-listen/lock-screen playback benchmark.
 *
 * Uses the real app shell and real WAV audio with an Android PWA user agent.
 * There is deliberately no Chromium autoplay bypass. The page receives one
 * trusted Play click, then enters a lock-screen simulation where timers are
 * clamped to 60 seconds and every later play() call is rejected.
 */
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const { performance } = require('perf_hooks');
const { chromium } = require('playwright');

const VANADIUM_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36';
const SAMPLE_INTERVAL_MS = 100;
const LOCKED_SAMPLE_DURATION_MS = 6000;
const MAX_FIRST_SOUND_MS = 1500;
const MAX_STALL_MS = 650;
const MIN_LOCKED_ADVANCE_SECONDS = 4.8;
const FIRST_CHAPTER_SECONDS = 3;

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
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function startFixtureServer() {
  const publicRoot = path.join(__dirname, '..', 'public');
  const chapterWavs = [wavBuffer(FIRST_CHAPTER_SECONDS), wavBuffer(10)];
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2',
    '.png': 'image/png'
  };
  const state = { requests: [] };
  const book = {
    id: 'lockscreen',
    title: 'Lock Screen Book',
    author: 'Fixture Author',
    description: 'First-listen continuity fixture.',
    language: 'en',
    chapterCount: 2,
    chapterDurations: [FIRST_CHAPTER_SECONDS, 10],
    totalDuration: FIRST_CHAPTER_SECONDS + 10
  };
  const chapters = [
    {
      title: 'Chapter One',
      type: 'chapter',
      estimatedDuration: FIRST_CHAPTER_SECONDS,
      text: 'First-listen lock-screen verification fixture.'
    },
    {
      title: 'Chapter Two',
      type: 'chapter',
      estimatedDuration: 10,
      text: 'Background chapter continuation fixture.'
    }
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    const pathname = url.pathname;
    state.requests.push(pathname + url.search);

    if (pathname === '/health') return jsonResponse(res, { status: 'ok' });
    if (pathname === '/api/legal/operator-policy') {
      return jsonResponse(res, {
        version: 1,
        acknowledged: true,
        acknowledgedAt: '2026-07-01T00:00:00.000Z',
        unverifiedSourcesEnabled: false
      });
    }
    if (pathname === '/api/auth/status') {
      return jsonResponse(res, { authenticationRequired: false, authenticated: true });
    }
    if (pathname === '/api/library') return jsonResponse(res, { books: [book] });
    if (pathname === '/api/positions') return jsonResponse(res, { positions: {} });
    if (pathname === '/api/settings/client') return jsonResponse(res, { settings: {} });
    if (pathname === '/api/book/lockscreen') return jsonResponse(res, { book, chapters });
    if (pathname === '/api/position/lockscreen') return jsonResponse(res, { position: null });
    if (pathname === '/api/position') return jsonResponse(res, { success: true });
    if (pathname === '/api/bookmarks/lockscreen') return jsonResponse(res, { bookmarks: [] });
    if (pathname === '/api/queue/status') {
      return jsonResponse(res, { active: 0, queued: 0, books: [] });
    }
    if (pathname === '/api/voices') {
      return jsonResponse(res, {
        current: 'edge:andrew',
        voices: [{ id: 'edge:andrew', name: 'Andrew', provider: 'edge', gender: 'male' }]
      });
    }
    if (pathname === '/api/engines/status') return jsonResponse(res, { engines: { edge: { up: true } } });
    if (pathname.startsWith('/api/voice-cache/')) return jsonResponse(res, { voices: [] });
    if (pathname.startsWith('/api/premium-prep/')) return jsonResponse(res, {}, 404);
    if (pathname === '/api/pronunciations') return jsonResponse(res, { book: [], global: [] });

    const streamMatch = pathname.match(/^\/api\/audio-stream\/lockscreen\/([01])$/);
    if (streamMatch) {
      const chapterWav = chapterWavs[Number(streamMatch[1])];
      const streamingHeader = Buffer.from(chapterWav.subarray(0, 44));
      streamingHeader.writeUInt32LE(0xffffffff, 4);
      streamingHeader.writeUInt32LE(0xffffffff, 40);
      // Real TTS chunks provide tens of seconds of runway. Four seconds keeps
      // this fixture small while still exercising an open response boundary.
      const runwayBytes = 24000 * 2 * Math.min(4, chapterWav.length / (24000 * 2));
      const firstPartEnd = Math.min(chapterWav.length, 44 + runwayBytes);
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Accept-Ranges': 'none',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
      });
      res.write(Buffer.concat([streamingHeader, chapterWav.subarray(44, firstPartEnd)]));
      const finish = () => {
        if (!res.destroyed) res.end(chapterWav.subarray(firstPartEnd));
      };
      if (Number(streamMatch[1]) === 0) setTimeout(finish, 900);
      else finish();
      return;
    }
    const fallbackMatch = pathname.match(/^\/api\/(?:audio|audio-ios)\/lockscreen\/([01])$/);
    if (fallbackMatch) {
      const chapterWav = chapterWavs[Number(fallbackMatch[1])];
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': chapterWav.length,
        'Cache-Control': 'no-store'
      });
      return res.end(chapterWav);
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
    try {
      const body = await fs.readFile(filePath);
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
  return {
    state,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function newAndroidPage(browser, origin) {
  const context = await browser.newContext({
    userAgent: VANADIUM_UA,
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__lockScreen = false;
    window.__mediaPlayCalls = [];
    const realSetTimeout = window.setTimeout.bind(window);
    const realSetInterval = window.setInterval.bind(window);
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function auditedPlay() {
      window.__mediaPlayCalls.push({ src: this.currentSrc || this.src, locked: window.__lockScreen });
      if (window.__lockScreen) {
        return Promise.reject(new DOMException('Background play blocked by benchmark', 'NotAllowedError'));
      }
      return nativePlay.apply(this, arguments);
    };
    window.setTimeout = (fn, ms, ...args) => (
      realSetTimeout(fn, window.__lockScreen ? Math.max(Number(ms) || 0, 60000) : ms, ...args)
    );
    window.setInterval = (fn, ms, ...args) => (
      realSetInterval(fn, window.__lockScreen ? Math.max(Number(ms) || 0, 60000) : ms, ...args)
    );
  });
  await page.goto(`${origin}/#/player/lockscreen`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#player-view.active');
  await page.waitForFunction(() => typeof window.xandrioPlaybackReport === 'function');
  await page.waitForFunction(() => (
    document.getElementById('audio-loading')?.style.display === 'none' &&
    window.xandrioPlaybackReport().backend === 'audio-stream'
  ), null, { timeout: 20000 });
  return { context, page, pageErrors };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function benchmarkFirstListening(browser, fixture) {
  const { context, page, pageErrors } = await newAndroidPage(browser, fixture.origin);
  try {
    const before = await page.evaluate(() => ({
      report: window.xandrioPlaybackReport(),
      audioElements: document.querySelectorAll('audio').length,
      source: document.getElementById('audio-player')?.getAttribute('src')
    }));
    assert(before.audioElements === 1, `Expected one persistent audio element, found ${before.audioElements}`);
    assert(before.source === '/api/audio-stream/lockscreen/0', `Unexpected initial source: ${before.source}`);

    await page.evaluate(() => { window.__benchmarkClickAt = performance.now(); });
    await page.click('#play-pause-btn');
    await page.waitForFunction(() => {
      const audio = document.getElementById('audio-player');
      return audio && !audio.paused && audio.currentTime > 0.05;
    }, null, { timeout: 10000 });
    const firstSoundMs = await page.evaluate(() => performance.now() - window.__benchmarkClickAt);
    assert(firstSoundMs <= MAX_FIRST_SOUND_MS, `First sound took ${firstSoundMs.toFixed(0)}ms`);

    const lockedStart = await page.evaluate(firstChapterSeconds => {
      window.__lockScreen = true;
      const report = window.xandrioPlaybackReport();
      return report.currentChapter * firstChapterSeconds +
        document.getElementById('audio-player').currentTime;
    }, FIRST_CHAPTER_SECONDS);
    const samples = [];
    const sampleStart = performance.now();
    while (performance.now() - sampleStart < LOCKED_SAMPLE_DURATION_MS) {
      await new Promise(resolve => setTimeout(resolve, SAMPLE_INTERVAL_MS));
      samples.push(await page.evaluate(({ wallMs, firstChapterSeconds }) => {
        const report = window.xandrioPlaybackReport();
        return {
          wallMs,
          audioTime: report.currentChapter * firstChapterSeconds +
            document.getElementById('audio-player').currentTime
        };
      }, { wallMs: performance.now() - sampleStart, firstChapterSeconds: FIRST_CHAPTER_SECONDS }));
    }

    let lastAdvanceAt = 0;
    let lastAudioTime = lockedStart;
    let longestStallMs = 0;
    for (const sample of samples) {
      if (sample.audioTime > lastAudioTime + 0.015) {
        longestStallMs = Math.max(longestStallMs, sample.wallMs - lastAdvanceAt);
        lastAdvanceAt = sample.wallMs;
        lastAudioTime = sample.audioTime;
      }
    }
    longestStallMs = Math.max(longestStallMs, LOCKED_SAMPLE_DURATION_MS - lastAdvanceAt);

    const after = await page.evaluate(firstChapterSeconds => {
      const audio = document.getElementById('audio-player');
      return {
        report: window.xandrioPlaybackReport(),
        currentTime: audio.currentTime,
        logicalTime: window.xandrioPlaybackReport().currentChapter * firstChapterSeconds + audio.currentTime,
        paused: audio.paused,
        source: audio.getAttribute('src'),
        audioElements: document.querySelectorAll('audio').length,
        playCalls: window.__mediaPlayCalls,
        resumePromptHidden: document.getElementById('playback-resume-prompt')?.hidden
      };
    }, FIRST_CHAPTER_SECONDS);
    const lockedAdvanceSeconds = after.logicalTime - lockedStart;
    const streamRequests = fixture.state.requests.filter(request => request.startsWith('/api/audio-stream/lockscreen/'));
    const fallbackRequests = fixture.state.requests.filter(request => {
      const pathname = request.split('?')[0];
      return /^\/api\/(?:audio|audio-ios)\/lockscreen\/[01]$/.test(pathname) ||
        /^\/api\/chunks\/lockscreen\/[01]\/manifest$/.test(pathname) ||
        /^\/api\/chunks\/lockscreen\/[01]\/\d+$/.test(pathname);
    });

    assert(after.audioElements === 1, `Audio element count changed to ${after.audioElements}`);
    assert(after.playCalls.length === 1, `Expected one user-triggered play(), saw ${after.playCalls.length}`);
    assert(after.playCalls[0].locked === false, 'The only play() call was not user-triggered before lock');
    assert(!after.paused && after.report.isPlaying, 'Playback paused while the PWA was backgrounded');
    assert(after.resumePromptHidden, 'The UI asked the listener to resume playback');
    assert(after.report.currentChapter === 1, `Playback did not auto-advance while locked: chapter ${after.report.currentChapter}`);
    assert(after.source === '/api/audio-stream/lockscreen/1', `Unexpected next-chapter source: ${after.source}`);
    assert(streamRequests.length === 2, `Expected one stable stream request per chapter, saw ${streamRequests.length}`);
    assert(fallbackRequests.length === 0, `Unexpected fallback media requests: ${fallbackRequests.join(', ')}`);
    assert(lockedAdvanceSeconds >= MIN_LOCKED_ADVANCE_SECONDS, `Audio advanced only ${lockedAdvanceSeconds.toFixed(2)}s while locked`);
    assert(longestStallMs <= MAX_STALL_MS, `Longest playback stall was ${longestStallMs.toFixed(0)}ms`);
    if (pageErrors.length) throw new Error(`Page errors:\n${pageErrors.join('\n')}`);

    return {
      firstSoundMs,
      longestStallMs,
      lockedAdvanceSeconds,
      mediaElements: after.audioElements,
      playCalls: after.playCalls.length,
      streamRequests: streamRequests.length,
      fallbackRequests: fallbackRequests.length
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const result = await benchmarkFirstListening(browser, fixture);
    console.log(JSON.stringify({
      benchmark: 'first-listen-lock-screen',
      thresholds: {
        maxFirstSoundMs: MAX_FIRST_SOUND_MS,
        maxStallMs: MAX_STALL_MS,
        minLockedAdvanceSeconds: MIN_LOCKED_ADVANCE_SECONDS
      },
      result: {
        firstSoundMs: Number(result.firstSoundMs.toFixed(1)),
        longestStallMs: Number(result.longestStallMs.toFixed(1)),
        lockedAdvanceSeconds: Number(result.lockedAdvanceSeconds.toFixed(2)),
        mediaElements: result.mediaElements,
        playCalls: result.playCalls,
        streamRequests: result.streamRequests,
        fallbackRequests: result.fallbackRequests
      },
      passed: true
    }, null, 2));
  } finally {
    await browser.close().catch(() => {});
    await fixture.close();
  }
}

module.exports = { benchmarkFirstListening, startFixtureServer, wavBuffer };

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
