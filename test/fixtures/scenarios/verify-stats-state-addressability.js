#!/usr/bin/env node
/**
 * Regression for the Stats fixture and capture contract. The full fixture
 * seeds listening positions, so its real /api/stats response must render the
 * tile surface at every sample variant; an out-of-date position structure key
 * otherwise makes the server filter every position and silently renders the
 * empty state instead.
 */
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-stats-states-'));
const states = ['empty', 'loading', 'error', 'offline', 'full'];
const fullVariants = [
  'mobile_dark_nopreference_normal.png',
  'mobile_dark_nopreference_large.png',
  'mobile_dark_reduce_normal.png',
  'mobile_light_nopreference_normal.png',
  'desktop_dark_nopreference_normal.png'
];

try {
  const result = spawnSync(process.execPath, [
    'scripts/scenario-shots.js',
    '--port=0',
    '--views=stats',
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

  assert.strictEqual(result.error, undefined, `stats scenario capture did not finish: ${result.error?.message}`);
  assert.strictEqual(result.status, 0, `stats scenario capture failed:\n${result.stdout}\n${result.stderr}`);

  for (const state of states) {
    const expected = state === 'full'
      ? fullVariants
      : ['mobile_dark_nopreference_normal.png'];
    for (const variant of expected) {
      const file = path.join(outputDir, 'stats', state, variant);
      assert.ok(fs.existsSync(file), `missing stats:${state} ${variant}`);
    }
  }

  console.log('stats state addressability regression: passed');
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
