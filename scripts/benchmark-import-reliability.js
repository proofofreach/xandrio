#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { compareImportBenchmark } = require('../lib/import-benchmark');
const { evaluateImportVersion } = require('./lib/import-benchmark-evaluator');
const { createSyntheticImportEpub } = require('./lib/import-benchmark-fixtures');
const policyCases = require('../test/fixtures/import-corpus');

const REPO_ROOT = path.join(__dirname, '..');
const REQUIRED_BASELINE = 'b2873a24f7bd1c1ecc02c882abfb9321284d7bbd';
const REQUIRED_PRIVATE_BOOKS = 5;

function parseArgs(argv) {
  const args = {
    baseline: REQUIRED_BASELINE,
    candidate: 'HEAD',
    privateLimit: REQUIRED_PRIVATE_BOOKS,
    dataDir: path.resolve(process.env.DATA_DIR || path.join(REPO_ROOT, 'data')),
    output: ''
  };
  for (let index = 2; index < argv.length; index++) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === '--baseline') args.baseline = value;
    else if (name === '--candidate') args.candidate = value;
    else if (name === '--private-limit') args.privateLimit = Number(value);
    else if (name === '--data-dir') args.dataDir = path.resolve(value);
    else if (name === '--output') args.output = path.resolve(value);
    else if (name === '--help' || name === '-h') {
      args.help = true;
      continue;
    } else {
      throw new Error(`Unknown argument: ${name}`);
    }
    index++;
  }
  if (!args.help && args.baseline !== REQUIRED_BASELINE) {
    throw new Error(`--baseline must be the approved previous system ${REQUIRED_BASELINE}`);
  }
  if (!args.help && args.candidate === 'WORKTREE') {
    throw new Error('--candidate must be a committed git revision, not WORKTREE');
  }
  if (!args.help && args.privateLimit !== REQUIRED_PRIVATE_BOOKS) {
    throw new Error(`--private-limit must be exactly ${REQUIRED_PRIVATE_BOOKS}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/benchmark-import-reliability.js [options]

Runs the previous and candidate import systems on identical synthetic format
fixtures and the most recent private imports. Output contains no book metadata,
paths, narration text, or content hashes.

Options:
  --baseline <git-ref>            Fixed approved previous system
  --candidate <git-ref>           Committed candidate revision (default: HEAD)
  --private-limit <count>         Fixed recent private corpus size (must be 5)
  --data-dir <path>               Library data directory
  --output <path>                 Write the privacy-safe JSON report
`);
}

function opaqueBookToken(bookId) {
  return crypto.createHash('sha256')
    .update(`xandrio-import-benchmark-v1:${String(bookId || '')}`)
    .digest('hex')
    .slice(0, 12);
}

async function privateBookManifest(dataDir, limit) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dataDir, 'books.json'), 'utf8'));
  } catch {
    throw new Error('Private import benchmark could not read the library manifest');
  }
  const books = (Array.isArray(raw) ? raw : Object.values(raw || {}))
    .sort((left, right) => String(right?.addedAt || '').localeCompare(String(left?.addedAt || '')))
    .slice(0, limit);
  if (books.length < limit) {
    throw new Error(`Private import benchmark requires ${limit} books; found ${books.length}`);
  }
  const manifest = [];
  for (const book of books) {
    const bookPath = String(book?.path || '');
    if (!bookPath) throw new Error('Private import benchmark found a book without a path');
    let format = path.extname(bookPath).slice(1).toLowerCase();
    if (/\.xbook\.json$/i.test(bookPath)) {
      let artifact;
      try {
        artifact = JSON.parse(await fs.readFile(bookPath, 'utf8'));
      } catch {
        throw new Error('Private import benchmark could not read a recent book artifact');
      }
      format = String(artifact?.sourceFormat || format).toLowerCase();
    }
    manifest.push({
      id: `private:${opaqueBookToken(book?.id)}`,
      path: bookPath,
      format
    });
  }
  return manifest;
}

function resolveRevision(ref) {
  return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  }).trim();
}

