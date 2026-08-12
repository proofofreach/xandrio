const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
};

async function startStaticServer(publicRoot) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://benchmark.local');
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const filePath = path.resolve(publicRoot, relative);
    if (!filePath.startsWith(`${publicRoot}${path.sep}`)) {
      response.writeHead(403);
      return response.end();
    }
    try {
      const body = await fs.readFile(filePath);
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function fixtureBook() {
  return {
    id: 'benchmark-imported',
    title: 'Synthetic UX Benchmark',
    author: 'Fixture Author',
    language: 'en',
    chapterCount: 1,
    chapterDurations: [60],
    totalDuration: 60
  };
}

function searchResponse() {
  const edition = {
    hash: 'benchmark-edition',
    title: 'Synthetic UX Benchmark',
    author: 'Fixture Author',
    language: 'en',
    format: 'EPUB',
    source: 'gutenberg',
    fallbackGroupId: 'benchmark-work',
    rightsStatus: 'public-domain'
  };
  return {
    works: [{
      id: 'benchmark-work',
      title: edition.title,
      author: edition.author,
      bestEdition: edition,
      editions: [edition],
      editionCount: 1,
      versionCount: 1,
      sources: ['gutenberg'],
      sourceCount: 1
    }],
    sourceStatus: { gutenberg: { id: 'gutenberg', ok: true } }
  };
}

async function installApiFixtures(page, state) {
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body)
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/status') {
      return json(route, {
        authenticationRequired: false,
        authenticated: true,
        accountsConfigured: true,
        user: { id: 'benchmark-user', username: 'benchmark', role: 'member' }
      });
    }
    if (pathname === '/api/settings/client') return json(route, { settings: {} });
    if (pathname === '/api/library') {
      return json(route, { books: state.imported ? [fixtureBook()] : [], shelf: [] });
    }
    if (pathname === '/api/positions') return json(route, { positions: {} });
    if (pathname === '/api/search/sources') {
      return json(route, {
        sources: [
          { id: 'annas', enabled: true, searchAvailable: true },
          { id: 'zlibrary', enabled: true, searchAvailable: true },
          { id: 'gutenberg', enabled: true, searchAvailable: true }
        ]
      });
    }
    if (pathname === '/api/search') return json(route, searchResponse());
    if (pathname === '/api/download') {
      state.imported = true;
      const warnings = state.warning ? ['Synthetic non-blocking extraction diagnostic'] : [];
      return json(route, {
        success: true,
        bookId: 'benchmark-imported',
        book: {
          ...fixtureBook(),
          needsReview: state.needsReview,
          validationWarnings: warnings
        },
        validation: { valid: true, warnings }
      });
    }
    if (pathname === '/api/book/benchmark-imported') {
      return json(route, {
        book: fixtureBook(),
        chapters: [{
          index: 0,
          title: 'Chapter One',
          type: 'chapter',
          estimatedDuration: 60,
          text: 'Synthetic browser narration for the import UX benchmark.'
        }]
      });
    }
    if (pathname === '/api/bookmarks/benchmark-imported') return json(route, { bookmarks: [] });
    if (pathname === '/api/position/benchmark-imported') return json(route, { position: null });
    if (pathname === '/api/pronunciations') return json(route, { book: [], global: [] });
    if (pathname === '/api/voices') return json(route, { current: '', voices: [] });
    if (pathname === '/api/engines/status') return json(route, { engines: {} });
    if (pathname === '/api/legal/operator-policy') {
      return json(route, { version: 1, acknowledged: true, unverifiedSourcesEnabled: false });
    }
    return json(route, {});
  });
}

function classifyImportOutcome(value = {}) {
  if (value.playerOpen) return 0;
  if (value.openBookAction) return 1;
  return 2;
}

async function runScenario(browser, origin, mode) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const state = {
    imported: false,
    warning: mode === 'warning',
    needsReview: mode !== 'clean'
  };
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(message.text());
  });
  await installApiFixtures(page, state);
  try {
    await page.goto(`${origin}/#/search`, { waitUntil: 'networkidle' });
    try {
      await page.waitForSelector('#search-view.active', { timeout: 10000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        hash: location.hash,
        activeView: document.querySelector('.view.active')?.id || '',
        body: (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
      }));
      throw new Error(`Import UX app did not open search: ${JSON.stringify(state)}; page=${pageErrors.join(' | ')}; console=${consoleErrors.join(' | ')}`);
    }
    await page.fill('#search-input', 'synthetic benchmark');
    await page.click('#search-btn');
    await page.waitForSelector('.result-cover-action[data-work-add]');
    await page.click('.result-cover-action[data-work-add]');
    await page.waitForFunction(() =>
      document.querySelector('#player-view.active') ||
      document.querySelector('[data-import-action="open-book"]') ||
      document.querySelector('#download-error .error-box'),
    { timeout: 10000 });
    if (pageErrors.length) throw new Error(`Import UX browser errors: ${pageErrors.join(' | ')}`);
    const outcome = await page.evaluate(() => ({
      playerOpen: Boolean(document.querySelector('#player-view.active')),
      openBookAction: Boolean(document.querySelector('[data-import-action="open-book"]')),
      emptyWarningMessage: /no specific warning/i.test(document.body.textContent || '')
    }));
    return {
      manualActions: classifyImportOutcome(outcome),
      emptyWarningMessage: outcome.emptyWarningMessage
    };
  } finally {
    await context.close();
  }
}

async function evaluateImportUx(versionRoot) {
  const server = await startStaticServer(path.join(versionRoot, 'public'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const clean = await runScenario(browser, server.origin, 'clean');
    const warning = await runScenario(browser, server.origin, 'warning');
    const empty = await runScenario(browser, server.origin, 'empty');
    return {
      cleanImportManualActions: clean.manualActions,
      warningImportManualActions: warning.manualActions,
      emptyWarningMessage: empty.emptyWarningMessage
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await server.close();
  }
}

module.exports = { classifyImportOutcome, evaluateImportUx };
