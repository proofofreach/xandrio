#!/usr/bin/env node
/**
 * Fast regressions for the screenshot gate's negative evidence contract.
 * These deliberately reproduce the previously accepted contaminated frames:
 * stale-guide banner, player error toast, clipped evidence, duplicate
 * bookmark rows, and evidence that leaves the viewport at large-text scale.
 * No scenario server is needed.
 */
const assert = require('node:assert');
const { chromium } = require('playwright');
const { assertDomSignature, applyTextScale } = require('../../../scripts/scenario-shots');
const { MATRIX } = require('./lib/matrix');

const baseCell = {
  domSignature: { present: ['#evidence'], absent: [], exactly: {} }
};

async function rejects(page, cell, pattern) {
  await assert.rejects(
    () => assertDomSignature(page, 'player', 'full', cell),
    pattern
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    await page.setContent('<div id="evidence" style="position:fixed;left:20px;top:20px;width:100px;height:40px"></div><div id="guide-body"><div class="guide-stale">stale</div></div>');
    await rejects(page, baseCell, /negative state check.*guide-stale/);

    await page.setContent('<div id="evidence" style="position:fixed;left:20px;top:20px;width:100px;height:40px"></div><div id="success-toast" class="show toast--error">failed</div>');
    await rejects(page, baseCell, /negative state check.*success-toast/);

    await page.setContent('<div id="evidence" style="position:fixed;left:20px;top:20px;width:100px;height:40px"></div><div id="offline-banner">offline</div>');
    await rejects(page, baseCell, /negative state check.*offline-banner/);
    await assert.doesNotReject(
      () => assertDomSignature(page, 'guide', 'offline', {
        ...baseCell,
        allowVisible: ['#offline-banner:not([hidden])']
      })
    );

    await page.setContent('<div id="evidence" style="position:fixed;left:360px;top:20px;width:100px;height:40px"></div>');
    await rejects(page, baseCell, /not fully contained/);

    await page.setContent('<div id="evidence" style="position:fixed;left:20px;top:20px;width:100px;height:40px"></div><div class="bookmark-row"></div><div class="bookmark-row"></div>');
    await rejects(page, {
      domSignature: {
        present: ['#evidence'],
        absent: [],
        exactly: { '.bookmark-row': 1 }
      }
    }, /duplicate-state check.*found 2/);

    // This reproduces the old ordering bug. The evidence fit when the
    // interaction first framed it at normal scale, but at 1.4x it cannot be
    // scrolled back because it is fixed. Capture validation must therefore
    // run only after applyTextScale(), against the layout the PNG receives.
    await page.setContent('<div id="evidence" style="position:fixed;left:20px;top:800px;width:100px;height:40px"></div>');
    await assert.doesNotReject(() => assertDomSignature(page, 'settings', 'full', baseCell));
    await applyTextScale(page, { textScale: 'large' });
    await rejects(page, baseCell, /not fully contained/);

    await context.close();
  } finally {
    await browser.close();
  }
  for (const view of ['library', 'search', 'settings', 'stats', 'guide', 'player']) {
    assert.deepStrictEqual(
      MATRIX[view].offline.allowVisible,
      ['#offline-banner:not([hidden])'],
      `${view}:offline must be the explicit exception to the offline-banner negative check`
    );
  }
  assert.deepStrictEqual(
    MATRIX.login.offline.allowVisible,
    undefined,
    'login:offline must not permit the authenticated-app offline banner'
  );
  console.log('scenario capture integrity regressions: 7 passed, 0 failed');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
