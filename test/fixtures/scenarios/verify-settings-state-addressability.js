#!/usr/bin/env node
/**
 * Regression: each state-bearing Settings Voice surface must be opened and
 * visibly distinct on mobile and desktop. scenario-shots.js enforces the
 * state-specific DOM signatures before it writes these PNGs; this check also
 * rejects a byte-identical captured surface across the four declared states.
 */
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-settings-states-'));
const states = ['loading', 'error', 'degraded', 'full'];
const variants = [
  'mobile_dark_nopreference_normal.png',
  'desktop_dark_nopreference_normal.png'
];

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

try {
  // Only PATH is needed to start Node and ffmpeg. Do not pass through any
  // operator credentials or provider configuration to this fixture process.
  const result = spawnSync(process.execPath, [
    'scripts/scenario-shots.js',
    '--port=0',
    '--views=settings',
    `--states=${states.join(',')}`
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      PATH: process.env.PATH || '',
      SCENARIO_SHOTS_OUT_DIR: outputDir
    }
  });

  assert.strictEqual(result.error, undefined, `settings scenario capture did not finish: ${result.error?.message}`);
  assert.strictEqual(result.status, 0, `settings scenario capture failed:\n${result.stdout}\n${result.stderr}`);

  for (const variant of variants) {
    const hashes = new Map();
    for (const state of states) {
      const file = path.join(outputDir, 'settings', state, variant);
      assert.ok(fs.existsSync(file), `missing settings:${state} ${variant}`);
      const value = digest(file);
      const previous = hashes.get(value);
      assert.strictEqual(previous, undefined, `settings:${state} is byte-identical to settings:${previous} at ${variant}`);
      hashes.set(value, state);
    }
  }

  console.log('settings state addressability regression: passed');
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
