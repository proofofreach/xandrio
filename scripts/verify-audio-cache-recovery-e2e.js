// Failure modes recorded before implementation:
// 1. Storage maintenance can delete a running HLS session when its completed
//    segments exceed the disk cap, turning the next segment request into 410.
// 2. Protecting running sessions must still let maintenance remove an
//    over-budget session after its generator and encoder have finished.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const ChunkedTTS = require('../lib/chunked-tts');
const { createHlsAudioStreamer } = require('../lib/hls-audio-stream');
const { serveAudioFile } = require('../lib/audio-response');
const TTSQueue = require('../lib/tts-queue');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'output/playback-interruption/backend');
const phase = String(process.env.AUDIO_CACHE_RECOVERY_PHASE || 'verification')
  .replace(/[^a-zA-Z0-9._-]/g, '-');
const storageAccessLeaseMs = 120;

function wavTone(seconds = 12) {
  const sampleRate = 24000;
  const samples = sampleRate * seconds;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    data.writeInt16LE(
      Math.round(1200 * Math.sin(2 * Math.PI * 440 * index / sampleRate)),
      44 + index * 2
    );
  }
  return data;
}

async function command(name, args, { signal } = {}) {
  const child = spawn(name, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => {
        if (signal?.aborted) {
          reject(Object.assign(new Error('Fixture generator cancelled'), { name: 'AbortError' }));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${name} exited with code ${code}: ${stderr}`));
        }
      });
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function probeDuration(filePath) {
  const child = spawn('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    filePath
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const duration = Number.parseFloat(stdout.trim());
  return code === 0 && Number.isFinite(duration) ? duration : null;
}

function waitForRelease(signal, releasePromise) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason || Object.assign(new Error('Fixture source cancelled'), {
        name: 'AbortError'
      }));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    releasePromise.then(() => {
      cleanup();
      resolve();
    }, error => {
      cleanup();
      reject(error);
    });
  });
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function withFixture(tempDir, name, tonePath, createSource, work) {
  const streamer = createHlsAudioStreamer({
    serveAudioFile,
    rootDir: path.join(tempDir, name),
    segmentSeconds: 1,
    readyTimeoutMs: 15000,
    maxStorageBytes: 1024,
    storageAccessLeaseMs,
    maintenanceIntervalMs: 0
  });
  const app = express();
  const mediaLimit = rateLimit({ windowMs: 60_000, limit: 120 });
  app.get('/playlist', mediaLimit, (req, res, next) => {
    streamer.servePlaylist(req, res, {
      key: name,
      ownerKey: `fixture:${name}`,
      rateKey: 'fixture-account',
      createSource: signal => createSource(signal, tonePath)
    }).catch(next);
  });
  app.get('/api/audio-hls-segment/:sessionId/:fileName', mediaLimit, (req, res, next) => {
    streamer.serveSegment(req, res, req.params.sessionId, req.params.fileName).catch(next);
  });
  app.use((error, _req, res, _next) => {
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else res.destroy();
  });

  let server;
  try {
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const playlistResponse = await fetch(`${origin}/playlist`, {
      signal: AbortSignal.timeout(15000)
    });
    assert.equal(playlistResponse.status, 200);
    const playlist = await playlistResponse.text();
    const segmentPath = playlist.split('\n').find(line => (
      line.startsWith('/api/audio-hls-segment/') && line.includes('/segment-')
    ));
    assert(segmentPath, 'Playlist must expose a completed media segment');
    const session = [...streamer.sessionsById.values()][0];
    assert(session, 'Fixture must retain its HLS session');
    return await work({ streamer, session, origin, segmentPath });
  } finally {
    await streamer.dispose();
    await closeServer(server);
  }
}

async function run() {
  await fs.mkdir(outputDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alexandrio-audio-cache-recovery-'));
  const tonePath = path.join(tempDir, 'tone.wav');
  await fs.writeFile(tonePath, wavTone());
  const results = [];

  try {
    const activeReleased = new Promise(() => {});
    const active = await withFixture(
      tempDir,
      'active-over-budget',
      tonePath,
      async signal => ({
        chapterIndex: 0,
        outputPacing: { burstAudioSeconds: 30, realtimeMultiplier: 100 },
        async *iterateInputs() {
          yield { path: tonePath, chapterIndex: 0, lastInChapter: false };
          await waitForRelease(signal, activeReleased);
        }
      }),
      async ({ streamer, session, origin, segmentPath }) => {
        assert.equal(session.running, true, 'Source must still be active before maintenance');
        const before = await fetch(origin + segmentPath, { signal: AbortSignal.timeout(3000) });
        const beforeBytes = (await before.arrayBuffer()).byteLength;
        await fs.writeFile(path.join(session.directory, 'quota-pressure.bin'), Buffer.alloc(64 * 1024));
        await streamer.maintain();
        const retained = streamer.sessionsById.has(session.id);
        const after = await fetch(origin + segmentPath, { signal: AbortSignal.timeout(3000) });
        const afterBytes = (await after.arrayBuffer()).byteLength;
        await new Promise(resolve => setTimeout(resolve, storageAccessLeaseMs + 40));
        await streamer.maintain();
        const retainedAfterIdle = streamer.sessionsById.has(session.id);
        const afterIdle = await fetch(origin + segmentPath, { signal: AbortSignal.timeout(3000) });
        await afterIdle.body.cancel();
        await session.runPromise;
        return {
          name: 'disk maintenance leases active HLS access and later reclaims an idle encoder',
          beforeStatus: before.status,
          beforeBytes,
          retained,
          afterStatus: after.status,
          afterBytes,
          retainedAfterIdle,
          afterIdleStatus: afterIdle.status,
          sourceAborted: session.controller.signal.aborted,
          passed: before.status === 200 && beforeBytes > 0 && retained &&
            after.status === 200 && afterBytes > 0 && !retainedAfterIdle &&
            afterIdle.status === 410 && session.controller.signal.aborted
        };
      }
    );
    results.push(active);
    console.log(`${active.passed ? 'PASS' : 'FAIL'} ${active.name}: ${JSON.stringify(active)}`);

    const inactive = await withFixture(
      tempDir,
      'inactive-over-budget',
      tonePath,
      async () => ({
        chapterIndex: 0,
        outputPacing: { burstAudioSeconds: 30, realtimeMultiplier: 100 },
        async *iterateInputs() {
          yield { path: tonePath, chapterIndex: 0, lastInChapter: true };
        }
      }),
      async ({ streamer, session, origin, segmentPath }) => {
        await session.runPromise;
        assert.equal(session.running, false, 'Encoder must finish before retained-session cleanup');
        await fs.writeFile(path.join(session.directory, 'quota-pressure.bin'), Buffer.alloc(64 * 1024));
        const before = await fetch(origin + segmentPath, { signal: AbortSignal.timeout(3000) });
        const beforeBytes = (await before.arrayBuffer()).byteLength;
        await streamer.maintain();
        const retainedDuringLease = streamer.sessionsById.has(session.id);
        await new Promise(resolve => setTimeout(resolve, storageAccessLeaseMs + 40));
        await streamer.maintain();
        const retainedAfterIdle = streamer.sessionsById.has(session.id);
        const response = await fetch(origin + segmentPath, { signal: AbortSignal.timeout(3000) });
        await response.body.cancel();
        return {
          name: 'disk maintenance leases completed playback and evicts it after idle',
          beforeStatus: before.status,
          beforeBytes,
          retainedDuringLease,
          retainedAfterIdle,
          segmentStatus: response.status,
          passed: before.status === 200 && beforeBytes > 0 && retainedDuringLease &&
            !retainedAfterIdle && response.status === 410
        };
      }
    );
    results.push(inactive);
    console.log(`${inactive.passed ? 'PASS' : 'FAIL'} ${inactive.name}: ${JSON.stringify(inactive)}`);

    const cacheDir = path.join(tempDir, 'persisted-chunk-cache');
    await fs.mkdir(cacheDir);
    let generationCalls = 0;
    const queue = new TTSQueue({
      cacheDir,
      maxConcurrent: 1,
      defaultVoice: 'fixture:voice',
      engineAdapters: {
        resolve() {
          return {
            id: 'fixture',
            minimumTextLength: 1,
            usesGpu: false,
            schedulingResource: null,
            synthesisInput(text, language, voice) {
              return { text, language, voice, sourceFormat: 'wav' };
            },
            async generate({ outputPath, signal }) {
              generationCalls++;
              await command('ffmpeg', [
                '-v', 'error', '-y', '-i', tonePath,
                '-ar', '24000', '-ac', '1', '-b:a', '128k', outputPath
              ], { signal });
            }
          };
        }
      }
    });
    const tts = new ChunkedTTS(cacheDir, queue, {
      chunkSize: 1000,
      reconcileIntervalMs: 0,
      variantKeyProvider: () => 'fixture:voice:cache-v1',
      outputFormatProvider: () => 'mp3',
      voiceProvider: () => 'fixture:voice'
    });
    const text = 'A persisted narration chunk can survive a process restart even when an interrupted write left only a small fragment. '.repeat(4);
    const chunkMeta = tts.splitIntoChunksWithMeta(text, tts.getActiveChunkSize());
    assert.equal(chunkMeta.length, 1, 'Corrupt-cache fixture must remain one chunk');
    const textHash = crypto.createHash('sha1')
      .update(chunkMeta.map(chunk => chunk.text).join('\u0000'))
      .digest('hex')
      .slice(0, 12);
    const chunkPath = tts.chunkPath('persisted', 0, 0);
    await fs.writeFile(chunkPath, Buffer.concat([
      Buffer.from('ID3'),
      Buffer.alloc(253, 0x7f)
    ]));
    await fs.writeFile(tts._chapterHashPath('persisted', 0), textHash);
    const beforeDuration = await probeDuration(chunkPath);
    const manifest = await tts.generateChapter('persisted', 0, text, 'en', 'immediate', {
      voice: 'fixture:voice',
      origin: 'playback-current',
      requestId: 'persisted-recovery'
    });
    if (!manifest.chunks.every(chunk => chunk.status === 'ready')) {
      await tts.waitForChapter('persisted', 0);
    }
    const afterDuration = await probeDuration(chunkPath);
    const recovered = {
      name: 'nonempty truncated persisted chunk is regenerated',
      beforeBytes: 256,
      beforeDuration,
      generationCalls,
      finalStatus: tts.getChapterManifest('persisted', 0)?.chunks?.[0]?.status,
      afterDuration,
      passed: beforeDuration === null && generationCalls === 1 &&
        afterDuration >= 10 && tts.getChapterManifest('persisted', 0)?.chunks?.[0]?.status === 'ready'
    };
    results.push(recovered);
    console.log(`${recovered.passed ? 'PASS' : 'FAIL'} ${recovered.name}: ${JSON.stringify(recovered)}`);
    tts.stopReconcileLoop();

    const restartedTts = new ChunkedTTS(cacheDir, queue, {
      chunkSize: 1000,
      reconcileIntervalMs: 0,
      variantKeyProvider: () => 'fixture:voice:cache-v1',
      outputFormatProvider: () => 'mp3',
      voiceProvider: () => 'fixture:voice'
    });
    const reusedManifest = await restartedTts.generateChapter('persisted', 0, text, 'en', 'immediate', {
      voice: 'fixture:voice',
      origin: 'playback-current',
      requestId: 'persisted-reuse'
    });
    const reused = {
      name: 'recovered verified chunk is reused after a fresh manifest build',
      generationCalls,
      finalStatus: reusedManifest.chunks[0]?.status,
      passed: generationCalls === 1 && reusedManifest.chunks[0]?.status === 'ready'
    };
    results.push(reused);
    console.log(`${reused.passed ? 'PASS' : 'FAIL'} ${reused.name}: ${JSON.stringify(reused)}`);
    restartedTts.stopReconcileLoop();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const artifact = {
    phase,
    node: process.version,
    generatedAt: new Date().toISOString(),
    passed: results.every(result => result.passed),
    results
  };
  await fs.writeFile(
    path.join(outputDir, `audio-cache-recovery-${phase}.json`),
    JSON.stringify(artifact, null, 2)
  );
  assert.equal(artifact.passed, true, `Audio cache recovery verification failed; see ${outputDir}`);
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
