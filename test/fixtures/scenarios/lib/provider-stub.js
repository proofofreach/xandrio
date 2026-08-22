'use strict';

// Two kinds of local HTTP stub used by the scenario harness, so the real
// server.js can run its real TTS/search/cover code paths against synthetic
// data instead of the live internet:
//
// 1. `createTtsEngineStub(name)` — one instance per engine, pointed to
//    directly via KOKORO_TTS_URL / CHATTERBOX_TTS_URL. Implements just the
//    `POST /tts` contract lib/tts-queue.js._generateHttpTTSOnce expects
//    (JSON in, `audio/wav` bytes out) plus `GET /health`. The real chunking,
//    caching, and ffmpeg mastering pipeline runs completely unmodified
//    against synthetic sine-tone audio — nothing about TTS generation itself
//    is faked, only the model.
//
// 2. `createProviderNetworkStub(searchResults)` — the landing point for every
//    request lib/network-guard.js redirects, matched by the
//    `x-scenario-target-host` header the guard attaches: Gutenberg
//    (gutendex.com), Internet Archive (archive.org), Standard Ebooks
//    (standardebooks.org — its own real default feed URL; there is no local
//    override that survives lib/remote-fetch.js's HTTPS-only SSRF guard),
//    the custom OPDS source (example.com, an IANA-reserved domain used as a
//    stand-in feed URL), and cover hosts. Anything not explicitly modeled
//    answers 404 — never a live fetch, by construction.
//
// Anna's Archive and Z-Library report configured:true unconditionally
// (lib/search-providers/index.js) — this harness does not rely on
// "unconfigured" to keep them silent. Instead it leaves the operator
// policy's unverifiedSourcesEnabled flag off (see provision.js), which
// blocks all three "unverified" sources — Anna's, Z-Library, *and* Internet
// Archive — at the request-validation layer, before any provider code runs.
// This matters especially for Anna's Archive, whose search launches a real
// headless browser (lib/annas-scraper.js) that does its own networking
// outside Node's http/https modules — something the network guard cannot
// intercept — so it must never be allowed to run at all.

const http = require('node:http');
const { URL } = require('node:url');
const { ttsResponseWavForText } = require('./wav');

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
  res.end(payload);
}

function sendXml(res, status, body) {
  const payload = Buffer.from(body, 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/atom+xml; charset=utf-8', 'Content-Length': payload.length });
  res.end(payload);
}

function sendInternalError(res) {
  sendJson(res, 500, { error: 'Scenario provider failed' });
}

function listenOn(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

// The real gutendex.com and archive.org APIs filter server-side by the
// incoming query — lib/gutenberg.js and lib/search-providers/internet-archive.js
// trust that and do no client-side re-filtering (unlike lib/search-providers/opds.js,
// which does filter locally, so its stub feeds can stay unfiltered). Mirroring
// that filtering here — not just returning the canned fixture set for every
// query — is what lets the "search-results.json" emptyQuery/defaultQuery
// distinction actually produce different result counts, matching how the
// live providers behave.
function matchesQuery(haystack, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const normalized = String(haystack || '').toLowerCase();
  return words.every(word => normalized.includes(word));
}

function createTtsEngineStub(name, { failing = false } = {}) {
  let isFailing = failing;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/health') {
        return sendJson(res, isFailing ? 503 : 200, { status: isFailing ? 'down' : 'ok', engine: name });
      }
      if (req.url === '/tts' && req.method === 'POST') {
        if (isFailing) return sendJson(res, 503, { error: `Scenario ${name} engine marked down` });
        const body = await readJsonBody(req);
        const wav = ttsResponseWavForText(body.text || '');
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        return res.end(wav);
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch {
      sendInternalError(res);
    }
  });
  return {
    server,
    setFailing(value) { isFailing = value; },
    listen: port => listenOn(server, port),
    close: () => closeServer(server)
  };
}

