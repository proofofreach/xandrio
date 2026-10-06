'use strict';

// Fail-first evidence and all failure cases were recorded before fixes in
// output/ui-rewrite-fixes/verification-failure-cases.md. The original real-app
// browser reproductions remain in output/ui-rewrite-review-91a6d38. This runner
// uses a real server and synthetic XBooks; it never reads operator books/data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { startScenarioEnvironment } = require('../test/fixtures/scenarios/lib/environment');
const { chapterStructureKey } = require('../lib/chapter-structure');
const { splitOversizedChapters, repairTextArtifacts, normalizeChapterType, normalizeChapterSequence } = require('../lib/chapter-utils');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/ui-rewrite-fixes/readable-e2e');
const browsers = (process.env.READABLE_E2E_BROWSERS || 'chromium,webkit').split(',');
const filter = process.env.READABLE_E2E_FILTER;

async function prepareDataset({ dataDir, cacheDir }) {
  const books = JSON.parse(await fs.readFile(path.join(dataDir, 'books.json'), 'utf8'));
  for (const id of ['scn-meridian', 'scn-lighthouse']) {
    const file = path.join(cacheDir, `${id}.xbook.json`);
    const book = JSON.parse(await fs.readFile(file, 'utf8'));
    if (id === 'scn-lighthouse') book.chapters.forEach((ch, i) => { ch.title = `Chapter ${[2, 7, 9][i]}: ${ch.title}`; });
    book.chapters.unshift(
      { title: 'Copyright', type: 'copyright', text: 'Copyright fixture. This is a synthetic book made only to verify the reading interface.', estimatedDuration: 5 },
      { title: 'Acknowledgements', type: 'frontmatter', text: 'Acknowledgements fixture. We thank the imaginary researchers who made this synthetic story possible.', estimatedDuration: 5 }
    );
    await fs.writeFile(file, JSON.stringify(book));
    const mapped = book.chapters.map(ch => normalizeChapterType({ ...ch, text: repairTextArtifacts(ch.text) }));
    const live = normalizeChapterSequence(splitOversizedChapters(mapped), { sourceFormat: 'EPUB', work: book.metadata });
    books[id].chapterStructureKey = chapterStructureKey(live);
    books[id].chapterCount = live.length;
    books[id].chapterDurations = live.map(ch => ch.estimatedDuration || 5);
    books[id].audioGeneratedChapters = live.length;
    books[id].audioGenerationTotal = live.length;
  }
  books['scn-driftwood'].chapterStructureKey = 'stale-synthetic-structure';
  await fs.writeFile(path.join(dataDir, 'books.json'), JSON.stringify(books));
  const positions = { users: { default: {} } };
  for (const id of ['scn-meridian', 'scn-lighthouse']) positions.users.default[id] = {
    userId: 'default', bookId: id, chapterIndex: 2, timestamp: 0, chunkIndex: 0, chunkTime: 0,
    playbackRate: 1, wasPlaying: false, finished: false, chapterStructureKey: books[id].chapterStructureKey,
    updatedAt: '2026-10-01T12:00:00.000Z', updatedAtMs: Date.parse('2026-10-01T12:00:00.000Z')
  };
  positions.users.default['scn-driftwood'] = { userId: 'default', bookId: 'scn-driftwood', chapterIndex: 1, timestamp: 2, wasPlaying: false, finished: false, chapterStructureKey: 'stale-synthetic-structure', updatedAt: '2026-09-30T12:00:00Z', updatedAtMs: Date.parse('2026-09-30T12:00:00Z') };
  await fs.writeFile(path.join(dataDir, 'positions.json'), JSON.stringify(positions));
  await fs.writeFile(path.join(dataDir, 'listening-queues.json'), JSON.stringify({ users: { default: { bookIds: ['scn-meridian', 'scn-lighthouse'], autoContinue: false, bookSettings: {} } } }));
}

