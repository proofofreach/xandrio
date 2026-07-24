#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { EdgeTTS } = require('node-edge-tts');

const execFileAsync = promisify(execFile);

const KOKORO_URL = (process.env.KOKORO_TTS_URL || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const KOKORO_FORMAT = String(process.env.KOKORO_TTS_AUDIO_FORMAT || process.env.KOKORO_TTS_FORMAT || 'mp3').toLowerCase() === 'wav'
  ? 'wav'
  : 'mp3';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const ITERATIONS = Number(process.env.TTS_BENCH_ITERATIONS || 3);
const VOICES = {
  edge: process.env.TTS_BENCH_EDGE_VOICE || 'en-US-AndrewMultilingualNeural',
  kokoro: process.env.TTS_BENCH_KOKORO_VOICE || 'am_michael'
};

const SAMPLES = [
  {
    name: 'short',
    text: 'The morning sun cast golden light through the library windows, illuminating rows of leather-bound books.'
  },
  {
    name: 'chapter-open',
    text: [
      'This book is the result of some living-room discussions that I had with friends over a period of time.',
      'They became more and more elaborate as topics were added to the original discussions.',
      'Eventually, my friends felt that presenting these ideas to a broader audience would be in order.',
      'Finally, I gave in to the well-intentioned nagging of my friends and put down some of these ideas on paper.'
    ].join(' ')
  },
  {
    name: 'long',
    text: [
      'In order for us to develop a common language, I have to utilize some elementary concepts in science such as the behavior of sound and of light waves, and finally, a hologram.',
      'I have tried to make the description of this behavior as palatable as possible and as short as possible.',
      'I have to convey to you how Nature works by simple examples that will suffice perfectly to handle the final concepts.',
      'I suggest, therefore, that you bear with me for the first four chapters. Beyond that it is all downhill and fun.'
    ].join(' ')
  }
];

function tmpPath(provider, ext) {
  const id = crypto.randomBytes(5).toString('hex');
  return path.join(os.tmpdir(), `xandrio-tts-bench-${provider}-${process.pid}-${id}.${ext}`);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function durationSeconds(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  return Number(stdout.trim());
}

async function synthesizeEdge(text, outputPath) {
  const tts = new EdgeTTS({
    voice: VOICES.edge,
    lang: 'en-US',
    outputFormat: OUTPUT_FORMAT,
    timeout: 120000
  });
  await tts.ttsPromise(text, outputPath);
}

async function synthesizeKokoro(text, outputPath) {
  const wavPath = tmpPath('kokoro', 'wav');
  try {
    const response = await fetch(`${KOKORO_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: VOICES.kokoro, language: 'en', format: KOKORO_FORMAT })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Kokoro failed ${response.status}: ${body || response.statusText}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('audio/mpeg')) {
      await fs.writeFile(outputPath, audio);
      return;
    }

    await fs.writeFile(wavPath, audio);
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', wavPath,
      '-ar', '24000',
      '-ac', '1',
      '-b:a', '48k',
      outputPath
    ]);
  } finally {
    await fs.unlink(wavPath).catch(() => {});
  }
}

async function runOne(provider, sample) {
  const outputPath = tmpPath(provider, 'mp3');
  const start = performance.now();
  try {
    if (provider === 'edge') {
      await synthesizeEdge(sample.text, outputPath);
    } else {
      await synthesizeKokoro(sample.text, outputPath);
    }
    const elapsedMs = performance.now() - start;
    const [stat, duration] = await Promise.all([
      fs.stat(outputPath),
      durationSeconds(outputPath)
    ]);
    return {
      provider,
      sample: sample.name,
      chars: sample.text.length,
      elapsedMs,
      duration,
      rtf: elapsedMs / 1000 / duration,
      bytes: stat.size
    };
  } finally {
    await fs.unlink(outputPath).catch(() => {});
  }
}

async function main() {
  const results = [];
  console.log(`Benchmarking ${ITERATIONS} iteration(s) per provider/sample`);
  console.log(`Edge voice: ${VOICES.edge}`);
  console.log(`Kokoro voice: ${VOICES.kokoro}`);
  console.log(`Kokoro requested format: ${KOKORO_FORMAT}`);

  for (const sample of SAMPLES) {
    for (const provider of ['kokoro', 'edge']) {
      for (let i = 0; i < ITERATIONS; i++) {
        const result = await runOne(provider, sample);
        results.push(result);
        console.log(
          `${provider.padEnd(6)} ${sample.name.padEnd(12)} #${i + 1}: ` +
          `${Math.round(result.elapsedMs)}ms, ${result.duration.toFixed(2)}s audio, ` +
          `RTF ${result.rtf.toFixed(2)}, ${result.bytes} bytes`
        );
      }
    }
  }

  console.log('\nSummary');
  for (const provider of ['kokoro', 'edge']) {
    const providerResults = results.filter(result => result.provider === provider);
    const times = providerResults.map(result => result.elapsedMs);
    const rtfs = providerResults.map(result => result.rtf);
    console.log(JSON.stringify({
      provider,
      samples: providerResults.length,
      avgMs: Math.round(mean(times)),
      p50Ms: Math.round(percentile(times, 50)),
      p95Ms: Math.round(percentile(times, 95)),
      avgRtf: Number(mean(rtfs).toFixed(3)),
      p95Rtf: Number(percentile(rtfs, 95).toFixed(3))
    }));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
