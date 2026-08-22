#!/usr/bin/env node
/**
 * Finite regression for stateful playback sheets. It proves that every
 * declared sheet has an addressable product route and a real interaction,
 * then drives those cells through the screenshot runner at mobile and desktop
 * sizes. The runner rejects a selector that is merely in the DOM but outside
 * the screenshot viewport, so successful output is viewport evidence too.
 */
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const { MATRIX, HASH_ROUTE } = require('./lib/matrix');
const { expectedPixelSize, readPngDimensions } = require('../../../scripts/scenario-shots');

const playerStates = ['chapters', 'bookmarks', 'voice', 'voice-degraded', 'speed', 'sleep', 'pronunciation'];
const cells = [
  ...playerStates.map(state => ({ view: 'player', state })),
  { view: 'activity', state: 'active' }
];
const variants = ['mobile', 'desktop'];
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-player-sheets-'));

function filename(viewport) {
  return `${viewport}_dark_nopreference_normal.png`;
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

try {
  for (const { view, state } of cells) {
    const cell = MATRIX[view]?.[state];
    assert.ok(cell?.applicable, `${view}:${state} must be a declared applicable scenario cell`);
    assert.strictEqual(cell.overlay, true, `${view}:${state} must declare responsive sheet coverage`);
    assert.ok(cell.route, `${view}:${state} must declare a product route`);
    assert.ok(cell.interaction, `${view}:${state} must declare a real product interaction`);
    assert.ok(cell.domSignature?.present?.length, `${view}:${state} must declare visible distinguishing evidence`);
    if (view === 'player') {
      assert.strictEqual(cell.isolateVariants, true, `${view}:${state} must get a fresh server dataset per variant`);
    }
  }
  assert.deepStrictEqual(
    MATRIX.player.bookmarks.domSignature.exactly,
    { '#chapter-sheet.active .bookmarks-section .bookmark-row': 1 },
    'bookmark evidence must reject rows leaked from an earlier variant'
  );
  assert.strictEqual(MATRIX.player.chapters.route, HASH_ROUTE.player);
  assert.strictEqual(MATRIX.activity.active.route, HASH_ROUTE.activity);

  const result = spawnSync(process.execPath, [
    'scripts/scenario-shots.js',
    '--port=0',
    '--views=player,activity',
    `--states=${[...playerStates, 'active'].join(',')}`
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      PATH: process.env.PATH || '',
      SCENARIO_SHOTS_OUT_DIR: outputDir
    }
  });

  assert.strictEqual(result.error, undefined, `player sheet capture did not finish: ${result.error?.message}`);
  assert.strictEqual(result.status, 0, `player sheet capture failed:\n${result.stdout}\n${result.stderr}`);

  for (const { view, state } of cells) {
    for (const viewport of variants) {
      const file = path.join(outputDir, view, state, filename(viewport));
      assert.ok(fs.existsSync(file), `missing ${view}:${state} ${viewport} capture`);
      const dimensions = readPngDimensions(fs.readFileSync(file));
      assert.deepStrictEqual(dimensions, expectedPixelSize(viewport), `${view}:${state} ${viewport} has the wrong viewport dimensions`);
    }
  }

  for (const viewport of variants) {
    const fullVoice = path.join(outputDir, 'player', 'voice', filename(viewport));
    const degradedVoice = path.join(outputDir, 'player', 'voice-degraded', filename(viewport));
    assert.notStrictEqual(digest(fullVoice), digest(degradedVoice), `voice-degraded must visibly differ from voice at ${viewport}`);
  }

  console.log('player sheet addressability and viewport regression: passed');
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
