#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const TTSQueue = require('../lib/tts-queue');
const { getKokoroChunkSize } = require('../lib/kokoro-tuning');
const { getParagraphPauseMs } = require('../lib/tts-engine-profile');
const { verifyAudioFile } = require('../lib/audio-quality');
const {
  LEGACY_SPLIT_POLICY,
  HYBRID_SPLIT_POLICY,
  planNarrationForPolicy
} = require('../lib/tts-split-policy');

const execFileAsync = promisify(execFile);
const DEFAULT_OUTPUT_DIR = path.join(os.tmpdir(), 'xandrio-kokoro-split-ab');
const DEFAULT_TEXT = [
  'CHAPTER SEVEN',
  '',
  'Rain moved softly across the high windows of the reading room. Mara closed the atlas, listened for the clock, and wondered why the last train had not sounded from the valley. The lamps made small islands on the tables, while beyond them the shelves receded into patient darkness.',
  '',
  '“You heard it too?” Elias asked.',
  '',
  '“I heard nothing,” she said, “and that is precisely what worries me.” He smiled as if the answer had settled some private argument, then crossed to the western window. Below, the river bent around the old station and disappeared beneath a stand of cedar trees.',
  '',
  'A bell rang once. It was not the clear brass note of the station clock, but a lower sound, almost a vibration, that seemed to pass through the floor before it reached the air. Mara opened the atlas again. A thin line of blue ink now crossed a page that had been blank a moment before.',
  '',
  '“That road is not on any survey,” Elias whispered. “And before you ask: no, it was not there yesterday.”',
  '',
  'They followed the mark with their fingers. It began at the library, crossed the river without a bridge, and ended at a circle drawn among the hills. Beside the circle, in letters too small to have been written by hand, were four words: arrive before the second bell.',
  '',
  'For several seconds neither of them moved. Then the building shuddered, the lamps dimmed, and somewhere beneath the city a great mechanism began to turn. Mara folded the map along its oldest crease and placed it inside her coat.',
  '',
  '“We should tell the others,” Elias said.',
  '',
  '“We should,” she replied, looking toward the dark stairwell. “But we will not have time.”'
].join('\n');

function parseArgs(argv) {
  const args = {
    outputDir: DEFAULT_OUTPUT_DIR,
    voice: 'af_heart',
    text: DEFAULT_TEXT,
    trials: 2,
    candidateTargetChars: 750,
    candidateMaxChars: 900,
    candidateMinChars: 200
  };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--output' || arg === '--output-dir') {
      args.outputDir = next;
      index++;
    } else if (arg === '--voice') {
      args.voice = next.replace(/^kokoro:/, '');
      index++;
    } else if (arg === '--text-file') {
      args.textFile = next;
      index++;
    } else if (arg === '--trials') {
      const requested = Math.max(2, Math.round(Number(next) || 2));
      args.trials = requested % 2 === 0 ? requested : requested + 1;
      index++;
    } else if (arg === '--candidate-target') {
      args.candidateTargetChars = Math.max(20, Math.round(Number(next) || 750));
      index++;
    } else if (arg === '--candidate-max') {
      args.candidateMaxChars = Math.max(20, Math.round(Number(next) || 900));
      index++;
    } else if (arg === '--candidate-min') {
      args.candidateMinChars = Math.max(20, Math.round(Number(next) || 200));
      index++;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/benchmark-kokoro-split-ab.js [options]',
        '',
        '  --voice af_heart       Kokoro voice',
        '  --text-file sample.txt Narration sample (default: built-in mixed prose/dialogue)',
        '  --output-dir PATH      A/B audio and report directory',
        '  --trials 2             Paired forward/reverse runs (even; minimum: 2)',
        '  --candidate-target 750 Candidate continuation target',
        '  --candidate-max 900    Candidate continuation ceiling',
        '  --candidate-min 200    Candidate tail-merge threshold',
        '',
        'The control remains the application default. The answer key is written separately.'
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function split(text, policy, firstMaxChars, splitOptions = {}) {
  return planNarrationForPolicy(text, {
    policy,
    firstMaxChars,
    targetChars: splitOptions.targetChars ?? 750,
    maxChars: splitOptions.maxChars ?? 900,
    minChars: splitOptions.minChars ?? 200
  }).chunks;
}

function firstMaxCharsForPolicy(policy, profileChunkSize) {
  return policy === HYBRID_SPLIT_POLICY
    ? Math.min(420, profileChunkSize)
    : profileChunkSize;
}

function deterministicLabels(text, voice, candidateOptions = {}) {
  const candidateIdentity = JSON.stringify({
    targetChars: candidateOptions.targetChars ?? 750,
    maxChars: candidateOptions.maxChars ?? 900,
    minChars: candidateOptions.minChars ?? 200
  });
  const flip = crypto.createHash('sha256')
    .update(`${voice}\u0000${text}\u0000${candidateIdentity}`)
    .digest()[0] % 2 === 1;
  return flip
    ? { [LEGACY_SPLIT_POLICY]: 'B', [HYBRID_SPLIT_POLICY]: 'A' }
    : { [LEGACY_SPLIT_POLICY]: 'A', [HYBRID_SPLIT_POLICY]: 'B' };
}

function isProductionHybridConfig(candidateOptions = {}) {
  return (candidateOptions.targetChars ?? 750) === 750 &&
    (candidateOptions.maxChars ?? 900) === 900 &&
    (candidateOptions.minChars ?? 200) === 200;
}

async function concatenate(files, outputPath) {
  const listPath = `${outputPath}.txt`;
  await fs.writeFile(
    listPath,
    files.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n')
  );
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-map_metadata', '-1', '-vn', '-ac', '1', '-ar', '24000',
      '-c:a', 'libmp3lame', '-b:a', '160k', '-f', 'mp3',
      outputPath
    ]);
  } finally {
    await fs.unlink(listPath).catch(() => {});
  }
}

