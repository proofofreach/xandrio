const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

// Minimal stand-in for an HTMLAudioElement: records listeners so a test can
// fire media events by hand and assert which loads they settle.
function fakeAudio() {
  const listeners = new Map();
  return {
    listeners,
    src: '',
    preload: '',
    volume: 1,
    playbackRate: 1,
    currentTime: 0,
    duration: 10,
    readyState: 4,
    networkState: 1,
    paused: true,
    ended: false,
    error: null,
    buffered: {
      length: 1,
      start() { return 0; },
      end() { return 10; }
    },
    loadCalls: 0,
    playCalls: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    countFor(type) {
      return listeners.get(type)?.size || 0;
    },
    emit(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type });
    },
    load() { this.loadCalls += 1; },
    pause() { this.paused = true; },
    async play() { this.playCalls += 1; this.paused = false; },
    removeAttribute() { this.src = ''; }
  };
}

(async () => {
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'lifecycle.js'),
    'utf8'
  );
  Function(lifecycleSource)();
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'single-file-chapter-player.js'),
    'utf8'
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { SingleFileChapterPlayer } = await import(moduleUrl);

  function makePlayer(audio, extra = {}) {
    const ready = [];
    const player = new SingleFileChapterPlayer(audio, {
      onReady: () => ready.push(player.chapterIndex),
      loadTimeoutMs: 50,
      playTimeoutMs: 50,
      preparePlaybackRunway: false,
      ...extra
    });
    return { player, ready };
  }

  await test('continuous transports wait for the shared playback runway', async () => {
    for (const iosLike of [false, true]) {
      const audio = fakeAudio();
      audio.canPlayType = type => type === 'application/vnd.apple.mpegurl' ? 'maybe' : '';
      const requests = [];
      let statusPolls = 0;
      const { player } = makePlayer(audio, {
        isIOSLike: () => iosLike,
        getChapterCount: () => 4,
        getContinuousEndChapter: () => 3,
        resolveServedTier: async () => 'instant',
        preparePlaybackRunway: true,
        runwayPollIntervalMs: 1,
        fetch: async (url, options = {}) => {
          requests.push({ url, options });
          const polls = options.method === 'POST' ? 0 : ++statusPolls;
          const ready = options.method !== 'POST' && polls >= 2;
          return {
            ok: true,
            status: ready ? 200 : 202,
            async json() {
              return {
                ready,
                status: ready ? 'ready' : 'generating',
                readyChunks: ready ? 8 : polls,
                totalChunks: 8
              };
            }
          };
        }
      });
      player.setSpeed(1.25);

      const load = player.loadChapter('book1', 2, { startOffsetSeconds: 45 });
      await new Promise(resolve => setTimeout(resolve, 1));
      assert.strictEqual(audio.src, '', 'media transport stays closed while runway is generating');
      await new Promise(resolve => setTimeout(resolve, 10));

      const preparations = requests.filter(request => request.options.method === 'POST');
      assert.strictEqual(preparations.length, 1, 'the server owns the complete runway');
      assert.match(preparations[0].url, /\/api\/chunks\/book1\/2\/prepare-chapter-audio\?tier=/);
      assert.deepStrictEqual(JSON.parse(preparations[0].options.body), {
        purpose: 'playback-runway',
        playbackRate: 1.25,
        offsetSeconds: 45,
        endChapterIndex: 3
      });
      assert(
        requests.some(request => (
          request.url.includes('/chapter-audio-status')
          && request.url.includes('purpose=playback-runway')
          && request.url.includes('endChapter=3')
        )),
        'readiness is polled without holding a media encoder open'
      );
      const mediaUrl = new URL(audio.src, 'https://xandrio.test');
      assert.strictEqual(
        mediaUrl.pathname,
        iosLike
          ? '/api/audio-hls/book1/2/index.m3u8'
          : '/api/audio-continuous/book1/2'
      );
      assert(mediaUrl.searchParams.get('session'));

      audio.emit('loadedmetadata');
      await load;
    }
  });

  await test('a failed runway stops preparation instead of polling forever', async () => {
    const audio = fakeAudio();
    const errors = [];
    const { player } = makePlayer(audio, {
      preparePlaybackRunway: true,
      onError: error => errors.push(error),
      fetch: async () => ({
        ok: true,
        status: 202,
        async json() {
          return { ready: false, status: 'error', errorChunks: 1, totalChunks: 8 };
        }
      })
    });

    await assert.rejects(
      player.loadChapter('book1', 0),
      /Narration generation failed while preparing playback runway/
    );
    assert.strictEqual(audio.src, '');
    assert.strictEqual(errors.length, 1);
  });

  await test('an automatic runway tier pins the media transport when the tier probe fails', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, {
      preparePlaybackRunway: true,
      resolveServedTier: async () => { throw new Error('tier probe unavailable'); },
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            ready: true,
            status: 'ready',
            servedTier: 'premium',
            readyChunks: 8,
            totalChunks: 8
          };
        }
      })
    });

    const load = player.loadChapter('book1', 0);
    await new Promise(resolve => setTimeout(resolve, 1));
    const mediaUrl = new URL(audio.src, 'https://xandrio.test');
    assert.strictEqual(mediaUrl.searchParams.get('tier'), 'premium');
    audio.emit('loadedmetadata');
    await load;
  });

  await test('a superseded load rejects promptly and never fires onReady', async () => {
    const audio = fakeAudio();
    const { player, ready } = makePlayer(audio);

    const first = player.loadChapter('book1', 0);
    const second = player.loadChapter('book1', 1);
    const firstCancelled = assert.rejects(first, error => error?.cancelled === true);
    audio.emit('loadedmetadata');
    await Promise.all([firstCancelled, second]);

    assert.deepStrictEqual(ready, [1], 'only the current chapter reports ready');
  });

  await test('loads one continuous book stream first and falls back on the same media element', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);

    const load = player.loadChapter('book 1', 2);
    assert.match(audio.src, /^\/api\/audio-continuous\/book%201\/2\?session=/);

    audio.error = { message: 'stream unavailable' };
    audio.emit('error');
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(audio.src, '/api/audio/book%201/2');
    audio.error = null;
    audio.emit('loadedmetadata');
    await load;
  });

  await test('downloaded playback uses the account-scoped offline media URL', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, {
      preferStandardAudio: true,
      resolveOfflineAudioUrl: (bookId, chapterIndex) =>
        `/api/audio/${bookId}/${chapterIndex}?xandrio-offline-scope=account_a`
    });

    const load = player.loadChapter('book1', 2);
    assert.strictEqual(
      audio.src,
      '/api/audio/book1/2?xandrio-offline-scope=account_a'
    );
    audio.emit('loadedmetadata');
    await load;
  });

  await test('play refuses an in-flight load until the new source is ready', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);
    const load = player.loadChapter('book1', 1);
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(player.isPreparingSource(), true, 'a load in flight is preparing');
    assert.strictEqual(
      player.ownsReadySource('book1', 1),
      false,
      'the requested chapter is not playable before media is ready'
    );
    await assert.rejects(
      player.play(),
      error => error?.code === 'SOURCE_NOT_READY',
      'play() must not start the previous source during a chapter load'
    );
    assert.strictEqual(audio.playCalls, 0);

    audio.emit('loadedmetadata');
    await load;
    assert.strictEqual(player.isPreparingSource(), false);
    assert.strictEqual(player.ownsReadySource('book1', 1), true);
    assert.strictEqual(player.ownsReadySource('book1', 0), false);

    const play = player.play();
    audio.emit('playing');
    audio.currentTime = 1;
    audio.emit('timeupdate');
    await play;
    assert.strictEqual(audio.playCalls, 1);
  });

  await test('a ready continuous source still owns later chapters in its range', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, { getChapterCount: () => 4 });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    assert.strictEqual(player.ownsReadySource('book1', 0), true);
    assert.strictEqual(player.ownsReadySource('book1', 2), true);
    assert.strictEqual(player.ownsReadySource('other', 0), false);
  });

  await test('continuous first listening needs only the original play call', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    const play = player.play();
    audio.emit('playing');
    audio.currentTime = 45;
    audio.emit('timeupdate');
    await play;
    audio.currentTime = 90;
    audio.emit('timeupdate');

    assert.match(audio.src, /^\/api\/audio-continuous\/book1\/0\?session=/);
    assert.strictEqual(audio.playCalls, 1);
    assert.deepStrictEqual(
      { backend: player.getPosition().backend, isPlaying: player.getPosition().isPlaying },
      { backend: 'audio-stream', isPlaying: true }
    );
  });

  await test('streamed WAV uses chapter timing and preserves the resolved tier', async () => {
    const audio = fakeAudio();
    audio.duration = Infinity;
    audio.currentTime = 30;
    const { player } = makePlayer(audio, {
      getEstimatedDuration: (_bookId, chapterIndex) => chapterIndex === 2 ? 120 : 0,
      resolveServedTier: async () => 'instant'
    });
    const load = player.loadChapter('book1', 2);
    await new Promise(resolve => setImmediate(resolve));
    audio.emit('loadedmetadata');
    await load;

    assert.strictEqual(player.getTotalTime(), 120);
    assert.strictEqual(player.getProgressPercent(), 25);
    assert.strictEqual(player.servedTier, 'instant');
    assert.strictEqual(player.getPosition().totalEstimatedTime, 30);
    assert.match(audio.src, /^\/api\/audio-continuous\/book1\/2\?tier=instant&session=/);
  });

  await test('iOS-like native HLS is selected without an open-ended MP3 probe', async () => {
    const audio = fakeAudio();
    audio.canPlayType = type => type === 'application/vnd.apple.mpegurl' ? 'maybe' : '';
    const { player } = makePlayer(audio, { isIOSLike: () => true });
    const load = player.loadChapter('book1', 0);
    assert.match(audio.src, /^\/api\/audio-hls\/book1\/0\/index\.m3u8\?session=/);
    const hlsUrl = new URL(audio.src, 'https://xandrio.test');
    assert.match(hlsUrl.searchParams.get('owner'), /^[A-Za-z0-9_-]{8,64}$/);
    audio.emit('loadedmetadata');
    await load;
    assert.strictEqual(player.isContinuous, true);
  });

  await test('iOS without native HLS skips open-ended MP3 and loads finite chapter audio', async () => {
    const audio = fakeAudio();
    audio.canPlayType = () => '';
    const { player } = makePlayer(audio, { isIOSLike: () => true });
    const load = player.loadChapter('book1', 0);

    assert.strictEqual(audio.src, '/api/audio-ios/book1/0');
    audio.emit('loadedmetadata');
    await load;
    assert.strictEqual(player.isContinuous, false);
  });

  await test('playback session identity uses secure random bytes when randomUUID is unavailable', () => {
    const values = Array.from({ length: 16 }, (_value, index) => index);
    const { player } = makePlayer(fakeAudio(), {
      cryptoProvider: {
        getRandomValues(bytes) {
          bytes.set(values);
          return bytes;
        }
      }
    });
    assert.strictEqual(
      player._newPlaybackSessionId(),
      '00010203-0405-4607-8809-0a0b0c0d0e0f'
    );
  });

  await test('native HLS falls back directly to finite chapter audio', async () => {
    const audio = fakeAudio();
    audio.canPlayType = type => type === 'application/vnd.apple.mpegurl' ? 'maybe' : '';
    const { player } = makePlayer(audio, { isIOSLike: () => true });
    const load = player.loadChapter('book1', 0);
    audio.error = { message: 'HLS unavailable' };
    audio.emit('error');
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(audio.src, '/api/audio-ios/book1/0');
    audio.error = null;
    audio.emit('loadedmetadata');
    await load;
    assert.strictEqual(player.isContinuous, false);
  });

  await test('end-of-chapter transport limits reload with a stable HLS owner', async () => {
    const audio = fakeAudio();
    audio.canPlayType = type => type === 'application/vnd.apple.mpegurl' ? 'maybe' : '';
    const { player } = makePlayer(audio, {
      isIOSLike: () => true,
      getChapterCount: () => 4,
      getEstimatedDuration: () => 60
    });
    const load = player.loadChapter('book1', 1);
    audio.emit('loadedmetadata');
    await load;
    const initial = new URL(audio.src, 'https://xandrio.test');
    audio.paused = false;
    player._isPlaying = true;

    const arm = player.setContinuousEndChapter(1);
    await new Promise(resolve => setImmediate(resolve));
    const armed = new URL(audio.src, 'https://xandrio.test');
    assert.strictEqual(armed.searchParams.get('endChapter'), '1');
    assert.strictEqual(armed.searchParams.get('owner'), initial.searchParams.get('owner'));
    audio.emit('loadedmetadata');
    await arm;

    const cancel = player.setContinuousEndChapter(null);
    await new Promise(resolve => setImmediate(resolve));
    const cancelled = new URL(audio.src, 'https://xandrio.test');
    assert.strictEqual(cancelled.searchParams.has('endChapter'), false);
    assert.strictEqual(cancelled.searchParams.get('owner'), initial.searchParams.get('owner'));
    audio.emit('loadedmetadata');
    await cancel;
    assert.strictEqual(audio.playCalls, 2, 'arming and cancellation both preserve active playback');
  });

  await test('a nonseekable progressive stream reconnects at a server-side offset', async () => {
    const audio = fakeAudio();
    audio.seekable = { length: 0, start() { return 0; }, end() { return 0; } };
    const { player } = makePlayer(audio, {
      getEstimatedDuration: () => 60
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    const originalSource = audio.src;

    const seek = player.seek(18);
    await new Promise(resolve => setImmediate(resolve));
    assert.notStrictEqual(audio.src, originalSource);
    assert.match(audio.src, /offsetSeconds=18/);
    audio.currentTime = 0;
    audio.emit('loadedmetadata');
    await seek;
    assert.strictEqual(player.getCurrentTime(), 18);
  });

  await test('a false-positive seekable range cannot strand a restored stream outside its buffer', async () => {
    const audio = fakeAudio();
    audio.seekable = {
      length: 1,
      start() { return 0; },
      end() { return Infinity; }
    };
    audio.buffered = {
      length: 0,
      start() { return 0; },
      end() { return 0; }
    };
    const { player } = makePlayer(audio, {
      getEstimatedDuration: () => 60
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    const originalSource = audio.src;

    const seek = player.seek(18);
    await new Promise(resolve => setImmediate(resolve));

    assert.notStrictEqual(
      audio.src,
      originalSource,
      'an unbuffered target must reopen the transport instead of trusting seekable'
    );
    assert.match(audio.src, /offsetSeconds=18/);
    audio.currentTime = 0;
    audio.emit('loadedmetadata');
    await seek;
    assert.strictEqual(player.getCurrentTime(), 18);
  });

  await test('timeline polling replaces estimates with decoded chapter durations', async () => {
    const audio = fakeAudio();
    const fetchCalls = [];
    const { player } = makePlayer(audio, {
      getChapterCount: () => 2,
      getEstimatedDuration: () => 10,
      fetch: async url => {
        fetchCalls.push(url);
        return {
          ok: true,
          async json() {
            return {
              startChapterIndex: 0,
              durations: [6, 8]
            };
          }
        };
      }
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    await new Promise(resolve => setImmediate(resolve));
    audio.currentTime = 6.5;
    audio.emit('timeupdate');
    assert.strictEqual(player.chapterIndex, 1);
    assert.strictEqual(player.getCurrentTime(), 0.5);
    assert.strictEqual(fetchCalls.length >= 1, true);
    player.dispose();
  });

  await test('timeline polling applies the server-clamped seek offset', async () => {
    const audio = fakeAudio();
    audio.buffered = {
      length: 0,
      start() { return 0; },
      end() { return 0; }
    };
    let fetchCalls = 0;
    const { player } = makePlayer(audio, {
      getChapterCount: () => 1,
      getEstimatedDuration: () => 60,
      fetch: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          async json() {
            return {
              startChapterIndex: 0,
              startOffsetSeconds: fetchCalls === 1 ? 0 : 30,
              durations: [40]
            };
          }
        };
      }
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    await new Promise(resolve => setImmediate(resolve));

    const seek = player.seek(50);
    await new Promise(resolve => setImmediate(resolve));
    audio.currentTime = 0;
    audio.emit('loadedmetadata');
    await seek;
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(player.streamStartOffset, 30);
    assert.strictEqual(player.getCurrentTime(), 30);
    assert.strictEqual(player.requestedStartOffset, 40);
    assert.strictEqual(
      player.openedAtOffset(0, 40),
      true,
      'the immutable requested offset survives a mapped timeline update'
    );
    player.dispose();
  });

  await test('maps continuous stream time across chapters without replacing src', async () => {
    const audio = fakeAudio();
    audio.duration = Infinity;
    const transitions = [];
    const durations = [10, 20, 30];
    const { player } = makePlayer(audio, {
      getChapterCount: () => durations.length,
      getEstimatedDuration: (_bookId, chapterIndex) => durations[chapterIndex],
      onChapterTransition: detail => transitions.push(detail)
    });
    const load = player.loadChapter('book1', 1);
    audio.emit('loadedmetadata');
    await load;
    const source = audio.src;
    const loadCalls = audio.loadCalls;

    audio.currentTime = 21;
    audio.emit('timeupdate');

    assert.strictEqual(audio.src, source);
    assert.strictEqual(audio.loadCalls, loadCalls);
    assert.strictEqual(player.chapterIndex, 2);
    assert.strictEqual(player.getCurrentTime(), 1);
    assert.strictEqual(player.getTotalTime(), 30);
    assert.deepStrictEqual(transitions, [{
      previousChapterIndex: 1,
      chapterIndex: 2,
      chapterTime: 1,
      streamTime: 21
    }]);
  });

  await test('skips zero-duration structural chapters in the continuous time map', async () => {
    const audio = fakeAudio();
    audio.duration = Infinity;
    const transitions = [];
    const durations = [10, 0, 20];
    const { player } = makePlayer(audio, {
      getChapterCount: () => durations.length,
      getEstimatedDuration: (_bookId, chapterIndex) => durations[chapterIndex],
      onChapterTransition: detail => transitions.push(detail)
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    audio.currentTime = 11;
    audio.emit('timeupdate');

    assert.strictEqual(player.chapterIndex, 2);
    assert.strictEqual(player.getCurrentTime(), 1);
    assert.strictEqual(transitions.at(-1).chapterIndex, 2);
  });

  await test('treats premature continuous EOF as recoverable instead of finishing the book', async () => {
    const audio = fakeAudio();
    audio.duration = Infinity;
    const errors = [];
    let chapterEnds = 0;
    const durations = [10, 20, 30];
    const { player } = makePlayer(audio, {
      getChapterCount: () => durations.length,
      getEstimatedDuration: (_bookId, chapterIndex) => durations[chapterIndex],
      onChapterEnd: () => { chapterEnds += 1; },
      onError: error => errors.push(error)
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    audio.currentTime = 15;
    audio.ended = true;
    audio.emit('ended');

    assert.strictEqual(player.chapterIndex, 1);
    assert.strictEqual(chapterEnds, 0);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'CONTINUOUS_STREAM_EOF');
    assert.strictEqual(errors[0].recoverable, true);
  });

  await test('continuous EOF finishes only after playback maps into the final chapter', async () => {
    const audio = fakeAudio();
    audio.duration = Infinity;
    const errors = [];
    let chapterEnds = 0;
    const durations = [10, 20, 30];
    const { player } = makePlayer(audio, {
      getChapterCount: () => durations.length,
      getEstimatedDuration: (_bookId, chapterIndex) => durations[chapterIndex],
      onChapterEnd: () => { chapterEnds += 1; },
      onError: error => errors.push(error)
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    audio.currentTime = 55;
    audio.ended = true;
    audio.emit('ended');

    assert.strictEqual(player.chapterIndex, 2);
    assert.strictEqual(chapterEnds, 1);
    assert.deepStrictEqual(errors, []);
  });

  await test('server EOF at an explicit chapter limit is intentional and never recoverable', async () => {
    const audio = fakeAudio();
    audio.duration = Infinity;
    const errors = [];
    const chapterEnds = [];
    const { player } = makePlayer(audio, {
      getChapterCount: () => 3,
      getEstimatedDuration: () => 20,
      getContinuousEndChapter: () => 1,
      onChapterEnd: detail => chapterEnds.push(detail),
      onError: error => errors.push(error)
    });
    const load = player.loadChapter('book1', 1);
    assert.match(audio.src, /[?&]endChapter=1(?:&|$)/);
    audio.emit('loadedmetadata');
    await load;

    audio.currentTime = 20;
    audio.ended = true;
    audio.emit('ended');

    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(chapterEnds, [{
      reason: 'continuous-limit',
      endChapterIndex: 1
    }]);
    assert.strictEqual(
      player.ownsReadySource('book1', 1),
      false,
      'an ended chapter-limit stream is not a ready source'
    );
    await assert.rejects(
      player.play(),
      error => error?.code === 'SOURCE_NOT_READY'
    );
  });

  await test('offline playback keeps the per-chapter standard audio source', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, {
      isIOSLike: () => true
    });
    player.preferStandardAudio = true;

    const load = player.loadChapter('book1', 2);
    audio.emit('loadedmetadata');
    await load;

    assert.strictEqual(audio.src, '/api/audio/book1/2');
    assert.strictEqual(player.isContinuous, false);
  });

  // A locked phone suspends the page and its service worker the moment audio
  // stops, so a per-chapter source that is only fetched after `ended` never
  // loads: the boundary becomes a permanent pause with a dead lock screen.
  // These cover the pre-warm that keeps the handoff off the network.
  async function playDownloadedChapter(player, audio, options = {}) {
    const load = player.loadChapter('book1', options.chapterIndex ?? 0);
    audio.emit('loadedmetadata');
    await load;
    const play = player.play();
    audio.emit('playing');
    audio.currentTime = 1;
    audio.emit('timeupdate');
    await play;
    // Let the pre-warm fetch and its blob read settle.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  }

  function downloadedPlayer(audio, extra = {}) {
    const fetched = [];
    const advances = [];
    const chapterEnds = [];
    const { player } = makePlayer(audio, {
      preferStandardAudio: true,
      getChapterCount: () => 3,
      resolveOfflineAudioUrl: (bookId, chapterIndex) => `/offline/${bookId}/${chapterIndex}`,
      resolveNextChapterUrl: async (bookId, chapterIndex) => `/offline/${bookId}/${chapterIndex}`,
      fetch: async url => {
        fetched.push(url);
        return { ok: true, status: 200, async blob() { return new Blob(['audio']); } };
      },
      onChapterAdvance: detail => advances.push(detail),
      onChapterEnd: detail => chapterEnds.push(detail ?? null),
      ...extra
    });
    return { player, fetched, advances, chapterEnds };
  }

  await test('a downloaded next chapter takes over the element inside the ended event', async () => {
    const audio = fakeAudio();
    const { player, fetched, advances, chapterEnds } = downloadedPlayer(audio);
    await playDownloadedChapter(player, audio);

    assert.deepStrictEqual(fetched, ['/offline/book1/1']);
    const playCallsBeforeBoundary = audio.playCalls;

    audio.currentTime = 10;
    audio.ended = true;
    audio.emit('ended');

    // Asserted before any await: the swap and the play() call both have to
    // happen in the media event's own task, with no load and no network.
    assert.match(audio.src, /^blob:/);
    assert.strictEqual(audio.playCalls, playCallsBeforeBoundary + 1);
    assert.strictEqual(player.chapterIndex, 1);
    assert.deepStrictEqual(advances, [{
      previousChapterIndex: 0,
      chapterIndex: 1,
      chapterTime: 0
    }]);
    assert.deepStrictEqual(chapterEnds, []);
    player.dispose();
  });

  await test('a chapter with no local successor still ends the ordinary way', async () => {
    const audio = fakeAudio();
    const { player, fetched, advances, chapterEnds } = downloadedPlayer(audio, {
      resolveNextChapterUrl: async () => null
    });
    await playDownloadedChapter(player, audio);

    assert.deepStrictEqual(fetched, []);
    audio.ended = true;
    audio.emit('ended');

    assert.strictEqual(player.chapterIndex, 0);
    assert.deepStrictEqual(advances, []);
    assert.strictEqual(chapterEnds.length, 1);
  });

  await test('a chapter that cannot be pre-warmed is looked up once, not every timeupdate', async () => {
    const audio = fakeAudio();
    const lookups = [];
    const { player, fetched } = downloadedPlayer(audio, {
      resolveNextChapterUrl: async (_bookId, chapterIndex) => {
        lookups.push(chapterIndex);
        return null;
      }
    });
    await playDownloadedChapter(player, audio);
    for (let tick = 0; tick < 5; tick++) {
      audio.currentTime += 1;
      audio.emit('timeupdate');
      await new Promise(resolve => setImmediate(resolve));
    }

    assert.deepStrictEqual(lookups, [1]);
    assert.deepStrictEqual(fetched, []);
  });

  await test('a failed pre-warm is not retried for the rest of the chapter', async () => {
    const audio = fakeAudio();
    const attempts = [];
    const { player } = downloadedPlayer(audio, {
      fetch: async url => {
        attempts.push(url);
        return { ok: false, status: 503 };
      }
    });
    await playDownloadedChapter(player, audio);
    for (let tick = 0; tick < 5; tick++) {
      audio.currentTime += 1;
      audio.emit('timeupdate');
      await new Promise(resolve => setImmediate(resolve));
    }

    assert.deepStrictEqual(attempts, ['/offline/book1/1']);
  });

  // A streamed session normally rides one continuous transport, which never
  // changes source at a chapter end. When it has fallen back to finite chapter
  // audio it has the same boundary to cross as a download, over the network.
  await test('a streamed chapter fallback pre-warms its own next chapter source', async () => {
    const audio = fakeAudio();
    audio.canPlayType = () => '';
    const fetched = [];
    const advances = [];
    const { player } = makePlayer(audio, {
      isIOSLike: () => true,
      getChapterCount: () => 3,
      resolveServedTier: async () => 'premium',
      resolveNextChapterUrl: async () => null,
      fetch: async url => {
        fetched.push(url);
        return { ok: true, status: 200, async blob() { return new Blob(['audio']); } };
      },
      onChapterAdvance: detail => advances.push(detail)
    });

    const load = player.loadChapter('book1', 0);
    await new Promise(resolve => setImmediate(resolve));
    audio.emit('loadedmetadata');
    await load;
    assert.strictEqual(player.isContinuous, false, 'iOS without HLS uses finite chapter audio');

    const play = player.play();
    audio.emit('playing');
    audio.currentTime = 1;
    audio.emit('timeupdate');
    await play;
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepStrictEqual(fetched, ['/api/audio-ios/book1/1?tier=premium']);

    audio.ended = true;
    audio.emit('ended');
    assert.match(audio.src, /^blob:/);
    assert.strictEqual(advances.length, 1);
    player.dispose();
  });

  await test('a download never pre-warms a streamed chapter behind the listener\'s back', async () => {
    const audio = fakeAudio();
    const fetched = [];
    const { player } = downloadedPlayer(audio, {
      resolveNextChapterUrl: async () => null,
      fetch: async url => {
        fetched.push(url);
        return { ok: true, status: 200, async blob() { return new Blob(['audio']); } };
      }
    });
    await playDownloadedChapter(player, audio);

    assert.deepStrictEqual(fetched, []);
  });

  await test('a boundary reached mid-download abandons the pre-warm fetch', async () => {
    const audio = fakeAudio();
    audio.canPlayType = () => '';
    let aborted = false;
    const { player } = makePlayer(audio, {
      isIOSLike: () => true,
      getChapterCount: () => 3,
      resolveNextChapterUrl: async () => null,
      fetch: (_url, options = {}) => new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })
    });

    const load = player.loadChapter('book1', 0);
    await new Promise(resolve => setImmediate(resolve));
    audio.emit('loadedmetadata');
    await load;
    const play = player.play();
    audio.emit('playing');
    audio.currentTime = 1;
    audio.emit('timeupdate');
    await play;
    await new Promise(resolve => setImmediate(resolve));

    audio.ended = true;
    audio.emit('ended');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(aborted, true);
  });

  await test('a sleep timer that stops at this chapter neither pre-warms nor advances', async () => {
    const audio = fakeAudio();
    const { player, fetched, advances, chapterEnds } = downloadedPlayer(audio, {
      getContinuousEndChapter: () => 0
    });
    await playDownloadedChapter(player, audio);

    assert.deepStrictEqual(fetched, []);
    audio.ended = true;
    audio.emit('ended');

    assert.deepStrictEqual(advances, []);
    assert.strictEqual(chapterEnds.length, 1);
  });

  await test('a sleep timer armed mid-chapter still stops at the boundary', async () => {
    const audio = fakeAudio();
    let stopAtCurrentChapter = false;
    const { player, advances, chapterEnds } = downloadedPlayer(audio, {
      getContinuousEndChapter: () => (stopAtCurrentChapter ? 0 : null)
    });
    await playDownloadedChapter(player, audio);
    stopAtCurrentChapter = true;

    audio.ended = true;
    audio.emit('ended');

    assert.deepStrictEqual(advances, []);
    assert.strictEqual(chapterEnds.length, 1);
  });

  await test('a chapter further away than the lead is not pre-warmed yet', async () => {
    const audio = fakeAudio();
    audio.duration = 600;
    const { player, fetched } = downloadedPlayer(audio, { prewarmLeadSeconds: 45 });
    await playDownloadedChapter(player, audio);
    assert.deepStrictEqual(fetched, []);

    audio.currentTime = 580;
    audio.emit('timeupdate');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(fetched, ['/offline/book1/1']);
    player.dispose();
  });

  await test('a pre-warmed chapter is released instead of pinning its blob forever', async () => {
    const audio = fakeAudio();
    const revoked = [];
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = url => {
      revoked.push(url);
      return originalRevoke.call(URL, url);
    };
    try {
      const { player } = downloadedPlayer(audio);
      await playDownloadedChapter(player, audio);
      const prewarmedUrl = player._prewarm?.objectUrl;
      assert.match(String(prewarmedUrl), /^blob:/);
      player.dispose();
      assert.deepStrictEqual(revoked, [prewarmedUrl]);
    } finally {
      URL.revokeObjectURL = originalRevoke;
    }
  });

  await test('reports media starvation and lifecycle-relevant events with bounded details', async () => {
    const audio = fakeAudio();
    const events = [];
    const { player } = makePlayer(audio, {
      onDiagnosticEvent: event => events.push(event)
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    audio.currentTime = 2;
    for (const type of ['waiting', 'stalled', 'suspend', 'abort', 'emptied']) audio.emit(type);
    audio.emit('timeupdate');

    assert.deepStrictEqual(
      events.filter(event => ['waiting', 'stalled', 'suspend', 'abort', 'emptied'].includes(event.type))
        .map(event => event.type),
      ['waiting', 'stalled', 'suspend', 'abort', 'emptied']
    );
    assert(events.every(event => !Object.hasOwn(event, 'src')));
  });

  await test('the second load\'s events cannot resolve the first load', async () => {
    const audio = fakeAudio();
    const { player, ready } = makePlayer(audio);

    const first = player.loadChapter('book1', 0);
    // The first load's listeners must be gone before the second one arms its own.
    const second = player.loadChapter('book1', 1);
    const firstCancelled = assert.rejects(first, error => error?.cancelled === true);
    assert.strictEqual(audio.countFor('loadedmetadata'), 1, 'stale listener was left attached');
    assert.strictEqual(audio.countFor('canplay'), 1, 'stale listener was left attached');

    audio.emit('canplay');
    await Promise.all([firstCancelled, second]);
    assert.deepStrictEqual(ready, [1]);
  });

  await test('a superseded load rejects instead of hanging forever', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);

    const first = player.loadChapter('book1', 0);
    const second = player.loadChapter('book1', 1);
    const firstCancelled = assert.rejects(first, error => error?.cancelled === true);
    audio.emit('loadedmetadata');

    // Neither promise may outlive the test; a hung first load would time out here.
    await Promise.race([
      Promise.all([firstCancelled, second]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('superseded load did not settle')), 100))
    ]);
  });

  await test('a stalled media element rejects instead of hanging', async () => {
    const audio = fakeAudio();
    const errors = [];
    const { player, ready } = makePlayer(audio, { onError: error => errors.push(error) });

    // No 'canplay', no 'error' — exactly the backgrounded-iOS stall case.
    await assert.rejects(player.loadChapter('book1', 0), /playback failed/i);
    assert.deepStrictEqual(ready, [], 'a timed-out load must not report ready');
    assert.strictEqual(errors.length, 1, 'a timed-out load must clear the loading UI through onError');
  });

  await test('a settled load leaves no listeners or timer behind', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);

    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    assert.strictEqual(audio.countFor('loadedmetadata'), 0);
    assert.strictEqual(audio.countFor('canplay'), 0);
    // 'error' keeps only the long-lived engine handler attached by _attach().
    assert.strictEqual(audio.countFor('error'), 1);
  });

  await test('a rejected play attempt removes its fallback listeners immediately', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    audio.play = async () => { throw new Error('autoplay denied'); };

    await assert.rejects(player.play(), /autoplay denied/);
    assert.strictEqual(audio.countFor('playing'), 1, 'only the engine-level playing listener should remain');
    assert.strictEqual(audio.countFor('error'), 1, 'only the engine-level error listener should remain');
  });

  await test('a rejected play reports paused state to the session UI', async () => {
    const audio = fakeAudio();
    const changes = [];
    const { player } = makePlayer(audio, {
      onPlaybackChange: (playing, detail) => changes.push([playing, detail.reason])
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    audio.play = async () => {
      const error = new Error('autoplay denied');
      error.name = 'NotAllowedError';
      throw error;
    };

    await assert.rejects(player.play(), error => error.name === 'NotAllowedError');

    assert.strictEqual(player.isPlaying, false);
    assert.deepStrictEqual(changes, [[false, 'app']]);
  });

  await test('a play call that never reaches playing rejects instead of claiming success', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    await assert.rejects(
      player.play(),
      error => error.code === 'MEDIA_PLAY_TIMEOUT'
    );
    assert.strictEqual(player.isPlaying, false);
  });

  await test('a stale stream that claims playing without advancing rejects', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, { playProgressTimeoutMs: 25 });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    const play = player.play();
    audio.emit('playing');

    await assert.rejects(
      play,
      error => error.code === 'MEDIA_PROGRESS_TIMEOUT'
    );
    assert.strictEqual(player.isPlaying, false);
  });

  await test('distinguishes app controls from native playback interruptions', async () => {
    const audio = fakeAudio();
    const changes = [];
    const { player } = makePlayer(audio, {
      onPlaybackChange: (playing, detail) => changes.push([playing, detail.reason])
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    const play = player.play();
    audio.emit('play');
    audio.emit('playing');
    audio.currentTime = 1;
    audio.emit('timeupdate');
    await play;
    player.pause();
    audio.emit('pause');

    audio.paused = false;
    audio.emit('play');
    audio.emit('playing');
    audio.paused = true;
    audio.emit('pause');

    assert.deepStrictEqual(changes, [
      [true, 'app'],
      [false, 'app'],
      [true, 'external'],
      [false, 'external']
    ]);
  });

  await test('preserves the explicit chapter sleep-timer pause reason', async () => {
    const audio = fakeAudio();
    const events = [];
    const { player } = makePlayer(audio, {
      onDiagnosticEvent: event => events.push(event)
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    audio.paused = false;

    player.pause('sleep-timer-chapter');
    audio.emit('pause');

    assert.strictEqual(events.at(-1).type, 'pause');
    assert.strictEqual(events.at(-1).reason, 'sleep-timer-chapter');
  });

  await test('a rejected native play does not leave an unhandled media wait rejection', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    audio.play = async () => { throw new Error('autoplay denied'); };
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(player.play(), /autoplay denied/);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  await test('a media error during load notifies onError exactly once', async () => {
    const audio = fakeAudio();
    const errors = [];
    const { player } = makePlayer(audio, { onError: error => errors.push(error) });
    const load = player.loadChapter('book1', 0);
    audio.error = { message: 'decode failed' };
    audio.emit('error');

    await assert.rejects(load, /decode failed/);
    assert.strictEqual(errors.length, 1);
  });

  await test('dispose during a load suppresses onReady', async () => {
    const audio = fakeAudio();
    const { player, ready } = makePlayer(audio);

    const load = player.loadChapter('book1', 0);
    player.dispose();
    audio.emit('loadedmetadata');
    await assert.rejects(load, error => error?.cancelled === true);

    assert.deepStrictEqual(ready, [], 'a disposed engine must not report ready');
  });

  // --- Resume churn: one server session per canonical request tuple ---------
  // The server keys an HLS session on the request tuple *including* the client
  // session id, so a fresh id per retry spawns a fresh ffmpeg encoder that must
  // reach its first segment before the playlist returns. Retrying the identical
  // tuple must therefore reuse the identical id.

  function sessionParam(src) {
    return new URL(src, 'https://reader.test').searchParams.get('session');
  }

  await test('retrying the identical request tuple reuses one playback session id', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, { isIOSLike: () => false });

    const first = player.loadChapter('book1', 3);
    const firstSession = sessionParam(audio.src);
    audio.emit('loadedmetadata');
    await first;

    const second = player.loadChapter('book1', 3);
    const secondSession = sessionParam(audio.src);
    audio.emit('loadedmetadata');
    await second;

    assert.ok(firstSession, 'the continuous source carries a session id');
    assert.strictEqual(
      secondSession,
      firstSession,
      'an identical retry must join the existing server session, not spawn a new one'
    );
  });

  await test('a different chapter mints a new playback session id', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, { isIOSLike: () => false });

    const first = player.loadChapter('book1', 0);
    const firstSession = sessionParam(audio.src);
    audio.emit('loadedmetadata');
    await first;

    const second = player.loadChapter('book1', 1);
    const secondSession = sessionParam(audio.src);
    audio.emit('loadedmetadata');
    await second;

    assert.notStrictEqual(
      secondSession,
      firstSession,
      'a genuinely different media tuple must not share a session'
    );
  });

  await test('an explicit seek relocation mints a new playback session id', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, { isIOSLike: () => false });

    const load = player.loadChapter('book1', 0);
    const initialSession = sessionParam(audio.src);
    audio.emit('loadedmetadata');
    await load;

    // Nothing buffered at the target, so this is a genuine relocation.
    audio.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
    const seek = player.seek(600);
    const relocatedSession = sessionParam(audio.src);
    audio.emit('loadedmetadata');
    await seek;

    assert.notStrictEqual(
      relocatedSession,
      initialSession,
      'relocating to an unbuffered offset is a new media tuple'
    );
  });

  // --- Activation-safe resume ----------------------------------------------
  // iOS grants a play() call only while the user-activation window from the tap
  // is still open. Anything that awaits a media event first — notably reloading
  // a nonseekable HLS source to satisfy a rewind — closes that window.

  await test('trySeekSync relocates a seekable source without awaiting', () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);
    player.bookId = 'book1';
    player.chapterIndex = 0;
    player.startChapterIndex = 0;

    const applied = player.trySeekSync(4);

    assert.strictEqual(applied, true, 'a buffered target applies immediately');
    assert.strictEqual(audio.currentTime, 4);
    assert.strictEqual(audio.loadCalls, 0, 'no reload is needed for a buffered target');
  });

  await test('trySeekSync refuses an unbuffered continuous target instead of reloading', () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);
    player.bookId = 'book1';
    player.chapterIndex = 0;
    player.startChapterIndex = 0;
    player.isContinuous = true;
    audio.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
    audio.currentTime = 300;

    const applied = player.trySeekSync(295);

    assert.strictEqual(applied, false, 'an unbuffered continuous target must be refused');
    assert.strictEqual(audio.loadCalls, 0, 'refusing must never reload the source');
    assert.strictEqual(audio.src, '', 'refusing must never replace the media source');
    assert.strictEqual(audio.currentTime, 300, 'the position is left untouched');
  });

  await test('seek with allowReload false refuses rather than relocating', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, { isIOSLike: () => false });

    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    const loadsBefore = audio.loadCalls;
    audio.buffered = { length: 0, start() { return 0; }, end() { return 0; } };

    const applied = await player.seek(600, { allowReload: false });

    assert.strictEqual(applied, false, 'the caller is told the seek did not happen');
    assert.strictEqual(
      audio.loadCalls,
      loadsBefore,
      'a rewind-originated seek must never reload a nonseekable stream'
    );
  });

  await test('a failed continuous relocation reports onError at the requested offset', async () => {
    const audio = fakeAudio();
    const errors = [];
    const { player } = makePlayer(audio, {
      getEstimatedDuration: () => 100,
      onError: error => errors.push(error)
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    audio.buffered = { length: 1, start() { return 0; }, end() { return 2; } };

    const seek = player.seek(18);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(player.isPreparingSource(), true);
    audio.error = { message: 'reload failed' };
    audio.emit('error');
    await assert.rejects(seek);
    assert.strictEqual(player.isPreparingSource(), false);
    assert.strictEqual(player.ownsReadySource('book1', 0), false);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'MEDIA_RELOCATE_FAILED');
    assert.strictEqual(errors[0].chapterTime, 18);
    assert.strictEqual(errors[0].recoverable, true);
  });

  // --- Rate-limit classification -------------------------------------------
  // A media element reports only "it failed" — never the HTTP status. When a
  // continuous source fails, one cheap probe recovers the reason so the app can
  // tell the user to wait instead of retrying into the same rate limit.

  await test('a failed continuous load is classified as rate limited', async () => {
    const audio = fakeAudio();
    audio.canPlayType = () => 'maybe';
    const probes = [];
    const { player } = makePlayer(audio, {
      isIOSLike: () => true,
      cryptoProvider: { randomUUID: () => 'session-1' },
      fetch: async (url) => {
        probes.push(url);
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '17' }
        });
      }
    });

    const load = player.loadChapter('book1', 0);
    audio.error = { message: 'network error' };
    audio.emit('error');

    const error = await load.then(() => null, err => err);
    assert.ok(error, 'the load fails');
    assert.strictEqual(error.status, 429, 'the rate limit is surfaced on the error');
    assert.strictEqual(error.retryAfterSeconds, 17, 'Retry-After is carried through');
    assert.strictEqual(probes.length, 1, 'exactly one classification probe is made');
  });

  await test('a failed continuous load is not misreported when the probe is fine', async () => {
    const audio = fakeAudio();
    audio.canPlayType = () => 'maybe';
    const { player } = makePlayer(audio, {
      isIOSLike: () => true,
      cryptoProvider: { randomUUID: () => 'session-2' },
      fetch: async () => new Response('#EXTM3U', { status: 200 })
    });

    const load = player.loadChapter('book1', 0);
    audio.error = { message: 'decode error' };
    audio.emit('error');

    const error = await load.then(() => null, err => err);
    assert.ok(error, 'the load still fails');
    assert.strictEqual(error.status, undefined, 'a healthy playlist adds no false status');
  });

  // --- Recovery at a nonzero offset ----------------------------------------
  // Recovery used to load the continuous transport at offset 0 and then seek to
  // the resume position, which relocated and therefore created a *second*
  // server session for every attempt. The load itself must start at the exact
  // captured offset.

  await test('loadChapter starts the continuous transport at the requested offset', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, { isIOSLike: () => false });

    const load = player.loadChapter('book1', 2, { startOffsetSeconds: 412.5 });
    const url = new URL(audio.src, 'https://reader.test');
    audio.emit('loadedmetadata');
    await load;

    assert.strictEqual(
      url.searchParams.get('offsetSeconds'),
      '412.5',
      'the initial source carries the resume offset'
    );
    assert.strictEqual(audio.loadCalls, 1, 'exactly one source is assigned');
  });

  await test('seeking to the offset it loaded at does not relocate', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, { isIOSLike: () => false });

    const load = player.loadChapter('book1', 2, { startOffsetSeconds: 412.5 });
    audio.emit('loadedmetadata');
    await load;
    const loadsAfterOpen = audio.loadCalls;
    const sessionAfterOpen = new URL(audio.src, 'https://reader.test').searchParams.get('session');

    // This is what playbackSession does after the transition commits.
    const applied = await player.seek(412.5);

    assert.strictEqual(applied, true, 'the position is applied');
    assert.strictEqual(audio.loadCalls, loadsAfterOpen, 'no reload is triggered');
    assert.strictEqual(
      new URL(audio.src, 'https://reader.test').searchParams.get('session'),
      sessionAfterOpen,
      'the session is unchanged'
    );
  });

  await test('every retry of one recovery snapshot reuses a single session tuple', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, { isIOSLike: () => false });
    const snapshot = { startOffsetSeconds: 412.5, endChapterIndex: 5, servedTier: 'premium' };
    const seen = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const load = player.loadChapter('book1', 2, snapshot);
      seen.push(new URL(audio.src, 'https://reader.test'));
      audio.emit('loadedmetadata');
      await load;
      await player.seek(snapshot.startOffsetSeconds);
    }

    const sessions = new Set(seen.map(url => url.searchParams.get('session')));
    assert.strictEqual(sessions.size, 1, 'all three attempts share one session id');
    assert.strictEqual(
      new Set(seen.map(url => `${url.pathname}?${url.searchParams.toString()}`)).size,
      1,
      'all three attempts request the byte-identical canonical tuple'
    );
    assert.strictEqual(seen[0].searchParams.get('offsetSeconds'), '412.5');
    assert.strictEqual(seen[0].searchParams.get('endChapter'), '5');
    assert.strictEqual(seen[0].searchParams.get('tier'), 'premium');
    assert.strictEqual(
      audio.loadCalls,
      3,
      'three attempts assign three sources — never six from offset-0-plus-relocation'
    );
  });

  // --- Underestimated chapter duration -------------------------------------
  // seek() clamps the target to the estimated chapter duration. When that
  // estimate is *below* the resume offset the clamp drags the target backwards,
  // the position is no longer buffered, and the stream relocates — a second
  // session for a resume that had already opened in exactly the right place.

  await test('a continuous source reports the offset it opened at', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, {
      isIOSLike: () => false,
      // Deliberately far below the resume offset.
      getEstimatedDuration: () => 100
    });

    const load = player.loadChapter('book1', 2, { startOffsetSeconds: 412.5 });
    audio.emit('loadedmetadata');
    await load;

    assert.strictEqual(player.openedAtOffset(2, 412.5), true);
    assert.strictEqual(player.openedAtOffset(2, 0), false, 'a different offset is not a match');
    assert.strictEqual(player.openedAtOffset(3, 412.5), false, 'a different chapter is not a match');
  });

  await test('an underestimated duration would otherwise relocate an already-correct stream', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, {
      isIOSLike: () => false,
      getEstimatedDuration: () => 100
    });

    const load = player.loadChapter('book1', 2, { startOffsetSeconds: 412.5 });
    audio.emit('loadedmetadata');
    await load;
    const loadsAfterOpen = audio.loadCalls;

    // This is the call the guard exists to skip. Left unguarded it reloads.
    const seek = player.seek(412.5);
    audio.emit('loadedmetadata');
    await seek;

    assert(
      audio.loadCalls > loadsAfterOpen,
      'the clamp does relocate — openedAtOffset is what prevents this being reached'
    );
  });

  await test('skipping the redundant seek keeps one source URL and one session', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio, {
      isIOSLike: () => false,
      getEstimatedDuration: () => 100
    });
    const sources = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const load = player.loadChapter('book1', 2, { startOffsetSeconds: 412.5 });
      sources.push(audio.src);
      audio.emit('loadedmetadata');
      await load;
      // Exactly what app.js does: skip the seek the source already satisfies.
      if (!player.openedAtOffset(2, 412.5)) await player.seek(412.5);
    }

    const sessions = new Set(
      sources.map(src => new URL(src, 'https://reader.test').searchParams.get('session'))
    );
    assert.strictEqual(sessions.size, 1, 'one session id across all attempts');
    assert.strictEqual(new Set(sources).size, 1, 'one source URL across all attempts');
    assert.strictEqual(audio.loadCalls, 3, 'three loads, not six');
  });

  // A manual clock plus a manual probe: the watchdog's decision is a pure
  // function of two counters and elapsed time, so drive both by hand.
  function stallHarness(extra = {}) {
    const audio = fakeAudio();
    audio.buffered = {
      length: 1,
      start: () => 0,
      end: () => audio.bufferedEnd
    };
    audio.bufferedEnd = 10;
    let clockMs = 0;
    const errors = [];
    const { player } = makePlayer(audio, {
      isIOSLike: () => false,
      stallTimeoutMs: 20000,
      stallProbeIntervalMs: 2000,
      now: () => clockMs,
      onError: error => errors.push(error),
      ...extra
    });
    return {
      audio,
      player,
      errors,
      advance: ms => { clockMs += ms; },
      // One probe tick, as the interval would deliver it.
      probe: () => player._checkForStall()
    };
  }

  async function playingPlayer(harness, chapterIndex = 0) {
    const load = harness.player.loadChapter('book1', chapterIndex);
    harness.audio.emit('loadedmetadata');
    await load;
    harness.audio.paused = false;
    harness.audio.emit('playing');
    return harness;
  }

  await test('a frozen playhead and frozen buffer report a recoverable stall', async () => {
    const harness = await playingPlayer(stallHarness());
    harness.probe();
    for (let elapsed = 0; elapsed < 20000; elapsed += 2000) {
      harness.advance(2000);
      harness.probe();
    }
    assert.strictEqual(harness.errors.length, 1, 'exactly one stall report');
    assert.strictEqual(harness.errors[0].code, 'MEDIA_STALLED');
    assert.strictEqual(harness.errors[0].recoverable, true);
  });

  await test('an advancing playhead never reports a stall', async () => {
    const harness = await playingPlayer(stallHarness());
    for (let elapsed = 0; elapsed < 120000; elapsed += 2000) {
      harness.audio.currentTime += 2;
      harness.advance(2000);
      harness.probe();
    }
    assert.strictEqual(harness.errors.length, 0, 'playback that advances is alive');
  });

  await test('a growing buffer keeps a parked playhead alive', async () => {
    // The live edge of a still-growing playlist: nothing plays out, but
    // segments keep arriving. That is a slow transport, not a dead one.
    const harness = await playingPlayer(stallHarness());
    for (let elapsed = 0; elapsed < 120000; elapsed += 2000) {
      harness.audio.bufferedEnd += 1;
      harness.advance(2000);
      harness.probe();
    }
    assert.strictEqual(harness.errors.length, 0, 'a filling buffer is liveness');
  });

  await test('a paused listener is never treated as stalled', async () => {
    const harness = await playingPlayer(stallHarness());
    harness.audio.paused = true;
    harness.audio.emit('pause');
    for (let elapsed = 0; elapsed < 120000; elapsed += 2000) {
      harness.advance(2000);
      harness.probe();
    }
    assert.strictEqual(harness.errors.length, 0, 'a pause is not a stall');
  });

  await test('the stall probe stops once playback pauses and restarts on play', async () => {
    const harness = await playingPlayer(stallHarness());
    assert(harness.player._stallWatchdog, 'watchdog runs while playing');
    harness.audio.paused = true;
    harness.audio.emit('pause');
    assert.strictEqual(harness.player._stallWatchdog, null, 'watchdog stops on pause');
    harness.audio.paused = false;
    harness.audio.emit('playing');
    assert(harness.player._stallWatchdog, 'watchdog resumes on play');
  });

  await test('a stall reports the position playback died at, once', async () => {
    const harness = await playingPlayer(stallHarness());
    harness.audio.currentTime = 137.5;
    harness.probe();
    for (let elapsed = 0; elapsed < 40000; elapsed += 2000) {
      harness.advance(2000);
      harness.probe();
    }
    assert.strictEqual(harness.errors.length, 1, 'a dead stream is reported once, not repeatedly');
    assert.strictEqual(harness.errors[0].chapterTime, 137.5, 'recovery resumes where it died');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
