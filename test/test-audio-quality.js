const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

function runFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (err, stdout, stderr) => err
      ? reject(new Error(`${command} failed: ${stderr || err.message}`))
      : resolve(stdout));
  });
}

async function run() {
  const { planNarration } = require('../lib/tts-text');

  await test('narration plan preserves headings and does not split common abbreviations', () => {
    const plan = planNarration(
      'CHAPTER IV\n\nDr. Rivera arrived at 3.14 p.m. She said, "We begin now."',
      { maxChars: 60 }
    );

    assert.strictEqual(plan.blocks[0].kind, 'heading');
    assert.strictEqual(plan.blocks[0].text, 'Chapter IV');
    assert.deepStrictEqual(
      plan.blocks[1].sentences,
      ['Dr. Rivera arrived at 3.14 p.m.', 'She said, "We begin now."']
    );
    assert.strictEqual(plan.chunks.map(chunk => chunk.text).join('\n\n'),
      'Chapter IV\n\nDr. Rivera arrived at 3.14 p.m.\n\nShe said, "We begin now."');
  });

  await test('chunk generation consumes the structured narration plan', () => {
    const ChunkedTTS = require('../lib/chunked-tts');
    const tts = new ChunkedTTS('/tmp/unused');
    const source = 'CHAPTER IV\n\nDr. Rivera arrived at 3.14 p.m. She said, "We begin now."';
    const chunks = tts.splitIntoChunksWithMeta(source, 60);

    assert.deepStrictEqual(chunks, planNarration(source, { maxChars: 60 }).chunks.map(chunk => ({
      ...chunk,
      pauseIntent: chunk.segments.at(-1)?.pauseIntent || 'sentence'
    })));
  });

  await test('narration plan preserves expressive punctuation and marks dialogue pause intent', () => {
    const plan = planNarration('“Wait—don’t go,” she said.\n\nThe door closed.', { maxChars: 100 });
    assert(plan.text.includes('“Wait—don’t go,”'));
    assert.strictEqual(plan.chunks[0].segments[0].kind, 'dialogue');
    assert.strictEqual(plan.chunks[0].segments[0].pauseIntent, 'paragraph');
  });

  await test('one mastering policy applies to WAV and MP3 inputs', () => {
    const { buildMasteringArgs } = require('../lib/audio-quality');
    for (const inputFormat of ['wav', 'mp3']) {
      const args = buildMasteringArgs({ inputFormat, outputPath: '/tmp/mastered.mp3', padEndMs: 350 });
      assert.strictEqual(args[args.indexOf('-f') + 1], inputFormat);
      const filters = args[args.indexOf('-af') + 1];
      assert(filters.includes('volume=0.00dB'));
      assert(filters.includes('alimiter=limit=0.750:attack=5:release=50:level=false'));
      assert(filters.includes('apad=pad_dur=0.350'));
      assert.strictEqual(args[args.indexOf('-ar') + 1], '24000');
      assert.strictEqual(args[args.indexOf('-b:a') + 1], '160k');
    }
  });

  await test('mastering can preserve Kokoro output as PCM WAV', () => {
    const { buildMasteringArgs } = require('../lib/audio-quality');
    const args = buildMasteringArgs({ inputFormat: 'wav', outputPath: '/tmp/mastered.wav', outputFormat: 'wav' });
    assert.strictEqual(args[args.indexOf('-c:a') + 1], 'pcm_s16le');
    assert.strictEqual(args.includes('-b:a'), false, 'WAV output should not get an MP3 bitrate flag');
    assert.strictEqual(args[args.length - 1], '/tmp/mastered.wav');
  });

  await test('audio response content type follows output container', () => {
    const { audioContentType } = require('../lib/audio-response');
    assert.strictEqual(audioContentType('/tmp/chapter.mp3'), 'audio/mpeg');
    assert.strictEqual(audioContentType('/tmp/chapter.wav'), 'audio/wav');
    assert.strictEqual(audioContentType('/tmp/chapter.m4a'), 'audio/mp4');
  });

  await test('mastering bitrate can be overridden and falls back safely', () => {
    const { getMasteringBitrate } = require('../lib/audio-quality');
    assert.strictEqual(getMasteringBitrate({ TTS_MP3_BITRATE: '144k' }), '144k');
    assert.strictEqual(getMasteringBitrate({ AUDIO_MP3_BITRATE: '96k' }), '96k');
    assert.strictEqual(getMasteringBitrate({ TTS_MP3_BITRATE: '192k' }), '160k');
    assert.strictEqual(getMasteringBitrate({ TTS_MP3_BITRATE: 'lossless' }), '160k');
  });

  await test('checked-in calibration manifest matches every default engine gain', async () => {
    const { DEFAULT_ENGINE_GAIN_DB } = require('../lib/audio-quality');
    const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'scripts', 'audio-calibration-fixtures.json'), 'utf8'));
    assert.deepStrictEqual(
      Object.fromEntries(manifest.fixtures.map(fixture => [fixture.engine, fixture.gainDb])),
      DEFAULT_ENGINE_GAIN_DB
    );
    assert(manifest.fixtures.find(fixture => fixture.engine === 'edge')?.text, 'Edge calibration must record its source passage');
  });

  await test('acoustic gate reports loudness, peak, range, and truncation failures', () => {
    const { assessAcousticQuality } = require('../lib/audio-quality');
    const good = assessAcousticQuality({
      integratedLufs: -18.4, truePeakDb: -1.4, loudnessRange: 7,
      durationSeconds: 12, minimumDurationSeconds: 8
    });
    assert.strictEqual(good.pass, true);

    const bad = assessAcousticQuality({
      integratedLufs: -24, truePeakDb: 0.1, loudnessRange: 22,
      durationSeconds: 3, minimumDurationSeconds: 8
    });
    assert.strictEqual(bad.pass, false);
    assert.strictEqual(bad.issues.length, 4);
  });

  await test('chapter generation applies the async text transform before planning chunks', async () => {
    const { EventEmitter } = require('events');
    const ChunkedTTS = require('../lib/chunked-tts');
    class Queue extends EventEmitter {
      constructor() { super(); this.jobs = []; }
      async enqueue(job) { this.jobs.push(job); return `job-${this.jobs.length}`; }
    }
    const queue = new Queue();
    const seen = [];
    const tts = new ChunkedTTS('/tmp/unused', queue, {
      textTransform: async context => {
        seen.push(context);
        return context.text.replace('Xandrio', 'ZAN-dree-oh');
      }
    });
    tts._fileExists = async () => false;
    await tts.generateChapter('book1', 2, 'Xandrio is the audiobook application used for this test.');

    assert.strictEqual(seen[0].bookId, 'book1');
    assert.strictEqual(seen[0].chapterIndex, 2);
    assert(queue.jobs[0].text.includes('ZAN-dree-oh'));
  });

  await test('chapter manifest reconstructs from durable artifacts without enqueueing generation', async () => {
    const ChunkedTTS = require('../lib/chunked-tts');
    const tts = new ChunkedTTS('/tmp/unused', null, {
      textTransform: async ({ text }) => text.replace('Xandrio', 'ZAN-dree-oh')
    });
    tts._fileExists = async filePath => filePath.endsWith('chunk0.mp3');
    const manifest = await tts.reconstructChapterManifest(
      'book1', 0, 'Xandrio provides enough narration text to reconstruct this chapter manifest.'
    );
    assert.strictEqual(manifest.totalChunks, 1);
    assert.strictEqual(manifest.chunks[0].status, 'ready');
  });

  await test('mastered audio passes the executable acoustic quality gate', async () => {
    const TTSQueue = require('../lib/tts-queue');
    const { verifyAudioFile } = require('../lib/audio-quality');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-audio-gate-'));
    const source = path.join(dir, 'source.wav');
    const output = path.join(dir, 'mastered.mp3');
    try {
      await runFile('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=3',
        '-c:a', 'pcm_s16le', source
      ]);
      await new TTSQueue()._masterAudioFileToMp3(source, 'wav', output, 0, 3);
      const result = await verifyAudioFile(output, { minimumDurationSeconds: 2.8 });
      assert.strictEqual(result.pass, true, result.issues.join('; '));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

run();
