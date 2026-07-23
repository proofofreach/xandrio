/**
 * Project Gutenberg API Client
 * Uses Gutendex REST API (https://gutendex.com/books) for search.
 * No authentication needed. EPUB downloads are direct URLs.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { requestRemote, declaredLength, readBoundedBuffer, byteLimit } = require('./remote-fetch');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const SETTINGS_FILE = path.join(DATA_DIR, 'gutenberg-settings.json');
const CACHE_FILE = path.join(DATA_DIR, 'gutenberg-cache.json');
const API_BASE = 'https://gutendex.com/books';
const SEARCH_TIMEOUT_MS = Number(process.env.GUTENBERG_SEARCH_TIMEOUT_MS || 25000);
const CACHE_TTL_MS = Number(process.env.GUTENBERG_CACHE_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const MAX_SEARCH_BYTES = Number(process.env.GUTENBERG_MAX_SEARCH_BYTES || 2 * 1024 * 1024);
const MAX_DOWNLOAD_BYTES = Number(process.env.GUTENBERG_MAX_DOWNLOAD_BYTES || 1024 * 1024 * 1024);
const USER_AGENT = 'Xandrio-Audiobook-Player/1.0';

function remoteOptions(timeoutMs) {
  return {
    timeoutMs,
    maxRedirects: 3,
    headersForUrl: () => ({ 'User-Agent': USER_AGENT })
  };
}

async function fetchJson(url, timeoutMs = SEARCH_TIMEOUT_MS) {
  const remote = await requestRemote(url, remoteOptions(timeoutMs));
  try {
    if (!remote.response.ok) {
      throw new Error(`Gutendex API error: ${remote.response.status} ${remote.response.statusText}`);
    }
    return JSON.parse((await readBoundedBuffer(remote.response, MAX_SEARCH_BYTES)).toString('utf8'));
  } finally {
    remote.close();
  }
}

function normalizeCacheKey(query, language) {
  const normalizedQuery = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedLanguage = String(language || 'all').toLowerCase();
  return `${normalizedLanguage}:${normalizedQuery}`;
}

async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function getCachedSearch(query, language) {
  const cache = await loadCache();
  const entry = cache[normalizeCacheKey(query, language)];
  if (!entry || !Array.isArray(entry.results)) return [];
  if (Date.now() - Date.parse(entry.cachedAt || 0) > CACHE_TTL_MS) return [];
  console.log(`[gutenberg] Using cached results for "${query}"`);
  return entry.results;
}

async function setCachedSearch(query, language, results) {
  const cache = await loadCache();
  cache[normalizeCacheKey(query, language)] = {
    cachedAt: new Date().toISOString(),
    results
  };
  await saveCache(cache);
}

/**
 * Check if Gutenberg source is enabled (default: true)
 */
function isEnabled() {
  try {
    const data = JSON.parse(fsSync.readFileSync(SETTINGS_FILE, 'utf-8'));
    return data.enabled !== false;
  } catch {
    return true; // enabled by default
  }
}

/**
 * Set enabled/disabled state
 */
async function setEnabled(enabled) {
  const dir = path.dirname(SETTINGS_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify({ enabled: !!enabled }, null, 2));
}

/**
 * Flip author name from "Last, First" to "First Last"
 */
function flipAuthorName(name) {
  if (!name) return 'Unknown';
  if (!name.includes(',')) return name;
  const parts = name.split(',').map(s => s.trim());
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`;
  return name;
}

/**
 * Search Project Gutenberg for books via Gutendex API
 * Returns normalized result array matching the standard shape.
 */
async function search(query, opts = {}) {
  const { language } = opts;

  try {
    const params = new URLSearchParams({ search: query });
    if (language && language !== 'all') {
      params.set('languages', language);
    }

    const url = `${API_BASE}?${params}`;
    console.log(`[gutenberg] Searching: ${url}`);

    const body = await fetchJson(url);

    if (!body.results || !Array.isArray(body.results)) {
      return [];
    }

    // Filter to books that have an EPUB download available
    const results = [];
    for (const book of body.results) {
      const epubUrl = book.formats?.['application/epub+zip'];
      if (!epubUrl) continue;

      const author = book.authors?.[0]?.name || 'Unknown';
      const coverUrl = book.formats?.['image/jpeg'] || '';

      results.push({
        title: book.title || 'Unknown Title',
        author: flipAuthorName(author),
        format: 'EPUB',
        size: '',
        hash: `pg-${book.id}`,
        gutenbergId: String(book.id),
        publisher: 'Project Gutenberg',
        language: book.languages?.[0] || '',
        url: `https://www.gutenberg.org/ebooks/${book.id}`,
        source: 'gutenberg',
        downloadUrl: epubUrl,
        coverUrl,
        downloadCount: book.download_count || 0,
        description: Array.isArray(book.summaries) && book.summaries[0] ? book.summaries[0] : undefined,
        subjects: Array.isArray(book.subjects) ? book.subjects.slice(0, 8) : []
      });
    }

    console.log(`[gutenberg] Found ${results.length} EPUB results`);
    if (results.length > 0) await setCachedSearch(query, language, results).catch(() => {});
    return results;
  } catch (err) {
    console.error('[gutenberg] Search error:', err.message);
    return getCachedSearch(query, language);
  }
}

/**
 * Download a Gutenberg EPUB by direct URL
 */
async function downloadBook(gutenbergId, downloadUrl, destPath) {
  console.log(`[gutenberg] Downloading book ${gutenbergId} from: ${downloadUrl}`);

  const remote = await requestRemote(downloadUrl, remoteOptions(30000));
  try {
    const { response } = remote;
    if (!response.ok) {
      throw new Error(`Gutenberg download failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) throw new Error('Gutenberg download returned an empty response');
    const length = declaredLength(response);
    if (length !== null && length > MAX_DOWNLOAD_BYTES) {
      throw new Error('Gutenberg download exceeds the allowed size');
    }

    // Stream to a temp file and rename so an interrupted download can't
    // leave a truncated book at destPath.
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const partPath = `${destPath}.part`;
    const fileStream = fsSync.createWriteStream(partPath);
    await pipeline(Readable.fromWeb(response.body), byteLimit(MAX_DOWNLOAD_BYTES), fileStream);
    await fs.rename(partPath, destPath);
  } catch (err) {
    await fs.unlink(`${destPath}.part`).catch(() => {});
    throw err;
  } finally {
    remote.close();
  }

  console.log(`[gutenberg] Downloaded to: ${destPath}`);
  return destPath;
}

module.exports = { isEnabled, setEnabled, search, downloadBook, getCachedSearch, setCachedSearch };
