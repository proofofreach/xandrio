/**
 * Deterministic mobile playback continuity regression.
 *
 * This benchmark deliberately uses:
 * - the real app shell and service worker,
 * - Chromium's Android/Pixel device profile,
 * - a real HTMLMediaElement,
 * - one trusted Play click,
 * - independently encoded MP3 chunks for the legacy transport,
 * - a single continuously encoded MP3 for Chromium and native fMP4 HLS for
 *   WebKit,
 * - a controlled network starvation and main-thread suspension spanning a
 *   logical chapter boundary.
 *
 * The legacy raw-MP3-concat/per-chapter-source architecture must fail. The
 * continuous endpoint passes only when one native source survives the chapter
 * boundary without pause/emptied/loadstart churn.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { performance } = require('perf_hooks');
const { chromium, webkit, devices } = require('playwright');

const SEGMENT_SECONDS = 3;
const CHAPTER_SECONDS = SEGMENT_SECONDS * 2;
const SAMPLE_INTERVAL_MS = 100;
const SAMPLE_DURATION_MS = 8200;
const RELEASE_AFTER_PLAY_MS = 3600;
const JS_BLOCK_START_MS = 5400;
const JS_BLOCK_DURATION_MS = 1200;
const MAX_FIRST_SOUND_MS = 1500;
const MAX_STALL_MS = 700;
const MAX_BOUNDARY_STALL_MS = 250;
const MIN_ADVANCE_SECONDS = 7.0;
const FORCE_LEGACY = process.env.XANDRIO_BENCHMARK_FORCE_LEGACY === '1';
const VERBOSE_LEDGER = process.env.XANDRIO_BENCHMARK_VERBOSE === '1';
const MEDIA_EVENTS = [
  'loadstart',
  'durationchange',
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'waiting',
  'stalled',
  'suspend',
  'pause',
  'emptied',
  'abort',
  'ended',
  'error'
];

function execFileResult(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        exitCode: Number.isInteger(error?.code) ? error.code : (error ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      });
    });
  });
}

async function requireCommand(command) {
  const result = await execFileResult('/usr/bin/env', ['which', command]);
  if (result.exitCode !== 0) {
    throw new Error(`${command} is required for the mobile playback benchmark`);
  }
}

async function encodeTone(outputPath, frequency) {
  const result = await execFileResult('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi',
    '-i', `sine=frequency=${frequency}:sample_rate=24000:duration=${SEGMENT_SECONDS}`,
    '-ac', '1',
    '-ar', '24000',
    '-c:a', 'libmp3lame',
    '-b:a', '160k',
    outputPath
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`MP3 segment encoding failed: ${result.stderr.trim()}`);
  }
}

async function encodeContinuous(outputPath, frequencies) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const frequency of frequencies) {
    args.push(
      '-f', 'lavfi',
      '-i', `sine=frequency=${frequency}:sample_rate=24000:duration=${SEGMENT_SECONDS}`
    );
  }
  const inputs = frequencies.map((_, index) => `[${index}:a]`).join('');
  args.push(
    '-filter_complex', `${inputs}concat=n=${frequencies.length}:v=0:a=1[a]`,
    '-map', '[a]',
    '-ac', '1',
    '-ar', '24000',
    '-c:a', 'libmp3lame',
    '-b:a', '160k',
    // The production continuous encoder writes to an unseekable pipe and
    // therefore cannot backfill a file-level Xing duration/index.
    '-write_xing', '0',
    outputPath
  );
  const result = await execFileResult('ffmpeg', args);
  if (result.exitCode !== 0) {
    throw new Error(`Continuous MP3 encoding failed: ${result.stderr.trim()}`);
  }
}

async function encodeHls(inputPath, outputDirectory) {
  await fsp.mkdir(outputDirectory, { recursive: true });
  const result = await execFileResult('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(outputDirectory, 'segment-%06d.m4s'),
    '-hls_flags', 'independent_segments+temp_file',
    path.join(outputDirectory, 'index.m3u8')
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`HLS fixture encoding failed: ${result.stderr.trim()}`);
  }
}

function conciseDecoderError(stderr) {
  return String(stderr || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => (
      /invalid concatenated file/i.test(line) ||
      /header missing/i.test(line) ||
      /invalid data found/i.test(line)
    ))
    .slice(0, 6);
}

async function validateMp3(filePath) {
  const result = await execFileResult('ffmpeg', [
    '-hide_banner', '-nostats', '-v', 'warning', '-xerror',
    '-i', filePath,
    '-f', 'null', '-'
  ]);
  return {
    valid: result.exitCode === 0,
    exitCode: result.exitCode,
    decoderErrors: conciseDecoderError(result.stderr)
  };
}

async function buildAudioFixtures() {
  await requireCommand('ffmpeg');
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-mobile-continuity-'));
  const frequencies = [330, 440, 550, 660];
  const chunkPaths = frequencies.map((_, index) => path.join(tempRoot, `chunk-${index}.mp3`));
  await Promise.all(chunkPaths.map((chunkPath, index) => encodeTone(chunkPath, frequencies[index])));

  const chunks = await Promise.all(chunkPaths.map(chunkPath => fsp.readFile(chunkPath)));
  const rawConcatPath = path.join(tempRoot, 'legacy-raw-concat.mp3');
  const continuousPath = path.join(tempRoot, 'continuous.mp3');
  await fsp.writeFile(rawConcatPath, Buffer.concat(chunks));
  await encodeContinuous(continuousPath, frequencies);
  const continuous = await fsp.readFile(continuousPath);
  const hlsDirectory = path.join(tempRoot, 'hls');
  await encodeHls(continuousPath, hlsDirectory);
  const hlsPlaylist = await fsp.readFile(path.join(hlsDirectory, 'index.m3u8'), 'utf8');
  const hlsFiles = new Map();
  for (const fileName of await fsp.readdir(hlsDirectory)) {
    if (fileName !== 'index.m3u8') {
      hlsFiles.set(fileName, await fsp.readFile(path.join(hlsDirectory, fileName)));
    }
  }
  const hlsValidation = await execFileResult('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-xerror',
    '-i', path.join(hlsDirectory, 'index.m3u8'),
    '-f', 'null', '-'
  ]);

  const validation = {
    legacyRawConcat: await validateMp3(rawConcatPath),
    continuous: await validateMp3(continuousPath),
    hls: { valid: hlsValidation.exitCode === 0, exitCode: hlsValidation.exitCode }
  };
  return {
    chunks,
    chapters: [chunks.slice(0, 2), chunks.slice(2, 4)],
    continuous,
    hlsPlaylist,
    hlsFiles,
    validation,
    close: () => fsp.rm(tempRoot, { recursive: true, force: true })
  };
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

function writeAudioHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'none',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  });
}

function finiteResponse(req, res, body, contentType) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
    if (!Number.isInteger(start) || start < 0 || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
      return res.end();
    }
    const slice = body.subarray(start, end + 1);
    res.writeHead(206, {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Content-Length': slice.length,
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    });
    return res.end(slice);
  }
  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': body.length,
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  return res.end(body);
}

function exposedHlsPlaylist(fullPlaylist, released, initialSegments = 8) {
  let segmentCount = 0;
  let includeNextUri = false;
  const lines = [];
  for (const line of String(fullPlaylist).split('\n')) {
    if (line === '#EXT-X-ENDLIST' && !released) continue;
    if (line.startsWith('#EXTINF:')) {
      segmentCount += 1;
      includeNextUri = released || segmentCount <= initialSegments;
      if (includeNextUri) lines.push(line);
      continue;
    }
    if (line && !line.startsWith('#')) {
      if (includeNextUri) {
        lines.push(`/api/audio-hls-segment/fixture-session/${line}`);
      }
      includeNextUri = false;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      lines.push(line.replace(
        'URI="init.mp4"',
        'URI="/api/audio-hls-segment/fixture-session/init.mp4"'
      ));
      continue;
    }
    lines.push(line);
  }
  return lines.join('\n').replace(
    /(#EXT-X-PLAYLIST-TYPE:EVENT\n)/,
    '$1#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n'
  );
}

async function startFixtureServer(audioFixtures) {
  const publicRoot = path.join(__dirname, '..', 'public');
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };
  const state = {
    requests: [],
    pendingAudio: [],
    starvationReleased: false,
    starvationScheduledAt: null,
    starvationReleasedAt: null,
    hlsFirstRequestAt: null
  };
  const book = {
    id: 'lockscreen',
    title: 'Mobile Continuity Fixture',
    author: 'Xandrio Benchmark',
    description: 'Real MP3 mobile playback continuity fixture.',
    language: 'en',
    chapterCount: 2,
    chapterDurations: [CHAPTER_SECONDS, CHAPTER_SECONDS],
    totalDuration: CHAPTER_SECONDS * 2
  };
  const chapters = [
    {
      title: 'Chapter One',
      type: 'chapter',
      estimatedDuration: CHAPTER_SECONDS,
      text: 'First chapter continuity benchmark.'
    },
    {
      title: 'Chapter Two',
      type: 'chapter',
      estimatedDuration: CHAPTER_SECONDS,
      text: 'Second chapter continuity benchmark.'
    }
  ];

  function holdRemainder(res, remainder) {
    if (state.starvationReleased) {
      res.end(remainder);
      return;
    }
    state.pendingAudio.push({ res, remainder });
  }

  function releasePreparedRunway() {
    state.starvationReleased = true;
    const pending = state.pendingAudio.splice(0);
    for (const { res, remainder } of pending) {
      if (!res.destroyed) res.end(remainder);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    const pathname = url.pathname;
    state.requests.push({
      method: req.method,
      pathname,
      search: url.search,
      range: req.headers.range || null,
      fetchDest: req.headers['sec-fetch-dest'] || null,
      atMs: performance.now()
    });

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
    if (pathname === '/api/engines/status') {
      return jsonResponse(res, { engines: { edge: { up: true } } });
    }
    if (pathname.startsWith('/api/voice-cache/')) return jsonResponse(res, { voices: [] });
    if (pathname.startsWith('/api/premium-prep/')) return jsonResponse(res, {}, 404);
    if (pathname === '/api/pronunciations') return jsonResponse(res, { book: [], global: [] });
    if (/^\/api\/chunks\/lockscreen\/[01]\/prepare-chapter-audio$/.test(pathname)) {
      // A ready runway means both selected-tier chapters are already complete;
      // the media fixture must not reintroduce the server starvation this
      // contract is designed to prevent.
      releasePreparedRunway();
      return jsonResponse(res, {
        ready: true,
        status: 'ready',
        runwayPolicy: 'buffer-current-lookahead-next-playable'
      });
    }
    if (/^\/api\/chunks\/lockscreen\/[01]\/chapter-audio-status$/.test(pathname)) {
      return jsonResponse(res, { ready: true, status: 'ready' });
    }
    if (pathname.startsWith('/api/audio-timeline/')) {
      return jsonResponse(res, {
        sessionId: pathname.split('/').at(-1),
        bookId: 'lockscreen',
        startChapterIndex: 0,
        startOffsetSeconds: 0,
        durations: [CHAPTER_SECONDS, CHAPTER_SECONDS],
        complete: true
      });
    }

    if (pathname === '/api/audio-hls/lockscreen/0/index.m3u8') {
      if (FORCE_LEGACY) return jsonResponse(res, {}, 404);
      state.hlsFirstRequestAt ??= performance.now();
      const hlsElapsedMs = performance.now() - state.hlsFirstRequestAt;
      const exposedSegments = state.starvationReleased
        ? Number.MAX_SAFE_INTEGER
        : Math.min(8, 2 + Math.floor(hlsElapsedMs / 250));
      const playlist = Buffer.from(exposedHlsPlaylist(
        audioFixtures.hlsPlaylist,
        state.starvationReleased,
        exposedSegments
      ));
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': playlist.length,
        'Cache-Control': 'no-store'
      });
      return res.end(playlist);
    }
    const hlsSegmentMatch = pathname.match(
      /^\/api\/audio-hls-segment\/fixture-session\/(init\.mp4|segment-\d{6}\.m4s)$/
    );
    if (hlsSegmentMatch) {
      const body = audioFixtures.hlsFiles.get(hlsSegmentMatch[1]);
      if (!body) return jsonResponse(res, {}, 404);
      return finiteResponse(req, res, body, 'audio/mp4');
    }

    const continuousMatch = pathname.match(/^\/api\/audio-continuous\/lockscreen\/([01])$/);
    if (continuousMatch) {
      if (FORCE_LEGACY) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      const startChapter = Number(continuousMatch[1]);
      const startRatio = startChapter / 2;
      const payload = audioFixtures.continuous.subarray(
        Math.floor(audioFixtures.continuous.length * startRatio)
      );
      // Retain the split-response path so the fixture still exercises streaming.
      // A successful runway preflight releases both halves before media opens.
      const runwayRatio = startChapter === 0 ? 0.375 : 0.5;
      const splitAt = Math.max(1024, Math.floor(payload.length * runwayRatio));
      writeAudioHeaders(res);
      res.write(payload.subarray(0, splitAt));
      holdRemainder(res, payload.subarray(splitAt));
      return;
    }

    const streamMatch = pathname.match(/^\/api\/audio-stream\/lockscreen\/([01])$/);
    if (streamMatch) {
      const chapterIndex = Number(streamMatch[1]);
      const [first, second] = audioFixtures.chapters[chapterIndex];
      writeAudioHeaders(res);
      // The legacy response is complete so its failure is specifically the
      // invalid raw concat plus per-chapter source reset, not fixture loading.
      return res.end(Buffer.concat([first, second]));
    }

    const fallbackMatch = pathname.match(/^\/api\/(?:audio|audio-ios)\/lockscreen\/([01])$/);
    if (fallbackMatch) {
      const chapterIndex = Number(fallbackMatch[1]);
      const payload = Buffer.concat(audioFixtures.chapters[chapterIndex]);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store'
      });
      return res.end(payload);
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
      const body = await fsp.readFile(filePath);
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
    releaseStarvationAfter(delayMs) {
      if (state.starvationReleased) return;
      state.starvationScheduledAt = performance.now();
      setTimeout(() => {
        if (state.starvationReleased) return;
        state.starvationReleasedAt = performance.now();
        releasePreparedRunway();
      }, delayMs);
    },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function webkitCapability() {
  const executablePath = webkit.executablePath();
  const exists = fs.existsSync(executablePath);
  if (!exists) {
    return {
      available: false,
      executablePath,
      reason: 'Playwright WebKit executable is not installed; no iOS result is claimed.'
    };
  }
  try {
    const browser = await webkit.launch({ headless: true });
    await browser.close();
    return {
      available: true,
      executablePath,
      note: 'Desktop Playwright WebKit is only an iOS-like engine check, not a physical iOS PWA lock-screen result.'
    };
  } catch (error) {
    return {
      available: false,
      executablePath,
      reason: `Playwright WebKit could not launch: ${error.message}`
    };
  }
}

async function installEventLedger(page) {
  await page.addInitScript(eventNames => {
    window.__mobilePlaybackLedger = [];
    window.__mediaPlayCalls = [];
    window.__pushPlaybackEvent = entry => {
      window.__mobilePlaybackLedger.push({ atMs: performance.now(), ...entry });
    };
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function benchmarkedPlay() {
      window.__mediaPlayCalls.push({
        atMs: performance.now(),
        src: this.currentSrc || this.getAttribute('src') || ''
      });
      return nativePlay.apply(this, arguments);
    };
    for (const eventName of eventNames) {
      document.addEventListener(eventName, event => {
        const media = event.target;
        if (!(media instanceof HTMLMediaElement) || media.id !== 'audio-player') return;
        window.__pushPlaybackEvent({
          type: eventName,
          src: media.getAttribute('src') || '',
          currentSrc: media.currentSrc || '',
          currentTime: Number(media.currentTime) || 0,
          duration: Number.isFinite(media.duration) ? media.duration : null,
          paused: media.paused,
          ended: media.ended,
          readyState: media.readyState,
          networkState: media.networkState,
          mediaError: media.error?.code || null
        });
      }, true);
    }
    document.addEventListener('visibilitychange', () => {
      window.__pushPlaybackEvent({
        type: 'visibilitychange',
        visibilityState: document.visibilityState
      });
    });
    window.addEventListener('pagehide', event => {
      window.__pushPlaybackEvent({ type: 'pagehide', persisted: event.persisted });
    });
    window.addEventListener('pageshow', event => {
      window.__pushPlaybackEvent({ type: 'pageshow', persisted: event.persisted });
    });
  }, MEDIA_EVENTS);
}

function longestTimelineStall(samples) {
  if (samples.length < 2) return 0;
  let lastAdvanceAt = samples[0].wallMs;
  let lastTime = samples[0].currentTime;
  let priorWallMs = samples[0].wallMs;
  let maxStallMs = 0;
  for (const sample of samples.slice(1)) {
    // Sampling itself is page-JS work. A deliberate main-thread block creates
    // a long observation gap even though native media advances normally; do
    // not misclassify that unsampled period as an audio stall.
    if (sample.wallMs - priorWallMs > SAMPLE_INTERVAL_MS * 2.5) {
      lastAdvanceAt = sample.wallMs;
      lastTime = sample.currentTime;
      priorWallMs = sample.wallMs;
      continue;
    }
    if (sample.currentTime > lastTime + 0.015) {
      maxStallMs = Math.max(maxStallMs, sample.wallMs - lastAdvanceAt);
      lastAdvanceAt = sample.wallMs;
      lastTime = sample.currentTime;
    }
    priorWallMs = sample.wallMs;
  }
  maxStallMs = Math.max(maxStallMs, samples.at(-1).wallMs - lastAdvanceAt);
  return maxStallMs;
}

function longestWaitingEventStall(events) {
  let maxStallMs = 0;
  for (let index = 0; index < events.length; index++) {
    if (events[index].type !== 'waiting') continue;
    const resumed = events.slice(index + 1).find(event => (
      event.type === 'playing' || event.type === 'error' || event.type === 'ended'
    ));
    if (resumed) maxStallMs = Math.max(maxStallMs, resumed.atMs - events[index].atMs);
  }
  return maxStallMs;
}

function unique(values) {
  return [...new Set(values)];
}

async function benchmarkBrowser(fixture, transportValidation, profileConfig) {
  const browser = await profileConfig.browserType.launch({ headless: true });
  const context = await browser.newContext({
    ...devices[profileConfig.device],
    serviceWorkers: 'allow'
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await installEventLedger(page);

  try {
    await page.goto(`${fixture.origin}/#/player/lockscreen`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#player-view.active');
    await page.waitForFunction(() => typeof window.xandrioPlaybackReport === 'function');
    await page.waitForFunction(() => (
      document.getElementById('audio-loading')?.style.display === 'none' &&
      window.xandrioPlaybackReport().backend === 'audio-stream'
    ), null, { timeout: 20000 });

    let serviceWorkerReady = false;
    try {
      await page.evaluate(() => navigator.serviceWorker?.ready);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 10000 });
      serviceWorkerReady = true;
    } catch {
      serviceWorkerReady = false;
    }

    const before = await page.evaluate(() => ({
      report: window.xandrioPlaybackReport(),
      source: document.getElementById('audio-player')?.getAttribute('src') || '',
      audioElements: document.querySelectorAll('audio').length,
      serviceWorkerSupported: 'serviceWorker' in navigator,
      serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller)
    }));

    await page.evaluate(() => { window.__trustedClickAt = performance.now(); });
    await page.click('#play-pause-btn');
    await page.waitForFunction(() => {
      const audio = document.getElementById('audio-player');
      return audio && !audio.paused && audio.currentTime > 0.05;
    }, null, { timeout: 10000 });
    const firstSoundMs = await page.evaluate(() => performance.now() - window.__trustedClickAt);

    fixture.releaseStarvationAfter(profileConfig.releaseAfterPlayMs || RELEASE_AFTER_PLAY_MS);
    await page.evaluate(({ startMs, durationMs }) => {
      setTimeout(() => {
        window.__pushPlaybackEvent({ type: 'js-block-start' });
        const blockedUntil = performance.now() + durationMs;
        while (performance.now() < blockedUntil) {
          // Deliberately block page JS while native media should continue.
        }
        window.__pushPlaybackEvent({ type: 'js-block-end' });
      }, startMs);
    }, { startMs: JS_BLOCK_START_MS, durationMs: JS_BLOCK_DURATION_MS });

    const samples = [];
    const sampleStart = performance.now();
    while (performance.now() - sampleStart < SAMPLE_DURATION_MS) {
      await new Promise(resolve => setTimeout(resolve, SAMPLE_INTERVAL_MS));
      samples.push(await page.evaluate(wallMs => {
        const audio = document.getElementById('audio-player');
        const report = window.xandrioPlaybackReport();
        return {
          wallMs,
          currentTime: Number(audio.currentTime) || 0,
          paused: audio.paused,
          readyState: audio.readyState,
          chapter: report.currentChapter,
          source: audio.getAttribute('src') || ''
        };
      }, performance.now() - sampleStart));
    }

    const after = await page.evaluate(() => {
      const audio = document.getElementById('audio-player');
      return {
        report: window.xandrioPlaybackReport(),
        currentTime: Number(audio.currentTime) || 0,
        paused: audio.paused,
        ended: audio.ended,
        source: audio.getAttribute('src') || '',
        audioElements: document.querySelectorAll('audio').length,
        ledger: window.__mobilePlaybackLedger,
        playCalls: window.__mediaPlayCalls,
        serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller)
      };
    });

    const firstPlaying = after.ledger.find(event => event.type === 'playing');
    const playbackEvents = firstPlaying
      ? after.ledger.filter(event => event.atMs >= firstPlaying.atMs)
      : after.ledger;
    const loadSources = unique(
      after.ledger
        .filter(event => event.type === 'loadstart')
        .map(event => event.src)
        .filter(Boolean)
    );
    const postStartResetEvents = playbackEvents.filter(event => (
      event.type === 'pause' || event.type === 'emptied' || event.type === 'abort'
    ));
    const mediaErrors = playbackEvents.filter(event => event.type === 'error');
    const allContinuousRequests = fixture.state.requests.filter(request => (
      request.pathname.startsWith('/api/audio-continuous/')
    ));
    const hlsPlaylistRequests = fixture.state.requests.filter(request => (
      request.pathname.startsWith('/api/audio-hls/')
    ));
    const hlsSegmentRequests = fixture.state.requests.filter(request => (
      request.pathname.startsWith('/api/audio-hls-segment/')
    ));
    // WebKit performs a two-byte metadata probe before its one payload
    // request. It is not a source replacement or a second playback stream.
    const continuousMetadataProbes = allContinuousRequests.filter(request => request.range === 'bytes=0-1');
    const continuousRequests = allContinuousRequests.filter(request => request.range !== 'bytes=0-1');
    const legacyStreamRequests = fixture.state.requests.filter(request => (
      request.pathname.startsWith('/api/audio-stream/')
    ));
    const activeIsHls = after.source.includes('/api/audio-hls/');
    const activeIsContinuous = activeIsHls || after.source.includes('/api/audio-continuous/');
    const activeValidation = activeIsHls
      ? transportValidation.hls
      : (activeIsContinuous ? transportValidation.continuous : transportValidation.legacyRawConcat);
    const sampledStallMs = longestTimelineStall(samples);
    const eventStallMs = longestWaitingEventStall(playbackEvents);
    const maxStallMs = Math.max(sampledStallMs, eventStallMs);
    const boundaryIndex = samples.findIndex(sample => sample.chapter >= 1);
    const boundarySamples = boundaryIndex === -1
      ? []
      : samples.slice(Math.max(0, boundaryIndex - 10), boundaryIndex + 11);
    const boundaryStallMs = longestTimelineStall(boundarySamples);
    const advanceSeconds = samples.length
      ? samples.at(-1).currentTime - samples[0].currentTime
      : 0;
    const failures = [];

    if (before.audioElements !== 1 || after.audioElements !== 1) {
      failures.push(`expected one persistent audio element, saw ${before.audioElements} then ${after.audioElements}`);
    }
    if (before.serviceWorkerSupported && (!serviceWorkerReady || !after.serviceWorkerControlled)) {
      failures.push('service worker was not active and controlling the benchmark page');
    }
    if (!activeIsContinuous) {
      failures.push(`active source is not a continuous transport: ${after.source}`);
    }
    if (!activeIsHls && continuousRequests.length !== 1) {
      failures.push(`expected one continuous request, saw ${continuousRequests.length}`);
    }
    if (activeIsHls && hlsPlaylistRequests.length < 1) {
      failures.push('native HLS playlist was not requested');
    }
    if (legacyStreamRequests.length !== 0) {
      failures.push(`legacy per-chapter stream was requested ${legacyStreamRequests.length} time(s)`);
    }
    if (loadSources.length !== 1) {
      failures.push(`expected one media source/loadstart, saw ${loadSources.length}: ${loadSources.join(', ')}`);
    }
    if (postStartResetEvents.length !== 0) {
      failures.push(`media reset after playback began: ${postStartResetEvents.map(event => event.type).join(', ')}`);
    }
    if (after.playCalls.length !== 1) {
      failures.push(`expected one trusted play() call, saw ${after.playCalls.length}`);
    }
    if (after.paused || after.ended) failures.push('playback did not remain active');
    if (after.report.currentChapter < 1) {
      failures.push(`logical chapter boundary was not crossed: chapter ${after.report.currentChapter}`);
    }
    if (!activeValidation.valid) {
      failures.push(`active MP3 transport failed ffmpeg -xerror validation (exit ${activeValidation.exitCode})`);
    }
    if (firstSoundMs > MAX_FIRST_SOUND_MS) {
      failures.push(`first sound took ${firstSoundMs.toFixed(0)}ms`);
    }
    if (maxStallMs > MAX_STALL_MS) {
      failures.push(`maximum playback stall was ${maxStallMs.toFixed(0)}ms`);
    }
    if (boundaryStallMs > MAX_BOUNDARY_STALL_MS) {
      failures.push(`chapter-boundary stall was ${boundaryStallMs.toFixed(0)}ms`);
    }
    if (advanceSeconds < MIN_ADVANCE_SECONDS) {
      failures.push(`audio advanced only ${advanceSeconds.toFixed(2)}s`);
    }
    if (mediaErrors.length) failures.push(`media emitted ${mediaErrors.length} error event(s)`);
    if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);

    return {
      passed: failures.length === 0,
      failures,
      profile: {
        engine: profileConfig.engine,
        device: profileConfig.device,
        approximation: profileConfig.approximation,
        userAgent: await page.evaluate(() => navigator.userAgent),
        platform: await page.evaluate(() => navigator.platform),
        appDetectedIOSLike: after.report.isIOSLike,
        serviceWorkerSupported: before.serviceWorkerSupported,
        serviceWorkerControlled: after.serviceWorkerControlled
      },
      thresholds: {
        maxFirstSoundMs: MAX_FIRST_SOUND_MS,
        maxStallMs: MAX_STALL_MS,
        maxBoundaryStallMs: MAX_BOUNDARY_STALL_MS,
        minAdvanceSeconds: MIN_ADVANCE_SECONDS
      },
      result: {
        firstSoundMs: Number(firstSoundMs.toFixed(1)),
        maxStallMs: Number(maxStallMs.toFixed(1)),
        boundaryStallMs: Number(boundaryStallMs.toFixed(1)),
        sampledStallMs: Number(sampledStallMs.toFixed(1)),
        eventStallMs: Number(eventStallMs.toFixed(1)),
        advanceSeconds: Number(advanceSeconds.toFixed(2)),
        currentChapter: after.report.currentChapter,
        activeSource: after.source,
        activeTransportValid: activeValidation.valid,
        mediaElements: after.audioElements,
        playCalls: after.playCalls.length,
        loadstartSources: loadSources,
        continuousRequests: continuousRequests.length,
        hlsPlaylistRequests: hlsPlaylistRequests.length,
        hlsSegmentRequests: hlsSegmentRequests.length,
        continuousMetadataProbes: continuousMetadataProbes.length,
        continuousRequestDetails: allContinuousRequests.map(request => ({
          range: request.range,
          fetchDest: request.fetchDest,
          atMs: Number(request.atMs.toFixed(1))
        })),
        legacyStreamRequests: legacyStreamRequests.length,
        postStartResetEvents: postStartResetEvents.map(event => event.type),
        waitingEvents: playbackEvents.filter(event => event.type === 'waiting').length,
        stalledEvents: playbackEvents.filter(event => event.type === 'stalled').length,
        mediaErrors: mediaErrors.length,
        starvationDelayMs: fixture.state.starvationReleasedAt && fixture.state.starvationScheduledAt
          ? Number((fixture.state.starvationReleasedAt - fixture.state.starvationScheduledAt).toFixed(1))
          : null,
        starvationMode: 'selected-tier current-plus-next runway prepared before media open',
        jsBlockMs: JS_BLOCK_DURATION_MS
      },
      diagnostics: {
        pageErrors,
        consoleErrors,
        eventSequence: playbackEvents.map(event => event.type),
        relevantEvents: playbackEvents.filter(event => (
          event.type === 'pause' ||
          event.type === 'emptied' ||
          event.type === 'abort' ||
          event.type === 'error' ||
          event.type === 'waiting' ||
          event.type === 'playing' ||
          event.type === 'js-block-start' ||
          event.type === 'js-block-end'
        )),
        ledger: VERBOSE_LEDGER ? after.ledger : undefined
      }
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const webkitStatus = await webkitCapability();
  const audioFixtures = await buildAudioFixtures();

  async function runProfile(profileConfig) {
    const fixture = await startFixtureServer(audioFixtures);
    try {
      return await benchmarkBrowser(fixture, audioFixtures.validation, profileConfig);
    } finally {
      await fixture.close().catch(() => {});
    }
  }

  try {
    const android = await runProfile({
      browserType: chromium,
      engine: 'Chromium desktop engine with Android emulation',
      device: 'Pixel 7',
      approximation: 'Android viewport, input, and user agent; not a physical installed Android PWA or OS lock screen.'
    });
    const iosLike = webkitStatus.available
      ? await runProfile({
          browserType: webkit,
          engine: 'Playwright desktop WebKit with iPhone emulation',
          device: 'iPhone 15',
          approximation: 'WebKit viewport, input, and user agent; not MobileSafari on a physical iPhone or an iOS lock screen.',
          releaseAfterPlayMs: 5200
        })
      : webkitStatus;
    const report = {
      benchmark: 'mobile-pwa-real-media-continuity',
      fixtureMode: FORCE_LEGACY ? 'forced-legacy-red-check' : 'continuous-target',
      transportValidation: audioFixtures.validation,
      browsers: {
        androidChromium: android,
        iosLikeWebKit: iosLike
      },
      passed: android.passed && (webkitStatus.available ? iosLike.passed : true)
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    await audioFixtures.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  benchmarkBrowser,
  buildAudioFixtures,
  startFixtureServer,
  validateMp3
};
