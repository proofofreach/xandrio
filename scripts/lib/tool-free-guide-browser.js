'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

// Uses the actual HTML, settings module, confirmation component and API client.
// Only application boot/navigation are supplied by the local fixture.
async function verifyToolFreeGuideBrowser({ app, origin, output, requestCount }) {
  const publicRoot = path.join(__dirname, '../../public');
  const browser = await chromium.launch({ headless: true });
  const parser = await browser.newPage();
  const markup = await parser.evaluate(source => {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    doc.querySelectorAll('script').forEach(script => script.remove());
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  }, await fs.readFile(path.join(publicRoot, 'index.html'), 'utf8'));
  await parser.close();
  const html = markup
    .replace('</body>', `<script type="module">
      import { setCurrentUser } from '/js/api.js';
      import { initSettings } from '/js/views/settings.js';
      setCurrentUser({ id: 'fixture-user', role: 'admin', username: 'fixture' });
      initSettings({ syncTimeDisplayModeFromClientSettings() {}, applySkipIntervalLabels() {},
        getCurrentBook: () => null, getCurrentChapter: () => 0, getChapters: () => [], getChunkPlayer: () => null });
      document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
      document.getElementById('settings-view').classList.add('active');
      document.dispatchEvent(new CustomEvent('xandrio:viewchange', { detail: { view: 'settings', section: 'guides' } }));
      window.fixtureBooted = true;
    </script></body>`);
  app.get('/guide-browser-fixture', (_req, res) => res.type('html').send(html));
  app.get('/api/legal/operator-policy', (_req, res) => res.json({ acknowledged: true, acknowledgedAt: '2026-10-22' }));
  app.get('/api/library', (_req, res) => res.json({ books: [] }));
  app.use(express.static(publicRoot));
  const checks = [];
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      const external = [];
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${origin}/guide-browser-fixture`);
      await page.waitForFunction(() => window.fixtureBooted === true);
      await page.waitForFunction(() => document.getElementById('book-guides-api-key').placeholder.includes('OpenAI API'));
      assert.equal(await page.locator('#book-guides-generator-model').inputValue(), 'gpt-5.6-luna');
      assert.equal(await page.locator('#book-guides-verifier-model').inputValue(), 'gpt-5.6-terra');
      assert.equal(await page.locator('#book-guides-device-connection').isVisible(), false);
      assert.equal(await page.locator('label[for="book-guides-api-key"]').innerText(), 'Provider API key');
      const before = requestCount();
      await page.locator('#book-guides-test').click();
      await page.locator('#confirm-sheet[aria-hidden="false"]').waitFor();
      const message = await page.locator('#confirm-sheet-message').innerText();
      await page.screenshot({ path: path.join(output, `paid-test-${viewport.width}.png`), fullPage: true });
      assert(message.includes('OpenAI API') && !message.includes('PPQ.ai'), message);
      assert.equal(requestCount(), before, 'opening dialog must not invoke model');
      await page.locator('[data-confirm-cancel]').click();
      assert.equal(requestCount(), before, 'cancelling must not invoke model');
      await page.locator('#book-guides-test').click();
      await page.locator('[data-confirm-ok]').click();
      await page.waitForFunction(() => document.getElementById('book-guides-test').disabled === false);
      assert.equal(requestCount(), before + 1, 'confirmation invokes exactly one fixture request');
      assert.equal(await page.locator('#book-guides-settings-error').isVisible(), false);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      checks.push({ width: viewport.width, message, modelRequests: requestCount() - before, errors, external });
      await context.close();
    }
  } finally { await browser.close(); }
  await fs.writeFile(path.join(output, 'browser-results.json'), JSON.stringify(checks, null, 2));
}
module.exports = { verifyToolFreeGuideBrowser };
