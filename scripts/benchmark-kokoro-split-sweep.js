#!/usr/bin/env node

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const TTSQueue = require('../lib/tts-queue');
const { getKokoroChunkSize } = require('../lib/kokoro-tuning');
const {
  LEGACY_SPLIT_POLICY,
  HYBRID_SPLIT_POLICY
} = require('../lib/tts-split-policy');
const {
  DEFAULT_TEXT,
  firstMaxCharsForPolicy,
  median,
  renderPolicy
} = require('./benchmark-kokoro-split-ab');

const DEFAULT_OUTPUT_DIR = path.join(os.tmpdir(), 'xandrio-kokoro-split-sweep');
const DEFAULT_STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'legacy-420',
    policy: LEGACY_SPLIT_POLICY,
    description: 'Current default: independently bounded chunks'
  }),
  Object.freeze({
    id: 'continuation-475',
    policy: HYBRID_SPLIT_POLICY,
    targetChars: 475,
    maxChars: 525,
    description: 'Conservative four-chunk continuation candidate'
  }),
  Object.freeze({
    id: 'continuation-500',
    policy: HYBRID_SPLIT_POLICY,
    targetChars: 500,
    maxChars: 550,
    description: 'Moderate four-chunk continuation candidate'
  }),
  Object.freeze({
    id: 'continuation-550',
    policy: HYBRID_SPLIT_POLICY,
    targetChars: 550,
    maxChars: 650,
    description: 'Short continuation candidate'
  }),
  Object.freeze({
    id: 'continuation-650',
    policy: HYBRID_SPLIT_POLICY,
    targetChars: 650,
    maxChars: 750,
    description: 'Medium continuation candidate'
  }),
  Object.freeze({
    id: 'continuation-750',
    policy: HYBRID_SPLIT_POLICY,
    targetChars: 750,
    maxChars: 900,
    description: 'Original hybrid candidate'
  })
]);

