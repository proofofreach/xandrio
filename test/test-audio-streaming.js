/**
 * Audio streaming resilience tests.
 *
 * serveAudioFile() writes the response headers and then streams a file off
 * disk. The chapter audio it serves is actively unlinked by the post-delete
 * artifact sweeps and the TTS orphan cleaner, so a read can fail *after* the
 * headers are out. A raw readStream.pipe(res) does not forward that error,
 * which surfaces as an unhandled 'error' event and takes the process down.
 *
 * Run: node test/test-audio-streaming.js
 */

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const { serveAudioFile } = require('../lib/audio-response');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'audio-stream-test-'));
  const audioPath = path.join(dir, 'chapter.mp3');
  await fsp.writeFile(audioPath, Buffer.alloc(64 * 1024, 7));

  // Route that streams a real file, plus one that streams a file whose
  // descriptor fails on first read — standing in for a mid-stream disk error.
  const app = express();
  app.get('/ok', async (req, res, next) => {
    try { await serveAudioFile(req, res, audioPath); } catch (err) { next(err); }
  });
  app.get('/broken', async (req, res, next) => {
    try { await serveAudioFile(req, res, path.join(dir, 'chapter.mp3')); } catch (err) { next(err); }
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('uncaughtException', onUnhandled);
  const streamWarnings = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args) => streamWarnings.push(args.join(' '));

  await test('serves a full body with the audio content type', async () => {
    const response = await fetch(`${base}/ok`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('content-type'), 'audio/mpeg');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.strictEqual(bytes.byteLength, 64 * 1024);
    assert.strictEqual(response.headers.get('x-xandrio-content-sha256'), null);
  });

  await test('adds a content identity only for an explicit offline download', async () => {
    const response = await fetch(`${base}/ok`, {
      headers: { 'X-Xandrio-Offline-Download': '1' }
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.strictEqual(
      response.headers.get('x-xandrio-content-sha256'),
      `sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}`
    );
  });

  await test('serves a byte range as 206 with Content-Range', async () => {
    const response = await fetch(`${base}/ok`, { headers: { Range: 'bytes=0-1023' } });
    assert.strictEqual(response.status, 206);
    assert.strictEqual(response.headers.get('content-range'), `bytes 0-1023/${64 * 1024}`);
    assert.strictEqual((await response.arrayBuffer()).byteLength, 1024);
  });

  await test('a client aborting mid-stream does not raise an unhandled error', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/ok`, { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    // Give the server's stream teardown a tick to settle.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepStrictEqual(unhandled.map(e => e.message), []);
  });

  await test('a read failure after headers are sent does not crash the process', async () => {
    // Replace the file with a directory: createReadStream succeeds in
    // constructing, then emits EISDIR asynchronously — after writeHead.
    const trapDir = path.join(dir, 'trap');
    await fsp.mkdir(trapDir, { recursive: true });
    const trapApp = express();
    // Loopback-only test fixture; it is never part of the production server.
    // codeql[js/missing-rate-limiting]
    trapApp.get('/trap', async (req, res) => {
      // stat() reports a size, so headers go out before the read fails.
      await serveAudioFile(req, res, trapDir).catch(() => {});
    });
    const trapServer = http.createServer(trapApp);
    await new Promise(resolve => trapServer.listen(0, '127.0.0.1', resolve));
    const trapBase = `http://127.0.0.1:${trapServer.address().port}`;

    await fetch(`${trapBase}/trap`).then(r => r.arrayBuffer()).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 150));
    await new Promise(resolve => trapServer.close(resolve));

    assert.deepStrictEqual(
      unhandled.map(e => e.message),
      [],
      'stream error must be handled, not thrown as an uncaught exception'
    );
    assert(
      streamWarnings.some(message => message.includes('Audio stream failed') && message.includes('EISDIR')),
      'non-client stream failures must remain visible to operators'
    );
  });

  process.off('uncaughtException', onUnhandled);
  console.warn = originalConsoleWarn;
  await new Promise(resolve => server.close(resolve));
  await fsp.rm(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
