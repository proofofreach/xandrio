#!/usr/bin/env node
/**
 * The single operator interface for a production release.
 *
 * Publication waits for the sanitized public PR and every check to merge.
 * Deployment then promotes that exact public revision to the VPS.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const MIRROR_SCRIPT = resolve(import.meta.dirname, 'check-source-mirror.mjs');
const TEST_SCRIPT = resolve(REPO_ROOT, 'test', 'run-all.js');
const BROWSER_SCRIPT = resolve(REPO_ROOT, 'scripts', 'smoke-browser.js');
const IMPORT_BENCHMARK_SCRIPT = resolve(REPO_ROOT, 'scripts', 'benchmark-import-reliability.js');
const SYNC_SCRIPT = resolve(import.meta.dirname, 'sync-public.mjs');
const DEPLOY_SCRIPT = resolve(import.meta.dirname, 'deploy-production.mjs');

function defaultRunPhase(_name, script, args) {
  execFileSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  });
}

export function releaseProduction({
  deploymentArgs = [],
  runPhase = defaultRunPhase
} = {}) {
  // First, and before anything expensive: a release publishes through the
  // public repository and never touches the private one, so the mirror can fall
  // behind silently while every release still succeeds.
  runPhase('source-mirror', MIRROR_SCRIPT, []);
  runPhase('tests', TEST_SCRIPT, []);
  runPhase('browser', BROWSER_SCRIPT, []);
  runPhase('import-benchmark', IMPORT_BENCHMARK_SCRIPT, ['--candidate', 'HEAD']);
  runPhase('publish', SYNC_SCRIPT, []);
  runPhase('deploy', DEPLOY_SCRIPT, deploymentArgs);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    releaseProduction({ deploymentArgs: process.argv.slice(2) });
  } catch (error) {
    console.error(`release-production error: ${error.message}`);
    process.exitCode = 1;
  }
}