function opdsFeed({ id, title, entries }) {
  const entryXml = entries.map(entry => `
    <entry>
      <id>${entry.id}</id>
      <title>${entry.title}</title>
      <author><name>${entry.author}</name></author>
      <language>${entry.language || 'en'}</language>
      <rights>${entry.rights || ''}</rights>
      <summary>${entry.summary || ''}</summary>
      <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="${entry.href}"/>
      ${entry.licenseHref ? `<link rel="license" href="${entry.licenseHref}"/>` : ''}
    </entry>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${id}</id>
  <title>${title}</title>
  ${entryXml}
</feed>`;
}

// A placeholder body for "download this edition" links. Search-result
// rendering (the scenario matrix's actual target) never needs this to be a
// real EPUB; wiring the acquisition pipeline through the stub is out of
// scope for this harness (see docs/SCENARIO_SERVER.md).
function placeholderDownload(title, author) {
  return Buffer.from(`Synthetic scenario-harness placeholder for "${title}" by ${author} — not a real EPUB.`);
}

function createProviderNetworkStub(searchResults) {
  const requestLog = [];
  const server = http.createServer((req, res) => {
    try {
      const targetHost = req.headers['x-scenario-target-host'] || '';
      const url = new URL(req.url, `http://${targetHost || '127.0.0.1'}`);
      requestLog.push({ host: targetHost, path: url.pathname, method: req.method });

      if (targetHost === 'gutendex.com' && url.pathname === '/books') {
        const query = url.searchParams.get('search') || '';
        const matched = searchResults.gutenberg.filter(book =>
          matchesQuery(`${book.title || ''} ${(book.authors || []).map(a => a.name).join(' ')}`, query)
        );
        return sendJson(res, 200, { count: matched.length, results: matched });
      }
      if (targetHost === 'gutendex.com' && url.pathname.startsWith('/files/')) {
        return res.end(placeholderDownload('Gutenberg fixture', 'Fixture Author'));
      }

      if (targetHost === 'archive.org' && url.pathname === '/advancedsearch.php') {
        // lib/search-providers/internet-archive.js sends q=`(<query>) AND mediatype:texts`.
        const rawQ = url.searchParams.get('q') || '';
        const query = (rawQ.match(/^\((.*)\) AND mediatype:texts$/) || [, rawQ])[1];
        const matched = searchResults.internetArchive.docs.filter(doc =>
          matchesQuery(`${doc.title || ''} ${doc.creator || ''}`, query)
        );
        return sendJson(res, 200, { response: { docs: matched } });
      }
      if (targetHost === 'archive.org' && url.pathname.startsWith('/metadata/')) {
        const identifier = decodeURIComponent(url.pathname.slice('/metadata/'.length));
        const entry = searchResults.internetArchive.metadata[identifier];
        if (!entry) return sendJson(res, 404, {});
        return sendJson(res, 200, entry);
      }
      if (targetHost === 'archive.org' && url.pathname.startsWith('/download/')) {
        return res.end(placeholderDownload('Internet Archive fixture', 'Fixture Author'));
      }

      // Standard Ebooks (its real default feed URL) and the custom OPDS
      // source (example.com, an IANA-reserved domain) both reach here via
      // the network guard's hostname-based redirect — see environment.js.
      if (targetHost === 'standardebooks.org' && url.pathname === '/feeds/opds') {
        return sendXml(res, 200, opdsFeed({
          id: searchResults.standardEbooksOpds.id,
          title: 'Standard Ebooks (scenario fixture)',
          entries: searchResults.standardEbooksOpds.entries
        }));
      }
      if (targetHost === 'example.com' && url.pathname === '/opds-feed') {
        return sendXml(res, 200, opdsFeed({
          id: searchResults.customOpds.id,
          title: 'Custom OPDS catalog (scenario fixture)',
          entries: searchResults.customOpds.entries
        }));
      }
      // Any other path on a known, modeled host (e.g. an OPDS acquisition
      // link's own href) — most likely a download attempt. See
      // docs/SCENARIO_SERVER.md: acquisition fidelity is out of scope.
      if (['gutendex.com', 'archive.org', 'standardebooks.org', 'example.com'].includes(targetHost)) {
        return res.end(placeholderDownload('Scenario fixture download', 'Fixture Author'));
      }

      // Cover fetchers (Google Books, OpenLibrary, etc.) and anything else
      // the guard redirected here: never fabricate imagery, just say "not
      // found" — a realistic, already-exercised UI state.
      return sendJson(res, 404, { error: 'Not found (scenario provider stub)' });
    } catch {
      sendInternalError(res);
    }
  });
  return {
    server,
    requestLog,
    listen: port => listenOn(server, port),
    close: () => closeServer(server)
  };
}

module.exports = { createTtsEngineStub, createProviderNetworkStub };
