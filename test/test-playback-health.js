const assert = require('assert');
const express = require('express');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const jsonStore = require('../lib/json-store');
const {
  createPlaybackHealthStore,
  normalizeReport,
  registerPlaybackHealthRoutes,
  summarizePlaybackHealth
} = require('../lib/playback-health');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.stack || error.message}`);
  }
}

function clientHarness() {
  let clock = 0;
  const sent = [];
  return import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'playback-health.mjs')).href)
    .then(module => {
      const health = module.createPlaybackHealth({
        now: () => clock,
        platform: 'ios',
        standalone: true,
        send: report => sent.push(report)
      });
      return {
        module,
        health,
        sent,
        at(ms, type, extra = {}) {
          clock = ms;
          health.observe({ type, ...extra });
        },
        advance(ms) { clock = ms; }
      };
    });
}

(async () => {
  console.log('playback-health tests');

  await test('client measures startup from play intent to audible playback', async () => {
    const h = await clientHarness();
    h.at(0, 'play-intent');
    h.at(50, 'source-load', { sourceKind: 'continuous' });
    h.at(60, 'pause', { reason: 'source-change' });
    h.at(2400, 'play');
    h.at(2600, 'playing');
    h.advance(62600);
    const report = h.health.takeReport();
    assert.deepStrictEqual(report.startupMs, [2600], 'engine pauses inside a load do not abandon the start');
    assert.strictEqual(report.backend, 'audio-stream');
    assert.strictEqual(report.listenedSeconds, 60);
    assert.strictEqual(report.platform, 'ios');
    assert.strictEqual(report.standalone, true);
  });

  await test('client counts stalls during running audio and closes them on resume', async () => {
    const h = await clientHarness();
    h.at(0, 'play-intent');
    h.at(300, 'playing');
    h.at(10300, 'waiting');
    h.at(10400, 'waiting');
    h.at(11300, 'load-chapter', { reason: 'automatic-recovery' });
    h.at(11310, 'automatic-recovery');
    h.at(13300, 'playing');
    h.advance(23300);
    const report = h.health.takeReport();
    assert.strictEqual(report.stalls, 1, 'repeated waiting events are one stall');
    assert.strictEqual(report.stallMs, 3000, 'a recovery reload stays inside the stall');
    assert.strictEqual(report.recoveries, 1);
    assert.deepStrictEqual(report.startupMs, [300], 'a recovery reload is not a new startup');
    assert.strictEqual(report.listenedSeconds, 20);
  });

  await test('client abandons a wait the listener cancels', async () => {
    const h = await clientHarness();
    h.at(0, 'play-intent');
    h.at(5000, 'pause-intent');
    h.at(90000, 'playing');
    h.advance(91000);
    const report = h.health.takeReport();
    assert.deepStrictEqual(report.startupMs, [], 'a cancelled start is not a startup');
    assert.deepStrictEqual(report.abandonedStartMs, [5000], 'the time the listener waited is kept');
  });

  await test('client records chapter-boundary waits and failures', async () => {
    const h = await clientHarness();
    h.at(0, 'play-intent');
    h.at(200, 'playing');
    h.at(1000, 'ended');
    h.at(1000, 'chapter-advance-waiting');
    h.at(1800, 'playing');
    h.at(2000, 'stalled-timeout');
    h.at(2000, 'error');
    const report = h.health.takeReport();
    assert.deepStrictEqual(report.boundaryWaitMs, [800]);
    assert.deepStrictEqual(report.errors, { 'stalled-timeout': 1, error: 1 });
  });

  await test('client flush splits a running session without losing time', async () => {
    const h = await clientHarness();
    h.at(0, 'play-intent');
    h.at(100, 'playing');
    h.advance(30100);
    h.health.flush();
    h.advance(60100);
    h.health.flush();
    assert.strictEqual(h.sent.length, 2);
    assert.strictEqual(h.sent[0].listenedSeconds + h.sent[1].listenedSeconds, 60);
    assert.deepStrictEqual(h.sent[1].startupMs, [], 'a startup is reported once');
    assert.strictEqual(h.health.takeReport(), null, 'an idle paused session reports nothing');
  });

  await test('client reports contain no identifying fields', async () => {
    const h = await clientHarness();
    h.at(0, 'play-intent', { chapterIndex: 4, bookId: 'book_secret' });
    h.at(100, 'playing', { chapterIndex: 4, streamTime: 12 });
    h.advance(1100);
    const report = h.health.takeReport();
    assert.deepStrictEqual(Object.keys(report).sort(), [
      'abandonedStartMs', 'backend', 'boundaryWaitMs', 'errors', 'listenedSeconds', 'platform', 'recoveries',
      'stallMs', 'stalls', 'standalone', 'startupMs', 'v'
    ]);
  });

  await test('client classifies device platforms', async () => {
    const { module } = await clientHarness();
    assert.strictEqual(module.platformClass('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios');
    assert.strictEqual(module.platformClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'ios', 'iPadOS desktop UA');
    assert.strictEqual(module.platformClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 'desktop');
    assert.strictEqual(module.platformClass('Mozilla/5.0 (Linux; Android 15)'), 'android');
    assert.strictEqual(module.platformClass(''), 'other');
  });

  await test('server normalization drops unknown fields and clamps values', () => {
    assert.strictEqual(normalizeReport({ v: 2 }), null);
    assert.strictEqual(normalizeReport([]), null);
    const report = normalizeReport({
      v: 1,
      platform: 'toaster',
      backend: 'mystery',
      bookId: 'book_secret',
      startupMs: [100, -5, 'x', 10 ** 9, ...new Array(40).fill(1)],
      stalls: 5000,
      errors: { error: 2, 'made-up': 9 }
    });
    assert.strictEqual(report.platform, 'other');
    assert.strictEqual(report.backend, 'unknown');
    assert.strictEqual(report.bookId, undefined);
    assert.strictEqual(report.startupMs.length, 18, 'samples are capped before filtering invalid values');
    assert.strictEqual(report.startupMs[1], 600000, 'waits are clamped to ten minutes');
    assert.strictEqual(report.stalls, 1000);
    assert.deepStrictEqual(report.errors, { error: 2 });
  });

  await test('server aggregates by day and platform and expires old days', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-health-'));
    const file = path.join(dir, 'playback-health.json');
    let current = new Date('2026-10-27T12:00:00Z');
    const store = createPlaybackHealthStore({ file, jsonStore, now: () => current });
    try {
      await store.record({ v: 1, platform: 'ios', startupMs: [300, 3800], stalls: 1, listenedSeconds: 3600, errors: { error: 1 } });
      await store.record({ v: 1, platform: 'ios', startupMs: [16000], listenedSeconds: 1800 });
      await store.record({ v: 1, platform: 'desktop', startupMs: [700] });
      assert.strictEqual(await store.record({ v: 1, platform: 'ios' }), true, 'an empty report is accepted');
      const summary = await store.summarize({ days: 7 });
      assert.strictEqual(summary.platforms.ios.reports, 2, 'an empty report is not stored');
      assert.deepStrictEqual(summary.platforms.ios.startupMs.buckets, [1, 0, 0, 1, 0, 0, 1]);
      assert.strictEqual(summary.platforms.ios.startupMs.p50, '<4000ms');
      assert.strictEqual(summary.platforms.ios.stallsPerListenedHour, 0.7);
      assert.strictEqual(summary.total.reports, 3);
      assert.deepStrictEqual(summary.total.errors, { error: 1 });

      current = new Date('2026-12-15T12:00:00Z');
      await store.record({ v: 1, platform: 'android', startupMs: [400] });
      const stored = await jsonStore.load(file, {});
      assert.deepStrictEqual(Object.keys(stored.days), ['2026-12-15'], 'days past retention are deleted');
      assert(!JSON.stringify(stored).includes('book'), 'stored data has no book identifiers');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  await test('summary window excludes days before the cutoff', () => {
    const bucket = { reports: 1, startups: [1, 0, 0, 0, 0, 0, 0] };
    const summary = summarizePlaybackHealth({
      days: { '2026-10-20': { ios: bucket }, '2026-10-27': { ios: bucket } }
    }, { days: 7, now: new Date('2026-10-27T00:00:00Z') });
    assert.strictEqual(summary.since, '2026-10-21');
    assert.strictEqual(summary.total.reports, 1);
  });

  await test('route accepts valid reports and rejects malformed ones', async () => {
    const recorded = [];
    const app = express();
    app.use(express.json());
    registerPlaybackHealthRoutes(app, {
      store: { record: async body => { const report = normalizeReport(body); if (report) recorded.push(report); return Boolean(report); } }
    });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/api/playback-health`;
    try {
      const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.strictEqual((await post({ v: 1, platform: 'ios', startupMs: [100] })).status, 204);
      assert.strictEqual((await post({ v: 9 })).status, 400);
      assert.strictEqual(recorded.length, 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  console.log(`\nplayback-health tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
