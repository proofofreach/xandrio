#!/usr/bin/env node
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const syncScript = resolve(__dirname, '..', 'scripts', 'release', 'sync-public.mjs');
const { readFileSync } = require('node:fs');
let passed = 0;
let failed = 0;

function check(name, callback) {
  try {
    callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

// The script resolves the repository root from its own location, so it always
// runs against the real repo; --dry-run plus the guard firing before any git
// mutation keeps these invocations side-effect free.
function invoke(...extra) {
  return spawnSync(process.execPath, [syncScript, '--dry-run', ...extra], {
    encoding: 'utf8'
  });
}

const GUARD = /only 'main' may publish/;

check('refuses to publish from a branch other than main', () => {
  const result = invoke('--source', 'feat/anything');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, GUARD);
});

check('--allow-source bypasses the trunk-only guard', () => {
  const result = invoke('--source', 'feat/anything', '--allow-source');
  // The run may still stop later (dirty tree, missing remote in CI); the
  // guard itself must not be what stops it.
  assert.doesNotMatch(result.stderr || '', GUARD);
});

check('a main source is never rejected by the guard', () => {
  const result = invoke('--source', 'main');
  assert.doesNotMatch(result.stderr || '', GUARD);
});

check('candidate scan clone excludes private-history tags', () => {
  const source = readFileSync(syncScript, 'utf8');
  assert.match(
    source,
    /git\('clone', '--quiet', '--single-branch', '--no-tags', '--branch'/
  );
});

check('default publication waits for merge before advancing its checkpoint', () => {
  const source = readFileSync(syncScript, 'utf8');
  const waitIndex = source.indexOf('waitForMergedPullRequest(prUrl)');
  const tagIndex = source.indexOf("persistCheckpoint(git('rev-parse', source))");
  assert(waitIndex !== -1);
  assert(tagIndex > waitIndex);
  assert.match(source, /gh\('pr', 'checks'.*'--watch'/s);
});

check('known private-only files preserve their public exclusion automatically', () => {
  const source = readFileSync(syncScript, 'utf8');
  assert.match(source, /PUBLIC_EXCLUDED_PATHS = new Set\(\['AGENTS\.md'\]\)/);
  assert.match(source, /canAutoResolvePublicExclusions\(conflicts\)/);
  assert.match(source, /git\('rm', '--ignore-unmatch', '--', filePath\)/);
});

check('publication waits through GitHub check-registration latency', () => {
  const source = readFileSync(syncScript, 'utf8');
  assert.match(source, /isPendingCheckRegistration\(error\)/);
  assert.match(source, /Waiting for GitHub to register release checks/);
  assert.match(source, /sleep\(5000\)/);
});

check('publication uses a durable checkpoint rather than unstable patch IDs', () => {
  const source = readFileSync(syncScript, 'utf8');
  assert.match(source, /git\('rev-list', '--reverse', `\$\{baseLimit\}\.\.\$\{source\}`\)/);
  assert.doesNotMatch(source, /git\('cherry'/);
  assert.match(source, /Xandrio-Source-Commit:/);
  assert.match(source, /git\('push', '--force', PRIVATE_REMOTE, 'refs\/tags\/public-sync-base'\)/);
});

check('publication verifies the checkpoint against the published tree', () => {
  const source = readFileSync(syncScript, 'utf8');
  // A checkpoint seeded at the current head once asserted that two
  // unpublished commits had shipped. Because it only moves forward, nothing
  // downstream could notice; only the tree can falsify the claim.
  const driftIndex = source.indexOf('const drifted = driftedPaths(');
  const pendingIndex = source.indexOf("const pending = git('rev-list'");
  assert(driftIndex !== -1, 'drift verification is missing');
  assert(driftIndex < pendingIndex, 'drift must be checked before commits are selected');
  assert.match(source, /git\(\s*'diff', '--name-only', `\$\{REMOTE\}\/\$\{TARGET\}`, baseLimit\s*\)/);
  assert.match(source, /does not match public-sync-base/);
});

check('drift verification ignores only the deliberate public exclusions', () => {
  const source = readFileSync(syncScript, 'utf8');
  const body = source.slice(source.indexOf('export function driftedPaths'));
  assert.match(body, /!PUBLIC_EXCLUDED_PATHS\.has\(filePath\)/);
  // Anything else differing is unpublished work, so the guard must fail closed.
  assert.match(source, /if \(drifted\.length\) \{\s*fail\(/);
});

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
