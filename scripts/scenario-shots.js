#!/usr/bin/env node
/**
 * Deterministic screenshot sweep over the scenario matrix
 * (test/fixtures/scenarios/lib/matrix.js), driven against the real
 * server.js/public bundle via scripts/scenario-server.js's environment.
 *
 * Usage:
 *   npm run scenario:shots
 *   node scripts/scenario-shots.js --dimensions=full
 *   node scripts/scenario-shots.js --views=library,player --states=full,loading
 *
 * Output: artifacts/scenario-shots/<view>/<state>/<variant>.png
 *
 * Dimension coverage — Xandrio ships one fixed dark theme and has no in-app
 * text-scale control (confirmed by reading public/app.js and style-v3.css;
 * see docs/SCENARIO_SERVER.md). "light" is captured via a forced
 * prefers-color-scheme so any accidental light leakage (native form control
 * chrome, browser UA styles) is still caught; "large text" is captured via
 * a page-zoom emulation of real accessibility zoom, since there is no
 * dedicated control to drive instead.
 *
 * By default (--dimensions=sample) every applicable (view, state) gets one
 * mobile/dark/normal-motion/normal-text shot, and only each view's "full"
 * state additionally gets desktop, light, reduced-motion, and large-text
 * variants — the full cartesian product (--dimensions=full) is several
 * hundred screenshots and is meant for deliberate, occasional audits, not
 * every run.
 */
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

const { startScenarioEnvironment } = require('../test/fixtures/scenarios/lib/environment');
const { MATRIX, HASH_ROUTE } = require('../test/fixtures/scenarios/lib/matrix');

// Tests can direct output to a temporary directory, which keeps their proof
// isolated from a developer's retained screenshot artifacts.
const OUT_DIR = process.env.SCENARIO_SHOTS_OUT_DIR
  ? path.resolve(process.env.SCENARIO_SHOTS_OUT_DIR)
  : path.join(__dirname, '..', 'artifacts', 'scenario-shots');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// `browser.newContext()` takes viewport dimensions nested under `viewport:
// {width, height}` — top-level `width`/`height` keys are silently ignored,
// so a context created that way just gets Playwright's 1280x720 default.
// This shape keeps the CSS-pixel viewport nested while `isMobile`,
// `hasTouch`, `deviceScaleFactor`, and `userAgent` stay top-level, so
// `{...VIEWPORTS[name], ...otherContextOptions}` produces valid options.
const VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: IPHONE_UA },
  desktop: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }
};

// A screenshot's actual pixel dimensions are the CSS viewport size times the
// device scale factor — the one fact that makes it possible to verify, from
// the PNG bytes alone, that a context really got the viewport it asked for.
function expectedPixelSize(viewportName) {
  const config = VIEWPORTS[viewportName];
  return {
    width: config.viewport.width * config.deviceScaleFactor,
    height: config.viewport.height * config.deviceScaleFactor
  };
}

// Reads width/height straight out of the PNG IHDR chunk (bytes 16-23):
// 8-byte signature, 4-byte chunk length, 4-byte "IHDR" type, then two
// big-endian uint32s. Avoids pulling in an image-decoding dependency for a
// two-field check.
function readPngDimensions(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseArgs(argv) {
  const args = { dimensions: 'sample', views: null, states: null };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'dimensions') args.dimensions = value;
    else if (key === 'views') args.views = value.split(',');
    else if (key === 'states') args.states = value.split(',');
    else if (key === 'port') args.port = Number(value);
  }
  return args;
}

// Full cartesian product of (viewport, colorScheme, motion, textScale). The
// "primary" variant is always shot; extras are added only for --dimensions=full
// or for a view's "full" state under --dimensions=sample.
const ALL_VARIANTS = [];
for (const viewport of ['mobile', 'desktop']) {
  for (const colorScheme of ['dark', 'light']) {
    for (const motion of ['no-preference', 'reduce']) {
      for (const textScale of ['normal', 'large']) {
        ALL_VARIANTS.push({ viewport, colorScheme, motion, textScale });
      }
    }
  }
}
const PRIMARY_VARIANT = { viewport: 'mobile', colorScheme: 'dark', motion: 'no-preference', textScale: 'normal' };

