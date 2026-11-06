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
  mp3FrameBytes,
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
    const source = sourceForRequest(req);
    try {
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

  await test('planResumeFromRange maps a byte offset to the CBR frame grid', () => {
    assert.strictEqual(mp3FrameBytes(), 480);
    assert.strictEqual(planResumeFromRange(undefined), null);
    assert.strictEqual(planResumeFromRange('bytes=0-'), null, 'the initial request stays a 200');
    assert.strictEqual(planResumeFromRange('bytes=-500'), null, 'suffix ranges have no meaning on a live encode');
    assert.strictEqual(planResumeFromRange('items=1-2'), null);
    assert.strictEqual(planResumeFromRange('bytes=10-5'), null);
    assert.strictEqual(planResumeFromRange('bytes=100-', 'wav'), null, 'only the MP3 transport resumes');
    // The exact byte Chromium asked for in the reproduction run.
    const plan = planResumeFromRange('bytes=8197746-');
    assert.deepStrictEqual(plan, { firstByte: 8197440, lastByte: null, seconds: 409.872 });
    assert.strictEqual(plan.firstByte % 480, 0);
    assert.deepStrictEqual(planResumeFromRange('bytes=0-1'), { firstByte: 0, lastByte: 1, seconds: 0 });
    assert.strictEqual(planResumeFromRange(`bytes=${25 * 3600 * BYTES_PER_SECOND}-`), null, 'beyond the offset horizon');
  });

  await test('the transport emits pure CBR frames: no ID3 tag, no Xing frame, 480-byte grid', async () => {
    const server = await listen(streamerApp(() => makeSource(fixture, { resumable: true, resume: null })));
    try {
      const response = await request(server.address().port, { Range: 'bytes=0-' });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers['accept-ranges'], 'bytes');
      assert.strictEqual(response.headers['content-type'], 'audio/mpeg');
      assert.notStrictEqual(response.body.toString('latin1', 0, 3), 'ID3', 'no ID3v2 header');
      assert.strictEqual(response.body[0], 0xff, 'starts on a frame sync word');
      assert.strictEqual(response.body[1] & 0xe0, 0xe0, 'starts on a frame sync word');
      assert.strictEqual(response.body.length % 480, 0, `length ${response.body.length} must sit on the frame grid`);
      // Every frame boundary carries a sync word, so byte N / 480 is a frame.
      for (let offset = 0; offset < response.body.length; offset += 480) {
        assert.strictEqual(response.body[offset], 0xff, `frame at ${offset}`);
        assert.strictEqual(response.body[offset + 1] & 0xe0, 0xe0, `frame at ${offset}`);
      }
      // No Xing/Info frame: the first frame must decode to audio, so the
      // decoded length is the whole fixture, not the fixture minus one frame.
      const pcm = await decodePcm(response.body);
      assert(Math.abs(pcmSeconds(pcm) - 12) < 0.1, `decoded ${pcmSeconds(pcm)}s`);
      console.log(`    full stream: ${response.body.length} bytes = ${response.body.length / 480} frames, ${pcmSeconds(pcm).toFixed(3)}s decoded`);
    } finally {
      await close(server);
    }
  });

  await test('a source that is not resumable keeps advertising Accept-Ranges: none', async () => {
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

  await test('Range: bytes=N- answers 206 from the time byte N maps to', async () => {
    const server = await listen(streamerApp(req => makeSource(fixture, {
      resumable: true,
      resume: planResumeFromRange(req.headers.range)
    })));
    try {
      // 7 s in = 140 000 bytes; ask for a byte just past a frame boundary.
      const response = await request(server.address().port, { Range: 'bytes=140100-' });
      assert.strictEqual(response.status, 206);
      assert.strictEqual(response.headers['accept-ranges'], 'bytes');
      const match = /^bytes (\d+)-(\d+)\/\*$/.exec(response.headers['content-range']);
      assert(match, `content-range ${response.headers['content-range']}`);
      // 140100 / 480 = 291.875 frames: resume from frame 291.
      assert.strictEqual(Number(match[1]), 139680, 'snapped down to the frame grid');
      assert(Number(match[2]) > 139680);
      assert.strictEqual(response.body[0], 0xff);
      const pcm = await decodePcm(response.body);
      const expectedSeconds = 12 - 139680 / BYTES_PER_SECOND;
      assert(Math.abs(pcmSeconds(pcm) - expectedSeconds) < 0.1,
        `resumed body decodes to ${pcmSeconds(pcm)}s, expected about ${expectedSeconds}s`);
      // 7 s is inside the 880 Hz half: the resumed audio is the right audio.
      const frequency = dominantFrequency(pcm, 0.2, 0.5);
      assert(Math.abs(frequency - 880) < 40, `resumed audio starts at ${frequency.toFixed(0)} Hz, expected 880 Hz`);
      console.log(`    206 body: ${response.body.length} bytes, ${pcmSeconds(pcm).toFixed(3)}s, starts at ${frequency.toFixed(0)} Hz`);
    } finally {
      await close(server);
    }
  });

  await test('a bounded range (WebKit bytes=0-1 probe) returns exactly that many bytes and reaps ffmpeg', async () => {
    const children = new Set();
    const spawnProcess = (...args) => {
      const child = spawn(...args);
      children.add(child);
      return child;
    };
    const server = await listen(streamerApp(req => makeSource(fixture, {
      resumable: true,
      resume: planResumeFromRange(req.headers.range)
    }), { spawnProcess }));
    try {
      const response = await request(server.address().port, { Range: 'bytes=0-1' });
      assert.strictEqual(response.status, 206);
      assert.strictEqual(response.headers['content-range'], 'bytes 0-1/*');
      assert.strictEqual(response.body.length, 2);
      assert.strictEqual(response.body[0], 0xff);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && [...children].some(child => child.exitCode === null && child.signalCode === null)) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert(children.size >= 2, 'decoder and encoder were spawned');
      for (const child of children) {
        assert(child.exitCode !== null || child.signalCode !== null, 'ffmpeg child reaped after the bounded range completed');
      }
    } finally {
      await close(server);
    }
  });

  await test('a dropped connection followed by Range: bytes=N- yields one continuous chapter', async () => {
    const server = await listen(streamerApp(req => makeSource(fixture, {
      resumable: true,
      resume: planResumeFromRange(req.headers.range)
    })));
    try {
      const port = server.address().port;
      // The proxy drops the connection after the browser has part of the
      // stream; the browser keeps those bytes and asks for the rest.
      const first = await readThenDrop(port, 5 * BYTES_PER_SECOND);
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

  await test('/api/audio-continuous passes the resumed seconds to the orchestrator and answers 206', async () => {
    const prepared = [];
    const app = express();
    const playbackOrchestrator = new Proxy({
      resolveTier: async () => ({ servedTier: 'instant' }),
      chapterAudioStatus: async () => ({ ready: true, servedTier: 'instant' }),
      prepareContinuousAudioStream: async options => {
        prepared.push(options);
        return makeSource(fixture, {
          startOffsetSeconds: options.startOffsetSeconds,
          // The real orchestrator prepares the decode at start + resume.
          decodeStartOffsetSeconds: options.startOffsetSeconds + options.resumeSeconds,
          resumeAppliedToDecodeStart: true
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
      const initial = await get({ Range: 'bytes=0-' });
      assert.strictEqual(initial.status, 200);
      assert.strictEqual(initial.headers['accept-ranges'], 'bytes');
      assert.strictEqual(prepared[0].resumeSeconds, 0);
      assert.strictEqual(prepared[0].startOffsetSeconds, 2);

      const resumed = await get({ Range: 'bytes=60000-' });
      assert.strictEqual(resumed.status, 206);
      assert.strictEqual(resumed.headers['content-range'].startsWith('bytes 60000-'), true);
      assert.strictEqual(prepared[1].resumeSeconds, 3);
      assert.strictEqual(prepared[1].startOffsetSeconds, 2, 'the logical start offset is unchanged by a resume');
      const pcm = await decodePcm(resumed.body);
      // Fixture 12 s, stream starts at 2 s, resumed 3 s in: 7 s remain.
      assert(Math.abs(pcmSeconds(pcm) - 7) < 0.1, `resumed route body decodes to ${pcmSeconds(pcm)}s`);
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
