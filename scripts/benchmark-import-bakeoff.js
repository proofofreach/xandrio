#!/usr/bin/env node

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { compareImportBakeoff } = require('../lib/import-bakeoff');
const { evaluateBakeoffVersion } = require('./lib/import-bakeoff-evaluator');
const {
  assertCandidateSnapshot,
  resolveRevision,
  snapshotRevision
} = require('./benchmark-import-reliability');
const {
  buildHistoricalCases,
  downloadHoldoutCases,
  librarySourceDigests
} = require('./lib/import-bakeoff-corpus');

const REPO_ROOT = path.join(__dirname, '..');
const REQUIRED_BASELINE = 'b2873a24f7bd1c1ecc02c882abfb9321284d7bbd';
const HOLDOUT_MANIFEST = path.join(REPO_ROOT, 'test', 'fixtures', 'import-bakeoff-holdouts.json');

function parseArgs(argv) {
  const args = {
    baseline: REQUIRED_BASELINE,
    candidate: 'HEAD',
    historicalManifest: '',
    dataDir: path.resolve(process.env.DATA_DIR || path.join(REPO_ROOT, 'data')),
    output: ''
  };
  for (let index = 2; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '-h') {
      args.help = true;
      continue;
    }
    if (!['--baseline', '--candidate', '--historical-manifest', '--data-dir', '--output'].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    if (name === '--baseline') args.baseline = value;
    else if (name === '--candidate') args.candidate = value;
    else if (name === '--historical-manifest') args.historicalManifest = path.resolve(value);
    else if (name === '--data-dir') args.dataDir = path.resolve(value);
    else if (name === '--output') args.output = path.resolve(value);
    index += 1;
  }
  if (!args.help && !args.historicalManifest) {
    throw new Error('--historical-manifest is required');
  }
  if (!args.help && args.baseline !== REQUIRED_BASELINE) {
    throw new Error(`--baseline must be the approved previous system ${REQUIRED_BASELINE}`);
  }
  if (!args.help && args.candidate === 'WORKTREE') {
    throw new Error('--candidate must be a committed git revision, not WORKTREE');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/benchmark-import-bakeoff.js [options]

Runs the approved previous and current import systems on exactly four selected
historical library sources and four frozen public-domain holdouts. The output
contains no book metadata, paths, narration text, or content hashes.

Options:
  --historical-manifest <path>   Private manifest with exactly four library paths
  --baseline <git-ref>           Fixed approved previous system
  --candidate <git-ref>          Committed candidate revision (default: HEAD)
  --data-dir <path>              Library data directory
  --output <path>                Write the privacy-safe JSON report
`);
}

function assertPrivateHistoricalManifest(manifestPath, repositoryRoot = REPO_ROOT) {
  const relative = path.relative(path.resolve(repositoryRoot), path.resolve(manifestPath));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error('The historical manifest must remain outside the repository');
  }
}

function privacySafeBakeoffReport({ baselineRef, candidateRef, baseline, candidate, comparison }) {
  return {
    schemaVersion: 1,
    kind: 'bounded-eight-book-old-new-bakeoff',
    privacy: 'opaque-no-book-metadata-paths-text-content-hashes-or-source-digests',
    baselineRef,
    candidateRef,
    passed: Boolean(comparison?.passed),
    summary: comparison?.summary,
    gates: comparison?.gates,
    ux: {
      baseline: baseline?.ux,
      candidate: candidate?.ux
    },
    differences: comparison?.differences || []
  };
}

async function runBakeoff(args) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-import-bakeoff-'));
  try {
    assertPrivateHistoricalManifest(args.historicalManifest);
    const baselineCommit = resolveRevision(args.baseline);
    const candidateCommit = resolveRevision(args.candidate);
    if (baselineCommit !== REQUIRED_BASELINE) {
      throw new Error(`Approved baseline resolved to unexpected revision ${baselineCommit}`);
    }
    assertCandidateSnapshot({
      candidateCommit,
      headCommit: resolveRevision('HEAD'),
      worktreeStatus: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
      })
    });

    const digests = await librarySourceDigests(args.dataDir);
    const historicalCases = await buildHistoricalCases({
      manifestPath: args.historicalManifest,
      dataDir: args.dataDir,
      libraryDigests: digests
    });
    const holdoutCases = await downloadHoldoutCases({
      manifestPath: HOLDOUT_MANIFEST,
      directory: path.join(temporaryRoot, 'holdouts'),
      libraryDigests: digests
    });
    const [baselineRoot, candidateRoot] = await Promise.all([
      snapshotRevision(baselineCommit, temporaryRoot, 'baseline'),
      snapshotRevision(candidateCommit, temporaryRoot, 'candidate')
    ]);
    const corpus = [...historicalCases, ...holdoutCases];
    const baseline = await evaluateBakeoffVersion({
      versionRoot: baselineRoot,
      cases: corpus,
      scratchRoot: path.join(temporaryRoot, 'baseline-evaluation')
    });
    const candidate = await evaluateBakeoffVersion({
      versionRoot: candidateRoot,
      cases: corpus,
      scratchRoot: path.join(temporaryRoot, 'candidate-evaluation')
    });
    const comparison = compareImportBakeoff({ baseline, candidate });
    return privacySafeBakeoffReport({
      baselineRef: baselineCommit,
      candidateRef: candidateCommit,
      baseline,
      candidate,
      comparison
    });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();
  const report = await runBakeoff(args);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) await fs.writeFile(args.output, output);
  process.stdout.write(output);
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`import bake-off error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  HOLDOUT_MANIFEST,
  REQUIRED_BASELINE,
  assertPrivateHistoricalManifest,
  parseArgs,
  privacySafeBakeoffReport,
  runBakeoff
};
