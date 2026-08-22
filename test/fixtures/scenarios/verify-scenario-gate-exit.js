#!/usr/bin/env node
/**
 * Regression check: the scenario gate must keep its one-line JSON judge
 * envelope while returning a nonzero shell status for semantic failures.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '../../..');
const fixture = path.join(__dirname, 'fake-semantic-failure-shots.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-gate-exit-'));

try {
  function runGate(variant) {
    return spawnSync(process.execPath, [
      path.join(projectRoot, 'scripts', 'run-ws00-scenario-gate.mjs'),
      tempRoot
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, SCENARIO_SHOTS_SCRIPT: fixture, SCENARIO_SHOTS_VARIANT: variant }
    });
  }

  const result = runGate('stable');

  assert.strictEqual(result.status, 1, `expected actionable gate to exit 1, got ${result.status}: ${result.stderr}`);
  assert.strictEqual(result.stderr, '');
  const envelope = JSON.parse(result.stdout);
  assert.strictEqual(envelope.status, 'actionable');
  assert.ok(envelope.evidence.failures.some((failure) => failure.includes('library:empty is byte-identical to library:cold')));

  const stableRepeat = JSON.parse(runGate('stable').stdout);
  const changedBytes = JSON.parse(runGate('changed').stdout);
  assert.strictEqual(stableRepeat.evidence.screenshots, 90);
  assert.strictEqual(changedBytes.evidence.screenshots, 90);
  assert.strictEqual(
    envelope.evidence.fingerprint,
    stableRepeat.evidence.fingerprint,
    'same screenshot paths and bytes must keep the gate fingerprint stable'
  );
  assert.notStrictEqual(
    envelope.evidence.fingerprint,
    changedBytes.evidence.fingerprint,
    'changed screenshot bytes at an otherwise identical path must change the gate fingerprint'
  );
  console.log('scenario gate fingerprint and actionable-result exit regressions: passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