async function waitFor(page, predicate, message, timeout = 15000) {
  try { await page.waitForFunction(predicate, null, { timeout }); }
  catch { throw new Error(message); }
}
async function playingEvidence(page) {
  return page.locator('#audio-player').evaluate(el => ({ paused: el.paused, currentTime: el.currentTime, src: el.currentSrc, readyState: el.readyState }));
}
async function requirePlaying(page) {
  await waitFor(page, () => { const a = document.getElementById('audio-player'); return a && !a.paused && a.readyState >= 2; }, 'audio did not actually play after one tap', 25000);
  const before = await playingEvidence(page);
  await page.waitForFunction(start => { const a = document.getElementById('audio-player'); return a && !a.paused && a.currentTime > start + 0.25; }, before.currentTime, { timeout: 10000 });
  const after = await playingEvidence(page);
  assert(!after.paused && after.currentTime > before.currentTime + 0.25); return { before, after };
}
async function pause(page) {
  if (!(await playingEvidence(page)).paused) await page.locator('#play-pause-btn').click();
  await waitFor(page, () => document.getElementById('audio-player').paused, 'player did not pause');
}
async function openPlayer(page, origin, id = 'scn-meridian') {
  await page.goto(`${origin}/#/player/${id}`);
  await page.locator('#player-view.active').waitFor();
  await waitFor(page, () => document.getElementById('audio-player').readyState >= 2, 'deep linked synthetic audio did not load', 25000);
}
async function focusAtTitle(page, titleId, dialog) {
  await waitFor(page, () => document.activeElement?.tagName === 'H3', 'sheet did not focus its title');
  assert.equal(await page.evaluate(() => document.activeElement.id), titleId);
  await page.keyboard.press('Shift+Tab');
  assert(await page.evaluate(selector => Boolean(document.activeElement.closest(selector)), dialog), 'Shift+Tab escaped from the dialog title');
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  let environment;
  const report = { passed: false, autoplayPolicyOverride: false, fixture: 'real server, synthetic XBooks with frontmatter and authored gaps', checks: [] };
  try {
    for (const browserName of browsers) {
      const browser = await ({ chromium, webkit }[browserName]).launch();
      try {
        for (const viewport of [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }]) {
          async function check(name, fn) {
            if (filter && !name.includes(filter)) return;
            const label = `${browserName}-${viewport.name}-${name}`;
            environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['full'], defaultDataset: 'full', prepareDataset });
            const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block', isMobile: viewport.name === 'phone', hasTouch: viewport.name === 'phone' });
            // Browser clients also fail closed if markup tries an external URL.
            await context.route('**/*', route => new URL(route.request().url()).origin === environment.origin ? route.continue() : route.abort());
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
            const page = await context.newPage(); page.setDefaultTimeout(12000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            try {
              const evidence = await fn(page);
              assert.deepEqual(errors, [], 'unexpected browser error');
              await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true });
              report.checks.push({ name: label, passed: true, evidence }); console.log(`PASS ${label}`);
            } catch (error) {
              await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true }).catch(() => {});
              report.checks.push({ name: label, passed: false, error: error.message, browserErrors: errors }); console.log(`FAIL ${label}: ${error.message}`);
            } finally {
              await context.tracing.stop({ path: path.join(out, `${label}.trace.zip`) }); await context.close(); await environment.close(); environment = null;
            }
          }
          await check('fresh-continue-resumes-real-media', async page => {
            await page.goto(`${environment.origin}/#/library`);
            const card = page.locator('.rail-card[data-book-id="scn-meridian"]');
            if (viewport.name === 'desktop') {
              // Continue is intentionally a phone-only strip. Desktop rows are
              // an explicit resume action; this first click uses real media.
              await page.locator('.book-item[data-book-id="scn-meridian"] .book-card-open').click();
            } else {
              await card.waitFor();
              await card.click();
            }
            await page.locator('#player-view.active').waitFor();
            const cold = await requirePlaying(page);
            await pause(page);
            await page.locator('#player-recent-btn').click();
            await page.locator('[data-recent-book="scn-meridian"]').click();
            const sameRecent = await requirePlaying(page);
            await pause(page);
            await page.locator('#player-recent-btn').click();
            await page.locator('[data-recent-book="scn-lighthouse"]').click();
            await page.waitForURL('**/#/player/scn-lighthouse');
            const otherRecent = await requirePlaying(page);
            if (viewport.name === 'phone') {
              await pause(page); await page.evaluate(() => { location.hash = '#/library'; });
              await card.waitFor(); await card.click();
              await page.waitForURL('**/#/player/scn-meridian');
              const otherContinue = await requirePlaying(page);
              await pause(page); await page.evaluate(() => { location.hash = '#/library'; });
              await card.waitFor(); await card.click();
              const sameContinue = await requirePlaying(page);
              await pause(page); await page.evaluate(() => { location.hash = '#/library'; });
              await page.locator('#mini-player-open').focus(); await page.keyboard.press('Shift+F10');
              await page.locator('[data-recent-book="scn-meridian"]').click();
              await page.waitForURL('**/#/player/scn-meridian');
              return { cold, sameRecent, otherRecent, otherContinue, sameContinue, miniRecent: await requirePlaying(page) };
            }
            await pause(page);
            await page.locator('[data-up-next-book="scn-meridian"]').click();
            await page.waitForURL('**/#/player/scn-meridian');
            return { cold, sameRecent, otherRecent, paneUpNext: await requirePlaying(page) };
          });
          await check('modal-keyboard-and-tabs', async page => {
            await openPlayer(page, environment.origin, 'scn-fieldnotes');
            assert((await playingEvidence(page)).paused, 'deep link must load paused');
            await page.locator('#speed-sheet-btn').click();
            await focusAtTitle(page, 'speed-sheet-title', '#speed-sheet [role="dialog"]');
            await page.locator('#speed-sheet-title').focus();
            const modalBefore = await page.locator('#audio-player').evaluate(a => ({ time: a.currentTime, rate: a.playbackRate, volume: a.volume, paused: a.paused }));
            for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift+ArrowRight', 'Shift+ArrowLeft', 'Space']) await page.keyboard.press(key);
            assert.deepEqual(await page.locator('#audio-player').evaluate(a => ({ time: a.currentTime, rate: a.playbackRate, volume: a.volume, paused: a.paused })), modalBefore, 'global playback keys changed audio behind Speed');
            await page.keyboard.press('Escape');
            await page.locator('#player-recent-btn').click();
            await focusAtTitle(page, 'recent-sheet-title', '#recent-sheet [role="dialog"]');
            await page.locator('#recent-sheet-title').focus();
            for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift+ArrowRight', 'Shift+ArrowLeft', 'Space']) await page.keyboard.press(key);
            assert.deepEqual(await page.locator('#audio-player').evaluate(a => ({ time: a.currentTime, rate: a.playbackRate, volume: a.volume, paused: a.paused })), modalBefore, 'global playback keys changed audio behind Recent');
            await page.keyboard.press('Escape');
            await page.locator('#player-more-btn').click();
            await focusAtTitle(page, 'player-more-title', '#player-more-sheet [role="dialog"]');
            await page.locator('#player-book-seek-btn').click();
            await focusAtTitle(page, 'book-seek-title', '#book-seek-sheet [role="dialog"]');
            await page.keyboard.press('Escape');
            await page.locator('#chapter-sheet-btn').click();
            await page.locator('#chapter-sheet-tab-chapters').focus();
            const before = await playingEvidence(page);
            for (const key of ['ArrowRight', 'ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowLeft']) {
              await page.keyboard.press(key);
              const audio = await playingEvidence(page);
              assert.equal(audio.currentTime, before.currentTime, `${key} sought behind chapter tabs`);
            }
            assert.equal(await page.locator('#chapter-sheet-tab-chapters').getAttribute('aria-selected'), 'true');
            return { elapsedBefore: before.currentTime, elapsedAfter: (await playingEvidence(page)).currentTime, titleFocusAndWrap: true };
          });
          await check('pronunciation-radio-keyboard', async page => {
            await openPlayer(page, environment.origin, 'scn-fieldnotes');
            await page.locator('#player-more-btn').click(); await page.locator('#pronunciation-repair-btn').click();
            await page.locator('#pronunciation-replacement').focus();
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.value), 'book', 'Tab did not enter the checked scope radio');
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'pronunciation-repair-cancel', 'Tab visited an unchecked radio instead of leaving the group');
            await page.keyboard.press('Shift+Tab');
            await page.keyboard.press('ArrowRight');
            assert.equal(await page.evaluate(() => document.activeElement.value), 'global');
            assert(await page.locator('input[name="pronunciation-scope"][value="global"]').isChecked());
            assert.equal((await playingEvidence(page)).currentTime, 0, 'radio arrow sought the paused book');
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'pronunciation-repair-cancel');
            await page.keyboard.press('Shift+Tab');
            assert.equal(await page.evaluate(() => document.activeElement.value), 'global', 'reverse Tab did not enter the selected scope');
            return { checkedScope: 'global', tabGroupStops: 1, playbackUnchanged: true };
          });
          if (viewport.name === 'phone') await check('resume-activation-and-blocked-play', async page => {
            await page.addInitScript(() => {
              window.__readableMediaCalls = [];
              const original = HTMLMediaElement.prototype.load;
              HTMLMediaElement.prototype.load = function () {
                window.__readableMediaCalls.push({ method: 'load', id: this.id, source: this.getAttribute('src'), currentSrc: this.currentSrc, activeGesture: navigator.userActivation?.isActive ?? null });
                return original.apply(this, arguments);
              };
            });
            await page.goto(`${environment.origin}/#/library`);
            const card = page.locator('.rail-card[data-book-id="scn-meridian"]'); await card.waitFor();
            let release, hit;
            const waiting = new Promise(resolve => { release = resolve; });
            const metadataHit = new Promise(resolve => { hit = resolve; });
            await page.route('**/api/book/scn-meridian', async route => { hit(); await waiting; await route.continue(); });
            await page.evaluate(() => { window.__readableMediaCalls = []; });
            await card.click(); await metadataHit;
            const coldCalls = await page.evaluate(() => window.__readableMediaCalls);
            release();
            await requirePlaying(page); await pause(page);
            await page.evaluate(() => {
              window.__readableBlockedPlayCalls = [];
              const original = HTMLMediaElement.prototype.play;
              HTMLMediaElement.prototype.play = function () {
                if (this.id !== 'audio-player') return original.apply(this, arguments);
                window.__readableBlockedPlayCalls.push({ source: this.currentSrc, paused: this.paused });
                return Promise.reject(new DOMException('Synthetic media authorization refusal', 'NotAllowedError'));
              };
            });
            await page.locator('#player-recent-btn').click();
            await page.locator('[data-recent-book="scn-meridian"]').click();
            await page.waitForTimeout(400);
            const blocked = await page.evaluate(() => window.__readableBlockedPlayCalls);
            assert.equal(blocked.length, 1, 'one resume tap retried a rejected ready-source play');
            assert((await playingEvidence(page)).paused, 'blocked play falsely reported playback');
            assert(coldCalls.some(call => call.id === 'audio-player' && !call.source && !call.currentSrc), 'empty source was not load() primed before async metadata');
            return { coldCalls, blocked, actualMedia: await playingEvidence(page) };
          });
          if (viewport.name === 'phone') await check('loaded-paused-activation', async page => {
            await page.addInitScript(() => {
              window.__readableAutoplayChanges = [];
              const property = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'autoplay');
              Object.defineProperty(HTMLMediaElement.prototype, 'autoplay', { ...property, set(value) {
                window.__readableAutoplayChanges.push({ value, source: this.currentSrc, time: this.currentTime, paused: this.paused, activeGesture: navigator.userActivation?.isActive ?? null });
                property.set.call(this, value);
              } });
            });
            await openPlayer(page, environment.origin, 'scn-fieldnotes');
            const before = await playingEvidence(page); assert(before.paused);
            let release, hit;
            const waiting = new Promise(resolve => { release = resolve; });
            const metadataHit = new Promise(resolve => { hit = resolve; });
            await page.route('**/api/book/scn-meridian', async route => { hit(); await waiting; await route.continue(); });
            await page.evaluate(() => { window.__readableAutoplayChanges = []; });
            await page.locator('#player-recent-btn').click(); await page.locator('[data-recent-book="scn-meridian"]').click();
            await metadataHit;
            const held = await playingEvidence(page);
            const changes = await page.evaluate(() => window.__readableAutoplayChanges);
            const restored = await page.locator('#audio-player').evaluate(el => !el.autoplay && !el.hasAttribute('autoplay'));
            release();
            const target = await requirePlaying(page);
            assert.equal(held.src, before.src, 'gesture changed the outgoing loaded source');
            assert.equal(held.currentTime, before.currentTime, 'gesture moved outgoing paused audio');
            assert.equal(held.paused, true, 'gesture played outgoing paused audio');
            assert(restored, 'transient autoplay attribute was not restored');
            assert.deepEqual(changes.map(change => change.value), [true, false], 'loaded source did not transiently prime authorization');
            return { before, held, changes, restored, target };
          });
          if (viewport.name === 'phone') await check('resume-races-and-failed-open', async page => {
            await openPlayer(page, environment.origin, 'scn-fieldnotes');
            const plans = [];
            await page.route('**/api/book/scn-meridian', async route => {
              const plan = plans.shift();
              if (!plan) return route.continue();
              plan.hit(); await plan.wait;
              if (plan.fail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic open failure' }) });
              return route.continue();
            });
            function gate(fail = false) {
              let hit, release;
              const hitPromise = new Promise(resolve => { hit = resolve; });
              const wait = new Promise(resolve => { release = resolve; });
              const plan = { hit, wait, release, fail, hitPromise }; plans.push(plan); return plan;
            }
            async function recent(id) {
              await page.locator('#player-recent-btn').click();
              await page.locator(`[data-recent-book="${id}"]`).click();
            }
            const slow = gate();
            await recent('scn-meridian'); await slow.hitPromise;
            await recent('scn-lighthouse'); await page.waitForURL('**/#/player/scn-lighthouse');
            const winningAudio = await requirePlaying(page);
            const staleResponse = page.waitForResponse(response => response.url().endsWith('/api/book/scn-meridian'));
            slow.release(); await staleResponse;
            await page.waitForTimeout(200);
            assert(page.url().endsWith('/#/player/scn-lighthouse'), 'late book response changed the winning route');
            assert((await playingEvidence(page)).src.includes('scn-lighthouse'), 'late book response started the wrong audio');
            const pausing = gate();
            await recent('scn-meridian'); await pausing.hitPromise;
            await page.locator('#play-pause-btn').click();
            assert((await playingEvidence(page)).paused, 'explicit Pause did not stop outgoing audio');
            pausing.release(); await page.waitForURL('**/#/player/scn-meridian');
            await waitFor(page, () => document.getElementById('audio-player').readyState >= 2, 'cancelled resume did not finish loading');
            const cancelled = await playingEvidence(page);
            await page.waitForTimeout(350);
            assert((await playingEvidence(page)).paused, 'pending resume overrode explicit Pause');
            assert.equal((await playingEvidence(page)).currentTime, cancelled.currentTime, 'cancelled resume advanced audio');
            await page.locator('#play-pause-btn').click(); await requirePlaying(page);
            await recent('scn-lighthouse'); await requirePlaying(page);
            const failure = gate(true); await recent('scn-meridian'); await failure.hitPromise;
            const failedResponse = page.waitForResponse(response => response.url().endsWith('/api/book/scn-meridian') && response.status() === 503);
            failure.release(); await failedResponse;
            await waitFor(page, () => document.getElementById('audio-player').paused, 'failed resume left an unrelated book playing');
            assert(page.url().endsWith('/#/player/scn-lighthouse'), 'failed open changed the current route');
            const failedState = await playingEvidence(page);
            // A target with unavailable media may restore the old session, but
            // it must never report a ready, playing target source.
            await page.route('**/api/audio-continuous/scn-meridian/**', route => route.abort());
            await page.route('**/api/audio/scn-meridian/**', route => route.abort());
            await page.route('**/api/chunks/scn-meridian/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic narration unavailable' }) }));
            await recent('scn-meridian');
            await page.waitForTimeout(1000);
            const unavailable = await playingEvidence(page);
            assert(unavailable.paused, 'unready source claimed playback');
            return { winningAudio, explicitPause: cancelled, failedOpen: failedState, unavailable };
          });
          await check('chapter-labels-narrator-and-actions', async page => {
            await page.goto(`${environment.origin}/#/library`);
            const row = page.locator('.book-item[data-book-id="scn-meridian"]'); await row.waitFor();
            await page.waitForFunction(() => document.querySelector('.book-item[data-book-id="scn-meridian"] .book-resume')?.textContent.includes('Ch 1 of 3'));
            const rowText = await row.innerText(); assert.match(rowText, /Ch 1 of 3/);
            await page.screenshot({ path: path.join(out, `${browserName}-${viewport.name}-semantic-library.png`), fullPage: true });
            await page.waitForFunction(() => document.querySelector('.book-item[data-book-id="scn-lighthouse"] .book-resume')?.textContent.includes('Ch 2 of 9'));
            const authored = await page.locator('.book-item[data-book-id="scn-lighthouse"]').innerText(); assert.match(authored, /Ch 2 of 9/);
            if (viewport.name === 'phone') {
              const rail = await page.locator('.rail-card[data-book-id="scn-meridian"] .rail-meta').innerText(); assert.match(rail, /Ch 1 of 3/);
              await row.locator('.book-card-open').focus(); await page.keyboard.press('Shift+F10');
              await focusAtTitle(page, 'book-actions-title', '#book-actions-sheet [role="dialog"]');
              assert.equal(await page.evaluate(() => document.activeElement.id), 'book-actions-cancel');
              await page.locator('#book-actions-title').focus();
              let reached = false;
              for (let i = 0; i < 18; i++) { await page.keyboard.press('Tab'); if (await page.evaluate(() => document.activeElement.id === 'book-actions-cancel')) { reached = true; break; } }
              assert(reached, 'Cancel is unreachable in forward tab order');
              await page.locator('#book-actions-cancel').click();
            }
            await openPlayer(page, environment.origin);
            assert.match(await page.locator('#player-view').innerText(), /Chapter 1 of 3/);
            await page.locator('#player-recent-btn').click();
            const recent = await page.locator('[data-recent-book="scn-meridian"]').innerText(); assert.match(recent, /Ch 1/);
            const unknown = await page.locator('[data-recent-book="scn-driftwood"]').innerText(); assert(!/Ch(?:apter)? \d/.test(unknown), 'unknown stale Recent structure fabricated a chapter number');
            await page.keyboard.press('Escape');
            const narrator = page.locator('#player-voice-status');
            const narratorEvidence = await narrator.evaluate(el => {
              const rects = []; const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) { const text = walker.currentNode; if (!text.textContent.trim() || !text.parentElement.getClientRects().length) continue; const range = document.createRange(); range.selectNodeContents(text); rects.push(...[...range.getClientRects()].filter(r => r.width).map(r => ({ top: r.top, bottom: r.bottom }))); }
              return { text: el.innerText, label: el.getAttribute('aria-label'), lines: [...new Set(rects.map(r => Math.round(r.top)))].length };
            });
            assert.equal(narratorEvidence.lines, 1, 'narrator line wraps');
            assert.match(narratorEvidence.label, /Kokoro|kokoro/); assert(narratorEvidence.text.trim().length > 0);
            return { rowText, authored, recent, narrator: narratorEvidence };
          });
        }
      } finally { await browser.close(); }
    }
  } catch (error) { report.error = error.stack; }
  finally {
    await environment?.close(); report.passed = !report.error && report.checks.length > 0 && report.checks.every(check => check.passed);
    await fs.writeFile(path.join(out, `results${filter ? `-${filter}` : ''}.json`), JSON.stringify(report, null, 2));
    console.log(`Readable UI E2E: ${report.checks.filter(check => check.passed).length}/${report.checks.length} passed; ${out}`);
    process.exitCode = report.passed ? 0 : 1;
  }
})();
