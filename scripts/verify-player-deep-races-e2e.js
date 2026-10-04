'use strict';

// Failure modes recorded before implementation:
// 1. Repeating play on already-playing native audio waits for an event that will
//    not repeat, then falsely reports stopped playback.
// 2. A rejected chapter-handoff play promise mutates a newer book's playback.
// 3. A late NotAllowedError after pause arms a recovery watchdog for cancelled
//    playback and reports a spurious error.
// 4. A book selected while waiting at a chapter boundary inherits autoplay and
//    starts before the caller requests playback.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/deep-reliability/player');
const browserName = process.env.DEEP_PLAYER_BROWSER || 'chromium';
const phase = process.env.DEEP_PLAYER_PHASE || 'verified';

function wav(seconds) {
  const samples = Math.floor(24000 * seconds);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(i * 2 * Math.PI * 440 / 24000)), 44 + 2 * i);
  return bytes;
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const app = express();
  const results = [];
  app.get('/fixture', (_req, res) => res.type('html').send('<!doctype html><audio controls></audio><script src="/js/lifecycle.js"></script><script type="module">import { SingleFileChapterPlayer } from "/js/single-file-chapter-player.js"; window.Player = SingleFileChapterPlayer;</script>'));
  app.get('/api/audio/:book/:chapter', (req, res) => res.type('audio/wav').send(wav(req.params.chapter === '0' && req.params.book === 'boundary' ? 1.5 : 8)));
  app.use(express.static(path.join(root, 'public')));
  let server, browser, context;
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
        window.events = []; window.errors = [];
        window.audio = document.querySelector('audio');
        window.player = new Player(audio, {
          preferStandardAudio: true, getChapterCount: () => 2,
          playTimeoutMs: 400, playProgressTimeoutMs: 1000,
          chapterAdvancePlayWatchdogMs: 160,
          resolveNextChapterUrl: (book, chapter) => `/api/audio/${book}/${chapter}`,
          onPlaybackChange: (playing, detail) => events.push({ playing, reason: detail?.reason }),
          onError: error => errors.push({ code: error.code, message: error.message })
        });
      });
      try { const evidence = await run(page); results.push({ name, ...evidence, diagnostics }); }
      catch (error) { results.push({ name, passed: false, error: error.stack, diagnostics }); }
      await page.screenshot({ path: path.join(output, `${browserName}-${phase}-${results.length}.png`) });
      await page.close();
    }
    await check('repeat native play remains successful and advancing', async page => {
      const evidence = await page.evaluate(async () => {
        await player.loadChapter('repeat', 0); await player.play();
        const before = audio.currentTime;
        const result = await player.play().then(() => ({ ok: true }), error => ({ ok: false, code: error.code }));
        return { ...result, before, after: audio.currentTime, playing: player.isPlaying, paused: audio.paused, events };
      });
      return { evidence, passed: evidence.ok && evidence.playing && evidence.after > evidence.before };
    });
    async function holdBoundaryPlay(page) {
      await page.evaluate(async () => {
        await player.loadChapter('boundary', 0); await player.play();
        const nativePlay = audio.play.bind(audio);
        audio.play = () => {
          const native = nativePlay(); native.catch(() => {});
          if (!audio.src.startsWith('blob:')) return native;
          return new Promise((resolve, reject) => { window.handoff = { resolve, reject }; });
        };
      });
      await page.waitForFunction(() => player._prewarm);
      await page.evaluate(() => { audio.currentTime = audio.duration - 0.15; });
      await page.waitForFunction(() => window.handoff && player.chapterIndex === 1 && audio.currentTime > 0.05);
    }
    await check('late rejected handoff cannot stop newer book', async page => {
      await holdBoundaryPlay(page);
      const evidence = await page.evaluate(async () => {
        await player.loadChapter('replacement', 0); await player.play();
        const eventCount = events.length;
        handoff.reject(new DOMException('superseded', 'AbortError'));
        await new Promise(resolve => setTimeout(resolve, 220));
        return { book: player.bookId, playing: player.isPlaying, paused: audio.paused, time: audio.currentTime, lateEvents: events.slice(eventCount), errors };
      });
      return { evidence, passed: evidence.playing && !evidence.paused && evidence.lateEvents.length === 0 && evidence.errors.length === 0 };
    });
    await check('late denied handoff remains cancelled after pause', async page => {
      await holdBoundaryPlay(page);
      const evidence = await page.evaluate(async () => {
        player.pause();
        await new Promise(resolve => setTimeout(resolve, 30));
        const eventCount = events.length;
        handoff.reject(new DOMException('background denied', 'NotAllowedError'));
        await new Promise(resolve => setTimeout(resolve, 260));
        return { playing: player.isPlaying, paused: audio.paused, lateEvents: events.slice(eventCount), errors };
      });
      return { evidence, passed: !evidence.playing && evidence.paused && evidence.errors.length === 0 && evidence.lateEvents.length === 0 };
    });
    await check('explicit book load clears boundary autoplay intent', async page => {
      await page.evaluate(async () => {
        player.resolveNextChapterUrl = () => new Promise(resolve => { window.releaseLookup = resolve; });
        await player.loadChapter('boundary', 0); await player.play();
        audio.currentTime = audio.duration - 0.15;
      });
      await page.waitForFunction(() => player._awaitingBoundaryPrewarm);
      const evidence = await page.evaluate(async () => {
        await player.loadChapter('selected', 0);
        await new Promise(resolve => setTimeout(resolve, 300));
        return { book: player.bookId, paused: audio.paused, playing: player.isPlaying, time: audio.currentTime, autoplay: audio.autoplay };
      });
      return { evidence, passed: evidence.paused && !evidence.playing && evidence.time === 0 && !evidence.autoplay };
    });
    await context.tracing.stop({ path: path.join(output, `${browserName}-${phase}-trace.zip`) });
    const report = { browser: browserName, phase, passed: results.every(result => result.passed), results };
    await fs.writeFile(path.join(output, `${browserName}-${phase}.json`), JSON.stringify(report, null, 2));
    results.forEach(result => console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${JSON.stringify(result.evidence || result.error)}`));
    assert(report.passed, `Player lifecycle verification failed; see ${output}`);
  } finally {
    await context?.close(); await browser?.close();
    await new Promise(resolve => server?.close(resolve) || resolve());
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
