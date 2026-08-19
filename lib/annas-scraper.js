/**
 * Anna's Archive browser compatibility fallback.
 * Uses playwright-extra's stealth compatibility plugin and browser fingerprint
 * adjustments. It is disabled by default and must be enabled only when the
 * operator has determined that automated access is permitted.
 */

const { chromium } = require('playwright-extra');
const { validateAnnasOrigin } = require('./annas-origin');
const { createPinnedBrowserProxy } = require('./pinned-browser-proxy');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

let browserInstance = null;
let browserContext = null;
let browserLaunch = null;
let browserProxy = null;
let lastUsed = 0;
let idleTimer = null;
const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    lastUsed = Date.now();
    return browserContext;
  }
  // Coalesce concurrent cold starts: parallel searches would otherwise each
  // launch a Chromium and all but the last would leak.
  if (!browserLaunch) {
    browserLaunch = (async () => {
      console.log('[annas-scraper] Launching browser fallback...');
      browserProxy = await createPinnedBrowserProxy();
      try {
        // No --no-sandbox by default: the image runs as an unprivileged user,
        // so Chromium's sandbox is the layer that contains a renderer exploit
        // on this attacker-controlled content. Loopback/link-local hosts bypass
        // the pinned proxy by default (Chromium implicit bypass rules), so that
        // bypass is closed explicitly rather than relying on the proxy alone.
        const baseArgs = ['--disable-blink-features=AutomationControlled', '--proxy-bypass-list=<-loopback>'];
        const launchOptions = { headless: true, proxy: { server: browserProxy.url } };
        try {
          browserInstance = await chromium.launch({ ...launchOptions, args: baseArgs });
        } catch (sandboxError) {
          // The sandbox needs unprivileged user namespaces on the HOST kernel
          // and a seccomp profile permitting CLONE_NEWUSER. Umbrel hosts and
          // older container runtimes do not always provide either, and there
          // the launch fails outright, taking the whole Anna's fallback
          // offline. Degrade loudly rather than break the feature, and let an
          // operator demand the contained configuration.
          if (process.env.XANDRIO_REQUIRE_BROWSER_SANDBOX === '1') throw sandboxError;
          console.warn(
            '[annas-scraper] Chromium sandbox unavailable (%s); retrying with --no-sandbox. ' +
            'A renderer exploit on scraped pages would not be contained. Enable unprivileged ' +
            'user namespaces on the host, or set XANDRIO_REQUIRE_BROWSER_SANDBOX=1 to fail closed.',
            sandboxError.message
          );
          browserInstance = await chromium.launch({
            ...launchOptions,
            args: [...baseArgs, '--no-sandbox', '--disable-setuid-sandbox']
          });
        }
        browserContext = await browserInstance.newContext({
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          locale: 'en-US',
          // A worker can make requests outside page.route interception. The
          // pinned CONNECT proxy remains the enforcement boundary, and this
          // blocks unnecessary persistent worker state as a second layer.
          serviceWorkers: 'block',
          // This module has no use for downloads; it only reads DOM text. The
          // default (true) would let a hostile page write unbounded bytes to
          // the server's temp directory, retained until the context closes.
          acceptDownloads: false
        });
      } catch (error) {
        if (browserInstance) { try { await browserInstance.close(); } catch {} }
        browserInstance = null;
        browserContext = null;
        if (browserProxy) { await browserProxy.close(); browserProxy = null; }
        throw error;
      }
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = setInterval(async () => {
        if (browserInstance && Date.now() - lastUsed > BROWSER_IDLE_TIMEOUT) {
          console.log('[annas-scraper] Closing idle browser');
          await closeBrowser();
        }
      }, 60000);
      return browserContext;
    })().finally(() => {
      browserLaunch = null;
    });
  }
  const context = await browserLaunch;
  lastUsed = Date.now();
  return context;
}

async function closeBrowser() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  if (browserInstance) {
    try { await browserInstance.close(); } catch (e) { /* ignore */ }
    browserInstance = null;
    browserContext = null;
  }
  if (browserProxy) {
    try { await browserProxy.close(); } catch (e) { /* ignore */ }
    browserProxy = null;
  }
}

// page.title()/page.evaluate() have no built-in timeout and hang forever if the
// (attacker-controlled) page's main thread never yields. Race every in-page call
// against a deadline so a hostile page can only ever cost us this long, and so
// the finally block below still runs and closes the page.
const PAGE_CALL_TIMEOUT_MS = 10000;
function withPageTimeout(promise, ms = PAGE_CALL_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Page call timed out')), ms))
  ]);
}

