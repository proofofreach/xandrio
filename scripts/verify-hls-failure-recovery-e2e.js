// Failure modes recorded before the fix: an encoder that exits after its first
// playlist leaves its upstream input waiting for audio; a missing segment from
// that failed session is reported as transient even though it can never arrive.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const { createHlsAudioStreamer } = require('../lib/hls-audio-stream');
const { serveAudioFile } = require('../lib/audio-response');

const outputDir = path.resolve(__dirname, '../output/playback-reliability/hls-failure-recovery');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function wavTone(seconds = 8) {
  const rate = 24000;
  const samples = rate * seconds;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  }
  return data;
}

async function until(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('Timed out waiting for HLS fixture state');
}

(async () => {
  await fs.mkdir(outputDir, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-hls-failure-e2e-'));
  const tonePath = path.join(temp, 'tone.wav');
  await fs.writeFile(tonePath, wavTone());
  let encoder = null;
  let inputWaiting = false;
  let inputAborted = false;
  const results = [];
  const streamer = createHlsAudioStreamer({
    serveAudioFile,
    rootDir: path.join(temp, 'hls'),
    segmentSeconds: 1,
    readyTimeoutMs: 15000,
    maintenanceIntervalMs: 0,
    spawnProcess(name, args, options) {
      const child = spawn(name, args, options);
      if (args.includes('-hls_time')) encoder = child;
      return child;
    }
  });
  const app = express();
  app.get('/hls/:kind', (req, res, next) => {
    const kind = req.params.kind;
    streamer.servePlaylist(req, res, {
      key: kind,
      ownerKey: `fixture:${kind}`,
      rateKey: 'fixture-account',
      createSource: async () => ({
        chapterIndex: 0,
        decodeStartOffsetSeconds: 0,
        outputPacing: { burstAudioSeconds: 30, realtimeMultiplier: 100 },
        async *iterateInputs(signal) {
          yield { path: tonePath, chapterIndex: 0, lastInChapter: kind === 'healthy' };
          if (kind !== 'failure') return;
          await new Promise((resolve, reject) => {
            const abort = () => {
              inputAborted = true;
              reject(Object.assign(new Error('Input was cancelled'), { name: 'AbortError' }));
            };
            signal.addEventListener('abort', abort, { once: true });
            inputWaiting = true;
            if (signal.aborted) abort();
          });
        }
      })
    }).catch(next);
  });
  app.get('/api/audio-hls-segment/:sessionId/:fileName', (req, res, next) => {
    streamer.serveSegment(req, res, req.params.sessionId, req.params.fileName).catch(next);
  });
  let server;
  try {
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const playlist = await fetch(`${origin}/hls/failure`, { signal: AbortSignal.timeout(15000) });
    assert.equal(playlist.status, 200);
    const playlistBody = await playlist.text();
    const segmentPath = playlistBody.split('\n').find(line => line.startsWith('/api/audio-hls-segment/') && line.includes('/segment-'));
    assert(segmentPath, 'First playlist must name a completed segment');
    const session = [...streamer.sessionsById.values()].find(item => item.key === 'failure');
    assert(session && encoder, 'Expected a real encoder and session');
    await until(() => inputWaiting);
    encoder.kill('SIGKILL');
    await until(() => session.error);
    await sleep(100);

    const valid = await fetch(`${origin}${segmentPath}`, { signal: AbortSignal.timeout(3000) });
    const validBytes = (await valid.arrayBuffer()).byteLength;
    const missing = await fetch(`${origin}/api/audio-hls-segment/${session.id}/segment-999999.m4s`, {
      signal: AbortSignal.timeout(3000)
    });
    await missing.body.cancel();
    results.push({
      name: 'failed encoder cancels its stalled source and distinguishes retained from missing segments',
      encoderError: session.error.message,
      inputAborted,
      signalAborted: session.controller.signal.aborted,
      validStatus: valid.status,
      validBytes,
      missingStatus: missing.status,
      passed: inputAborted && session.controller.signal.aborted && valid.status === 200 && validBytes > 0 && missing.status === 410
    });

    const healthyPlaylist = await fetch(`${origin}/hls/healthy`, { signal: AbortSignal.timeout(15000) });
    const healthyBody = await healthyPlaylist.text();
    const healthy = [...streamer.sessionsById.values()].find(item => item.key === 'healthy');
    await until(() => healthy && !healthy.running);
    const healthySegment = healthyBody.split('\n').find(line => line.startsWith('/api/audio-hls-segment/') && line.includes('/segment-'));
    const healthyRead = await fetch(`${origin}${healthySegment}`, { signal: AbortSignal.timeout(3000) });
    const healthyBytes = (await healthyRead.arrayBuffer()).byteLength;
    results.push({
      name: 'normal completed stream remains readable',
      playlistStatus: healthyPlaylist.status,
      sessionError: healthy.error?.message || null,
      segmentStatus: healthyRead.status,
      segmentBytes: healthyBytes,
      passed: healthyPlaylist.status === 200 && !healthy.error && healthyRead.status === 200 && healthyBytes > 0
    });

    const artifact = { results, passed: results.every(result => result.passed) };
    await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(artifact, null, 2));
    for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${JSON.stringify(result)}`);
    assert(artifact.passed, `HLS failure recovery failed; see ${outputDir}`);
  } finally {
    await streamer.dispose();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