function parseArgs(argv) {
  const args = {
    outputDir: DEFAULT_OUTPUT_DIR,
    voice: 'af_heart',
    text: DEFAULT_TEXT,
    trials: 2
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
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/benchmark-kokoro-split-sweep.js [options]',
        '',
        '  --voice af_heart       Kokoro voice',
        '  --text-file sample.txt Narration sample',
        '  --output-dir PATH      Audio and report directory',
        '  --trials 2             Paired forward/reverse runs (even; minimum: 2)',
        '',
        'The report screens playable latency and synthesis throughput before human review.'
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function aggregateStrategy(strategy, runs) {
  const reference = runs[0];
  return {
    id: strategy.id,
    description: strategy.description,
    policy: strategy.policy,
    targetChars: strategy.targetChars || null,
    maxChars: strategy.maxChars || null,
    chunks: reference.chunks,
    chunkChars: reference.chunkChars,
    requestReductionPercent: 0,
    firstChunkMs: median(runs.map(run => run.firstChunkMs)),
    currentAndNextMs: median(runs.map(run =>
      run.chunkMetrics.slice(0, 2).reduce((sum, chunk) => sum + chunk.elapsedMs, 0)
    )),
    synthesisMs: median(runs.map(run => run.synthesisMs)),
    longestChunkMs: median(runs.map(run =>
      Math.max(...run.chunkMetrics.map(chunk => chunk.elapsedMs))
    )),
    acousticPass: runs.every(run => run.quality.pass),
    trials: runs.map(run => ({
      trial: run.trial,
      synthesisMs: run.synthesisMs,
      longestChunkMs: Math.max(...run.chunkMetrics.map(chunk => chunk.elapsedMs))
    }))
  };
}

function screenStrategies(results) {
  const control = results.find(result => result.policy === LEGACY_SPLIT_POLICY);
  const candidates = results.filter(result => result !== control);
  for (const result of results) {
    result.requestReductionPercent = Math.round((1 - result.chunks / control.chunks) * 100);
    result.synthesisDeltaPercent = Math.round((result.synthesisMs / control.synthesisMs - 1) * 1000) / 10;
    result.blockingDeltaPercent = Math.round((result.longestChunkMs / control.longestChunkMs - 1) * 1000) / 10;
    result.currentAndNextDeltaPercent = Math.round(
      (result.currentAndNextMs / control.currentAndNextMs - 1) * 1000
    ) / 10;
  }

  const finalists = candidates
    .filter(candidate =>
      candidate.acousticPass &&
      candidate.synthesisMs <= control.synthesisMs * 0.98 &&
      candidate.currentAndNextMs <= control.currentAndNextMs * 1.05 &&
      candidate.longestChunkMs <= control.longestChunkMs * 1.1
    )
    .sort((left, right) =>
      left.synthesisMs - right.synthesisMs ||
      left.longestChunkMs - right.longestChunkMs ||
      left.chunks - right.chunks
    )
    .map(candidate => candidate.id);
  return {
    selected: control.id,
    changed: false,
    finalists,
    rationale: finalists.length
      ? `${finalists.join(', ')} passed performance screening and requires representative blind review before any default change.`
      : 'No candidate produced a material throughput win while preserving playable and blocking latency.'
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
  const rows = report.results.map(result => `
    <tr${result.id === report.decision.selected ? ' class="selected"' : ''}>
      <td>${escapeHtml(result.id)}</td>
      <td>${result.chunks}</td>
      <td>${result.synthesisMs} ms (${result.synthesisDeltaPercent >= 0 ? '+' : ''}${result.synthesisDeltaPercent}%)</td>
      <td>${result.currentAndNextMs} ms (${result.currentAndNextDeltaPercent >= 0 ? '+' : ''}${result.currentAndNextDeltaPercent}%)</td>
      <td>${result.longestChunkMs} ms (${result.blockingDeltaPercent >= 0 ? '+' : ''}${result.blockingDeltaPercent}%)</td>
      <td>${result.requestReductionPercent}%</td>
      <td>${result.acousticPass ? 'Pass' : 'Review'}</td>
    </tr>
  `).join('');
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Xandrio Kokoro split strategy sweep</title>
<style>
body{font:15px -apple-system,BlinkMacSystemFont,sans-serif;max-width:1180px;margin:36px auto;padding:0 18px;line-height:1.5;color:#171717}
table{border-collapse:collapse;width:100%;margin:20px 0}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#f5f5f5}
.selected{background:#edf8ee}.decision{border-left:4px solid #237a36;padding:8px 14px;background:#f6fbf7}
code{background:#f3f3f3;padding:2px 5px;border-radius:4px}
</style>
<h1>Kokoro split strategy screening sweep</h1>
<p class="decision"><strong>Production default remains:</strong> ${escapeHtml(report.decision.selected)}. ${escapeHtml(report.decision.rationale)}</p>
<p>Production admits one synthesis request at a time. Total synthesis time measures serialized backlog throughput; longest-chunk time bounds how long newly queued work can remain behind an active, non-preemptible request. These are isolated service measurements, not an observed production contention trace.</p>
<table>
  <thead><tr><th>Strategy</th><th>Requests</th><th>Synthesis</th><th>Current + next</th><th>Longest chunk</th><th>Request reduction</th><th>Acoustic gate</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p>The acoustic gate detects damaged output; it does not establish perceptual narration quality. This screening report never changes the default. Any finalist must proceed to a representative, blinded comparison across multiple passages and voices.</p>`;
  await fs.writeFile(path.join(outputDir, 'report.html'), html);
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.textFile) args.text = await fs.readFile(path.resolve(args.textFile), 'utf8');
  const outputDir = path.resolve(args.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const firstMaxChars = getKokoroChunkSize(`kokoro:${args.voice}`, 'quality');
  const queue = new TTSQueue({ timeout: 180000 });
  const runsByStrategy = new Map(DEFAULT_STRATEGIES.map(strategy => [strategy.id, []]));
  const warmupPath = path.join(outputDir, '.warmup.mp3');
  await queue._generateTTS(
    'The strategy benchmark warmup keeps provider startup outside measured runs.',
    warmupPath,
    'en',
    `kokoro:${args.voice}`
  );
  await fs.unlink(warmupPath).catch(() => {});

  for (let trial = 0; trial < args.trials; trial++) {
    const order = trial % 2 === 0
      ? DEFAULT_STRATEGIES
      : DEFAULT_STRATEGIES.slice().reverse();
    for (const strategy of order) {
      console.log(`Rendering ${strategy.id}, trial ${trial + 1}/${args.trials}…`);
      runsByStrategy.get(strategy.id).push(await renderPolicy({
        queue,
        outputDir,
        voice: args.voice,
        text: args.text,
        policy: strategy.policy,
        label: strategy.id,
        firstMaxChars: firstMaxCharsForPolicy(strategy.policy, firstMaxChars),
        trial,
        splitOptions: {
          targetChars: strategy.targetChars,
          maxChars: strategy.maxChars
        }
      }));
    }
  }

  const results = DEFAULT_STRATEGIES.map(strategy =>
    aggregateStrategy(strategy, runsByStrategy.get(strategy.id))
  );
  const decision = screenStrategies(results);
  const report = {
    generatedAt: new Date().toISOString(),
    voice: args.voice,
    textChars: args.text.length,
    firstMaxChars,
    trials: args.trials,
    decision,
    results
  };
  await writeReport(outputDir, report);
  console.log(`Strategy report: ${path.join(outputDir, 'report.html')}`);
  console.log(`${decision.changed ? 'New default candidate' : 'Keep current default'}: ${decision.selected}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_STRATEGIES,
  aggregateStrategy,
  screenStrategies,
  writeReport
};
