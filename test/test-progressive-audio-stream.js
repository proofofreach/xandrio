const assert = require('assert');
const express = require('express');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { registerPlaybackRoutes } = require('../lib/routes/playback-routes');
const { createChapterAudioStreamer } = require('../lib/chapter-audio-stream');
const { serveAudioFile } = require('../lib/audio-response');

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

function routeHarness(source) {
  const app = express();
  app.use(express.json());
  const playbackOrchestrator = new Proxy({
    prepareAudioStream: async () => source
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
    chapterAudioStreamer: createChapterAudioStreamer({ serveAudioFile }),
    serveAudioFile,
    sendServerError(res, _error, message) {
      if (!res.headersSent) res.status(500).json({ error: message });
      else res.destroy();
    },
    fs: fsp
  });
  return app;
}

function pcmWav(payload, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const data = Buffer.from(payload);
  const header = Buffer.alloc(44);
  const blockAlign = channels * bitsPerSample / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-progressive-audio-'));
  try {
    await test('one media request waits for and appends sequential MP3 chunks', async () => {
      const firstPath = path.join(dir, 'first.mp3');
      const secondPath = path.join(dir, 'second.mp3');
      await fsp.writeFile(firstPath, Buffer.from('FIRST-CHUNK'));
      await fsp.writeFile(secondPath, Buffer.from('SECOND-CHUNK'));
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

        const reader = response.body.getReader();
        const first = await reader.read();
        assert.strictEqual(Buffer.from(first.value).toString(), 'FIRST-CHUNK');

        const pendingSecond = reader.read();
        const early = await Promise.race([
          pendingSecond.then(() => 'arrived'),
          new Promise(resolve => setTimeout(() => resolve('waiting'), 40))
        ]);
        assert.strictEqual(early, 'waiting', 'response must remain open while the next chunk generates');

        secondReady.resolve();
        const second = await pendingSecond;
        assert.strictEqual(Buffer.from(second.value).toString(), 'SECOND-CHUNK');
        assert.strictEqual((await reader.read()).done, true);
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

    await test('progressive WAV emits one stream header and concatenated PCM payloads', async () => {
      const firstPath = path.join(dir, 'first.wav');
      const secondPath = path.join(dir, 'second.wav');
      await fsp.writeFile(firstPath, pcmWav(Buffer.from([1, 2, 3, 4])));
      await fsp.writeFile(secondPath, pcmWav(Buffer.from([5, 6, 7, 8])));
      const source = {
        bookId: 'book_wav',
        chapterIndex: 0,
        format: 'wav',
        finalPath: path.join(dir, 'not-ready.wav'),
        totalChunks: 2,
        waitForChunk: async index => index === 0 ? firstPath : secondPath,
        prioritize() {}
      };

      const server = await listen(routeHarness(source));
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/audio-stream/book_wav/0`);
        const body = Buffer.from(await response.arrayBuffer());
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'audio/wav');
        assert.strictEqual(body.subarray(0, 4).toString('ascii'), 'RIFF');
        assert.strictEqual(body.subarray(8, 12).toString('ascii'), 'WAVE');
        assert.strictEqual(body.subarray(36, 40).toString('ascii'), 'data');
        assert.deepStrictEqual([...body.subarray(44)], [1, 2, 3, 4, 5, 6, 7, 8]);
        assert.strictEqual(body.toString('latin1').split('RIFF').length - 1, 1);
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