async function searchAnnas(query, options = {}) {
  const { format = 'epub', limit = 20, baseUrl = 'annas-archive.gl' } = options;
  const origin = await validateAnnasOrigin(baseUrl);
  const url = `${origin}/search?q=${encodeURIComponent(query)}&ext=${format}`;
  console.log('[annas-scraper] Searching configured Anna origin');

  let context;
  try { context = await getBrowser(); } catch (err) {
    console.error('[annas-scraper] Browser launch failed:', err.message);
    return [];
  }

  let page;
  try {
    page = await context.newPage();
    // Belt and braces: acceptDownloads is off, but cancel any download that
    // slips through anyway rather than letting it sit until context close.
    page.on('download', d => { d.cancel().catch(() => {}); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for a provider interstitial to clear. This path does not solve or
    // bypass interactive challenges.
    for (let i = 0; i < 15; i++) {
      if (!(await withPageTimeout(page.title())).includes('DDoS-Guard')) break;
      await page.waitForTimeout(1000);
    }
    if ((await withPageTimeout(page.title())).includes('DDoS-Guard')) {
      console.error('[annas-scraper] Provider interstitial did not clear');
      return [];
    }

    await page.waitForTimeout(500);

    // Extract results from the search result cards
    // Structure per card (div.border-b):
    //   a[href="/md5/HASH"] (cover image, empty text)
    //   div > 
    //     div (file path in mono text)
    //     a[href="/md5/HASH"] (TITLE - with text)
    //     a[href="/search?q=AUTHOR"] (author)
    //     a[href="/search?q=PUBLISHER"] (publisher, series, year)
    //   div (metadata line: "English [en] · EPUB · 1.8MB · 2025 · 📕 Book")
    const evalArgs = { maxResults: limit, defaultFormat: format.toUpperCase(), origin };
    const results = await withPageTimeout(page.evaluate(({ maxResults, defaultFormat, origin }) => {
      const cards = document.querySelectorAll('div.border-b');
      const items = [];
      const seen = new Set();

      for (const card of cards) {
        if (items.length >= maxResults) break;

        // Find ALL md5 links in the card - the one WITH text is the title link
        const md5Links = card.querySelectorAll('a[href*="/md5/"]');
        let hash = null;
        let title = '';
        let coverUrl = '';

        for (const link of md5Links) {
          const href = link.getAttribute('href') || '';
          const hashMatch = href.match(/\/md5\/([a-f0-9]{32})/);
          if (!hashMatch) continue;
          hash = hashMatch[1];

          const text = link.innerText.trim();
          if (text && text.length > 1) {
            title = text;
          }
          if (!coverUrl) {
            const image = link.querySelector('img');
            const source = image?.currentSrc || image?.getAttribute('src') || image?.getAttribute('data-src') || '';
            // Bound the input, not just the output: a huge attribute value
            // must not reach new URL() before it is rejected.
            if (source && source.length <= 2048) {
              try { coverUrl = new URL(source, origin).href.substring(0, 2048); } catch {}
            }
          }
        }

        if (!hash || !title) continue;
        if (seen.has(hash)) continue;
        seen.add(hash);

        // Original file path (mono-font line, e.g. "lgli/…/Book (RTF)_split.epub").
        // Carries strong quality signals: retail/ePubLibre names vs RTF/OCR
        // conversion junk. Ranking uses it via sourceFileQualityPenalty().
        let filePath = '';
        for (const el of card.querySelectorAll('div,span')) {
          const cls = typeof el.className === 'string' ? el.className : '';
          if (/mono/.test(cls) && el.children.length === 0) {
            const text = el.innerText.trim();
            if (text) { filePath = text.substring(0, 400); break; }
          }
        }

        // Author and publisher from /search?q= links
        let author = 'Unknown';
        let publisher = '';
        const searchLinks = card.querySelectorAll('a[href^="/search?q="]');
        for (const sl of searchLinks) {
          const text = sl.innerText.trim();
          if (!text || text.length < 2 || text.length > 300) continue;
          if (author === 'Unknown') {
            author = text;
          } else if (!publisher) {
            publisher = text;
          }
        }

        // Metadata from the card's full text: "English [en] · EPUB · 1.8MB · 2025"
        const fullText = card.innerText || '';
        let language = '';
        let fileFormat = '';
        let size = '';

        // Find the metadata line (contains · separators)
        const lines = fullText.split('\n');
        for (const line of lines) {
          if (line.includes('·') && line.includes('[')) {
            const parts = line.split('·').map(p => p.trim());
            for (const part of parts) {
              // Language: "English [en]"
              const langMatch = part.match(/^(\w+)\s*\[(\w{2})\]/);
              if (langMatch) {
                language = langMatch[2]; // Use the code: "en", "de", etc.
              }
              // Format: "EPUB" or "PDF"
              if (/^(EPUB|PDF|MOBI|AZW3|DJVU|CBR|CBZ)$/i.test(part)) {
                fileFormat = part.toUpperCase();
              }
              // Size: "1.8MB" or "345 KB"
              const sizeMatch = part.match(/^([\d.,]{1,20}\s*(?:KB|MB|GB|kB))/i);
              if (sizeMatch) {
                size = sizeMatch[1];
              }
            }
            break;
          }
        }

        items.push({
          title: title.substring(0, 300),
          author: author.substring(0, 150),
          format: fileFormat || defaultFormat,
          size: (size || '').substring(0, 40),
          hash,
          publisher: (publisher || '').substring(0, 300),
          language: language || '',
          filePath,
          url: `${origin}/md5/${hash}`,
          coverUrl: coverUrl.substring(0, 2048)
        });
      }

      return items;
    }, evalArgs));

    console.log(`[annas-scraper] Found ${results.length} results`);
    return results;

  } catch (err) {
    // Playwright puts the navigation URL (which contains the user's search
    // query) into error.message and its call log. Strip both before logging,
    // matching the deliberate redaction above at the start of this function.
    const detail = String(err?.message || '')
      .split('\n')[0]
      .replace(/https?:\/\/\S+/g, '<annas-url>');
    console.error('[annas-scraper] Search error:', detail);
    return [];
  } finally {
    if (page) { try { await page.close(); } catch (e) { /* ignore */ } }
  }
}

module.exports = { searchAnnas, closeBrowser };
