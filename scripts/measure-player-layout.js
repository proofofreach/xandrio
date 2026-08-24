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
const { chromium, webkit } = require('playwright');
const { startFixtureServer } = require('./verify-android-lockscreen');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const DEVICES = [
  { name: 'iPhone SE (3rd gen)', width: 375, height: 667, insetTop: 20, insetBottom: 0 },
  { name: 'iPhone 13 mini', width: 375, height: 812, insetTop: 50, insetBottom: 34 },
  { name: 'iPhone 15/16', width: 393, height: 852, insetTop: 59, insetBottom: 34 },
  { name: 'iPhone 16 Pro Max', width: 440, height: 956, insetTop: 62, insetBottom: 34 },
  // Landscape: the Dynamic Island sits on one side and iOS reports a 59px
  // inset on both; edge controls must clear it. The height fold is not a
  // pass/fail here (the player scrolls in landscape); horizontal containment is.
  { name: 'iPhone 15 Pro Max landscape', width: 932, height: 430, insetTop: 0, insetBottom: 21, insetLeft: 59, insetRight: 59 }
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
      .replaceAll('env(safe-area-inset-bottom)', `${device.insetBottom}px`)
      .replaceAll('env(safe-area-inset-left, 0px)', `${device.insetLeft || 0}px`)
      .replaceAll('env(safe-area-inset-right, 0px)', `${device.insetRight || 0}px`);
    if (standalone) {
      css = css.replaceAll('@media (display-mode: standalone)', '@media all');
    }
    await route.fulfill({ response, body: css });
  });
  await page.goto(`${origin}/#/player/lockscreen`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#player-view.active');
  await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none', null, { timeout: 20000 });
  await page.waitForTimeout(400); // cover fade-in

  // Use representative production-length labels. Short fixture copy can hide
  // Safari min-content sizing regressions in the real player stack.
  await page.evaluate(() => {
    document.getElementById('book-title').textContent = "Napoleon Hill's Keys to Success: The 17 Principles of Personal Achievement";
    document.getElementById('chapter-trigger-title').textContent = '1 - Develop Definiteness Of Purpose (28m)';
    document.getElementById('book-progress-text').textContent = '20% · 4h 12m left';
    document.getElementById('player-book-progress').hidden = false;
    document.getElementById('player-voice-name').textContent = 'Kokoro Onyx · Kokoro';
    document.getElementById('player-voice-cache').textContent = '4/65 ready';
    document.getElementById('utility-speed-value').textContent = '1.2x';
  });

  const metrics = await page.evaluate(() => {
    const box = id => {
      const el = document.getElementById(id) || document.querySelector(id);
      if (!el || el.hidden) return null;
      const rect = el.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
    };
    const view = document.getElementById('player-view');
    const main = document.querySelector('.player-main');
    const mainStyle = getComputedStyle(main);
    const mainRect = main.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const overflowing = [...view.querySelectorAll('*')]
      .filter(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > viewportWidth + 1);
      })
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {
          selector: el.id ? `#${el.id}` : `.${[...el.classList].join('.')}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width)
        };
      })
      .slice(0, 8);
    return {
      viewport: window.innerHeight,
      viewportWidth,
      pageScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
      viewScroll: Math.round(view.scrollHeight - view.clientHeight),
      pageOverflowX: Math.round(document.documentElement.scrollWidth - viewportWidth),
      viewOverflowX: Math.round(view.scrollWidth - view.clientWidth),
      mainSizing: {
        width: Math.round(mainRect.width),
        minWidth: mainStyle.minWidth,
        maxWidth: mainStyle.maxWidth
      },
      overflowing,
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
  const fixture = await startFixtureServer({ singleFileReady: true });
  const failures = [];
  try {
    for (const [browserName, browserType] of [['Chromium', chromium], ['WebKit', webkit]]) {
      const browser = await browserType.launch({ headless: true });
      try {
        for (const standalone of [false, true]) {
          console.log(`\n=== ${browserName} · ${standalone ? 'PWA standalone' : 'browser tab'} ===`);
          for (const device of DEVICES) {
            const m = await measureDevice(browser, fixture.origin, device, { standalone });
            const fold = m.viewport;
            const primaryBottom = m.utility ? m.utility.bottom : (m.controls ? m.controls.bottom : null);
            const fits = primaryBottom !== null && primaryBottom <= fold && m.pageScroll <= 0;
            const mainIsContained = m.mainSizing.width <= m.viewportWidth + 1 && m.mainSizing.minWidth === '0px';
            const fitsWidth = mainIsContained && m.pageOverflowX <= 0 && m.viewOverflowX <= 0 && m.overflowing.length === 0;
            console.log(`${device.name} (${device.width}x${device.height}, insets top/bottom ${device.insetTop}/${device.insetBottom}, sides ${device.insetLeft || 0}/${device.insetRight || 0})`);
            console.log(`  bodyPadTop=${m.bodyPaddingTop} topbarH=${m.topbar?.height} coverH=${m.cover?.height} pageScroll=${m.pageScroll} viewScroll=${m.viewScroll}`);
            console.log(`  controlsBottom=${m.controls?.bottom} utilityBottom=${m.utility?.bottom} viewport=${fold} -> primary controls ${fits ? 'FIT' : 'OVERFLOW by ' + (primaryBottom - fold + Math.max(m.pageScroll, 0)) + 'px'}`);
            console.log(`  horizontal page=${m.pageOverflowX}px view=${m.viewOverflowX}px main=${JSON.stringify(m.mainSizing)} -> ${fitsWidth ? 'FIT' : 'UNCONTAINED'}${m.overflowing.length ? ` ${JSON.stringify(m.overflowing)}` : ''}`);
            if (!fitsWidth) failures.push(`${browserName} ${device.name} ${standalone ? 'standalone' : 'tab'} is not horizontally contained`);
          }
        }
      } finally {
        await browser.close().catch(() => {});
      }
    }
  } finally {
    await fixture.close();
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
