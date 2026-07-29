const assert = require('assert');
const express = require('express');
const http = require('http');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { registerPlaybackRoutes } = require('../lib/routes/playback-routes');
const { createChapterAudioStreamer, createOutputPacer } = require('../lib/chapter-audio-stream');
const {
  DEFAULT_MAX_ACTIVE_SESSIONS,
  cleanupStaleSessionRoots,
  createHlsAudioStreamer
} = require('../lib/hls-audio-stream');
const { serveAudioFile } = require('../lib/audio-response');
const { createConcurrencyLimitMiddleware } = require('../lib/concurrency-limit');
const ChunkedTTS = require('../lib/chunked-tts');

const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}

async function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function routeHarness(source, streamerOptions = {}) {
  const app = express();
  app.use(express.json());
  if (streamerOptions.concurrencyMiddleware) {
    app.use(streamerOptions.concurrencyMiddleware);
  }
  const hlsAudioStreamer = createHlsAudioStreamer({
    serveAudioFile,
    rootDir: streamerOptions.hlsRootDir,
    segmentSeconds: streamerOptions.hlsSegmentSeconds || 4,
    ...(streamerOptions.hlsOptions || {})
  });
  const playbackOrchestrator = new Proxy({
    prepareAudioStream: async () => source,
    prepareContinuousAudioStream: async () => source
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return async () => {
        throw new Error(`Unexpected orchestrator call: ${String(property)}`);
      };
    }
  });
  registerPlaybackRoutes(app, {
    playbackOrchestrator,
    ttsForTier: () => ({ variantKeyProvider: () => 'test' }),
    generationJournal: { listQuarantinedChapters: async () => [] },
    chapterAudioStreamer: createChapterAudioStreamer({ serveAudioFile, ...streamerOptions }),
    hlsAudioStreamer,
    serveAudioFile,
    sendServerError(res, _error, message) {
      if (!res.headersSent) res.status(500).json({ error: message });
      else res.destroy();
    },
    fs: fsp
  });
  app.locals.hlsAudioStreamer = hlsAudioStreamer;
  return app;
}

async function createTone(filePath, duration = 0.35, frequency = 440) {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`,
    '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k',
    filePath
  ]);
}

async function createWavTone(filePath, duration = 0.35, frequency = 440) {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`,
    '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
    filePath
  ]);
}

