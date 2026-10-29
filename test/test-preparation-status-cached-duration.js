#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '..', 'lib/routes/audio-prep-routes.js'), 'utf8');
const begin = server.indexOf('const narrationDurations = new Map();');
const end = server.indexOf('\nfunction kickPremiumPrep(', begin);
assert(begin >= 0 && end > begin);

(async () => {
  let stat = { size: 10, mtimeMs: 1 };
  const probes = [];
  const chapter = { type: 'chapter', text: 'actual chapter', estimatedDuration: 20 };
  const book = { path: '/book' };
  const context = {
    fs: { stat: async () => ({ ...stat }) },
    getBookNarration: () => ({ voiceId: 'voice' }),
    fixedNarrationWorker: () => ({ variantKeyProvider: () => 'variant', chapterPath: () => '/audio' }),
    getChaptersCached: async () => [chapter],
    probeAudioDurationSeconds: audioPath => new Promise(resolve => probes.push({ audioPath, resolve })),
    premiumPrep: { getState: () => ({ variantKey: 'variant', status: 'generating' }) },
    isPreparedVoice: () => true, registeredVoiceEntries: () => [{ id: 'voice', name: 'Voice' }],
    isPremiumPrepEnabled: () => true, getInstantVoiceFor: () => 'instant',
    Promise, Map
  };
  vm.createContext(context);
  vm.runInContext(server.slice(begin, end) + '\nthis.status = getPreparationStatus;', context);
  const cached = () => context.status('id', book, {}, { cachedDurationsOnly: true });
  const first = await Promise.race([cached(), new Promise((_, reject) =>
    setTimeout(() => reject(new Error('cached queue status waited for a probe')), 250))]);
  assert.equal(first.readyChapters, 1);
  assert.equal(first.readyAudioSeconds, 20);
  assert.equal(first.durationEstimated, true);
  assert.equal(probes.length, 1);
  const repeated = await cached();
  assert.equal(repeated.readyAudioSeconds, 20);
  assert.equal(probes.length, 1, 'repeated polls share a pending probe');
  let exactSettled = false;
  const exact = context.status('id', book).then(value => { exactSettled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exactSettled, false, 'normal callers wait for the same measurement');
  probes[0].resolve(41);
  const measured = await exact;
  assert.equal(measured.readyAudioSeconds, 41);
  assert.equal(measured.durationEstimated, false);
  const warm = await cached();
  assert.equal(warm.readyAudioSeconds, 41);
  assert.equal(warm.durationEstimated, false);

  stat = { size: 11, mtimeMs: 2 };
  const changed = await cached();
  assert.equal(changed.readyAudioSeconds, 20);
  assert.equal(changed.durationEstimated, true);
  assert.equal(probes.length, 2, 'changed file identity starts a new probe');
  probes[1].resolve(72);
  await new Promise(resolve => setImmediate(resolve));
  const updated = await cached();
  assert.equal(updated.readyAudioSeconds, 72);
  assert.equal(updated.durationEstimated, false);

  stat = { size: 12, mtimeMs: 3 };
  assert.equal((await cached()).durationEstimated, true);
  probes[2].resolve(null);
  await new Promise(resolve => setImmediate(resolve));
  const noMeasurement = await cached();
  assert.equal(noMeasurement.readyAudioSeconds, 20);
  assert.equal(noMeasurement.durationEstimated, true, 'a failed measurement retains the estimate flag');
  assert.match(route, /getPreparationStatus\(bookId, book, \{ chapterIndex: state\.fromChapter \}, \{ cachedDurationsOnly: true \}\)/);
  assert.match(route, /durationEstimated: preparation\.durationEstimated/);
  console.log('Queue preparation duration regressions passed\n1 passed, 0 failed');
})().catch(error => { console.error(error); process.exitCode = 1; });
