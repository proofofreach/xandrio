// Regression: a browser that loses its continuous-audio connection
// mid-chapter re-requests the same URL with `Range: bytes=N-`. The transport
// used to answer 200 from the start, so the browser downloaded and discarded N
// bytes at paced speed — a mid-chapter pause of a minute or more in
// production. The stream must resume at the time byte N maps to and answer
// 206, and the output must be a pure CBR MP3 frame grid so that mapping holds.
const assert = require('assert');
const express = require('express');
const http = require('http');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const {
  createChapterAudioStreamer,
  measureMp3HeaderBytes,
  mp3FrameBytes,
  parseMp3HeaderBytes,
  planResumeFromRange
} = require('../lib/chapter-audio-stream');
const { registerPlaybackRoutes } = require('../lib/routes/playback-routes');
const { serveAudioFile } = require('../lib/audio-response');
const { createHlsAudioStreamer } = require('../lib/hls-audio-stream');

const execFileAsync = promisify(execFile);
const BYTES_PER_SECOND = 20000; // 160 kbps mastering policy
const SAMPLE_RATE = 24000;

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

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

// 440 Hz for the first half, 880 Hz for the second half, so a resumed body
// can be checked for *which* audio it starts with, not just how long it is.
async function createTwoToneFixture(filePath, seconds = 12) {
  const half = seconds / 2;
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${half}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:duration=${half}`,
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]',
    '-map', '[out]',
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le',
    filePath
  ]);
}

async function decodePcm(buffer) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'mp3', '-i', 'pipe:0',
      '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg decode failed (${code}): ${stderr}`));
      resolve(Buffer.concat(chunks));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
}

function pcmSeconds(pcm) {
  return pcm.length / 2 / SAMPLE_RATE;
}

// Dominant frequency by zero crossings over a window of PCM, skipping the
// encoder's start-up ramp.
function dominantFrequency(pcm, fromSeconds, seconds) {
  const start = Math.floor(fromSeconds * SAMPLE_RATE) * 2;
  const end = Math.min(pcm.length, start + Math.floor(seconds * SAMPLE_RATE) * 2);
  let crossings = 0;
  let previous = pcm.readInt16LE(start);
  for (let offset = start + 2; offset < end; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    if ((previous < 0) !== (sample < 0)) crossings++;
    previous = sample;
  }
  return crossings / 2 / ((end - start) / 2 / SAMPLE_RATE);
}

function makeSource(fixturePath, overrides = {}) {
  return {
    bookId: 'book_resume',
    chapterIndex: 0,
    endChapterIndex: 0,
    format: 'mp3',
    startOffsetSeconds: 0,
    decodeStartOffsetSeconds: 0,
    async *iterateInputs() {
      yield { path: fixturePath, chapterIndex: 0, lastInChapter: true, seekable: true };
    },
    ...overrides
  };
}

function streamerApp(sourceForRequest, streamerOptions = {}) {
  const streamer = createChapterAudioStreamer({ serveAudioFile, ...streamerOptions });
  const app = express();
  app.get('/stream', async (req, res) => {
    try {
      const source = await sourceForRequest(req, streamer);
      await streamer.streamContinuous(req, res, source);
    } catch (error) {
      if (streamer.isClientDisconnect(error)) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (!res.headersSent) res.status(500).json({ error: error.message });
      else res.destroy();
    }
  });
  return app;
}

// A source the way the continuous route builds it: resumable, with the plan
// the streamer derived from this request's Range header.
function resumableSource(fixturePath) {
  return async (req, streamer) => makeSource(fixturePath, {
    resumable: true,
    resume: await streamer.planResume(req)
  });
}

