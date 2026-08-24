'use strict';

// Library Genesis search client.
//
// Anna's Archive aggregates Library Genesis, so a LibGen md5 is the same content
// address Anna's uses for downloads -- every LibGen result row even links to its
// own annas-archive.gl/md5/<hash> page. That lets Xandrio search the open LibGen
// index, which serves ordinary results, and hand the md5 to Anna's member
// download API. The anonymous annas-archive.gl HTML search is behind a
// DDoS-Guard JS challenge that a server cannot clear; LibGen has no such wall.
//
// All three default mirrors run the libgen.li software and share one 9-column
// results table (ID/Title, Author(s), Publisher, Year, Language, Pages, Size,
// Ext., Mirrors). The md5 is carried in the Mirrors cell's hrefs.

const { requestRemote, readBoundedBuffer } = require('./remote-fetch');
const { stripHTML } = require('./chapter-utils');

// Mirrors sharing the libgen.li table format, tried in order. Override with a
// comma-separated LIBGEN_MIRRORS to pin or extend the list.
const DEFAULT_MIRRORS = ['https://libgen.li', 'https://libgen.vg', 'https://libgen.bz'];

// The member download API only serves real ebooks; keep results to formats the
// rest of the pipeline knows how to import.
const ALLOWED_FORMATS = new Set(['EPUB', 'MOBI', 'AZW3', 'AZW', 'PDF', 'FB2']);

const FORMAT_PRIORITY = { EPUB: 1, AZW3: 2, AZW: 2, MOBI: 2, FB2: 3, PDF: 9 };

const MIN_BOOK_BYTES = 100 * 1024;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

