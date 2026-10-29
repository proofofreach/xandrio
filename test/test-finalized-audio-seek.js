'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { Writable } = require('node:stream');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { decodeInto, createChapterAudioStreamer, pcmBytesForSeconds } = require('../lib/chapter-audio-stream');
const { createHlsAudioStreamer } = require('../lib/hls-audio-stream');
const exec = promisify(execFile);

function response() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.status = code => { res.statusCode = code; return res; };
  res.set = () => res;
  res.flushHeaders = () => {};
  res.body = () => Buffer.concat(chunks);
  return res;
}

async function pcm(file) {
  return (await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-xerror', '-i', file,
    '-f', 's16le', '-ar', '24000', '-ac', '1', 'pipe:1'
  ], { encoding: 'buffer' })).stdout;
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalized-seek-'));
  let checks = 0;
  try {
    for (const format of ['mp3', 'wav']) {
      const file = path.join(dir, `input.${format}`);
      await exec('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'aevalsrc=0.2*sin(2*PI*(440+220*floor(t))*t):s=24000:d=5',
        '-c:a', format === 'wav' ? 'pcm_s16le' : 'libmp3lame', file
      ]);
      const original = await pcm(file);
      for (const offset of [0, 0.3, 1.001, 2.333333, 4.95, 5, 8]) {
        const sink = response();
        const skipState = { remaining: pcmBytesForSeconds(offset) };
        const invocations = [];
        const bytes = await decodeInto(file, { stdin: sink }, null, (...args) => {
          invocations.push(args[1]);
          return spawn(...args);
        }, { skipState, seekable: true });
        const expected = original.subarray(pcmBytesForSeconds(offset));
        assert.deepEqual(sink.body(), expected, `${format} seek ${offset} must preserve exact PCM`);
        assert.equal(bytes, expected.length);
        assert.equal(pcmBytesForSeconds(offset) - skipState.remaining, Math.min(original.length, pcmBytesForSeconds(offset)));
        if (offset > 1 && expected.length) {
          assert.equal(invocations.length, 1, 'valid seeks must not decode again from the beginning');
          assert(invocations[0].indexOf('-ss') < invocations[0].indexOf('-i'), 'seek must precede input');
        }
        checks++;
      }
    }

    const file = path.join(dir, 'input.mp3');
    const original = await pcm(file);
    for (const transport of ['progressive', 'hls']) {
      for (const offset of [0, 2.333333, 5, 8]) {
        const records = [];
        const source = {
          chapterIndex: 0, format: 'mp3', decodeStartOffsetSeconds: offset,
          onInputDecoded(input, bytes, details) { records.push({ input, bytes, details }); },
          async *iterateInputs() {
            yield { path: file, chapterIndex: 0, lastInChapter: true, seekable: true };
            yield { path: file, chapterIndex: 1, lastInChapter: true, seekable: true };
          }
        };
        const res = response();
        let outputFile;
        let hls;
        try {
          if (transport === 'progressive') {
            const streamer = createChapterAudioStreamer({ serveAudioFile() { assert.fail('unexpected file shortcut'); } });
            await streamer.streamContinuous(new EventEmitter(), res, source);
            outputFile = path.join(dir, `progressive-${offset}.mp3`);
            await fs.writeFile(outputFile, res.body());
          } else {
            hls = createHlsAudioStreamer({
              serveAudioFile() {}, rootDir: path.join(dir, `hls-${offset}`), segmentSeconds: 1,
              maintenanceIntervalMs: 0
            });
            await hls.servePlaylist(new EventEmitter(), res, { key: 'test', createSource: async () => source });
            const session = [...hls.sessionsById.values()][0];
            await session.runPromise;
            assert.equal(session.error, null);
            outputFile = session.playlistPath;
          }
          const actual = await pcm(outputFile);
          const expectedBytes = original.length + Math.max(0, original.length - pcmBytesForSeconds(offset));
          assert(Math.abs(actual.length - expectedBytes) < 24000 * 2 * 0.15, `${transport} seek ${offset} truncated output`);
          assert.equal(records.length, 2);
          assert.equal(records[0].bytes + records[0].details.skippedPcmBytes, original.length);
          assert.equal(records[1].bytes, original.length, 'offset must never consume the next chapter');
          assert.equal(records[1].details.skippedPcmBytes, 0);
          checks++;
        } finally {
          await hls?.dispose();
        }
      }
    }

    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(decodeInto(file, { stdin: response() }, cancelled.signal,
      () => assert.fail('pre-cancelled seek spawned ffmpeg'), { seekable: true }), { name: 'AbortError' });
    checks++;
    const controller = new AbortController();
    const children = [];
    const sink = new Writable({ write(_chunk, _encoding, done) { controller.abort(); done(); } });
    await assert.rejects(decodeInto(file, { stdin: sink }, controller.signal, (...args) => {
      const child = spawn(...args);
      children.push(once(child, 'close'));
      return child;
    }, { seekable: true, skipState: { remaining: pcmBytesForSeconds(2) } }), { name: 'AbortError' });
    await Promise.all(children);
    checks++;
    console.log(`finalized-audio-seek tests: ${checks} passed, 0 failed`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
