#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const jsonStore = require('../lib/json-store');
const {
  assertLiveProviderAuthorization,
  evaluateBookGuideBenchmark,
  fingerprintFileContents
} = require('./lib/book-guide-evaluation');

function parseArgs(argv) {
  const args = { manifest: '', calibration: '', results: '', output: '', allowLiveProvider: false, providerConfig: '' };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--allow-live-provider') {
      args.allowLiveProvider = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (arg === '--manifest') args.manifest = path.resolve(value);
    else if (arg === '--calibration') args.calibration = path.resolve(value);
    else if (arg === '--results') args.results = path.resolve(value);
    else if (arg === '--output') args.output = path.resolve(value);
    else if (arg === '--provider-config') args.providerConfig = path.resolve(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.help) {
    for (const key of ['manifest', 'calibration', 'results']) {
      if (!args[key]) throw new Error(`--${key} is required`);
    }
    assertLiveProviderAuthorization(args);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: npm run benchmark:book-guides -- --manifest <works.json> --calibration <claims.json> --results <evaluation.json> [options]

Validates the frozen, legally usable local evaluation corpus and emits an
aggregate-only acceptance report. It does not read book text or contact any
provider/model by default.

Required:
  --manifest <path>       12+ English nonfiction works; opaque IDs, local paths,
                          SHA-256 fingerprints, attested legal-use basis
  --calibration <path>    Exactly 200 frozen claims: 100 supported, 100 unsupported,
                          from at least six manifest works
  --results <path>        Human/anchor/quote metrics with no source text or metadata

Options:
  --output <path>         Write the safe aggregate JSON report (stdout otherwise)
  --allow-live-provider   Require an explicit provider configuration acknowledgement
  --provider-config <path> Required with --allow-live-provider. The current harness
                          has no network adapter and will still make no live call.
`);
}

async function readJson(filePath, label) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error(`Could not read ${label}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function assertLocalWorksReadable(manifest) {
  for (const work of manifest?.works || []) {
    try {
      const stats = await fs.stat(work.localPath);
      if (!stats.isFile()) throw new Error('not-file');
      const bytes = await fs.readFile(work.localPath);
      if (fingerprintFileContents(bytes) !== work.sourceFingerprint) throw new Error('fingerprint-mismatch');
    } catch {
      // Do not echo a private local path into a CI log or report.
      throw new Error('Manifest references a local work that is unavailable');
    }
  }
}

async function runBenchmark(args) {
  const [manifest, calibration, results] = await Promise.all([
    readJson(args.manifest, 'manifest'),
    readJson(args.calibration, 'calibration'),
    readJson(args.results, 'results')
  ]);
  await assertLocalWorksReadable(manifest);
  const report = evaluateBookGuideBenchmark({ manifest, calibration, results });
  report.mode = assertLiveProviderAuthorization(args);
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();
  const report = await runBenchmark(args);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) await jsonStore.save(args.output, report);
  process.stdout.write(output);
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`book-guide benchmark error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { assertLocalWorksReadable, parseArgs, readJson, runBenchmark };