async function decodedPcm(filePath) {
  const { stdout } = await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-xerror',
    '-i', filePath,
    '-f', 's16le', '-ac', '1', '-ar', '24000', 'pipe:1'
  ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function decodedDuration(filePath) {
  return (await decodedPcm(filePath)).length / (24000 * 2);
}

function zeroCrossingRate(pcm) {
  let crossings = 0;
  let previous = pcm.readInt16LE(0);
  for (let offset = 2; offset + 1 < pcm.length; offset += 2) {
    const current = pcm.readInt16LE(offset);
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings++;
    previous = current;
  }
  return crossings / Math.max(1, (pcm.length / 2) - 1);
}

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-progressive-audio-'));
  try {
    await test('one media request waits for and appends sequential MP3 chunks', async () => {
      const firstPath = path.join(dir, 'first.mp3');
      const secondPath = path.join(dir, 'second.mp3');
      await createTone(firstPath, 0.35, 440);
      await createTone(secondPath, 0.35, 660);
      const secondReady = deferred();
      const source = {
        bookId: 'book_one',
        chapterIndex: 0,
        servedTier: 'instant',
        format: 'mp3',
        finalPath: path.join(dir, 'not-ready.mp3'),
        totalChunks: 2,
        async waitForChunk(index) {
          if (index === 0) return firstPath;
          await secondReady.promise;
          return secondPath;
        },
        prioritize() {}
      };

      const server = await listen(routeHarness(source));
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/audio-stream/book_one/0`);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'audio/mpeg');
        assert.strictEqual(response.headers.get('x-served-tier'), 'instant');
        assert.strictEqual(response.headers.get('location'), null);

        const completeBody = response.arrayBuffer();
        const early = await Promise.race([
          completeBody.then(() => 'complete'),
          new Promise(resolve => setTimeout(() => resolve('waiting'), 40))
        ]);
        assert.strictEqual(early, 'waiting', 'response must remain open while the next chunk generates');

        secondReady.resolve();
        const outputPath = path.join(dir, 'waited-result.mp3');
        await fsp.writeFile(outputPath, Buffer.from(await completeBody));
        const actual = await decodedDuration(outputPath);
        assert(
          Math.abs(actual - 0.70) < 0.09,
          `waited progressive duration was ${actual.toFixed(3)}s`
        );
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('the stable URL serves finalized chapter audio with byte ranges', async () => {
      const finalPath = path.join(dir, 'final.mp3');
      await fsp.writeFile(finalPath, Buffer.from('0123456789'));
      const source = {
        bookId: 'book_one',
        chapterIndex: 0,
        format: 'mp3',
        finalPath,
        totalChunks: 2,
        async waitForChunk() {
          throw new Error('finalized audio must bypass chunk waiting');
        }
      };

      const server = await listen(routeHarness(source));
      try {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api/audio-stream/book_one/0`,
          { headers: { Range: 'bytes=3-6' } }
        );
        assert.strictEqual(response.status, 206);
        assert.strictEqual(response.headers.get('content-range'), 'bytes 3-6/10');
        assert.strictEqual(await response.text(), '3456');
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('progressive MP3 is one valid continuous encode without join delay', async () => {
      const chunkPaths = [];
      for (let index = 0; index < 5; index++) {
        const chunkPath = path.join(dir, `tone-${index}.mp3`);
        await createTone(chunkPath, 0.35, 440 + (index * 40));
        chunkPaths.push(chunkPath);
      }
      const source = {
        bookId: 'book_tones',
        chapterIndex: 0,
        format: 'mp3',
        finalPath: path.join(dir, 'not-ready-tones.mp3'),
        totalChunks: chunkPaths.length,
        waitForChunk: async index => chunkPaths[index],
        prioritize() {}
      };

      const server = await listen(routeHarness(source));
      const outputPath = path.join(dir, 'progressive-result.mp3');
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/audio-stream/book_tones/0`);
        assert.strictEqual(response.status, 200);
        await fsp.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
      } finally {
        await new Promise(resolve => server.close(resolve));
      }

      const actual = await decodedDuration(outputPath);
      assert(
        Math.abs(actual - 1.75) < 0.06,
        `decoded duration ${actual.toFixed(3)}s must not accumulate delay at five joins`
      );
    });

    await test('finalized chapter assembly re-encodes joins into one valid stream', async () => {
      const tts = new ChunkedTTS(dir, null, {
        variantKeyProvider: () => 'edge:test:outmp3',
        outputFormatProvider: () => 'mp3'
      });
      const chunks = [];
      for (let index = 0; index < 5; index++) {
        const chunkPath = tts.chunkPath('book_final', 0, index);
        await createTone(chunkPath, 0.35, 660 + (index * 40));
        chunks.push({ index, status: 'ready', path: chunkPath });
      }
      tts.manifests.set(tts._manifestKey('book_final', 0), {
        bookId: 'book_final',
        chapterIndex: 0,
        totalChunks: chunks.length,
        chunks
      });

      const outputPath = await tts.concatenateChunks('book_final', 0);
      const actual = await decodedDuration(outputPath);
      assert(
        Math.abs(actual - 1.75) < 0.06,
        `decoded duration ${actual.toFixed(3)}s must not accumulate delay at five joins`
      );
    });

    await test('finalized chapter assembly preserves configured WAV output', async () => {
      const tts = new ChunkedTTS(dir, null, {
        variantKeyProvider: () => 'kokoro:test:outwav',
        outputFormatProvider: () => 'wav'
      });
      const chunks = [];
      for (let index = 0; index < 3; index++) {
        const chunkPath = tts.chunkPath('book_final_wav', 0, index);
        await createWavTone(chunkPath, 0.35, 550 + (index * 40));
        chunks.push({ index, status: 'ready', path: chunkPath });
      }
      tts.manifests.set(tts._manifestKey('book_final_wav', 0), {
        bookId: 'book_final_wav',
        chapterIndex: 0,
        totalChunks: chunks.length,
        chunks
      });

      const outputPath = await tts.concatenateChunks('book_final_wav', 0);
      assert(outputPath.endsWith('.wav'));
      const actual = await decodedDuration(outputPath);
      assert(Math.abs(actual - 1.05) < 0.02, `final WAV duration was ${actual.toFixed(3)}s`);
    });

    await test('continuous endpoint keeps one valid encoder across chapter inputs', async () => {
      const chapterPaths = [];
      for (let index = 0; index < 3; index++) {
        const chapterPath = path.join(dir, `continuous-${index}.mp3`);
        await createTone(chapterPath, 0.40, 880 + (index * 80));
        chapterPaths.push(chapterPath);
      }
      const source = {
        bookId: 'book_continuous',
        chapterIndex: 1,
        endChapterIndex: 3,
        servedTier: 'instant',
        format: 'mp3',
        async *iterateInputs() {
          for (const chapterPath of chapterPaths) yield chapterPath;
        }
      };
      const server = await listen(routeHarness(source));
      const outputPath = path.join(dir, 'continuous-result.mp3');
      try {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api/audio-continuous/book_continuous/1`
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('x-served-tier'), 'instant');
        await fsp.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
      const actual = await decodedDuration(outputPath);
      assert(Math.abs(actual - 1.20) < 0.06, `continuous duration was ${actual.toFixed(3)}s`);
    });

    await test('an overestimated chapter seek never skips into the next chapter', async () => {
      const shortChapter = path.join(dir, 'continuous-short.mp3');
      const nextChapter = path.join(dir, 'continuous-next.mp3');
      await createTone(shortChapter, 0.20, 440);
      await createTone(nextChapter, 0.40, 880);
      const decoded = [];
      const source = {
        bookId: 'book_seek_bound',
        chapterIndex: 0,
        endChapterIndex: 1,
        startOffsetSeconds: 0.35,
        format: 'mp3',
        onInputDecoded(descriptor, pcmBytes, details) {
          decoded.push({ descriptor, pcmBytes, details });
        },
        async *iterateInputs() {
          yield { path: shortChapter, chapterIndex: 0, lastInChapter: true };
          yield { path: nextChapter, chapterIndex: 1, lastInChapter: true };
        }
      };
      const server = await listen(routeHarness(source));
      const outputPath = path.join(dir, 'continuous-seek-bound.mp3');
      try {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api/audio-continuous/book_seek_bound/0`
        );
        assert.strictEqual(response.status, 200);
        await fsp.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
      const actual = await decodedDuration(outputPath);
      assert(
        Math.abs(actual - 0.40) < 0.07,
        `next chapter was truncated after over-seek; output was ${actual.toFixed(3)}s`
      );
      assert.strictEqual(decoded.length, 2);
      assert(decoded[0].details.skippedPcmBytes > 0);
      assert.strictEqual(decoded[1].details.skippedPcmBytes, 0);
    });

    await test('continuous transport discards only the planned target-chunk offset', async () => {
      const targetChunk = path.join(dir, 'continuous-target-chunk.mp3');
      await createTone(targetChunk, 0.40, 520);
      const source = {
        bookId: 'book_targeted_seek',
        chapterIndex: 0,
        endChapterIndex: 0,
        startOffsetSeconds: 12,
        decodeStartOffsetSeconds: 0.10004,
        format: 'mp3',
        async *iterateInputs() {
          yield { path: targetChunk, chapterIndex: 0, lastInChapter: true };
        }
      };
      const server = await listen(routeHarness(source));
      const outputPath = path.join(dir, 'continuous-targeted-seek.mp3');
      try {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api/audio-continuous/book_targeted_seek/0`
        );
        assert.strictEqual(response.status, 200);
        await fsp.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
      const actual = await decodedDuration(outputPath);
      assert(
        Math.abs(actual - 0.30) < 0.07,
        `targeted seek output was ${actual.toFixed(3)}s instead of the target chunk remainder`
      );
      const crossingRate = zeroCrossingRate(await decodedPcm(outputPath));
      assert(
        crossingRate < 0.10,
        `targeted seek byte-swapped the tone into noise (${crossingRate.toFixed(3)} crossings/sample)`
      );
    });

    await test('native HLS stays playable while its EVENT playlist remains open', async () => {
      const firstPath = path.join(dir, 'hls-first.mp3');
      const secondPath = path.join(dir, 'hls-second.mp3');
      await createTone(firstPath, 2.5, 440);
      await createTone(secondPath, 2.5, 660);
      const releaseSecond = deferred();
      const source = {
        bookId: 'book_hls',
        chapterIndex: 0,
        endChapterIndex: 1,
        format: 'mp3',
        async *iterateInputs() {
          yield { path: firstPath, chapterIndex: 0, lastInChapter: true };
          await releaseSecond.promise;
          yield { path: secondPath, chapterIndex: 1, lastInChapter: true };
        }
      };
      const app = routeHarness(source, {
        hlsRootDir: path.join(dir, 'hls-sessions'),
        hlsSegmentSeconds: 1
      });
      const server = await listen(app);
      const origin = `http://127.0.0.1:${server.address().port}`;
      const playlistUrl = `${origin}/api/audio-hls/book_hls/0/index.m3u8?session=session-test-1&owner=owner-test-1`;
      try {
        const initialResponse = await fetch(playlistUrl);
        assert.strictEqual(initialResponse.status, 200);
        assert.strictEqual(
          initialResponse.headers.get('content-type'),
          'application/vnd.apple.mpegurl'
        );
        const initial = await initialResponse.text();
        for (const tag of [
          '#EXTM3U',
          '#EXT-X-VERSION:7',
          '#EXT-X-PLAYLIST-TYPE:EVENT',
          '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES',
          '#EXT-X-MEDIA-SEQUENCE:0',
          '#EXT-X-MAP:'
        ]) {
          assert(initial.includes(tag), `playlist omitted ${tag}`);
        }
        assert(!initial.includes('#EXT-X-ENDLIST'), 'live playlist closed before the next chapter');
        const firstSegmentUrl = initial.split('\n').find(line => line.startsWith('/api/audio-hls-segment/'));
        assert(firstSegmentUrl, 'playlist did not publish a finite media segment');
        const segmentResponse = await fetch(`${origin}${firstSegmentUrl}`, {
          headers: { Range: 'bytes=0-31' }
        });
        assert.strictEqual(segmentResponse.status, 206);
        assert.strictEqual(segmentResponse.headers.get('content-type'), 'audio/mp4');
        assert.strictEqual((await segmentResponse.arrayBuffer()).byteLength, 32);

        releaseSecond.resolve();
        let completed = '';
        for (let attempt = 0; attempt < 100; attempt++) {
          completed = await (await fetch(playlistUrl)).text();
          if (completed.includes('#EXT-X-ENDLIST')) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert(completed.includes('#EXT-X-ENDLIST'), 'completed source never closed the EVENT playlist');
        await execFileAsync('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-xerror',
          '-i', playlistUrl,
          '-f', 'null', '-'
        ], { timeout: 10000 });
      } finally {
        releaseSecond.resolve();
        await app.locals.hlsAudioStreamer.dispose();
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('HLS capacity admits concurrent iOS transports and preserves 503 overload status', async () => {
      assert(
        DEFAULT_MAX_ACTIVE_SESSIONS >= 8,
        `default HLS capacity unexpectedly regressed to ${DEFAULT_MAX_ACTIVE_SESSIONS}`
      );
      const pendingSource = deferred();
      const app = routeHarness(pendingSource.promise, {
        hlsRootDir: path.join(dir, 'hls-capacity'),
        hlsOptions: {
          maxActiveSessions: 2,
          maxCreationsPerAccount: 20,
          maintenanceIntervalMs: 0
        }
      });
      const server = await listen(app);
      const origin = `http://127.0.0.1:${server.address().port}`;
      const first = http.get(
        `${origin}/api/audio-hls/capacity_one/0/index.m3u8?session=capacity-session-1&owner=capacity-owner-1`
      );
      const second = http.get(
        `${origin}/api/audio-hls/capacity_two/0/index.m3u8?session=capacity-session-2&owner=capacity-owner-2`
      );
      first.on('error', () => {});
      second.on('error', () => {});
      try {
        await waitUntil(
          () => app.locals.hlsAudioStreamer.sessionsById.size === 2,
          'two concurrent HLS sessions were never admitted',
          10_000
        );
        const overloaded = await fetch(
          `${origin}/api/audio-hls/capacity_three/0/index.m3u8?session=capacity-session-3&owner=capacity-owner-3`,
          { signal: AbortSignal.timeout(10_000) }
        );
        assert.strictEqual(overloaded.status, 503);
        assert.match((await overloaded.json()).error, /capacity/i);
        assert.strictEqual(app.locals.hlsAudioStreamer.sessionsById.size, 2);
      } finally {
        first.destroy();
        second.destroy();
        await app.locals.hlsAudioStreamer.dispose();
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('HLS session creation is rate-limited per account with Retry-After', async () => {
      const pendingSource = deferred();
      const app = routeHarness(pendingSource.promise, {
        hlsRootDir: path.join(dir, 'hls-rate'),
        hlsOptions: {
          maxActiveSessions: 4,
          creationWindowMs: 60_000,
          maxCreationsPerAccount: 1,
          maintenanceIntervalMs: 0
        }
      });
      const server = await listen(app);
      const origin = `http://127.0.0.1:${server.address().port}`;
      const first = http.get(
        `${origin}/api/audio-hls/rate_one/0/index.m3u8?session=rate-session-0001&owner=rate-owner-0001`
      );
      first.on('error', () => {});
      try {
        await waitUntil(
          () => app.locals.hlsAudioStreamer.sessionsById.size === 1,
          'the first HLS session was never registered',
          10_000
        );
        const limited = await fetch(
          `${origin}/api/audio-hls/rate_two/0/index.m3u8?session=rate-session-0002&owner=rate-owner-0002`,
          { signal: AbortSignal.timeout(10_000) }
        );
        assert.strictEqual(limited.status, 429);
        assert.strictEqual(limited.headers.get('retry-after'), '60');
        assert.match((await limited.json()).error, /too many/i);
        assert.strictEqual(app.locals.hlsAudioStreamer.sessionsById.size, 1);
      } finally {
        first.destroy();
        await app.locals.hlsAudioStreamer.dispose();
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('disconnecting while HLS prepares aborts and evicts the unfinished session', async () => {
      const pendingSource = deferred();
      const rootDir = path.join(dir, 'hls-readiness-disconnect');
      const app = routeHarness(pendingSource.promise, {
        hlsRootDir: rootDir,
        hlsOptions: {
          maintenanceIntervalMs: 0
        }
      });
      const server = await listen(app);
      const request = http.get(
        `http://127.0.0.1:${server.address().port}/api/audio-hls/disconnect_book/0/index.m3u8?session=disconnect-session&owner=disconnect-owner`
      );
      request.on('error', () => {});
      try {
        await waitUntil(
          () => app.locals.hlsAudioStreamer.sessionsById.size === 1,
          'HLS readiness session was never registered'
        );
        request.destroy();
        await waitUntil(
          () => app.locals.hlsAudioStreamer.sessionsById.size === 0,
          'disconnected HLS readiness session was not evicted'
        );
        pendingSource.resolve({
          bookId: 'disconnect_book',
          chapterIndex: 0,
          format: 'mp3',
          async *iterateInputs() {}
        });
        await waitUntil(
          async () => {
            try {
              await fsp.access(rootDir);
              return (await fsp.readdir(rootDir)).length === 0;
            } catch (error) {
              return error.code === 'ENOENT';
            }
          },
          'disconnected HLS session directory was not removed'
        );
      } finally {
        request.destroy();
        pendingSource.resolve({
          bookId: 'disconnect_book',
          chapterIndex: 0,
          format: 'mp3',
          async *iterateInputs() {}
        });
        await app.locals.hlsAudioStreamer.dispose();
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('idle HLS sessions are evicted within the configured bound', async () => {
      const pendingSource = deferred();
      let clock = 1_000;
      const app = routeHarness(pendingSource.promise, {
        hlsRootDir: path.join(dir, 'hls-bounds'),
        hlsOptions: {
          sessionIdleMs: 50,
          sessionRetentionMs: 100,
          maxStorageBytes: 0,
          maintenanceIntervalMs: 0,
          now: () => clock
        }
      });
      const server = await listen(app);
      const request = http.get(
        `http://127.0.0.1:${server.address().port}/api/audio-hls/bounds_book/0/index.m3u8?session=bounds-session-01&owner=bounds-owner-01`
      );
      request.on('error', () => {});
      try {
        await waitUntil(
          () => app.locals.hlsAudioStreamer.sessionsById.size === 1,
          'the idle HLS session was never registered',
          10_000
        );
        clock += 51;
        await app.locals.hlsAudioStreamer.maintain();
        assert.strictEqual(app.locals.hlsAudioStreamer.sessionsById.size, 0);
      } finally {
        request.destroy();
        await app.locals.hlsAudioStreamer.dispose();
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('completed HLS sessions expire after the configured retention window', async () => {
      const pendingSource = deferred();
      let clock = 5_000;
      const app = routeHarness(pendingSource.promise, {
        hlsRootDir: path.join(dir, 'hls-retention'),
        hlsOptions: {
          sessionIdleMs: 0,
          sessionRetentionMs: 100,
          maxStorageBytes: 0,
          maintenanceIntervalMs: 0,
          now: () => clock
        }
      });
      const server = await listen(app);
      const request = http.get(
        `http://127.0.0.1:${server.address().port}/api/audio-hls/retention_book/0/index.m3u8?session=retention-session&owner=retention-owner`
      );
      request.on('error', () => {});
      try {
        await waitUntil(
          () => app.locals.hlsAudioStreamer.sessionsById.size === 1,
          'the retained HLS session was never registered',
          10_000
        );
        const session = [...app.locals.hlsAudioStreamer.sessionsById.values()][0];
        session.running = false;
        clock += 101;
        await app.locals.hlsAudioStreamer.maintain();
        assert.strictEqual(app.locals.hlsAudioStreamer.sessionsById.size, 0);
      } finally {
        request.destroy();
        await app.locals.hlsAudioStreamer.dispose();
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('HLS storage maintenance evicts completed sessions above the byte budget', async () => {
      const pendingSource = deferred();
      const app = routeHarness(pendingSource.promise, {
        hlsRootDir: path.join(dir, 'hls-storage'),
        hlsOptions: {
          sessionIdleMs: 0,
          sessionRetentionMs: 60_000,
          maxStorageBytes: 1,
          maintenanceIntervalMs: 0
        }
      });
      const server = await listen(app);
      const request = http.get(
        `http://127.0.0.1:${server.address().port}/api/audio-hls/storage_book/0/index.m3u8?session=storage-session-1&owner=storage-owner-1`
      );
      request.on('error', () => {});
      try {
        await waitUntil(
          () => app.locals.hlsAudioStreamer.sessionsById.size === 1,
          'the stored HLS session was never registered',
          10_000
        );
        const session = [...app.locals.hlsAudioStreamer.sessionsById.values()][0];
        await waitUntil(
          async () => {
            try {
              await fsp.access(session.directory);
              return true;
            } catch {
              return false;
            }
          },
          'the HLS session directory was never created',
          10_000
        );
        await fsp.writeFile(path.join(session.directory, 'retained.bin'), Buffer.alloc(2));
        session.running = false;
        await app.locals.hlsAudioStreamer.maintain();
        assert.strictEqual(app.locals.hlsAudioStreamer.sessionsById.size, 0);
      } finally {
        request.destroy();
        await app.locals.hlsAudioStreamer.dispose();
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('startup cleanup removes stale PID roots without touching live roots', async () => {
      const baseDir = path.join(dir, 'hls-pid-roots');
      await Promise.all([
        fsp.mkdir(path.join(baseDir, '111'), { recursive: true }),
        fsp.mkdir(path.join(baseDir, '222'), { recursive: true }),
        fsp.mkdir(path.join(baseDir, 'not-a-pid'), { recursive: true })
      ]);
      const removed = await cleanupStaleSessionRoots({
        baseDir,
        currentPid: 222,
        isProcessAlive: pid => pid === 222
      });
      assert.deepStrictEqual(removed, ['111']);
      await assert.rejects(fsp.access(path.join(baseDir, '111')), error => error.code === 'ENOENT');
      await fsp.access(path.join(baseDir, '222'));
      await fsp.access(path.join(baseDir, 'not-a-pid'));
    });

    await test('continuous output pacer allows a burst then limits bytes to four-times realtime', async () => {
      let current = 0;
      const waits = [];
      const pace = createOutputPacer({
        format: 'mp3',
        burstAudioSeconds: 1,
        realtimeMultiplier: 4,
        now: () => current,
        wait: async milliseconds => {
          waits.push(milliseconds);
          current += milliseconds;
        }
      });
      await pace(20_000);
      assert.deepStrictEqual(waits, [], 'one second of 160kbps audio is the initial burst');
      await pace(80_000);
      assert.strictEqual(waits.length, 1);
      assert(Math.abs(waits[0] - 1000) < 1, `expected 1s pacing delay, got ${waits[0]}ms`);
    });

    await test('continuous HTTP output is bounded to burst plus four-times encoded realtime', async () => {
      const inputPath = path.join(dir, 'paced-five-seconds.mp3');
      await createTone(inputPath, 5, 440);
      const source = {
        bookId: 'book_paced',
        chapterIndex: 0,
        endChapterIndex: 0,
        format: 'mp3',
        outputPacing: {
          burstAudioSeconds: 1,
          realtimeMultiplier: 4
        },
        async *iterateInputs() {
          yield inputPath;
        }
      };
      const server = await listen(routeHarness(source));
      try {
        const startedAt = Date.now();
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api/audio-continuous/book_paced/0`
        );
        const body = Buffer.from(await response.arrayBuffer());
        const elapsedMs = Date.now() - startedAt;
        console.log(`    pacing benchmark: ${body.length} bytes in ${elapsedMs}ms`);
        assert(body.length > 90_000, `expected about 100KB, received ${body.length} bytes`);
        assert(elapsedMs >= 850, `paced response completed too quickly in ${elapsedMs}ms`);
        assert(elapsedMs < 3000, `paced response was too slow at ${elapsedMs}ms`);
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('client cancellation aborts chunk waiting and reaps ffmpeg children', async () => {
      const firstPath = path.join(dir, 'abort-first.mp3');
      await createTone(firstPath, 2, 440);
      const aborted = deferred();
      const children = new Set();
      const source = {
        bookId: 'book_abort',
        chapterIndex: 0,
        format: 'mp3',
        finalPath: path.join(dir, 'not-ready-abort.mp3'),
        totalChunks: 2,
        waitForChunk(index, signal) {
          if (index === 0) return Promise.resolve(firstPath);
          return new Promise((resolve, reject) => {
            const onAbort = () => {
              aborted.resolve();
              const error = new Error('closed');
              error.name = 'AbortError';
              reject(error);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
        },
        prioritize() {}
      };
      const trackedSpawn = (...args) => {
        const child = spawn(...args);
        children.add(child);
        child.once('close', () => children.delete(child));
        return child;
      };
      const server = await listen(routeHarness(source, { spawnProcess: trackedSpawn }));
      try {
        await new Promise((resolve, reject) => {
          const request = http.get(
            `http://127.0.0.1:${server.address().port}/api/audio-stream/book_abort/0`,
            response => {
              response.once('data', () => {
                response.destroy();
                request.destroy();
                resolve();
              });
              response.once('error', error => {
                if (error.code !== 'ECONNRESET') reject(error);
              });
            }
          );
          request.once('error', error => {
            if (error.code !== 'ECONNRESET') reject(error);
          });
        });
        await Promise.race([
          aborted.promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('abort was not observed')), 1000))
        ]);
        for (let attempt = 0; attempt < 50 && children.size; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.strictEqual(children.size, 0, 'all decoder and encoder children exit after cancellation');
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('an aborted continuous response releases its TTS concurrency permit', async () => {
      const firstPath = path.join(dir, 'abort-permit-first.mp3');
      await createTone(firstPath, 2, 440);
      const limiter = createConcurrencyLimitMiddleware({
        groups: [{
          name: 'tts',
          max: 1,
          match: pathname => pathname.startsWith('/api/audio-continuous/')
        }]
      });
      const source = {
        bookId: 'book_abort_permit',
        chapterIndex: 0,
        format: 'mp3',
        async *iterateInputs(signal) {
          yield firstPath;
          await new Promise((resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('closed'), {
              name: 'AbortError',
              code: 'ABORT_ERR'
            }));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
        }
      };
      const server = await listen(routeHarness(source, {
        concurrencyMiddleware: limiter
      }));
      try {
        await new Promise((resolve, reject) => {
          const request = http.get(
            `http://127.0.0.1:${server.address().port}/api/audio-continuous/book_abort_permit/0`,
            response => {
              response.once('data', () => {
                response.destroy();
                request.destroy();
                resolve();
              });
            }
          );
          request.once('error', error => {
            if (error.code !== 'ECONNRESET') reject(error);
          });
        });
        for (let attempt = 0; attempt < 50 && !limiter.isIdle(); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.strictEqual(limiter.isIdle(), true);
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('progressive encoder accepts sequential WAV sources without corrupt joins', async () => {
      const firstPath = path.join(dir, 'first.wav');
      const secondPath = path.join(dir, 'second.wav');
      await createWavTone(firstPath, 0.35, 440);
      await createWavTone(secondPath, 0.35, 660);
      const source = {
        bookId: 'book_wav',
        chapterIndex: 0,
        format: 'mp3',
        finalPath: path.join(dir, 'not-ready.wav'),
        totalChunks: 2,
        waitForChunk: async index => index === 0 ? firstPath : secondPath,
        prioritize() {}
      };

      const server = await listen(routeHarness(source));
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/audio-stream/book_wav/0`);
        const body = Buffer.from(await response.arrayBuffer());
        const outputPath = path.join(dir, 'progressive-wav-sources.mp3');
        await fsp.writeFile(outputPath, body);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'audio/mpeg');
        const actual = await decodedDuration(outputPath);
        assert(Math.abs(actual - 0.70) < 0.09, `WAV-source duration was ${actual.toFixed(3)}s`);
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  console.log(`progressive-audio tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exit(1);
});
