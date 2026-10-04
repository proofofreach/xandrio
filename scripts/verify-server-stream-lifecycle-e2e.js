// Failure modes recorded before implementation:
// - An MP3 encoder failure rejects the HTTP handler but leaves its upstream
//   narration iterator waiting forever after the disconnect listener is removed.
// - A slow HLS source preparation is outside the first-segment deadline, so an
//   open HTTP socket can retain an active session indefinitely.
// - A request that disconnects during route preparation can reach the streamer
//   after its close event, starting an encoder whose input never gets cancelled.
// - A directory creation that finishes after startup timeout must not recreate
//   an orphan HLS session directory after eviction.
// Controls: client disconnect releases sources and children; normal MP3 output
// ends successfully and decodes with real ffmpeg; concurrent HLS requests share
// preparation and one disconnected waiter must not cancel the surviving waiter.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');
const { createChapterAudioStreamer } = require('../lib/chapter-audio-stream');
const { createHlsAudioStreamer } = require('../lib/hls-audio-stream');
const { serveAudioFile } = require('../lib/audio-response');

const outputDir = path.resolve(__dirname, '../output/deep-reliability/streams');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for stream fixture');
}
async function command(args) {
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

(async () => {
  await fs.mkdir(outputDir, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-stream-lifecycle-'));
  const tonePath = path.join(temp, 'tone.wav');
  const children = [];
  const states = new Map();
  const results = [];
  let server;
  let lateSourceResolve;
  let hlsCreates = 0;
  let releaseMkdir;
  let delayNextMkdir = false;
  const originalMkdir = fs.mkdir;
  fs.mkdir = async function(directory, options) {
    if (delayNextMkdir && path.dirname(directory) === path.join(temp, 'hls')) {
      delayNextMkdir = false;
      await new Promise(resolve => { releaseMkdir = resolve; });
    }
    return originalMkdir.call(fs, directory, options);
  };
  const hls = createHlsAudioStreamer({
    serveAudioFile, rootDir: path.join(temp, 'hls'), readyTimeoutMs: 250,
    maintenanceIntervalMs: 0,
    spawnProcess(name, args, options) {
      const child = spawn(name, args, options);
      children.push(child);
      return child;
    }
  });
  const app = express();
  app.get('/mp3/:kind', async (req, res) => {
    const kind = req.params.kind;
    const state = { waiting: false, aborted: false, closed: false, error: null, children: [] };
    states.set(kind, state);
    const streamer = createChapterAudioStreamer({
      serveAudioFile,
      spawnProcess(name, args, options) {
        const child = spawn(name, args, options);
        children.push(child);
        state.children.push(child);
        if (args.includes('libmp3lame')) state.encoder = child;
        return child;
      }
    });
    try {
      if (kind === 'early-disconnect') await new Promise(resolve => { state.start = resolve; });
      await streamer.streamContinuous(req, res, {
        format: 'mp3', chapterIndex: 0,
        async *iterateInputs(signal) {
          try {
            if (kind === 'early-disconnect') {
              await new Promise((resolve, reject) => {
                const abort = () => {
                  state.aborted = true;
                  reject(Object.assign(new Error('Fixture source aborted'), { name: 'AbortError' }));
                };
                state.release = resolve;
                state.waiting = true;
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
              });
            }
            yield { path: tonePath, chapterIndex: 0, lastInChapter: kind === 'healthy' };
            if (kind === 'healthy') return;
            await new Promise((resolve, reject) => {
              const abort = () => {
                state.aborted = true;
                reject(Object.assign(new Error('Fixture source aborted'), { name: 'AbortError' }));
              };
              state.release = resolve;
              state.signal = signal;
              signal.addEventListener('abort', abort, { once: true });
              state.waiting = true;
              if (signal.aborted) abort();
            });
          } finally { state.closed = true; }
        }
      });
    } catch (error) {
      state.error = error.message;
      res.destroy();
    }
  });
  app.get('/hls/:kind', (req, res) => {
    hls.servePlaylist(req, res, {
      key: req.params.kind,
      ownerKey: req.params.kind,
      rateKey: 'fixture',
      createSource: async () => {
        hlsCreates++;
        await new Promise(resolve => { lateSourceResolve = resolve; });
        return { async *iterateInputs() { yield tonePath; } };
      }
    }).catch(error => {
      if (!res.headersSent) res.status(503).json({ error: error.message });
      else res.destroy();
    });
  });
  function openRequest(url) {
    const observation = { status: null, bytes: 0, ended: false, closed: false };
    const request = http.get(url, response => {
      observation.status = response.statusCode;
      observation.response = response;
      response.on('data', chunk => { observation.bytes += chunk.length; });
      response.on('end', () => { observation.ended = true; });
      response.on('error', () => {});
      response.on('close', () => { observation.closed = true; });
    });
    request.on('error', () => { observation.closed = true; });
    return { request, observation };
  }
  try {
    await command(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '24000', '-ac', '1', tonePath]);
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    for (const kind of ['encoder-failure', 'disconnect']) {
      const { request, observation } = openRequest(`${origin}/mp3/${kind}`);
      await until(() => states.get(kind)?.waiting);
      const state = states.get(kind);
      if (kind === 'encoder-failure') state.encoder.kill('SIGKILL');
      else request.destroy();
      await sleep(250);
      const aliveChildren = state.children.filter(child => child.exitCode === null && child.signalCode === null).length;
      results.push({ name: kind, upstreamAborted: state.aborted, upstreamClosed: state.closed,
        aliveChildren, responseClosed: observation.closed,
        passed: state.aborted && state.closed && aliveChildren === 0 && observation.closed });
      request.destroy();
      state.release?.();
    }

    const early = openRequest(`${origin}/mp3/early-disconnect`);
    await until(() => states.get('early-disconnect')?.start);
    const earlyState = states.get('early-disconnect');
    early.request.destroy();
    await sleep(25);
    earlyState.start();
    await sleep(250);
    const earlyAliveChildren = earlyState.children.filter(child => child.exitCode === null && child.signalCode === null).length;
    results.push({ name: 'disconnect during route preparation', aliveChildren: earlyAliveChildren,
      upstreamWaiting: earlyState.waiting && !earlyState.closed,
      passed: earlyAliveChildren === 0 && (!earlyState.waiting || earlyState.closed) });
    earlyState.release?.();

    const healthy = await fetch(`${origin}/mp3/healthy`, { signal: AbortSignal.timeout(5000) });
    const healthyBytes = Buffer.from(await healthy.arrayBuffer());
    const healthyPath = path.join(outputDir, 'healthy.mp3');
    await fs.writeFile(healthyPath, healthyBytes);
    await command(['-v', 'error', '-xerror', '-i', healthyPath, '-f', 'null', '-']);
    results.push({ name: 'normal MP3 completes and decodes', status: healthy.status,
      bytes: healthyBytes.length, passed: healthy.status === 200 && healthyBytes.length > 0 });

    const started = Date.now();
    const delayed = openRequest(`${origin}/hls/source-deadline`);
    await until(() => hlsCreates === 1);
    await sleep(650);
    results.push({ name: 'HLS deadline includes source preparation', elapsedMs: Date.now() - started,
      status: delayed.observation.status, activeSessions: hls.sessionsById.size,
      passed: delayed.observation.status === 503 && hls.sessionsById.size === 0 });
    delayed.request.destroy();
    lateSourceResolve?.();
    await sleep(100);

    const first = openRequest(`${origin}/hls/shared`);
    const second = openRequest(`${origin}/hls/shared`);
    await until(() => hlsCreates === 2 && [...hls.sessionsById.values()].some(session => session.waiters === 2));
    first.request.destroy();
    await sleep(20);
    const session = [...hls.sessionsById.values()].find(item => item.key === 'shared');
    const survivorPreserved = Boolean(session && !session.controller.signal.aborted && session.waiters === 1);
    lateSourceResolve();
    await until(() => second.observation.closed);
    results.push({ name: 'shared HLS waiter disconnect preserves surviving request', survivorPreserved,
      status: second.observation.status, passed: survivorPreserved && second.observation.status === 200 });
    second.request.destroy();

    delayNextMkdir = true;
    const slowDirectory = openRequest(`${origin}/hls/slow-directory`);
    await until(() => releaseMkdir);
    const slowSession = [...hls.sessionsById.values()].find(item => item.key === 'slow-directory');
    await until(() => slowDirectory.observation.closed);
    releaseMkdir();
    await sleep(100);
    let orphanDirectory = false;
    try { orphanDirectory = (await fs.stat(slowSession.directory)).isDirectory(); } catch {}
    results.push({ name: 'late directory creation cannot resurrect an evicted HLS session',
      status: slowDirectory.observation.status, orphanDirectory,
      passed: slowDirectory.observation.status === 503 && !orphanDirectory });
    slowDirectory.request.destroy();

    const artifact = { node: process.version, results, passed: results.every(result => result.passed) };
    const reportName = process.env.STREAM_LIFECYCLE_REPORT || 'result.json';
    await fs.writeFile(path.join(outputDir, reportName), JSON.stringify(artifact, null, 2));
    for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${JSON.stringify(result)}`);
    assert(artifact.passed, `Stream lifecycle failed; see ${outputDir}/${reportName}`);
  } finally {
    releaseMkdir?.();
    fs.mkdir = originalMkdir;
    lateSourceResolve?.();
    for (const state of states.values()) state.release?.();
    await hls.dispose();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