function assertCandidateSnapshot({ candidateCommit, headCommit, worktreeStatus }) {
  if (candidateCommit !== headCommit) {
    throw new Error('Import benchmark candidate must resolve to HEAD');
  }
  if (String(worktreeStatus || '').trim()) {
    throw new Error('Import benchmark worktree must be clean so the committed candidate and harness are reproducible');
  }
}

async function snapshotRevision(ref, temporaryRoot, label) {
  if (ref === 'WORKTREE') return REPO_ROOT;
  const destination = path.join(temporaryRoot, label);
  await fs.mkdir(destination, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', ref], {
    cwd: REPO_ROOT,
    maxBuffer: 128 * 1024 * 1024
  });
  const extracted = spawnSync('tar', ['-x', '-C', destination], {
    input: archive,
    maxBuffer: 128 * 1024 * 1024
  });
  if (extracted.status !== 0) {
    throw new Error(`Could not extract ${label} revision: ${String(extracted.stderr || '').trim()}`);
  }
  await fs.symlink(path.join(REPO_ROOT, 'node_modules'), path.join(destination, 'node_modules'), 'dir');
  return destination;
}

function publicOutcome(value = {}) {
  return {
    importable: Boolean(value.importable),
    narrationValid: Boolean(value.narrationValid),
    normalizedChars: Number(value.normalizedChars || 0),
    chapterCount: Number(value.chapterCount || 0),
    maxChapterChars: Number(value.maxChapterChars || 0),
    defectCount: Number(value.defectCount || 0),
    warningCount: Number(value.warningCount || 0),
    errorCount: Number(value.errorCount || 0)
  };
}

function privacySafeReport({ baselineRef, candidateRef, baseline, candidate, comparison }) {
  const before = new Map((baseline?.cases || []).map(value => [value.id, value]));
  const after = new Map((candidate?.cases || []).map(value => [value.id, value]));
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  return {
    schemaVersion: 1,
    privacy: 'opaque-no-book-metadata-paths-text-or-content-hashes',
    baselineRef,
    candidateRef,
    passed: Boolean(comparison?.passed),
    summary: comparison?.summary,
    gates: comparison?.gates,
    ux: {
      baseline: baseline?.ux,
      candidate: candidate?.ux
    },
    cases: ids.map(id => {
      const baselineCase = before.get(id) || {};
      const candidateCase = after.get(id) || {};
      return {
        id,
        expectedImportable: candidateCase.expectedImportable ?? baselineCase.expectedImportable,
        narrationConserved: Boolean(
          baselineCase.normalizedHash &&
          baselineCase.normalizedHash === candidateCase.normalizedHash
        ),
        chapterStructureConserved: Boolean(
          baselineCase.structureKey &&
          baselineCase.structureKey === candidateCase.structureKey
        ),
        baseline: publicOutcome(baselineCase),
        candidate: publicOutcome(candidateCase)
      };
    })
  };
}

async function runBenchmark(args) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-import-ab-'));
  try {
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
    const [baselineRoot, candidateRoot, privateBooks] = await Promise.all([
      snapshotRevision(baselineCommit, temporaryRoot, 'baseline'),
      snapshotRevision(candidateCommit, temporaryRoot, 'candidate'),
      privateBookManifest(args.dataDir, args.privateLimit)
    ]);
    const epubPath = await createSyntheticImportEpub(temporaryRoot);
    const inputs = {
      policyCases,
      formatFixtures: { epubPath },
      privateBooks
    };
    const baseline = await evaluateImportVersion({ versionRoot: baselineRoot, ...inputs });
    const candidate = await evaluateImportVersion({ versionRoot: candidateRoot, ...inputs });
    const comparison = compareImportBenchmark({ baseline, candidate });
    return privacySafeReport({
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
  const report = await runBenchmark(args);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) await fs.writeFile(args.output, output);
  process.stdout.write(output);
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`import-reliability benchmark error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  REQUIRED_BASELINE,
  REQUIRED_PRIVATE_BOOKS,
  assertCandidateSnapshot,
  parseArgs,
  privacySafeReport,
  privateBookManifest,
  resolveRevision,
  runBenchmark,
  snapshotRevision
};
