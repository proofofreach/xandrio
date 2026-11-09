const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app } = require('../server');
const { hlsOwnerKey, timelineOwnerKey, registerPlaybackRoutes } = require('../lib/routes/playback-routes');

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

    await test('offline preparation and window requests use the same library gate as foreground priority', async () => {
      const routes = [];
      const fakeApp = {};
      for (const method of ['get', 'post', 'put', 'delete']) {
        fakeApp[method] = (routePath, ...handlers) => routes.push({ method, path: routePath, handlers });
      }
      let prioritized = 0;
      let requested = 0;
      let windows = 0;
      registerPlaybackRoutes(fakeApp, {
        playbackOrchestrator: {},
        ttsForTier: () => ({}),
        generationJournal: {},
        offlinePreparationCoordinator: { request: async () => { requested += 1; return {}; } },
        offlineWindowPreparation: { request: async () => { windows += 1; return {}; } },
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
      for (const routePath of ['/api/offline/preparation/:bookId', '/api/offline/preparation/:bookId/window']) {
        const route = routes.find(item => item.method === 'post' && item.path === routePath);
        const res = {
          statusCode: 200,
          body: null,
          status(code) { this.statusCode = code; return this; },
          json(body) { this.body = body; return this; }
        };
        await route.handlers.at(-1)({ params: { bookId: 'book-one' }, body: {}, user: { id: 'usr_x', role: 'member' } }, res);
        assert.strictEqual(res.statusCode, 404, `${routePath} must refuse a book outside the caller library`);
      }
      assert.strictEqual(prioritized, 0);
      assert.strictEqual(requested, 0);
      assert.strictEqual(windows, 0);
    });

    await test('first-load readiness polls do not consume the generation budget', async () => {
      const isolatedApp = require('express')();
      isolatedApp.use(require('express').json());
      let starts = 0;
      registerPlaybackRoutes(isolatedApp, {
        rateLimitMax: 2,
        playbackOrchestrator: {
          chapterAudioStatus: async () => ({ ready: false, status: 'generating' }),
          startChapterAudio: async () => {
            starts += 1;
            return { ready: false, status: 'generating' };
          }
        },
        sendServerError(res, error) { res.status(500).json({ error: error.message }); }
      });
      const instance = await new Promise(resolve => {
        const listening = isolatedApp.listen(0, '127.0.0.1', () => resolve(listening));
      });
      const origin = `http://127.0.0.1:${instance.address().port}`;
      const prepare = () => fetch(`${origin}/api/chunks/chaos/0/prepare-chapter-audio`, { method: 'POST' });
      try {
        assert.strictEqual((await prepare()).status, 202);
        for (let poll = 0; poll < 65; poll += 1) {
          // Exercise Express decoding and both status representations.
          const suffix = poll % 2 ? '?purpose=playback-runway' : '/';
          const response = await fetch(`${origin}/api/chunks/ch%61os/0/chapter-audio-status${suffix}`);
          assert.strictEqual(response.status, 200, `readiness poll ${poll + 1} must not exhaust generation quota`);
        }
        assert.strictEqual((await prepare()).status, 202, 'polls leave the remaining generation slot available');
        const blocked = await prepare();
        assert.strictEqual(blocked.status, 429, 'generation retains its original limit');
        assert.ok(Number(blocked.headers.get('retry-after')) > 0);
        assert.strictEqual(starts, 2);
      } finally {
        await new Promise(resolve => instance.close(resolve));
      }
    });

    await test('playback routes answer an unplayable section with a typed result, never a 500', async () => {
      const { createPlaybackOrchestrator } = require('../lib/playback-orchestrator');
      // Production 2026-10-18: chapter 12 of 1b2d4d was this divider and
      // prepare-chapter-audio returned 500 on all three client attempts.
      const chapters = [
        { title: 'Chapter 11', type: 'chapter', text: 'Chapter eleven has enough narration to speak aloud.' },
        { title: 'Part 2', type: 'divider', empty: true, text: 'Part 2 \nSEX' },
        { title: 'Heading only', type: 'chapter', text: '* * *' },
        { title: 'Chapter 12', type: 'chapter', text: 'Chapter twelve also has enough narration to speak.' }
      ];
      const unspeakable = () => Object.assign(new Error('Chapter has no speakable text for TTS'), { code: 'CHAPTER_UNSPEAKABLE' });
      const tts = {
        getChapterManifest: () => null,
        generateChapter: async () => { throw unspeakable(); },
        claimChapter: async () => 1,
        prioritizeChunk: () => true,
        reconstructChapterManifest: async () => { throw unspeakable(); },
        hasSpeakableText: async (_bookId, _chapterIndex, text) => text !== '* * *',
        chunkPath: () => '/missing.mp3',
        chapterPath: () => '/missing.mp3',
        currentOutputFormat: () => 'mp3'
      };
      const orchestrator = createPlaybackOrchestrator({
        resolveNarrationContext: async () => ({ tier: 'instant', tts, voice: 'edge:andrew' }),
        isPremiumVoiceActive: () => false,
        ensureChapterAudio: async () => { throw unspeakable(); },
        inspectChapterAudio: async () => ({ ready: false, status: 'pending', totalChunks: 0, readyChunks: 0 }),
        getChapterContext: async (_bookId, chapterIndex) => ({
          book: { language: 'en' },
          chapter: chapters[chapterIndex],
          chapters
        }),
        manifestNeedsResume: () => false,
        generationPriority: () => () => 'immediate'
      });
      const isolatedApp = require('express')();
      isolatedApp.use(require('express').json());
      const serverErrors = [];
      registerPlaybackRoutes(isolatedApp, {
        playbackOrchestrator: orchestrator,
        getBookChapters: async () => ({ book: {}, chapters }),
        chapterAudioStreamer: { isClientDisconnect: () => false },
        hlsAudioStreamer: {},
        serveAudioFile() { throw new Error('unplayable audio must not be served'); },
        sendServerError(res, error) {
          serverErrors.push(error);
          res.status(500).json({ error: error.message });
        }
      });
      const instance = await new Promise(resolve => {
        const listening = isolatedApp.listen(0, '127.0.0.1', () => resolve(listening));
      });
      const origin = `http://127.0.0.1:${instance.address().port}`;
      try {
        for (const chapterIndex of [1, 2]) {
          for (const body of [
            { purpose: 'playback-runway', offsetSeconds: 0, playbackRate: 1 },
            {}
          ]) {
            const response = await fetch(`${origin}/api/chunks/book1/${chapterIndex}/prepare-chapter-audio`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            assert.strictEqual(response.status, 200, `prepare ${chapterIndex} ${body.purpose || 'background'}`);
            const detail = await response.json();
            assert.strictEqual(detail.status, 'unplayable');
            assert.strictEqual(detail.retryable, false);
            assert.strictEqual(detail.code, 'CHAPTER_UNSPEAKABLE');
            // The structural rule cannot see that chapter 2 is unspeakable;
            // the client learns that from chapter 2's own typed result.
            assert.strictEqual(detail.nextPlayableChapterIndex, chapterIndex + 1);
          }
        }
        const runwayStatus = await fetch(`${origin}/api/chunks/book1/1/chapter-audio-status?purpose=playback-runway`);
        assert.strictEqual(runwayStatus.status, 200);
        assert.strictEqual((await runwayStatus.json()).status, 'unplayable');
        for (const route of [
          '/api/audio/book1/1',
          '/api/audio/book1/2',
          '/api/audio-ios/book1/1',
          '/api/audio-ios/book1/2',
          '/api/audio-stream/book1/1',
          '/api/audio-continuous/book1/1',
          '/api/audio-hls/book1/1/index.m3u8?session=session-0001&owner=owner-0001'
        ]) {
          const response = await fetch(`${origin}${route}`);
          assert.strictEqual(response.status, 422, route);
          const detail = await response.json();
          assert.strictEqual(detail.code, 'CHAPTER_UNSPEAKABLE', route);
          assert.strictEqual(detail.retryable, false, route);
          assert.strictEqual(detail.nextPlayableChapterIndex, Number(route.split('/')[4]) + 1, route);
        }
        assert.deepStrictEqual(serverErrors, [], 'no unplayable section reaches the 500 handler');
      } finally {
        await new Promise(resolve => instance.close(resolve));
      }
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
    // A routes-only app over a stub orchestrator, with an optional signed-in user.
    const isolatedRoutes = async (orchestrator, { user = null, files = fs.promises, journal = null } = {}) => {
      const express = require('express');
      const { createChapterAudioStreamer } = require('../lib/chapter-audio-stream');
      const isolatedApp = express();
      isolatedApp.use(express.json());
      if (user) isolatedApp.use((req, _res, next) => { req.user = user; next(); });
      registerPlaybackRoutes(isolatedApp, {
        playbackOrchestrator: orchestrator,
        ttsForTier: () => ({ variantKeyProvider: () => 'default-variant' }),
        generationJournal: journal || { listQuarantinedChapters: async () => [] },
        chapterAudioStreamer: createChapterAudioStreamer({ serveAudioFile: async (_req, res) => res.end() }),
        hlsAudioStreamer: {},
        serveAudioFile: async (_req, res) => res.status(200).end('audio'),
        sendServerError(res, error) { res.status(500).json({ error: error.message }); },
        fs: files,
        getBookChapters: async () => ({ chapters: [{ text: 'Chapter zero with narration text.' }] })
      });
      const instance = await new Promise(resolve => {
        const listening = isolatedApp.listen(0, '127.0.0.1', () => resolve(listening));
      });
      return { origin: `http://127.0.0.1:${instance.address().port}`, close: () => new Promise(resolve => instance.close(resolve)) };
    };

    await test('continuous timelines are read in the requesting owner\'s scope', async () => {
      assert.strictEqual(timelineOwnerKey({ user: { id: 'account-one' }, ip: '10.0.0.1' }), 'account:account-one');
      assert.strictEqual(timelineOwnerKey({ ip: '10.0.0.1' }), 'legacy', 'the poll carries no device owner in legacy modes');
      assert.strictEqual(
        timelineOwnerKey({ user: { id: 'account-one', sessionToken: 'opaque-session-token' } }),
        hlsOwnerKey({ user: { id: 'account-one', sessionToken: 'opaque-session-token' } }, 'ignored')
      );
      const reads = [];
      const prepares = [];
      const routes = await isolatedRoutes({
        continuousTimeline: (...args) => { reads.push(args); return { durations: [] }; },
        chapterAudioStatus: async () => ({ ready: true }),
        prepareContinuousAudioStream: async options => {
          prepares.push(options);
          throw Object.assign(new Error('stop'), { statusCode: 404 });
        }
      }, { user: { id: 'account-one' } });
      try {
        assert.strictEqual((await fetch(`${routes.origin}/api/audio-timeline/session-123456`)).status, 200);
        assert.deepStrictEqual(reads, [['session-123456', 'account:account-one']]);
        await (await fetch(`${routes.origin}/api/audio-continuous/book_one/0?session=session-123456`)).text();
        assert.strictEqual(prepares[0].ownerKey, 'account:account-one', 'the stream registers in the same scope');
      } finally {
        await routes.close();
      }
    });

    await test('a stream whose book or narration plan changed answers 410, not 500', async () => {
      for (const code of ['CHAPTER_STRUCTURE_CHANGED', 'CHUNK_PLAN_CHANGED']) {
        const routes = await isolatedRoutes({
          chapterAudioStatus: async () => ({ ready: true }),
          prepareContinuousAudioStream: async () => { throw Object.assign(new Error('changed'), { statusCode: 410, code }); },
          prepareAudioStream: async () => { throw Object.assign(new Error('changed'), { statusCode: 410, code }); }
        });
        try {
          for (const route of ['audio-continuous', 'audio-stream']) {
            const response = await fetch(`${routes.origin}/api/${route}/book_one/0`);
            assert.strictEqual(response.status, 410, `${route} ${code}`);
            assert.strictEqual((await response.json()).code, code);
          }
        } finally {
          await routes.close();
        }
      }
    });

    await test('chunk status reports quarantine for the pinned narrator it describes', async () => {
      const resolutions = [];
      const routes = await isolatedRoutes({
        chunkStatus: async () => ({ totalChunks: 1, readyChunks: 0, errorChunks: 1, status: 'error' }),
        resolveTier: async (_bookId, _chapterIndex, requested) => {
          resolutions.push(requested);
          const voiceId = typeof requested === 'object' ? requested.voiceId : null;
          return { tier: 'active', tts: { variantKeyProvider: () => voiceId ? `variant-${voiceId}` : 'default-variant' } };
        }
      }, {
        journal: {
          listQuarantinedChapters: async () => [{ bookId: 'book_one', chapterIndex: 0, variantKey: 'variant-narrator', attempts: 3 }]
        }
      });
      try {
        const response = await fetch(`${routes.origin}/api/chunks/book_one/0/status?tier=premium&voiceId=narrator`);
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(resolutions.at(-1), { tier: 'premium', voiceId: 'narrator' });
        assert.strictEqual((await response.json()).recovery.quarantined, true);
      } finally {
        await routes.close();
      }
    });

    await test('an empty chunk file is invalidated in its manifest and re-queued, not just deleted', async () => {
      const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xandrio-empty-chunk-'));
      const chunkPath = path.join(tmp, 'chunk.mp3');
      fs.writeFileSync(chunkPath, '');
      const calls = [];
      const routes = await isolatedRoutes({
        chunkAccess: async () => ({
          servedTier: 'premium',
          voiceId: 'narrator',
          path: chunkPath,
          status: 'ready',
          tts: { invalidateCachedChunk: async (...args) => { calls.push(['invalidate', ...args]); fs.rmSync(chunkPath, { force: true }); } }
        }),
        prioritizeChunk: async options => { calls.push(['prioritize', options]); return { success: true }; }
      });
      try {
        const response = await fetch(`${routes.origin}/api/chunks/book_one/2/5`);
        assert.strictEqual(response.status, 202);
        assert.deepStrictEqual(calls[0], ['invalidate', 'book_one', 2, 5]);
        assert.strictEqual(calls[1]?.[0], 'prioritize', 'the regeneration the response promises is requested');
        assert.deepStrictEqual(calls[1][1], {
          bookId: 'book_one', chapterIndex: 2, chunkIndex: 5, requestedTier: { tier: 'premium', voiceId: 'narrator' }
        });
      } finally {
        await routes.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    await test('a chapter rebuild retires the book\'s live streams and timelines', () => {
      const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      const hook = serverSource.slice(serverSource.indexOf('chapterRebuildService = createChapterRebuildService('));
      const afterCommit = hook.slice(hook.indexOf('afterCommit:'), hook.indexOf('onPostCommitError:'));
      assert.match(afterCommit, /playbackOrchestrator\.evictBookTimelines\(bookId\)/);
      assert.match(afterCommit, /hlsAudioStreamer\.evictBook\(bookId\)/);
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