function variantLabel(variant) {
  return `${variant.viewport}_${variant.colorScheme}_${variant.motion.replace('-', '')}_${variant.textScale}`;
}

function requiresSettingsStateSurface(view, state) {
  return view === 'settings' && ['loading', 'error', 'degraded', 'full'].includes(state);
}

function requiresOverlaySurface(cell) {
  return Boolean(cell?.overlay);
}

function variantsFor(dimensions, view, state, cell) {
  if (dimensions === 'full') return ALL_VARIANTS;
  if (state === 'full') return ALL_VARIANTS.filter(v =>
    JSON.stringify(v) === JSON.stringify(PRIMARY_VARIANT) ||
    v.viewport === 'desktop' && v.colorScheme === 'dark' && v.motion === 'no-preference' && v.textScale === 'normal' ||
    v.viewport === 'mobile' && v.colorScheme === 'light' && v.motion === 'no-preference' && v.textScale === 'normal' ||
    v.viewport === 'mobile' && v.colorScheme === 'dark' && v.motion === 'reduce' && v.textScale === 'normal' ||
    v.viewport === 'mobile' && v.colorScheme === 'dark' && v.motion === 'no-preference' && v.textScale === 'large'
  );
  // Settings states only become meaningful once the closed Voice accordion is
  // opened. Capture that exposed surface at both responsive breakpoints, not
  // just the mobile primary frame, so desktop coverage cannot silently fall
  // back to the collapsed, byte-identical settings shell.
  if (requiresSettingsStateSurface(view, state)) {
    return [
      PRIMARY_VARIANT,
      { viewport: 'desktop', colorScheme: 'dark', motion: 'no-preference', textScale: 'normal' }
    ];
  }
  // Stateful player overlays are independent scenario cells. Their only
  // useful evidence is the exposed panel itself, so always capture it at both
  // representative breakpoints rather than treating desktop as an optional
  // full-view variant.
  if (requiresOverlaySurface(cell)) {
    return [
      PRIMARY_VARIANT,
      { viewport: 'desktop', colorScheme: 'dark', motion: 'no-preference', textScale: 'normal' }
    ];
  }
  return [PRIMARY_VARIANT];
}

