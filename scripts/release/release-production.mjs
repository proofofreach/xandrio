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
