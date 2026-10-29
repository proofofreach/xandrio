'use strict';

// Drives the real chapter player in a browser and checks that its media events
// reach the real playback-health route and store as correct aggregates.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, webkit } = require('playwright');
const jsonStore = require('../lib/json-store');
const { createPlaybackHealthStore, registerPlaybackHealthRoutes } = require('../lib/playback-health');

const root = path.resolve(__dirname, '..');
const browserName = process.env.PLAYBACK_HEALTH_BROWSER || 'chromium';
assert(['chromium', 'webkit'].includes(browserName));

function wavTone(seconds, frequency = 440) {
  const rate = 24000;
  const samples = rate * seconds;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    bytes.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * frequency * index / rate)), 44 + index * 2);
  }
  return bytes;
}

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-playback-health-e2e-'));
  const file = path.join(temp, 'playback-health.json');
  const store = createPlaybackHealthStore({ file, jsonStore });
  const tone = wavTone(20);
  const reports = [];
  let server;
  let browser;
  let passed = 0;
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/playback-health', (req, _res, next) => { reports.push(req.body); next(); });
    registerPlaybackHealthRoutes(app, { store });
    app.get('/api/audio/:bookId/:chapter', async (_req, res) => {
      // A slow first response stands in for a cold start.
      await new Promise(resolve => setTimeout(resolve, 600));
      res.type('audio/wav').send(tone);
    });
    app.get('/health-fixture', (_req, res) => res.type('html').send(`<!doctype html><html><body>
      <audio></audio>
      <script src="/js/lifecycle.js"></script>
      <script type="module">
        import { SingleFileChapterPlayer } from '/js/single-file-chapter-player.js';
        import { createPlaybackHealth, sendPlaybackHealthReport } from '/js/playback-health.mjs';
        window.health = createPlaybackHealth({
          platform: 'desktop',
          send: report => sendPlaybackHealthReport(report)
        });
        window.player = new SingleFileChapterPlayer(document.querySelector('audio'), {
          preferStandardAudio: true,
          resolveOfflineAudioUrl: (bookId, chapterIndex) => '/api/audio/' + bookId + '/' + chapterIndex,
          isIOSLike: () => false,
          getChapterCount: () => 1,
          getEstimatedDuration: () => 20,
          onDiagnosticEvent: event => window.health.observe(event)
        });
        window.ready = true;
      </script></body></html>`));
    app.use(express.static(path.join(root, 'public')));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;

    browser = await ({ chromium, webkit }[browserName]).launch(
      browserName === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {}
    );
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(`${origin}/health-fixture`);
    await page.waitForFunction(() => window.ready === true);

    // Same order as the app: intent first, then load and play.
    await page.evaluate(async () => {
      window.health.observe({ type: 'play-intent' });
      await window.player.loadChapter('book_e2e', 0);
      await window.player.play();
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      window.health.observe({ type: 'pause-intent' });
      window.player.pause();
      window.health.flush();
    });
    for (let attempt = 0; attempt < 40 && reports.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    assert.equal(reports.length, 1, 'one report reached the server');
    const [report] = reports;
    assert.equal(report.startupMs.length, 1, 'one startup was measured');
    assert(report.startupMs[0] >= 600, `startup includes the slow source (${report.startupMs[0]}ms)`);
    assert(report.startupMs[0] < 5000, `startup is bounded (${report.startupMs[0]}ms)`);
    assert.equal(report.backend, 'single-file');
    assert(report.listenedSeconds >= 2 && report.listenedSeconds <= 3, `listened ${report.listenedSeconds}s`);
    assert.equal(report.stalls, 0);
    passed++;
    console.log(`PASS real media events produce a startup of ${report.startupMs[0]}ms and ${report.listenedSeconds}s listened`);

    // The request is observed before the store write finishes.
    let summary = await store.summarize({ days: 1 });
    for (let attempt = 0; attempt < 40 && !summary.platforms.desktop; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      summary = await store.summarize({ days: 1 });
    }
    assert.equal(summary.platforms.desktop.reports, 1);
    assert.equal(summary.platforms.desktop.startupMs.buckets.reduce((a, b) => a + b, 0), 1);
    const stored = await fs.readFile(file, 'utf8');
    assert(!stored.includes('book_e2e'), 'the stored aggregate has no book identifier');
    passed++;
    console.log('PASS the server stores only the aggregate');
    const abandonment = await page.evaluate(async () => {
      const { createPlaybackHealth } = await import('/js/playback-health.mjs');
      let time = 0;
      const health = createPlaybackHealth({ now: () => time });
      health.observe({ type: 'play-intent' });
      time = 10000;
      health.observe({ type: 'visibilitychange', visibility: 'hidden' });
      const background = health.flush();
      time = 15000;
      health.observe({ type: 'pagehide' });
      return { background, exit: health.flush(), repeated: health.flush() };
    });
    assert.equal(abandonment.background, null, 'backgrounding preserves a pending startup');
    assert.deepEqual(abandonment.exit?.abandonedStartMs, [15000], 'page exit records the entire pending wait');
    assert.equal(abandonment.repeated, null, 'page exit reports abandonment once');
    passed++;
    console.log('PASS page exit records abandoned startup while backgrounding preserves it');
    console.log(`\n${passed} passed, 0 failed`);
  } catch (error) {
    console.error(error);
    console.log(`\n${passed} passed, 1 failed`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await new Promise(resolve => server ? server.close(resolve) : resolve());
    await fs.rm(temp, { recursive: true, force: true });
  }
})();