async function findFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() > 0 && await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function performInteraction(page, interaction, log) {
  if (interaction === 'search-full' || interaction === 'search-loading' || interaction === 'search-empty' || interaction === 'search-error') {
    const input = await findFirst(page, ['#search-input', 'input[type="search"]', 'input[name="q"]', '.search-input input', '.search-box input']);
    if (!input) return log('  (skipping search interaction — no search input found)');
    // The default source set (test/fixtures/scenarios/lib/provision.js
    // seedClientSettings: gutenberg + standardebooks only — internetarchive/
    // annas/zlibrary/opds all sit behind an intentionally-off "unverified
    // sources" acknowledgement) never reaches the custom-OPDS fixture entry
    // "The Meridian Line", the only fixture title containing "meridian" —
    // so that query would always come back empty even with the right button
    // clicked. "boundaries" matches Gutenberg's "A Treatise on Old
    // Boundaries" (content/search-results.json), a real hit through a
    // source this harness actually enables by default.
    const query = interaction === 'search-empty' ? 'zzznonexistentscenarioquery' : 'boundaries';
    await input.fill(query);
    // '.search-box button' used to be in this list and matched
    // #search-clear-btn before #search-btn in DOM order — findFirst's
    // isVisible() filter let it through because fill() above just made the
    // (previously hidden) clear button visible, so every "search" click was
    // silently clicking Clear instead of Search. #search-btn (public/index.html)
    // is the one actual submit control; name it exactly, no generic fallback
    // that could re-match the clear button.
    const submit = await findFirst(page, ['#search-btn']);
    if (submit) await submit.click(); else await input.press('Enter');
    return true;
  }
  if (interaction === 'settings-expand-voice') {
    // The Voice section (public/index.html) is a native <details
    // class="settings-section"> with no "open" attribute, so its voice-card
    // markup never renders visibly until a user (or this interaction) opens
    // it — clicking the <summary> is exactly how a real user would.
    const summary = page.locator('details:has(#voice-list) > summary').first();
    const visible = await summary.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true, () => false);
    if (!visible) return log('  (skipping settings accordion interaction — no Voice section found)');
    await summary.click();
    // The Voice section is deliberately late in the long Settings page. A
    // summary click exposes it but does not guarantee that the state-bearing
    // voice list is within the fixed viewport screenshot. Scroll the real
    // list into the frame after opening it so a degraded engine card cannot
    // be technically present in the DOM yet indistinguishable from "full".
    await page.locator('#voice-list').scrollIntoViewIfNeeded();
    return true;
  }
  if (interaction === 'player-open-chapters') {
    const trigger = await findFirst(page, ['#chapter-sheet-btn', '#utility-chapters-btn']);
    if (!trigger) return log('  (skipping chapter-sheet interaction — no chapter trigger found)');
    await trigger.click();
    return true;
  }
  if (interaction === 'player-add-bookmark-and-open-chapters') {
    const bookmark = await findFirst(page, ['#bookmark-btn', '#utility-bookmark-btn']);
    if (!bookmark) return log('  (skipping bookmark interaction — no bookmark trigger found)');
    await bookmark.click();
    await page.waitForTimeout(350);
    const trigger = await findFirst(page, ['#chapter-sheet-btn', '#utility-chapters-btn']);
    if (!trigger) return log('  (skipping chapter-sheet interaction — no chapter trigger found)');
    await trigger.click();
    return true;
  }
  if (interaction === 'player-open-voice') {
    const trigger = await findFirst(page, ['#voice-btn', '#player-voice-status']);
    if (!trigger) return log('  (skipping voice-sheet interaction — no voice trigger found)');
    await trigger.click();
    return true;
  }
  if (interaction === 'player-open-speed') {
    const trigger = await findFirst(page, ['#speed-sheet-btn', '#utility-speed-btn']);
    if (!trigger) return log('  (skipping speed-sheet interaction — no speed trigger found)');
    await trigger.click();
    return true;
  }
  if (interaction === 'player-open-sleep') {
    const trigger = await findFirst(page, ['#timer-btn-inline', '#utility-timer-btn']);
    if (!trigger) return log('  (skipping sleep-sheet interaction — no timer trigger found)');
    await trigger.click();
    return true;
  }
  if (interaction === 'player-open-pronunciation') {
    const trigger = await findFirst(page, ['#pronunciation-repair-btn']);
    if (!trigger) return log('  (skipping pronunciation interaction — no repair trigger found)');
    await trigger.click();
    return true;
  }
  if (interaction === 'library-start-offline-and-open-activity') {
    const activityTrigger = page.locator('#queue-status').first();
    // The mobile capture starts the durable preparation. The desktop capture
    // intentionally reuses that same real server state, so open the already
    // visible activity control rather than pretending a second request is a
    // fresh action.
    if (await activityTrigger.isVisible().catch(() => false)) {
      await activityTrigger.click();
      return true;
    }
    // Each viewport is a separate browser context but intentionally shares
    // the same deterministic server dataset. The first preparation can finish
    // before the second viewport arrives, so choose the first title whose real
    // overflow menu still offers offline setup instead of assuming one fixed
    // book remains pending.
    let offlineAction = null;
    for (const bookId of ['scn-driftwood', 'scn-fieldnotes', 'scn-lighthouse', 'scn-meridian']) {
      const menu = page.locator(`[data-book-id="${bookId}"] [data-book-menu-toggle]`).first();
      if (!(await menu.isVisible().catch(() => false))) continue;
      await menu.click();
      const candidate = page.locator(`[data-download-book="${bookId}"]`).first();
      if (await candidate.isVisible().catch(() => false)) {
        offlineAction = candidate;
        break;
      }
    }
    if (!offlineAction) return log('  (skipping audio-activity interaction — no offline action found)');
    await offlineAction.click();
    const active = await activityTrigger.waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true, () => false);
    if (!active) return log('  (skipping audio-activity interaction — offline preparation did not expose activity)');
    await activityTrigger.click();
    return true;
  }
  if (interaction === 'login-error') {
    const username = await findFirst(page, ['#login-username', 'input[name="username"]', '#username']);
    const password = await findFirst(page, ['#login-password', 'input[name="password"]', '#password']);
    if (!username || !password) return log('  (skipping login interaction — no login fields found)');
    await username.fill('reader');
    await password.fill('not-the-right-password');
    const submit = await findFirst(page, ['#login-submit', '#login-view button[type="submit"]', '.login-gate button[type="submit"]']);
    if (submit) await submit.click(); else await password.press('Enter');
    return true;
  }
  return false;
}