function configuredMirrors(env = process.env) {
  const raw = String(env.LIBGEN_MIRRORS || '').trim();
  if (!raw) return DEFAULT_MIRRORS;
  const parsed = raw
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      try {
        const url = new URL(part);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_MIRRORS;
}

function cellText(cellHtml) {
  return stripHTML(String(cellHtml || ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// LibGen author/publisher cells often end with a stray separator ("Andy Weir,").
function trimField(value) {
  return String(value || '').replace(/^[\s,;]+|[\s,;]+$/g, '');
}

// The title cell holds an optional <b>series</b>, then an <a href="edition.php…">
// whose inner text is the clean title, then an <nobr> badge cluster. Anchor the
// match on href= itself: attributes before href (a tooltip title=) can contain a
// literal <br>, so a match that scanned from "<a" would stop on that stray ">".
function titleFromCell(cellHtml) {
  const withoutBadges = String(cellHtml || '').replace(/<nobr\b[\s\S]*?<\/nobr>/gi, ' ');
  const anchor = withoutBadges.match(
    /href=["'][^"']*(?:edition|book|file|index)\.php[^"']*["'][^>]*>([\s\S]*?)<\/a>/i
  );
  if (anchor) {
    const text = cellText(anchor[1]);
    if (text) return text;
  }
  // Fallback: the whole cell, minus a leading bold series label.
  return cellText(withoutBadges.replace(/^\s*<b\b[\s\S]*?<\/b>/i, ' '));
}

function md5FromRow(rowHtml) {
  const keyed = String(rowHtml || '').match(/md5=([a-f0-9]{32})/i);
  if (keyed) return keyed[1].toLowerCase();
  const pathed = String(rowHtml || '').match(/\/([a-f0-9]{32})(?:[/"'?]|$)/i);
  return pathed ? pathed[1].toLowerCase() : '';
}

function parseSizeToBytes(sizeStr) {
  const match = String(sizeStr || '').match(/([\d.]+)\s*(B|KB|MB|GB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const scale = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 }[unit] || 1;
  return Math.round(value * scale);
}

// Pure parser over one mirror's results page. No network, no side effects, so
// it is unit-tested directly the way parseAnnasResults is.
function parseLibgenResults(html, { baseUrl = DEFAULT_MIRRORS[0] } = {}) {
  const results = [];
  const seen = new Set();
  const rows = String(html || '').match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const md5 = md5FromRow(row);
    if (!md5 || seen.has(md5)) continue;

    const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
    // The results table has nine columns; anything shorter is a header or a
    // layout row that happens to contain a hash.
    if (cells.length < 8) continue;

    const inner = cells.map(cell => cell.replace(/^<td[^>]*>/i, '').replace(/<\/td>$/i, ''));
    const title = titleFromCell(inner[0]);
    if (!title) continue;

    const format = cellText(inner[7]).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (format && !ALLOWED_FORMATS.has(format)) continue;

    const size = cellText(inner[6]);
    const sizeBytes = parseSizeToBytes(size);
    if (sizeBytes > 0 && sizeBytes < MIN_BOOK_BYTES) continue;

    seen.add(md5);
    results.push({
      title,
      author: trimField(cellText(inner[1])) || 'Unknown',
      format: format || 'EPUB',
      size,
      hash: md5,
      publisher: trimField(cellText(inner[2])),
      language: cellText(inner[4]) || '',
      url: `${baseUrl}/ads.php?md5=${md5}`
    });
  }

  results.sort((a, b) => {
    const pa = FORMAT_PRIORITY[a.format] || 50;
    const pb = FORMAT_PRIORITY[b.format] || 50;
    if (pa !== pb) return pa - pb;
    const sa = parseSizeToBytes(a.size);
    const sb = parseSizeToBytes(b.size);
    if (sa !== sb) return sb - sa;
    return a.title.localeCompare(b.title);
  });

  return results;
}

async function fetchMirror(baseUrl, query, { timeoutMs, proxyUrl }) {
  const url = `${baseUrl}/index.php?req=${encodeURIComponent(query)}`;
  const remote = await requestRemote(url, {
    timeoutMs,
    maxRedirects: 3,
    proxyUrl,
    headersForUrl: () => ({
      Accept: 'text/html',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
  });
  try {
    const { response } = remote;
    if (!response.ok) throw new Error(`LibGen mirror returned ${response.status}`);
    const buffer = await readBoundedBuffer(response, MAX_HTML_BYTES);
    return buffer.toString('utf8');
  } finally {
    remote.close();
  }
}

// Search LibGen across mirrors and return results in the same shape as
// parseAnnasResults: { title, author, format, size, hash, publisher, language,
// url }, where `hash` is the md5 the Anna's download path expects.
//
// Rotation is fail-closed and honest, mirroring the rest of book acquisition: a
// mirror that errors is skipped; the first mirror that answers with results
// wins; if a mirror answers cleanly with zero rows that empty answer is
// returned (LibGen genuinely has nothing). Only when every mirror errors does
// this throw, so a refused search is never reported as an empty catalogue.
async function searchLibgen(query, opts = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];

  const env = opts.env || process.env;
  const mirrors = opts.mirrors || configuredMirrors(env);
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 25;
  const proxyUrl = opts.proxyUrl || env.BOOK_PROXY_URL || undefined;
  // Test seam: unit tests inject a fetcher so mirror behaviour is exercised
  // without live network. Production always uses the real fetchMirror.
  const fetch = opts._fetchMirror || ((baseUrl) => fetchMirror(baseUrl, trimmed, { timeoutMs, proxyUrl }));

  // Query the mirrors concurrently and take the first that returns results,
  // rather than rotating in sequence. From a datacenter IP some mirrors answer
  // 200 but then stall or 5xx the body; a sequential rotation waits each one
  // out and can burn the whole provider budget before reaching a healthy
  // mirror. Racing bounds latency to the fastest healthy mirror. The failure
  // contract is unchanged: a mirror that errors or answers empty never wins the
  // race; only when every mirror errors at the transport level do we throw, so
  // a refused search is never reported as an empty catalogue.
  const attempts = mirrors.map(baseUrl =>
    Promise.resolve(fetch(baseUrl)).then(html => parseLibgenResults(html, { baseUrl }))
  );

  let lastError = null;
  let sawCleanEmpty = false;
  let pending = attempts.length;
  if (pending === 0) return [];

  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    for (const attempt of attempts) {
      attempt
        .then(results => {
          if (results.length > 0) done(results.slice(0, limit));
          else sawCleanEmpty = true;
        })
        .catch(error => { lastError = error; })
        .finally(() => {
          pending -= 1;
          if (pending === 0 && !settled) {
            if (sawCleanEmpty) done([]);
            // Every mirror errored: surface it (rejecting the outer promise) so
            // the caller marks the source unavailable, not empty.
            else { settled = true; resolve(Promise.reject(lastError || new Error('LibGen search is unavailable'))); }
          }
        });
    }
  });
}

module.exports = {
  searchLibgen,
  parseLibgenResults,
  configuredMirrors,
  DEFAULT_MIRRORS
};