async function renderPolicy({
  queue,
  outputDir,
  voice,
  text,
  policy,
  label,
  firstMaxChars,
  trial,
  splitOptions = {}
}) {
  const chunks = split(text, policy, firstMaxChars, splitOptions);
  const chunkFiles = [];
  const chunkMetrics = [];
  const startedAt = performance.now();

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const trialSuffix = trial === 0 ? '' : `-trial-${trial + 1}`;
    const file = path.join(outputDir, `sample-${label}${trialSuffix}-chunk-${index}.mp3`);
    const chunkStartedAt = performance.now();
    const pauseIntent = chunk.segments.at(-1)?.pauseIntent || 'sentence';
    await queue._generateTTS(
      chunk.text,
      file,
      'en',
      `kokoro:${voice}`,
      pauseIntent === 'heading'
        ? Math.max(getParagraphPauseMs(), 500)
        : (chunk.paragraphFinal ? getParagraphPauseMs() : 0),
      null,
      {
        pauseIntent,
        segments: chunk.segments
      }
    );
    const elapsedMs = performance.now() - chunkStartedAt;
    chunkFiles.push(file);
    chunkMetrics.push({
      index,
      chars: chunk.text.length,
      elapsedMs: Math.round(elapsedMs),
      segmentKinds: [...new Set(chunk.segments.map(segment => segment.kind))]
    });
  }

  const trialSuffix = trial === 0 ? '' : `-trial-${trial + 1}`;
  const audioFile = path.join(outputDir, `sample-${label}${trialSuffix}.mp3`);
  await concatenate(chunkFiles, audioFile);
  const elapsedMs = performance.now() - startedAt;
  const quality = await verifyAudioFile(audioFile, { minimumDurationSeconds: 20 });
  return {
    label,
    trial: trial + 1,
    audioFile: path.basename(audioFile),
    chunks: chunks.length,
    chunkChars: chunks.map(chunk => chunk.text.length),
    firstChunkMs: chunkMetrics[0]?.elapsedMs || null,
    synthesisMs: chunkMetrics.reduce((sum, chunk) => sum + chunk.elapsedMs, 0),
    totalMs: Math.round(elapsedMs),
    quality,
    chunkMetrics
  };
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function aggregateRuns(runs) {
  const reference = runs[0];
  return {
    label: reference.label,
    audioFile: reference.audioFile,
    chunks: reference.chunks,
    chunkChars: reference.chunkChars,
    firstChunkMs: median(runs.map(run => run.firstChunkMs)),
    synthesisMs: median(runs.map(run => run.synthesisMs)),
    totalMs: median(runs.map(run => run.totalMs)),
    quality: reference.quality,
    trials: runs.map(run => ({
      trial: run.trial,
      firstChunkMs: run.firstChunkMs,
      synthesisMs: run.synthesisMs,
      totalMs: run.totalMs
    }))
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function writeReport(outputDir, report) {
  const cards = report.samples.map(sample => `
    <article>
      <h2>Sample ${sample.label}</h2>
      <audio controls preload="metadata" src="${escapeHtml(sample.audioFile)}"></audio>
      <dl>
        <dt>Chunks</dt><dd>${sample.chunks}</dd>
        <dt>First chunk</dt><dd>${sample.firstChunkMs} ms median</dd>
        <dt>Synthesis</dt><dd>${sample.synthesisMs} ms median</dd>
        <dt>Trials</dt><dd>${sample.trials.map(trial => `${trial.trial}: ${trial.synthesisMs} ms`).join(' · ')}</dd>
        <dt>Acoustic gate</dt><dd>${sample.quality.pass ? 'Pass' : `Review: ${escapeHtml(sample.quality.issues.join('; '))}`}</dd>
      </dl>
    </article>
  `).join('');
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Xandrio split-policy blind A/B</title>
<style>
body{font:15px -apple-system,BlinkMacSystemFont,sans-serif;max-width:920px;margin:36px auto;padding:0 18px;line-height:1.5;color:#171717}
.samples{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}article{border:1px solid #ccc;border-radius:10px;padding:18px}
audio{width:100%}dl{display:grid;grid-template-columns:110px 1fr;gap:6px 12px}dt{color:#666}dd{margin:0}
table{border-collapse:collapse;width:100%;margin-top:20px}th,td{border:1px solid #ccc;padding:8px;text-align:left}
</style>
<h1>Kokoro split-policy blind A/B</h1>
<p>Listen before opening <code>answer-key.json</code>. Use headphones and compare the same moments at chunk boundaries.</p>
<div class="samples">${cards}</div>
<h2>Listening scorecard</h2>
<table>
  <thead><tr><th>Criterion</th><th>A (1–5)</th><th>B (1–5)</th></tr></thead>
  <tbody>
    <tr><td>Prosody consistency</td><td></td><td></td></tr>
    <tr><td>Boundary smoothness</td><td></td><td></td></tr>
    <tr><td>Dialogue delivery</td><td></td><td></td></tr>
    <tr><td>Pronunciation accuracy</td><td></td><td></td></tr>
    <tr><td>Pause timing</td><td></td><td></td></tr>
  </tbody>
</table>
<p>Default gate: adopt the candidate only if it has no new truncation or pronunciation failures, no criterion drops by more than one point, and its mean listening score is no worse than control.</p>`;
  await fs.writeFile(path.join(outputDir, 'report.html'), html);
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.textFile) args.text = await fs.readFile(path.resolve(args.textFile), 'utf8');
  const outputDir = path.resolve(args.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const firstMaxChars = getKokoroChunkSize(`kokoro:${args.voice}`, 'quality');
  const candidateOptions = {
    targetChars: args.candidateTargetChars,
    maxChars: args.candidateMaxChars,
    minChars: args.candidateMinChars
  };
  const labels = deterministicLabels(args.text, args.voice, candidateOptions);
  const queue = new TTSQueue({ timeout: 180000 });
  const policies = [LEGACY_SPLIT_POLICY, HYBRID_SPLIT_POLICY];
  const runsByLabel = new Map([['A', []], ['B', []]]);
  const warmupPath = path.join(outputDir, '.warmup.mp3');
  await queue._generateTTS(
    'The benchmark warmup keeps provider startup outside the measured A and B samples.',
    warmupPath,
    'en',
    `kokoro:${args.voice}`
  );
  await fs.unlink(warmupPath).catch(() => {});

  for (let trial = 0; trial < args.trials; trial++) {
    const order = trial % 2 === 0 ? policies : policies.slice().reverse();
    for (const policy of order) {
      const label = labels[policy];
      console.log(`Rendering sample ${label}, trial ${trial + 1}/${args.trials}…`);
      runsByLabel.get(label).push(await renderPolicy({
        queue,
        outputDir,
        voice: args.voice,
        text: args.text,
        policy,
        label,
        firstMaxChars: firstMaxCharsForPolicy(policy, firstMaxChars),
        trial,
        splitOptions: policy === HYBRID_SPLIT_POLICY ? candidateOptions : {}
      }));
    }
  }
  const rendered = [...runsByLabel.values()]
    .map(aggregateRuns)
    .sort((left, right) => left.label.localeCompare(right.label));

  const report = {
    generatedAt: new Date().toISOString(),
    voice: args.voice,
    textChars: args.text.length,
    firstMaxChars,
    trials: args.trials,
    candidateOptions,
    samples: rendered
  };
  await writeReport(outputDir, report);
  // Named for what it holds rather than "key": secret scanners read
  // `<something>Key = '<literal>'` as a credential assignment, and a release
  // gate that scans all history would reject this file forever.
  const blindAnswers = {
    warning: 'Listen and score report.html before reading this file.',
    labels,
    control: LEGACY_SPLIT_POLICY,
    candidate: HYBRID_SPLIT_POLICY,
    candidateOptions
  };
  if (isProductionHybridConfig(candidateOptions)) {
    blindAnswers.enableCandidate = 'KOKORO_SPLIT_POLICY=hybrid-v1';
  } else {
    blindAnswers.implementationRequired =
      'This custom finalist needs its own production policy and cache identity before it can be enabled.';
  }
  await fs.writeFile(path.join(outputDir, 'answer-key.json'), JSON.stringify(blindAnswers, null, 2));
  console.log(`Blind report: ${path.join(outputDir, 'report.html')}`);
  console.log(`Answer key: ${path.join(outputDir, 'answer-key.json')}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_TEXT,
  concatenate,
  deterministicLabels,
  firstMaxCharsForPolicy,
  isProductionHybridConfig,
  median,
  renderPolicy,
  split
};
