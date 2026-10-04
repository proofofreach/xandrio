// Failure modes stated before the fix: a stalled timeline request overlaps every
// poll and survives source teardown; a stalled diagnostic stream probe leaves a
// completed media-load failure pending forever. Both requests must release on
// timeout or cancellation, while a healthy timeline response still updates.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { chromium, webkit } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playback-reliability/player-audit');
const browserName = process.env.PLAYER_AUDIT_BROWSER || 'chromium';
const browserType = { chromium, webkit }[browserName];
assert(browserType, 'PLAYER_AUDIT_BROWSER must be chromium or webkit');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  await fs.mkdir(output, { recursive: true });
  const requests = { timeline: 0, timelineActive: 0, timelineMaxActive: 0,
    timelineClosed: 0, probe: 0, probeActive: 0, probeClosed: 0 };
  const results = [];
  const app = express();
  app.get('/fixture', (_req, res) => res.type('html').send(
    '<!doctype html><audio></audio><script src="/js/lifecycle.js"></script>' +
    '<script type="module">import { SingleFileChapterPlayer } from "/js/single-file-chapter-player.js";' +
    'window.Player = SingleFileChapterPlayer;</script>'
  ));
  app.get('/api/audio-timeline/:session', (req, res) => {
    requests.timeline += 1;
    requests.timelineActive += 1;
    requests.timelineMaxActive = Math.max(requests.timelineMaxActive, requests.timelineActive);
    res.on('close', () => { requests.timelineActive -= 1; requests.timelineClosed += 1; });
    if (req.params.session === 'healthy') {
      res.json({ startChapterIndex: 0, startOffsetSeconds: 0, durations: [42] });
    }
  });
  app.get('/api/audio-continuous/:book/:chapter', (req, res) => {
    requests.probe += 1;
    requests.probeActive += 1;
    res.on('close', () => { requests.probeActive -= 1; requests.probeClosed += 1; });
  });
  app.get('/api/audio/:book/:chapter', (_req, res) => res.sendStatus(404));
  app.use(express.static(path.join(root, 'public')));
  let server, browser, context;
  try {
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    browser = await browserType.launch();
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.waitForFunction(() => window.Player);

    await page.evaluate(() => {
      const clock = {
        setInterval: callback => setInterval(callback, 30),
        clearInterval: id => clearInterval(id)
      };
      window.timelinePlayer = new Player(document.querySelector('audio'), {
        clock, getChapterCount: () => 1, timelineRequestTimeoutMs: 100
      });
      window.timelinePlayer.bookId = 'fixture';
      window.timelinePlayer.chapterIndex = 0;
      window.timelinePlayer.startChapterIndex = 0;
      window.timelinePlayer.isContinuous = true;
      window.timelinePlayer.playbackSessionId = 'stalled';
      window.timelinePlayer._attach();
      window.timelinePlayer._startTimelinePolling();
    });
    await sleep(260);
    const beforeDetach = { ...requests };
    await page.evaluate(() => window.timelinePlayer._detach());
    await sleep(100);
    const afterDetach = { ...requests };
    results.push({ name: 'timeline request single-flight and cancellation',
      beforeDetach, afterDetach,
      passed: beforeDetach.timelineMaxActive === 1 && beforeDetach.timeline >= 2
        && afterDetach.timelineActive === 0 && afterDetach.timelineClosed >= 2 });

    const healthy = await page.evaluate(async () => {
      const player = new Player(document.querySelector('audio'), {
        getChapterCount: () => 1, timelineRequestTimeoutMs: 100
      });
      player.bookId = 'fixture'; player.chapterIndex = 0;
      player.startChapterIndex = 0; player.isContinuous = true;
      player.playbackSessionId = 'healthy';
      player._attach(); player._startTimelinePolling();
      await new Promise(resolve => setTimeout(resolve, 80));
      const duration = player._timelineDurations.get(0);
      player._detach();
      return duration;
    });
    results.push({ name: 'healthy timeline still updates', duration: healthy, passed: healthy === 42 });

    const probe = await page.evaluate(async () => {
      const player = new Player(document.querySelector('audio'), {
        getChapterCount: () => 1, preparePlaybackRunway: false,
        loadTimeoutMs: 80, loadFailureProbeTimeoutMs: 100
      });
      const began = performance.now();
      const work = player.loadChapter('probe-stall', 0).then(
        () => ({ loaded: true }), error => ({ loaded: false, error: error.message })
      );
      const result = await Promise.race([
        work,
        new Promise(resolve => setTimeout(() => resolve({ hung: true }), 700))
      ]);
      const evidence = { ...result, elapsedMs: performance.now() - began, loading: player._isLoading };
      player.dispose();
      return evidence;
    });
    await sleep(50);
    results.push({ name: 'diagnostic stream probe cannot hang load failure', probe,
      requests: { ...requests },
      passed: probe.loaded === false && !probe.hung && probe.loading === false
        && requests.probeActive === 0 });

    const cancelledProbe = await page.evaluate(async () => {
      const player = new Player(document.querySelector('audio'), {
        loadFailureProbeTimeoutMs: 500
      });
      const began = performance.now();
      const work = player._classifyLoadFailure(new Error('media error'), [{
        url: '/api/audio-continuous/probe-cancel/0', continuous: true
      }]);
      setTimeout(() => player.cancelPendingLoad(), 30);
      await work;
      return { elapsedMs: performance.now() - began };
    });
    await sleep(50);
    results.push({ name: 'source cancellation closes diagnostic probe',
      cancelledProbe, requests: { ...requests },
      passed: cancelledProbe.elapsedMs < 200 && requests.probeActive === 0 });

    const artifact = { browser: browserName, results, passed: results.every(result => result.passed) };
    await fs.writeFile(path.join(output, `${browserName}-request-bounds.json`), JSON.stringify(artifact, null, 2));
    await page.screenshot({ path: path.join(output, `${browserName}-request-bounds.png`) });
    await context.tracing.stop({ path: path.join(output, `${browserName}-request-bounds-trace.zip`) });
    for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${JSON.stringify(result)}`);
    assert(artifact.passed, `Request bounds failed; see ${output}`);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await new Promise(resolve => server?.close(resolve) || resolve());
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
