/**
 * Browser regression for the global offline notice. The notice is fixed, so a
 * DOM-presence assertion cannot prove it leaves navigation usable. Exercise
 * the real offline scenario and compare rendered boxes at shipping phone and
 * desktop viewports instead.
 *
 * Run: node test/fixtures/scenarios/verify-offline-banner-layout.js
 */
const assert = require('node:assert');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./lib/environment');
const { VIEWPORTS } = require('../../../scripts/scenario-shots');

async function showOfflineBanner(page, textScale) {
  if (textScale === 'large') {
    await page.evaluate(() => { document.documentElement.style.zoom = '1.4'; });
    await page.waitForTimeout(150);
  }

  await page.context().setOffline(true);
  await page.waitForFunction(() => !document.getElementById('offline-banner')?.hidden);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('app')).paddingTop !== '0px');
}

async function assertOnlineRemovesBannerOffset(page, label) {
  await page.context().setOffline(false);
  await page.waitForFunction(() => document.getElementById('offline-banner')?.hidden);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('app')).paddingTop === '0px');
  console.log(`  ✓ ${label}: online state removes the banner offset`);
}

async function assertLibraryHeaderClearsBanner(page, textScale) {
  await showOfflineBanner(page, textScale);

  const geometry = await page.evaluate(() => {
    const rect = element => {
      const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    const banner = document.getElementById('offline-banner');
    const header = document.querySelector('.library-header');
    const logo = document.querySelector('.library-header .header-logo');
    const controls = [...document.querySelectorAll('.library-header .header-actions > button')]
      .filter(button => {
        const box = button.getBoundingClientRect();
        return !button.hidden && box.width > 0 && box.height > 0;
      })
      .map(rect);
    return { banner: rect(banner), header: rect(header), logo: rect(logo), controls };
  });

  assert(geometry.banner.height > 0, `${textScale}: the offline banner rendered`);
  assert(
    geometry.header.top >= geometry.banner.bottom,
    `${textScale}: library header begins below the offline banner (${geometry.header.top} < ${geometry.banner.bottom})`
  );
  assert(
    geometry.logo.top >= geometry.banner.bottom,
    `${textScale}: Xandrio logo clears the offline banner (${geometry.logo.top} < ${geometry.banner.bottom})`
  );
  assert(geometry.controls.length > 0, `${textScale}: header controls rendered`);
  for (const [index, control] of geometry.controls.entries()) {
    assert(
      control.top >= geometry.banner.bottom,
      `${textScale}: header control ${index + 1} clears the offline banner (${control.top} < ${geometry.banner.bottom})`
    );
  }
}

async function assertSelectorsClearBanner(page, selectors, label) {
  const geometry = await page.evaluate(selectors => {
    const banner = document.getElementById('offline-banner').getBoundingClientRect();
    const targets = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
      .filter(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map(element => {
        const box = element.getBoundingClientRect();
        return { selector: element.id ? `#${element.id}` : element.className, top: box.top };
      });
    return { bannerBottom: banner.bottom, targets };
  }, selectors);

  assert(geometry.targets.length > 0, `${label}: navigation controls rendered`);
  for (const target of geometry.targets) {
    assert(
      target.top >= geometry.bannerBottom,
      `${label}: ${target.selector} clears the offline banner (${target.top} < ${geometry.bannerBottom})`
    );
  }
}

async function openScenario(browser, env, viewport, scenario, route, activeView) {
  const context = await browser.newContext({
    ...viewport,
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'X-Xandrio-Scenario': scenario }
  });
  const page = await context.newPage();
  await page.goto(`${env.origin}/${route}`, { waitUntil: route.includes('player') ? 'domcontentloaded' : 'networkidle' });
  await page.waitForSelector(activeView);
  return { context, page };
}

async function main() {
  const env = await startScenarioEnvironment({
    proxyPort: 0,
    datasets: ['full'],
    defaultDataset: 'full'
  });
  const browser = await chromium.launch({ headless: true });
  let passed = 0;

  try {
    for (const textScale of ['normal', 'large']) {
      const { context, page } = await openScenario(
        browser, env, VIEWPORTS.mobile, 'library:offline', '#/library', '#library-view.active'
      );
      try {
        await assertLibraryHeaderClearsBanner(page, textScale);
        passed += 1;
        console.log(`  ✓ ${textScale} text: fixed offline banner clears the library navigation`);
        await assertOnlineRemovesBannerOffset(page, `${textScale} text`);
      } finally {
        await context.close();
      }
    }

    const desktopChecks = [
      {
        label: 'desktop library', scenario: 'library:offline', route: '#/library', activeView: '#library-view.active',
        selectors: ['.library-header', '.library-header .header-logo', '.library-header .header-actions > button']
      },
      {
        label: 'desktop player', scenario: 'player:offline', route: '#/player/scn-meridian', activeView: '#player-view.active',
        selectors: ['#player-view .player-topbar', '#player-view .player-topbar button']
      },
      {
        label: 'desktop settings', scenario: 'settings:offline', route: '#/settings', activeView: '#settings-view.active',
        selectors: ['#settings-back-btn']
      }
    ];
    for (const check of desktopChecks) {
      const { context, page } = await openScenario(
        browser, env, VIEWPORTS.desktop, check.scenario, check.route, check.activeView
      );
      try {
        await showOfflineBanner(page, 'normal');
        await assertSelectorsClearBanner(page, check.selectors, check.label);
        passed += 1;
        console.log(`  ✓ ${check.label}: fixed offline banner clears navigation`);
        await assertOnlineRemovesBannerOffset(page, check.label);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await env.close();
  }

  console.log(`\nOffline banner layout: ${passed}/5 geometry checks passed`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
