'use strict';

// Failure hypotheses recorded before implementation:
// 1. Rewinding a playing source leaves the stall sample ahead of advancing audio,
//    so the watchdog reports a false stall before playback reaches that sample.
// 2. A native play deadline rejects without cancelling the element's pending play,
//    allowing a delayed response to resume audio after failure was reported.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playback-interruption/native');
const browserName = process.env.NATIVE_INTERRUPTION_BROWSER || 'chromium';
const phase = process.env.NATIVE_INTERRUPTION_PHASE || 'verified';
function wav(seconds) {
  const samples = 24000 * seconds;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(i * 2 * Math.PI * 440 / 24000)), 44 + i * 2);
  return bytes;
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const app = express();
  app.use(rateLimit({ windowMs: 60000, limit: 1000 }));
  const audioBytes = wav(30);
  const held = new Set();
  const wavPath = path.join(output, 'fixture.wav');
  await fs.writeFile(wavPath, audioBytes);
  const mp3Path = path.join(output, 'fixture.mp3');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '64k', mp3Path]);
  const delayedBytes = await fs.readFile(mp3Path);
  const initialLimit = Math.floor(delayedBytes.length / 3);
  app.get('/fixture', (_req, res) => res.type('html').send('<!doctype html><title>Native interruption verification</title><h1>Native interruption verification</h1><audio controls></audio><pre id="result"></pre><script src="/js/lifecycle.js"></script><script type="module">import {SingleFileChapterPlayer} from "/js/single-file-chapter-player.js"; window.Player=SingleFileChapterPlayer;</script>'));
  app.get('/api/audio/:book/:chapter', (req, res) => {
    if (req.params.book !== 'delayed') return res.sendFile(wavPath);
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = Number(range?.[1]) || 0;
    const end = range?.[2] ? Math.min(Number(range[2]), delayedBytes.length - 1) : delayedBytes.length - 1;
    res.status(req.headers.range ? 206 : 200).type('audio/mpeg')
      .set('Accept-Ranges', 'bytes').set('Content-Length', String(end - start + 1));
    if (req.headers.range) res.set('Content-Range', `bytes ${start}-${end}/${delayedBytes.length}`);
    if (end < initialLimit) return res.end(delayedBytes.subarray(start, end + 1));
    const initialEnd = Math.max(start, initialLimit);
    if (start < initialEnd) res.write(delayedBytes.subarray(start, initialEnd));
    else res.flushHeaders();
    const release = () => res.end(delayedBytes.subarray(initialEnd, end + 1));
    held.add(release);
    res.on('close', () => held.delete(release));
  });
  app.use(express.static(path.join(root, 'public')));
  let server, browser, context;
  const results = [];
  try {
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    browser = await ({ chromium, webkit }[browserName]).launch();
    context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    async function check(name, run) {
      const page = await context.newPage();
      const diagnostics = [];
      page.on('pageerror', error => diagnostics.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
      await page.waitForFunction(() => window.Player);
      await page.evaluate(() => {
        window.audio = document.querySelector('audio'); window.errors = []; window.events = [];
        window.player = new Player(audio, {
          preferStandardAudio: true, loadTimeoutMs: 4000, playTimeoutMs: 500,
          playProgressTimeoutMs: 800, stallTimeoutMs: 600, stallProbeIntervalMs: 50,
          getChapterCount: () => 1,
          onError: error => errors.push({ code: error.code, time: audio.currentTime }),
          onPlaybackChange: (playing, detail) => events.push({ playing, reason: detail?.reason, code: detail?.error?.code }),
        });
      });
      try { const evidence = await run(page); results.push({ name, ...evidence, diagnostics }); }
      catch (error) { results.push({ name, passed: false, error: error.stack, diagnostics }); }
      await page.evaluate(result => { document.querySelector('#result').textContent = JSON.stringify(result, null, 2); }, results.at(-1));
      await page.screenshot({ path: path.join(output, `${browserName}-${phase}-${results.length}.png`) });
      await page.close();
    }
    for (const rate of [1, 0.5]) {
      await check(`${rate}x ${rate === 1 ? 'seek' : 'backward skip'} does not report a stall while native audio advances`, async page => {
        await page.evaluate(async rate => { player.setSpeed(rate); await player.loadChapter('rewind', 0); audio.currentTime = 10; await player.play(); }, rate);
        await page.waitForFunction(() => player._stallMark?.currentTime > 10);
        const evidence = await page.evaluate(async rate => {
          const sample = { ...player._stallMark };
          if (rate === 1) await player.seek(1); else await player.skip(-9);
          const before = audio.currentTime;
          await new Promise(resolve => setTimeout(resolve, 1400));
          return { sample, rate, before, after: audio.currentTime, playing: player.isPlaying, errors };
        }, rate);
        return { evidence, passed: evidence.playing && evidence.after > evidence.before + 0.2 && evidence.errors.length === 0 };
      });
    }
    await check('timed-out native play cannot start after the response resumes', async page => {
      await page.evaluate(async () => { player.stallTimeoutMs = 3000; await player.loadChapter('delayed', 0); audio.currentTime = 15; window.playResult = player.play().then(() => ({ ok: true }), error => ({ ok: false, code: error.code })); });
      const failure = await page.evaluate(() => playResult);
      const atFailure = await page.evaluate(() => ({ paused: audio.paused, time: audio.currentTime, playing: player.isPlaying }));
      for (const release of held) release();
      held.clear();
      await page.waitForTimeout(1000);
      const after = await page.evaluate(() => ({ paused: audio.paused, time: audio.currentTime, playing: player.isPlaying, events, errors }));
      return { evidence: { failure, atFailure, after }, passed: !failure.ok && ['MEDIA_PLAY_TIMEOUT', 'MEDIA_PROGRESS_TIMEOUT'].includes(failure.code) && atFailure.paused && after.paused && !after.playing };
    });
    await check('a real transport stall still reports once after rewinding', async page => {
      await page.evaluate(async () => {
        player.playProgressTimeoutMs = 1500;
        await player.loadChapter('delayed', 0); await player.play();
        await player.seek(6);
      });
      await page.waitForFunction(() => player._stallMark?.currentTime > 6);
      await page.evaluate(async () => { await player.seek(1); });
      await page.waitForTimeout(250);
      await page.evaluate(async () => { await player.seek(9); });
      await page.waitForFunction(() => errors.some(error => error.code === 'MEDIA_STALLED'), null, { timeout: 6000 });
      await page.waitForTimeout(750);
      const evidence = await page.evaluate(() => ({ errors, time: audio.currentTime, bufferedEnd: audio.buffered.end(audio.buffered.length - 1), paused: audio.paused }));
      return { evidence, passed: evidence.errors.length === 1 && evidence.errors[0].code === 'MEDIA_STALLED' && !evidence.paused };
    });
    await context.tracing.stop({ path: path.join(output, `${browserName}-${phase}-trace.zip`) });
    const report = { browser: browserName, phase, passed: results.every(result => result.passed && result.diagnostics.length === 0), results };
    await fs.writeFile(path.join(output, `${browserName}-${phase}.json`), JSON.stringify(report, null, 2));
    for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${JSON.stringify(result.evidence || result.error)}`);
    assert(report.passed, `Native interruption verification failed; see ${output}`);
  } finally {
    for (const release of held) release();
    await context?.close(); await browser?.close();
    await new Promise(resolve => server?.close(resolve) || resolve());
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