function request(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stream', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Read at least `minBytes` of a 200 response, then drop the socket the way a
// proxy idle timeout does: abruptly, with no clean end.
function readThenDrop(port, minBytes) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stream', headers: { Range: 'bytes=0-' } }, res => {
      const chunks = [];
      let received = 0;
      res.on('data', chunk => {
        chunks.push(chunk);
        received += chunk.length;
        if (received >= minBytes) {
          res.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        }
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
  });
}

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-resume-'));
  const fixture = path.join(dir, 'two-tone.wav');
  await createTwoToneFixture(fixture, 12);

  const headerBytes = await measureMp3HeaderBytes();
  console.log(`    measured first-response header: ${headerBytes} bytes`);

  await test('the first-response header is measured from the encoder, not assumed', () => {
    assert(Number.isInteger(headerBytes) && headerBytes >= 10, `header ${headerBytes}`);
    assert.strictEqual(mp3FrameBytes(), 480);
    assert.strictEqual(parseMp3HeaderBytes(Buffer.alloc(4)), null);
    assert.strictEqual(parseMp3HeaderBytes(Buffer.from('not an mp3 stream at all, just text')), null);
    // ID3 tag of 34 bytes followed by a sync word.
    const tag = Buffer.concat([
      Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x22', 'latin1'),
      Buffer.alloc(34),
      Buffer.from([0xff, 0xf3]),
      Buffer.alloc(478),
      Buffer.from([0xff, 0xf3])
    ]);
    assert.strictEqual(parseMp3HeaderBytes(tag), 44);
    // A Xing/Info frame after the tag is header too.
    const info = Buffer.concat([
      tag.subarray(0, 44),
      Buffer.from([0xff, 0xf3, 0x00, 0x00]), Buffer.from('Info'), Buffer.alloc(472),
      Buffer.from([0xff, 0xf3])
    ]);
    assert.strictEqual(parseMp3HeaderBytes(info), 44 + 480);
  });

  await test('planResumeFromRange resumes only an open-ended bytes=N- past the header', () => {
    assert.strictEqual(planResumeFromRange(undefined, 'mp3', headerBytes), null);
    assert.strictEqual(planResumeFromRange('bytes=0-', 'mp3', headerBytes), null, 'the initial request stays a 200');
    assert.strictEqual(planResumeFromRange('bytes=0-1', 'mp3', headerBytes), null, "Safari's probe stays a 200");
    assert.strictEqual(planResumeFromRange('bytes=1000-2000', 'mp3', headerBytes), null, 'bounded ranges stay a 200');
    assert.strictEqual(planResumeFromRange('bytes=-500', 'mp3', headerBytes), null, 'suffix ranges have no meaning on a live encode');
    assert.strictEqual(planResumeFromRange('items=1-2', 'mp3', headerBytes), null);
    assert.strictEqual(planResumeFromRange('bytes=100000-', 'wav', headerBytes), null, 'only the MP3 transport resumes');
    assert.strictEqual(planResumeFromRange(`bytes=${headerBytes + 10}-`, 'mp3', headerBytes), null, 'inside the first frame: full stream');
    // The exact byte Chromium asked for in the reproduction run.
    const plan = planResumeFromRange('bytes=8197746-', 'mp3', headerBytes);
    assert.strictEqual((plan.firstByte - headerBytes) % 480, 0, 'snapped to the frame grid after the header');
    assert(plan.firstByte <= 8197746 && 8197746 - plan.firstByte < 480);
    assert.strictEqual(plan.seconds, (plan.firstByte - headerBytes) / BYTES_PER_SECOND);
    // Past the horizon the reconnect is still a reconnect: a null plan would
    // answer 200 and replay the stream from its start.
    assert.deepStrictEqual(
      planResumeFromRange(`bytes=${25 * 3600 * BYTES_PER_SECOND}-`, 'mp3', headerBytes),
      { unavailable: true },
      'beyond the offset horizon'
    );
  });

  await test('a reconnect past the resume horizon gets 410 from the route, not a 200 replay', async () => {
    const prepared = [];
    const app = express();
    registerPlaybackRoutes(app, {
      playbackOrchestrator: {
        resolveTier: async () => ({ servedTier: 'instant' }),
        chapterAudioStatus: async () => ({ ready: true, servedTier: 'instant' }),
        prepareContinuousAudioStream: async options => {
          prepared.push(options);
          return makeSource(fixture, { resumeAccepted: false });
        }
      },
      ttsForTier: () => ({ variantKeyProvider: () => 'test' }),
      generationJournal: { listQuarantinedChapters: async () => [] },
      chapterAudioStreamer: createChapterAudioStreamer({ serveAudioFile }),
      hlsAudioStreamer: createHlsAudioStreamer({ serveAudioFile, rootDir: dir }),
      serveAudioFile,
      sendServerError(res, _error, message) {
        if (!res.headersSent) res.status(500).json({ error: message });
        else res.destroy();
      },
      fs: fsp,
      getBookChapters: async () => ({ chapters: [{ text: 'Chapter zero with narration text.' }] })
    });
    const server = await listen(app);
    try {
      const response = await new Promise((resolve, reject) => {
        http.get({
          host: '127.0.0.1',
          port: server.address().port,
          path: '/api/audio-continuous/book_resume/0',
          headers: { Range: `bytes=${headerBytes + 25 * 3600 * BYTES_PER_SECOND}-` }
        }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        }).on('error', reject);
      });
      assert.strictEqual(response.status, 410);
      assert.strictEqual(JSON.parse(response.body).code, 'CONTINUOUS_RESUME_UNAVAILABLE');
      assert.strictEqual(prepared.length, 0, 'no stream is prepared for a reconnect that cannot resume');
    } finally {
      await close(server);
    }
  });

  await test('no Range, bytes=0- and a bounded probe all get the unchanged 200 response', async () => {
    const server = await listen(streamerApp(resumableSource(fixture)));
    try {
      const port = server.address().port;
      const plain = await request(port);
      const zero = await request(port, { Range: 'bytes=0-' });
      const probe = await request(port, { Range: 'bytes=0-1' });
      const bounded = await request(port, { Range: 'bytes=96000-120000' });
      for (const [name, response] of Object.entries({ plain, zero, probe, bounded })) {
        assert.strictEqual(response.status, 200, name);
        assert.strictEqual(response.headers['accept-ranges'], 'none', name);
        assert.strictEqual(response.headers['content-range'], undefined, name);
        assert.strictEqual(response.headers['content-type'], 'audio/mpeg', name);
        assert.strictEqual(response.headers['cache-control'], 'no-store', name);
        assert.strictEqual(response.headers['x-accel-buffering'], 'no', name);
        assert.strictEqual(response.body.toString('latin1', 0, 3), 'ID3', `${name}: ffmpeg's ID3 header is still there`);
        assert.strictEqual(parseMp3HeaderBytes(response.body), headerBytes, name);
        assert.strictEqual((response.body.length - headerBytes) % 480, 0, `${name}: frame grid after the header`);
        assert.strictEqual(response.body.length, plain.body.length, `${name}: the whole stream, same as no Range`);
      }
      const pcm = await decodePcm(plain.body);
      assert(Math.abs(pcmSeconds(pcm) - 12) < 0.1, `decoded ${pcmSeconds(pcm)}s`);
      console.log(`    full stream: ${plain.body.length} bytes = ${headerBytes} header + ${(plain.body.length - headerBytes) / 480} frames`);
    } finally {
      await close(server);
    }
  });

  await test('a source that is not resumable ignores Range entirely', async () => {
    const server = await listen(streamerApp(() => makeSource(fixture)));
    try {
      const response = await request(server.address().port, { Range: 'bytes=96000-' });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers['accept-ranges'], 'none');
      assert.strictEqual(response.headers['content-range'], undefined);
    } finally {
      await close(server);
    }
  });

  await test('Range: bytes=N- answers 206 from the time byte N maps to, without a header', async () => {
    const server = await listen(streamerApp(resumableSource(fixture)));
    try {
      // 7.2 s of audio past the header (300 frames), plus a bit, so the snap
      // is visible.
      const requested = headerBytes + 7.2 * BYTES_PER_SECOND + 100;
      const response = await request(server.address().port, { Range: `bytes=${requested}-` });
      assert.strictEqual(response.status, 206);
      assert.strictEqual(response.headers['accept-ranges'], 'bytes');
      const match = /^bytes (\d+)-(\d+)\/\*$/.exec(response.headers['content-range']);
      assert(match, `content-range ${response.headers['content-range']}`);
      const firstByte = Number(match[1]);
      assert.strictEqual(firstByte, headerBytes + 7.2 * BYTES_PER_SECOND, 'snapped down to the frame grid');
      assert(Number(match[2]) > firstByte);
      assert.notStrictEqual(response.body.toString('latin1', 0, 3), 'ID3', 'no header mid-stream');
      assert.strictEqual(response.body[0], 0xff, 'starts on a frame sync word');
      const pcm = await decodePcm(response.body);
      assert(Math.abs(pcmSeconds(pcm) - 4.8) < 0.1, `resumed body decodes to ${pcmSeconds(pcm)}s, expected about 4.8s`);
      // 7.2 s is inside the 880 Hz half: the resumed audio is the right audio.
      const frequency = dominantFrequency(pcm, 0.2, 0.5);
      assert(Math.abs(frequency - 880) < 40, `resumed audio starts at ${frequency.toFixed(0)} Hz, expected 880 Hz`);
      console.log(`    206 body: ${response.body.length} bytes, ${pcmSeconds(pcm).toFixed(3)}s, starts at ${frequency.toFixed(0)} Hz`);
    } finally {
      await close(server);
    }
  });

  await test('a dropped connection followed by Range: bytes=N- yields one continuous chapter', async () => {
    const server = await listen(streamerApp(resumableSource(fixture)));
    try {
      const port = server.address().port;
      // The proxy drops the connection after the browser has part of the
      // stream; the browser keeps those bytes and asks for the rest from its
      // byte count, which includes the first response's header.
      const first = await readThenDrop(port, headerBytes + 5 * BYTES_PER_SECOND + 7);
      assert.strictEqual(first.status, 200);
      const kept = first.body;
      const second = await request(port, { Range: `bytes=${kept.length}-` });
      assert.strictEqual(second.status, 206);
      const firstByte = Number(/^bytes (\d+)-/.exec(second.headers['content-range'])[1]);
      assert(firstByte <= kept.length && kept.length - firstByte < 480, 'resumes within one frame of the drop point');
      // Splice the way the browser does: discard the overlap, append the rest.
      const spliced = Buffer.concat([kept.subarray(0, firstByte), second.body]);
      const pcm = await decodePcm(spliced);
      assert(Math.abs(pcmSeconds(pcm) - 12) < 0.1, `spliced stream decodes to ${pcmSeconds(pcm)}s, expected 12s`);
      const before = dominantFrequency(pcm, 4.0, 0.5);
      const after = dominantFrequency(pcm, 8.0, 0.5);
      assert(Math.abs(before - 440) < 40, `audio before the drop is ${before.toFixed(0)} Hz`);
      assert(Math.abs(after - 880) < 40, `audio after the resume is ${after.toFixed(0)} Hz`);
      console.log(`    dropped at ${kept.length} bytes, resumed at ${firstByte}; spliced ${pcmSeconds(pcm).toFixed(3)}s`);
    } finally {
      await close(server);
    }
  });

  await test('a failed header probe is retried with backoff, not cached for the life of the process', async () => {
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    let clock = 0;
    let spawns = 0;
    let failNext = true;
    const spawnProcess = (command, args, options) => {
      spawns++;
      if (!failNext) return spawn(command, args, options);
      failNext = false;
      // spawn under load: EAGAIN, no output, no close.
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ffmpeg EAGAIN'), { code: 'EAGAIN' })));
      return child;
    };
    const streamer = createChapterAudioStreamer({ serveAudioFile, spawnProcess, now: () => clock });
    const reconnect = { headers: { range: `bytes=${headerBytes + 60000}-` } };

    assert.strictEqual(await streamer.planResume({ headers: {} }), null);
    assert.strictEqual(spawns, 0, 'a request without Range never probes');
    assert.deepStrictEqual(await streamer.planResume(reconnect), { unavailable: true },
      'a reconnect that cannot be planned is reported, not served as a full stream');
    clock += 1000;
    assert.deepStrictEqual(await streamer.planResume(reconnect), { unavailable: true });
    assert.strictEqual(spawns, 1, 'no second probe inside the backoff');

    clock += 60 * 1000;
    const plan = await streamer.planResume(reconnect);
    assert.strictEqual(spawns, 2, 'the probe is retried after the backoff');
    assert.strictEqual(plan.firstByte, headerBytes + 60000);
    assert.strictEqual(plan.seconds, 3);
    await streamer.planResume(reconnect);
    assert.strictEqual(spawns, 2, 'a measured header is cached');
  });

  await test('HEAD on the progressive stream sends headers without waiting for narration', async () => {
    const waited = [];
    const streamer = createChapterAudioStreamer({ serveAudioFile });
    const app = express();
    app.get('/progressive', (req, res) => streamer.stream(req, res, {
      format: 'mp3',
      totalChunks: 1,
      finalPath: path.join(dir, 'missing.mp3'),
      waitForChunk: async index => { waited.push(index); return fixture; }
    }));
    const server = await listen(app);
    try {
      const head = await new Promise((resolve, reject) => {
        http.request({ host: '127.0.0.1', port: server.address().port, method: 'HEAD', path: '/progressive' }, res => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
        }).on('error', reject).end();
      });
      assert.strictEqual(head.status, 200);
      assert.strictEqual(head.headers['content-type'], 'audio/mpeg');
      assert.deepStrictEqual(waited, [], 'HEAD starts no narration or encode');
    } finally {
      await close(server);
    }
  });

  await test('/api/audio-continuous passes the resumed seconds to the orchestrator and answers 206', async () => {
    const prepared = [];
    let accept = true;
    const app = express();
    const playbackOrchestrator = new Proxy({
      resolveTier: async () => ({ servedTier: 'instant' }),
      chapterAudioStatus: async () => ({ ready: true, servedTier: 'instant' }),
      prepareContinuousAudioStream: async options => {
        prepared.push(options);
        if (!accept && options.requireResume) {
          throw Object.assign(new Error('resume refused'), { statusCode: 410, code: 'CONTINUOUS_RESUME_UNAVAILABLE' });
        }
        return makeSource(fixture, {
          startOffsetSeconds: options.startOffsetSeconds,
          // The real orchestrator prepares the decode at start + resume.
          decodeStartOffsetSeconds: options.startOffsetSeconds + (accept ? options.resumeSeconds : 0),
          resumeAppliedToDecodeStart: true,
          resumeAccepted: accept && options.resumeSeconds > 0
        });
      }
    }, {
      get(target, property) {
        if (property in target) return target[property];
        return async () => { throw new Error(`Unexpected orchestrator call: ${String(property)}`); };
      }
    });
    registerPlaybackRoutes(app, {
      playbackOrchestrator,
      ttsForTier: () => ({ variantKeyProvider: () => 'test' }),
      generationJournal: { listQuarantinedChapters: async () => [] },
      chapterAudioStreamer: createChapterAudioStreamer({ serveAudioFile }),
      hlsAudioStreamer: createHlsAudioStreamer({ serveAudioFile, rootDir: dir }),
      serveAudioFile,
      sendServerError(res, _error, message) {
        if (!res.headersSent) res.status(500).json({ error: message });
        else res.destroy();
      },
      fs: fsp,
      getBookChapters: async () => ({ chapters: [{ text: 'Chapter zero with narration text.' }] })
    });
    const server = await listen(app);
    try {
      const port = server.address().port;
      const get = headers => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/audio-continuous/book_resume/0?offsetSeconds=2', headers }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
      });
      const head = await new Promise((resolve, reject) => {
        http.request({ host: '127.0.0.1', port, method: 'HEAD', path: '/api/audio-continuous/book_resume/0?offsetSeconds=2' }, res => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
        }).on('error', reject).end();
      });
      assert.strictEqual(head.status, 200);
      assert.strictEqual(head.headers['accept-ranges'], 'none');
      assert.strictEqual(head.headers['content-type'], 'audio/mpeg');
      assert.strictEqual(prepared.length, 0, 'HEAD prepares no stream, so it starts no encode or narration');

      const initial = await get({ Range: 'bytes=0-' });
      assert.strictEqual(initial.status, 200);
      assert.strictEqual(initial.headers['accept-ranges'], 'none');
      assert.strictEqual(prepared[0].resumeSeconds, 0);
      assert.strictEqual(prepared[0].startOffsetSeconds, 2);
      const probe = await get({ Range: 'bytes=0-1' });
      assert.strictEqual(probe.status, 200);
      assert.strictEqual(probe.headers['accept-ranges'], 'none');
      assert.strictEqual(probe.body.length, initial.body.length, 'the probe gets the whole stream, as before');
      assert.strictEqual(prepared[1].resumeSeconds, 0);

      const resumed = await get({ Range: `bytes=${headerBytes + 60000}-` });
      assert.strictEqual(resumed.status, 206);
      assert.strictEqual(resumed.headers['content-range'].startsWith(`bytes ${headerBytes + 60000}-`), true);
      assert.strictEqual(prepared[2].resumeSeconds, 3);
      assert.strictEqual(prepared[2].startOffsetSeconds, 2, 'the logical start offset is unchanged by a resume');
      const pcm = await decodePcm(resumed.body);
      // Fixture 12 s, stream starts at 2 s, resumed 3 s in: 7 s remain.
      assert(Math.abs(pcmSeconds(pcm) - 7) < 0.1, `resumed route body decodes to ${pcmSeconds(pcm)}s`);

      assert.strictEqual(prepared[2].requireResume, true, 'a reconnect asks for a resume or nothing');
      assert.strictEqual(prepared[0].requireResume, false);

      // The orchestrator could not prove where the resume lands (a restart,
      // the 12 h prune, or past the first chapter). A 200 would make Chromium
      // download and discard every byte it holds; a 416 would read as the end
      // of the stream. 410 is a load failure: the client reloads at its own
      // position at once.
      accept = false;
      const refused = await get({ Range: `bytes=${headerBytes + 60000}-` });
      assert.strictEqual(refused.status, 410);
      assert.strictEqual(refused.headers['cache-control'], 'no-store');
      assert.strictEqual(JSON.parse(refused.body).code, 'CONTINUOUS_RESUME_UNAVAILABLE');
      // First requests and probes are unchanged.
      const stillPlays = await get({ Range: 'bytes=0-1' });
      assert.strictEqual(stillPlays.status, 200);
      assert.strictEqual(stillPlays.body.length, initial.body.length);
    } finally {
      await close(server);
    }
  });

  await fsp.rm(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
