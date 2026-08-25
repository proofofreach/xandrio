const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app } = require('../server');
const { hlsOwnerKey, registerPlaybackRoutes } = require('../lib/routes/playback-routes');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

(async () => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await test('legacy chunk route redirects into canonical playback access', async () => {
      const response = await fetch(`${base}/api/serve-chunk/book_one_tts0123456789_ch2_chunk3.mp3`, {
        redirect: 'manual'
      });
      assert.strictEqual(response.status, 307);
      assert.strictEqual(response.headers.get('location'), '/api/chunks/book_one/2/3');
    });

    await test('legacy chunk route rejects filenames outside playback identity', async () => {
      const response = await fetch(`${base}/api/serve-chunk/not-an-audio-file.mp3`, { redirect: 'manual' });
      assert.strictEqual(response.status, 403);
    });


    await test('foreground priority refuses a book outside the caller library', async () => {
      const routes = [];
      const fakeApp = {};
      for (const method of ['get', 'post', 'put', 'delete']) {
        fakeApp[method] = (routePath, ...handlers) => routes.push({ method, path: routePath, handlers });
      }
      let prioritized = 0;
      registerPlaybackRoutes(fakeApp, {
        playbackOrchestrator: {},
        ttsForTier: () => ({}),
        generationJournal: {},
        offlinePreparationCoordinator: {},
        chapterAudioStreamer: {},
        hlsAudioStreamer: {},
        serveAudioFile() {},
        sendServerError(res, error) { res.status(500).json({ error: error.message }); },
        fs: {},
        getBookChapters: async () => ({ book: {}, chapters: [] }),
        getOfflineChapterAudio: async () => ({}),
        canPrioritizeForegroundBook: async () => false,
        prioritizeForegroundBook: () => { prioritized += 1; return {}; }
      });
      const route = routes.find(item => item.method === 'post' && item.path === '/api/playback/foreground/:bookId');
      const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
      };
      await route.handlers.at(-1)({ params: { bookId: 'book-one' } }, res);
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(prioritized, 0);
    });

    await test('authenticated HLS ownership ignores caller-controlled owner ids', () => {
      const req = {
        user: { id: 'account-one', sessionToken: 'opaque-session-token' },
        ip: '127.0.0.1'
      };
      assert.strictEqual(hlsOwnerKey(req, 'owner-a'), hlsOwnerKey(req, 'owner-b'));
      assert.notStrictEqual(
        hlsOwnerKey(req, 'owner-a'),
        hlsOwnerKey({ user: { id: 'account-one', sessionToken: 'other-session-token' }, ip: '127.0.0.1' }, 'owner-a')
      );
    });
    // One deadline contract. The client owns abandonment; cancellation is
    // disconnect-driven (servePlaylist aborts on req 'aborted'/res 'close').
    // The server deadline exists only to stop a socket that never closes from
    // holding an encoder, so it must sit above the client's — never below it,
    // which would kill work a still-waiting client was about to receive.
    await test('the HLS readiness deadline is derived from the client deadline', () => {
      const playerSource = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'js', 'single-file-chapter-player.js'),
        'utf8'
      );
      const hlsSource = fs.readFileSync(
        path.join(__dirname, '..', 'lib', 'hls-audio-stream.js'),
        'utf8'
      );

      const clientDeadline = Number(
        playerSource.match(/export const CLIENT_LOAD_DEADLINE_MS = (\d+)/)?.[1]
      );
      const clientMirror = Number(
        hlsSource.match(/const CLIENT_LOAD_DEADLINE_MS = (\d+)/)?.[1]
      );
      const multiplier = Number(
        hlsSource.match(/const HLS_READY_TIMEOUT_MS = CLIENT_LOAD_DEADLINE_MS \* (\d+)/)?.[1]
      );

      assert.strictEqual(clientDeadline, 30000, 'the client abandons at 30 seconds');
      assert.strictEqual(
        clientMirror,
        clientDeadline,
        'the server mirrors the client deadline exactly'
      );
      assert.ok(Number.isFinite(multiplier) && multiplier >= 2, 'the server deadline is a stated multiple');

      const readyTimeout = clientMirror * multiplier;
      assert.ok(
        readyTimeout > clientDeadline,
        'a still-connected client never has its in-flight encoder killed'
      );
      assert.ok(
        readyTimeout <= 60000,
        'a wedged socket cannot hold an encoder for minutes'
      );
      assert.ok(
        /readyTimeoutMs = HLS_READY_TIMEOUT_MS/.test(hlsSource),
        'the streamer actually uses the derived deadline'
      );
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log(`playback-route tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