// Proves — before a screenshot is trusted and written to disk — that a cell's
// declared state actually rendered, instead of just capturing whatever
// happened to be on screen. Both `present` and `absent` selectors are polled
// rather than checked once: by this point every state-specific wait above
// has already run, so the state is normally already settled, but the player
// view's real (unmocked) TTS pipeline can occasionally still be finishing up
// a little past its own wait — polling here absorbs that without weakening
// what's actually being proven.
async function assertDomSignature(page, view, state, cell) {
  const signature = cell.domSignature;
  const visibleEvidence = [];
  const allowedVisible = new Set(cell.allowVisible || []);
  const forbiddenVisible = [
    '#success-toast.show.toast--error',
    '#deployment-banner:not([hidden])',
    '#offline-banner:not([hidden])',
    '#guide-body .guide-stale',
    '#audio-loading[data-status="error"]',
    '#playback-reliability:not([hidden])',
    '#playback-resume-prompt:not([hidden])'
  ];

  for (const selector of forbiddenVisible) {
    if (allowedVisible.has(selector)) continue;
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) {
      throw new Error(
        `${view}:${state} failed its negative state check — unexpected visible "${selector}" would contaminate this capture.`
      );
    }
  }

  if (!signature) return;
  for (const selector of signature.present) {
    const locator = page.locator(selector).first();
    const found = await locator.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false);
    if (!found) {
      throw new Error(
        `${view}:${state} failed its DOM-signature check — expected "${selector}" to be visible, ` +
        'proving the declared state actually rendered, but it never appeared.'
      );
    }
    // Some sheets populate asynchronously after the real open interaction.
    // Bring the proven state-bearing element into the capture frame only
    // after it exists; this is an ordinary reader scroll, not a fabricated
    // DOM state. The subsequent geometry check still rejects evidence that
    // the screenshot cannot actually see.
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    visibleEvidence.push({ selector, locator });
  }
  for (const [selector, expected] of Object.entries(signature.exactly || {})) {
    const actual = await page.locator(selector).count();
    if (actual !== expected) {
      throw new Error(
        `${view}:${state} failed its duplicate-state check — expected exactly ${expected} "${selector}" element(s), found ${actual}.`
      );
    }
  }
  for (const { selector, locator } of visibleEvidence) {
    // A visible DOM node is not screenshot evidence when it sits beyond a
    // fixed viewport. Evidence must fit entirely inside the final viewport;
    // an edge intersection can still clip the only distinguishing text.
    const fitsViewport = await locator.evaluate(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 &&
        box.left >= 0 && box.top >= 0 &&
        box.right <= window.innerWidth && box.bottom <= window.innerHeight;
    }).catch(() => false);
    if (!fitsViewport) {
      throw new Error(
        `${view}:${state} failed its viewport-evidence check — "${selector}" is visible in the DOM ` +
        'but is not fully contained in the screenshot viewport.'
      );
    }
  }
  for (const selector of signature.absent) {
    const stillVisible = await page.waitForSelector(selector, { state: 'hidden', timeout: 3000 })
      .then(() => false, () => true);
    if (stillVisible) {
      throw new Error(
        `${view}:${state} failed its DOM-signature check — "${selector}" is still visible, ` +
        'but this declared state requires it to be gone.'
      );
    }
  }
}

