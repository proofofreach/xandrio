/**
 * Player layout measurement for small iPhones (PWA standalone).
 *
 * Renders the real player view at small-iPhone viewports with simulated
 * standalone safe-area insets and reports whether the primary controls fit
 * without scrolling, where the fold lands, and the header height.
 *
 * env(safe-area-inset-*) cannot be forced in desktop Chromium, so insets are
 * simulated by rewriting the stylesheet's env() expressions to the target
 * device's inset values before measuring.
 */
const { chromium } = require('playwright');
const { startFixtureServer } = require('./verify-android-lockscreen');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const DEVICES = [
  { name: 'iPhone SE (3rd gen)', width: 375, height: 667, insetTop: 20, insetBottom: 0 },
  { name: 'iPhone 13 mini', width: 375, height: 812, insetTop: 50, insetBottom: 34 },
  { name: 'iPhone 15/16', width: 393, height: 852, insetTop: 59, insetBottom: 34 },
  { name: 'iPhone 16 Pro Max', width: 440, height: 956, insetTop: 62, insetBottom: 34 }
];

async function measureDevice(browser, origin, device, { standalone }) {
  const context = await browser.newContext({
    userAgent: IPHONE_UA,
    viewport: { width: device.width, height: device.height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  await page.route('**/style-v3.css*', async route => {
    const response = await route.fetch();
    let css = await response.text();
    css = css
      .replaceAll('env(safe-area-inset-top)', `${device.insetTop}px`)
      .replaceAll('env(safe-area-inset-bottom)', `${device.insetBottom}px`);
    if (standalone) {
      css = css.replaceAll('@media (display-mode: standalone)', '@media all');
    }
    await route.fulfill({ response, body: css });
  });
  await page.goto(`${origin}/#/player/lockscreen`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#player-view.active');
  await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none', null, { timeout: 20000 });
  await page.waitForTimeout(400); // cover fade-in

  const metrics = await page.evaluate(() => {
    const box = id => {
      const el = document.getElementById(id) || document.querySelector(id);
      if (!el || el.hidden) return null;
      const rect = el.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
    };
    const view = document.getElementById('player-view');
    return {
      viewport: window.innerHeight,
      pageScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
      viewScroll: Math.round(view.scrollHeight - view.clientHeight),
      bodyPaddingTop: Math.round(parseFloat(getComputedStyle(document.body).paddingTop)),
      topbar: box('.player-topbar'),
      cover: box('book-cover'),
      title: box('book-title'),
      chapterTrigger: box('chapter-sheet-btn'),
      progress: box('.player-progress'),
      controls: box('.player-controls'),
      utility: box('.player-utility-row')
    };
  });
  await context.close();
  return metrics;
}

async function main() {
  const fixture = await startFixtureServer();
  fixture.state.chapterAudioReady = true;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const standalone of [false, true]) {
      console.log(`\n=== ${standalone ? 'PWA standalone (body inset rule active)' : 'Browser tab'} ===`);
      for (const device of DEVICES) {
        const m = await measureDevice(browser, fixture.origin, device, { standalone });
        const fold = m.viewport;
        const primaryBottom = m.utility ? m.utility.bottom : (m.controls ? m.controls.bottom : null);
        const fits = primaryBottom !== null && primaryBottom <= fold && m.pageScroll <= 0;
        console.log(`${device.name} (${device.width}x${device.height}, insets ${device.insetTop}/${device.insetBottom})`);
        console.log(`  bodyPadTop=${m.bodyPaddingTop} topbarH=${m.topbar?.height} coverH=${m.cover?.height} pageScroll=${m.pageScroll} viewScroll=${m.viewScroll}`);
        console.log(`  controlsBottom=${m.controls?.bottom} utilityBottom=${m.utility?.bottom} viewport=${fold} -> primary controls ${fits ? 'FIT' : 'OVERFLOW by ' + (primaryBottom - fold + Math.max(m.pageScroll, 0)) + 'px'}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await fixture.close();
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