// Apply the visual variant before any state-specific interaction or evidence
// framing. In particular, a Voice card that fits at normal scale can move out
// of the fixed screenshot viewport at 1.4x. assertDomSignature() deliberately
// scrolls positive evidence into view, so running it only after this step
// both validates and frames the layout that the PNG will actually capture.
async function applyTextScale(page, variant) {
  if (variant.textScale !== 'large') return;
  await page.evaluate(() => {
    document.documentElement.style.zoom = '1.4';
  });
  await page.waitForTimeout(150);
}

async function captureOne({ browser, origin, view, state, cell, variant, log }) {
  const viewportConfig = VIEWPORTS[variant.viewport];
  const context = await browser.newContext({
    ...viewportConfig,
    colorScheme: variant.colorScheme,
    reducedMotion: variant.motion,
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'X-Xandrio-Scenario': `${view}:${state}` }
  });
  const page = await context.newPage();
  try {
    const url = `${origin}${cell.route || HASH_ROUTE[view]}`;
    const isLoadingLike = state === 'loading' || state === 'skeleton';
    // player/guide poll a status endpoint every ~1.5s while audio/narration
    // prepares, which means the network is never briefly idle enough for
    // Playwright's 'networkidle' to resolve — it would just eat the full
    // 30s timeout on every load. 'domcontentloaded' plus each state's own
    // explicit readiness wait below is both faster and more accurate.
    const waitUntil = isLoadingLike || view === 'player' || view === 'guide' ? 'domcontentloaded' : 'networkidle';
    await page.goto(url, { waitUntil, timeout: 30000 }).catch(error => {
      log(`  navigation warning: ${error.message}`);
    });

    // This must precede route checks, interactions, and every DOM/geometry
    // assertion. The screenshot is evidence of the final accessibility scale,
    // not the normal-scale layout that happened to exist while it was prepared.
    await applyTextScale(page, variant);

    // Hash routing completes after the document itself loads. Stateful
    // overlays must never try to click controls from the previous/library
    // view just because DOMContentLoaded won a race with the router.
    if (cell.overlay) {
      const activeView = view === 'activity' ? '#library-view.active' : '#player-view.active';
      const routed = await page.waitForSelector(activeView, { state: 'visible', timeout: 8000 })
        .then(() => true, () => false);
      if (!routed) {
        throw new Error(`${view}:${state} did not activate its declared product route (${cell.route || HASH_ROUTE[view]}).`);
      }
    }

    if (cell.interaction) {
      const acted = await performInteraction(page, cell.interaction, log);
      if (acted && isLoadingLike) await page.waitForTimeout(600);
      else if (acted) await page.waitForTimeout(1200);
    }

    if (state === 'offline') {
      await page.waitForTimeout(300);
      await context.setOffline(true);
      await page.waitForTimeout(300);
    } else if (isLoadingLike) {
      // Capture mid-flight, well inside the proxy's injected delay window.
      await page.waitForTimeout(600);
    } else if (state === 'cold') {
      await page.waitForSelector('#operator-notice-dialog.active', { timeout: 5000 }).catch(() => {});
    } else if (view === 'player') {
      // The player kicks off real chapter-audio preparation on mount —
      // against the real TTS pipeline (stubbed only at the engine network
      // boundary), first readiness takes a couple of seconds, not
      // milliseconds. Wait for the loading overlay to clear rather than a
      // fixed delay, so this isn't a flaky race against the real pipeline.
      await page.waitForFunction(
        () => document.getElementById('audio-loading')?.style.display === 'none',
        null,
        { timeout: 8000 }
      ).catch(() => {});
      await page.waitForTimeout(300);
    } else if (view === 'guide') {
      // Also navigated with 'domcontentloaded' (guide polls narration status
      // continuously, so 'networkidle' never resolves). The guide fetch
      // itself briefly renders an optimistic/default state before the real
      // status lands — 300ms caught that transient frame in testing (e.g. a
      // stray "may be out of date" banner on an artifact the API itself
      // reports as fresh); this view's single fetch just needs longer.
      await page.waitForTimeout(1500);
    } else {
      await page.waitForTimeout(300);
    }
    await assertDomSignature(page, view, state, cell);

    const dir = path.join(OUT_DIR, view, state);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${variantLabel(variant)}.png`);
    const png = await page.screenshot({ fullPage: false });
    const actual = readPngDimensions(png);
    const expected = expectedPixelSize(variant.viewport);
    if (actual.width !== expected.width || actual.height !== expected.height) {
      throw new Error(
        `${view}:${state} ${variantLabel(variant)}.png rendered at ${actual.width}x${actual.height}px, ` +
        `expected ${expected.width}x${expected.height}px for the "${variant.viewport}" viewport — ` +
        'the context did not actually get the requested viewport size.'
      );
    }
    await fs.writeFile(filePath, png);
    log(`  wrote ${path.relative(process.cwd(), filePath)}`);
  } finally {
    await context.close();
  }
}

// A single (view, state, variant) failing — a real product race, a slow
// real pipeline, a bad selector — used to abort the entire process
// immediately, which meant one bad cell could cost every other cell its
// screenshot too: a single run could never produce a complete, trustworthy
// artifact set to inspect, and a transient failure at cell 3 hid whatever
// cells 4-56 would otherwise have proven. Every applicable cell now always
// gets attempted regardless of earlier failures; failures are collected and
// only fail the run (nonzero exit) once the full sweep has finished, so a
// bad run still leaves behind every screenshot that *did* succeed.
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = message => console.log(`[scenario-shots] ${message}`);

  const env = await startScenarioEnvironment({ proxyPort: args.port, log });
  const browser = await chromium.launch({ headless: true });

  let shots = 0;
  let skipped = 0;
  const failures = [];
  try {
    for (const [view, states] of Object.entries(MATRIX)) {
      if (args.views && !args.views.includes(view)) continue;
      for (const [state, cell] of Object.entries(states)) {
        if (args.states && !args.states.includes(state)) continue;
        if (!cell.applicable) {
          log(`skipping ${view}:${state} — ${cell.reason}`);
          skipped++;
          continue;
        }
        log(`${view}:${state} (dataset=${cell.dataset})`);
        for (const variant of variantsFor(args.dimensions, view, state, cell)) {
          // Audio Activity starts a durable server-side preparation via the
          // same UI a reader uses. A very small fixture title can complete
          // between mobile and desktop screenshots, so that one state gets a
          // fresh deterministic product environment per variant. This keeps
          // the capture state real without slowing or mutating other cells.
          const isolatedEnv = cell.isolateVariants
            ? await startScenarioEnvironment({
              proxyPort: 0,
              datasets: [cell.dataset],
              defaultDataset: cell.dataset,
              log
            })
            : null;
          try {
            await captureOne({ browser, origin: isolatedEnv?.origin || env.origin, view, state, cell, variant, log });
            shots++;
          } catch (error) {
            const label = `${view}:${state} ${variantLabel(variant)}`;
            log(`  FAILED ${label} — ${error.message}`);
            failures.push({ label, error });
          } finally {
            await isolatedEnv?.close();
          }
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await env.close();
  }

  log(`done: ${shots} screenshots written, ${skipped} (view, state) cells skipped, ${failures.length} failed (see reasons above).`);

  if (failures.length) {
    console.error('');
    console.error(`${failures.length} (view, state, variant) capture(s) failed:`);
    for (const { label, error } of failures) {
      console.error(`- ${label}: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

module.exports = { VIEWPORTS, expectedPixelSize, readPngDimensions, variantLabel, variantsFor, requiresSettingsStateSurface, requiresOverlaySurface, assertDomSignature, applyTextScale, ALL_VARIANTS, PRIMARY_VARIANT };

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
