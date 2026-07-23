const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs').promises;
const fsSync = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const multer = require('multer');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { requestRemote, declaredLength, readBoundedBuffer, byteLimit } = require('./lib/remote-fetch');
const TTSQueue = require('./lib/tts-queue');
const ChunkedTTS = require('./lib/chunked-tts');
const { searchAnnas: searchAnnasDirect, closeBrowser: closeAnnasBrowser } = require('./lib/annas-scraper');
const zlibrary = require('./lib/zlibrary');
const gutenberg = require('./lib/gutenberg');
const { isSafeBookId: requestGuardIsSafeBookId, parseNonNegativeInteger } = require('./lib/request-guards');
const { serveAudioFile } = require('./lib/audio-response');
const { getTtsOutputFormatForVoice } = require('./lib/tts-output-format');
const { createNarrationEngineRegistry } = require('./lib/narration-engine-registry');
const { createNarrationRuntime } = require('./lib/narration-runtime');
const { createPlaybackOrchestrator } = require('./lib/playback-orchestrator');
const GenerationScheduler = require('./lib/generation-scheduler');
const GenerationJournal = require('./lib/generation-journal');
const { createPronunciationService, createCacheInvalidator } = require('./lib/pronunciation-repair');
const { registerPronunciationRoutes } = require('./lib/routes/pronunciation-routes');
const { createXBookStore } = require('./lib/xbook-store');
const { createBookDocument } = require('./lib/book-document');
const { chapterStructureKey, positionMatchesChapterStructure } = require('./lib/chapter-structure');
const { parseEpub } = require('./lib/epub-parser');
const { BookImportError, createBookImporter } = require('./lib/book-importer');
const { createUserLibraryState } = require('./lib/user-library-state');
const { createSearchProviderRegistry } = require('./lib/search-providers');
const { createSearchCoverService } = require('./lib/search-cover-service');
const { buildCatalogSearchResponse } = require('./lib/catalog-search');
const { searchCatalogQuery } = require('./lib/search-query');
const { fallbackCompatibility } = require('./lib/search-work-resolution');
const internetArchive = require('./lib/search-providers/internet-archive');
const { createStandardEbooksProvider } = require('./lib/search-providers/standard-ebooks');
const { createOpdsProvider } = require('./lib/search-providers/opds');
const { registerPreferencesRoutes } = require('./lib/routes/preferences-routes');
const { registerBookmarksRoutes, removeBookBookmarks } = require('./lib/routes/bookmarks-routes');
const { registerOperatorPolicyRoutes } = require('./lib/routes/operator-policy-routes');
const jsonStore = require('./lib/json-store');
const { computeListeningStats } = require('./lib/listening-stats');
const { createAuthMiddleware, createAuthRoutes, createSessionStore, requireAdmin, DEFAULT_SESSION_TTL_MS } = require('./lib/auth');
const { createAccountsStore } = require('./lib/accounts');
const shelves = require('./lib/shelves');
const { registerAccountRoutes } = require('./lib/routes/accounts-routes');
const { createRateLimitMiddleware, positiveInteger } = require('./lib/rate-limit');
const { createGracefulShutdown } = require('./lib/graceful-shutdown');
const {
  ConcurrencyGate,
  createConcurrencyLimitMiddleware,
  defaultConcurrencyGroups
} = require('./lib/concurrency-limit');
const {
  blockedSourceIds,
  decorateSourceDescriptors,
  filterEnabledAlternatives,
  operatorPolicyStatus
} = require('./lib/operator-policy');
const { sourceProvenanceFromSelection } = require('./lib/source-provenance');
const { DEFAULT_ANNAS_ORIGIN, normalizeAnnasOrigin } = require('./lib/annas-origin');
const {
  parseAnnasResults
} = require('./lib/search-utils');
const {
  shouldFilterChapter,
  stripHTML,
  splitOversizedChapters,
  buildChapterQuality,
  findPreferredAudioStartChapterIndex,
  normalizeChapterTitleForDisplay
} = require('./lib/chapter-utils');
const {
  __test: pdfExtractionTestHooks
} = require('./lib/pdf-extraction');
const {
  isGarbageTitle,
  isGarbageAuthor,
  normalizeAuthorForDisplay,
  resolveMetadataSeed,
  trustedEnrichedTitle,
  enrichBookMetadata,
  resolveOpenLibraryIdentity,
  resolveSearchQueryCorrection,
  titleTokenOverlap
} = require('./lib/metadata-service');
const {
  canonicalWorkKey,
  findDuplicateBook,
  assessExtractedContent,
  assessMetadataConfidence,
  buildImportValidationReport
} = require('./lib/import-validation');
const {
  isKokoroVoice,
  getKokoroChunkSize,
  normalizeKokoroProfile
} = require('./lib/kokoro-tuning');
const {
  isChatterboxVoice,
  getChatterboxChunkSize,
  normalizeChatterboxProfile
} = require('./lib/chatterbox-tuning');
const {
  getJpegDimensions,
  fetchCoverFromGoogleBooks,
  fetchCoverByISBN,
  fetchCoverFromOpenLibrary,
  fetchCoverByOpenLibraryWorkKey,
  fetchCoverFromGutenbergId,
  fetchCoverFromAnnasPage,
  extractCover
} = require('./lib/cover-service');

const app = express();
const PORT = process.env.PORT || 8181;
const HOST = process.env.HOST || '127.0.0.1';
const PREGENERATE_ON_IMPORT = process.env.XANDRIO_PREGENERATE_ON_IMPORT !== 'false';
process.title = `xandrio-server:${PORT}`;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, 'cache'));
const CHATTERBOX_VOICE_DIR = path.resolve(process.env.CHATTERBOX_VOICE_DIR || path.join(DATA_DIR, 'voice-references'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_CHUNK = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function configuredCorsOrigins(value) {
  const origins = new Set();
  for (const candidate of String(value || '').split(',')) {
    const raw = candidate.trim();
    if (!raw) continue;
    try {
      const origin = new URL(raw).origin;
      if (origin === raw.replace(/\/$/, '')) origins.add(origin);
      else console.warn(`Ignoring invalid CORS_ORIGIN entry: ${raw}`);
    } catch {
      console.warn(`Ignoring invalid CORS_ORIGIN entry: ${raw}`);
    }
  }
  return origins;
}

function configuredTrustProxy(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'false' || raw === '0') return false;
  if (/^[1-9]\d*$/.test(raw)) return Number(raw);
  if (['loopback', 'linklocal', 'uniquelocal'].includes(raw)) return raw;
  console.warn('Ignoring invalid XANDRIO_TRUST_PROXY; use a positive hop count or loopback/linklocal/uniquelocal.');
  return false;
}

function securityHeaders(req, res, next) {
  // The app has inline presentation attributes, so style-src retains
  // unsafe-inline. Scripts remain restricted to this instance.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob: data:",
    "connect-src 'self'",
    "worker-src 'self' blob:"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

const trustProxy = configuredTrustProxy(process.env.XANDRIO_TRUST_PROXY);
if (trustProxy) app.set('trust proxy', trustProxy);
const allowedCorsOrigins = configuredCorsOrigins(process.env.CORS_ORIGIN);
const corsOptions = {
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  origin(origin, callback) {
    // Same-origin browser requests do not require CORS headers.  Cross-origin
    // access is opt-in and must match an operator-configured origin exactly.
    callback(null, Boolean(origin && allowedCorsOrigins.has(origin)));
  },
  optionsSuccessStatus: 204
};

// Middleware
app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(bodyParser.json());

// Set XANDRIO_TOKEN for private-instance mode. Without it, this is the
// documented trusted-LAN mode: all API routes are reachable by anyone who can
// reach the server.
const XANDRIO_TOKEN = process.env.XANDRIO_TOKEN || '';
if (!XANDRIO_TOKEN) {
  console.warn('XANDRIO_TOKEN is not set — trusted-LAN mode is active. Anyone who can reach this server can access the library, audio, and settings.');
}
const RATE_LIMIT_WINDOW = positiveInteger(process.env.RATE_LIMIT_WINDOW, 60_000);
const RATE_LIMIT_MAX = positiveInteger(process.env.RATE_LIMIT_MAX, 60);
const CONCURRENCY_LIMITS = Object.freeze({
  auth: positiveInteger(process.env.XANDRIO_CONCURRENCY_AUTH, 8),
  search: positiveInteger(process.env.XANDRIO_CONCURRENCY_SEARCH, 4),
  upload: positiveInteger(process.env.XANDRIO_CONCURRENCY_UPLOAD, 2),
  metadata: positiveInteger(process.env.XANDRIO_CONCURRENCY_METADATA, 2),
  tts: positiveInteger(process.env.XANDRIO_CONCURRENCY_TTS, 8),
  voice: positiveInteger(process.env.XANDRIO_CONCURRENCY_VOICE, 1),
  download: positiveInteger(process.env.XANDRIO_CONCURRENCY_DOWNLOAD, 2)
});
const SESSION_TTL_HOURS = positiveInteger(process.env.XANDRIO_SESSION_TTL_HOURS, 30 * 24);
const SESSION_TTL_MS = Math.min(SESSION_TTL_HOURS * 60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000, DEFAULT_SESSION_TTL_MS * 3);
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const accountsStore = createAccountsStore({ filePath: ACCOUNTS_FILE, jsonStore });
const accountSessionStore = createSessionStore({ filePath: SESSIONS_FILE, jsonStore, ttlMs: SESSION_TTL_MS });
const authRoutes = createAuthRoutes({
  token: XANDRIO_TOKEN,
  sessionTtlMs: SESSION_TTL_MS,
  accounts: accountsStore,
  sessionStore: accountSessionStore
});
app.use(createRateLimitMiddleware({ windowMs: RATE_LIMIT_WINDOW, max: RATE_LIMIT_MAX }));
const requestConcurrencyLimiter = createConcurrencyLimitMiddleware({
  groups: defaultConcurrencyGroups(CONCURRENCY_LIMITS)
});
app.use(requestConcurrencyLimiter);
app.post('/api/auth/login', authRoutes.login);
app.post('/api/auth/logout', authRoutes.logout);
app.get('/api/auth/status', authRoutes.status);
app.use(createAuthMiddleware({ token: XANDRIO_TOKEN, accounts: accountsStore, sessionStore: accountSessionStore, sessionTtlMs: SESSION_TTL_MS }));
app.post('/api/auth/change-password', authRoutes.changePassword);
registerAccountRoutes(app, { accounts: accountsStore, sessionStore: accountSessionStore, requireAdmin });

// Instance-wide configuration stays admin-only once accounts exist; in
// trusted-LAN and shared-token modes every caller resolves as admin, so
// these guards are inert until the first account is created. The guard
// layers run before the matching handlers registered further down and fall
// through via next() when the caller is an admin.
const ADMIN_ONLY_ROUTES = [
  ['post', '/api/voice'],
  ['post', '/api/premium-prep/settings'],
  ['put', '/api/legal/operator-policy'],
  ['post', '/api/annas/configure'],
  ['delete', '/api/annas/configure'],
  ['post', '/api/zlibrary/configure'],
  ['delete', '/api/zlibrary/configure'],
  ['post', '/api/gutenberg/configure']
];
for (const [method, route] of ADMIN_ONLY_ROUTES) {
  app[method](route, requireAdmin);
}
app.get('/sw.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Service-Worker-Allowed', '/');
  next();
});
app.get('/manifest.webmanifest', (req, res, next) => {
  res.type('application/manifest+json');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/.well-known/assetlinks.json', (req, res) => {
  const packageName = process.env.TWA_PACKAGE_NAME;
  const fingerprints = (process.env.TWA_SHA256_CERT_FINGERPRINTS || '')
    .split(',')
    .map(fingerprint => fingerprint.trim())
    .filter(Boolean);

  if (!packageName || fingerprints.length === 0) {
    return res.status(404).json({ error: 'Trusted Web Activity asset links are not configured.' });
  }

  res.type('application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: packageName,
      sha256_cert_fingerprints: fingerprints
    }
  }]);
});
app.use(express.static('public', {
  setHeaders: (res, filePath) => {
    if (/\.(html|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// Data directories
const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
const BOOKS_FILE = path.join(DATA_DIR, 'books.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ANNAS_AUTH_FILE = path.join(DATA_DIR, 'annas-auth.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');
const SHELVES_FILE = path.join(DATA_DIR, 'shelves.json');
const CLIENT_SETTINGS_FILE = path.join(DATA_DIR, 'client-settings.json');
const CUSTOM_VOICES_FILE = path.join(DATA_DIR, 'custom-voices.json');
const PRONUNCIATIONS_FILE = path.join(DATA_DIR, 'pronunciations.json');
const searchCoverService = createSearchCoverService({
  cacheDir: path.join(CACHE_DIR, 'search-covers'),
  getDimensions: getJpegDimensions,
  fetchCoverByISBN,
  fetchCoverByOpenLibraryWorkKey,
  fetchCoverFromGutenbergId,
  fetchCoverFromGoogleBooks,
  // The configured origin is resolved at fetch time so changing Anna's
  // Archive settings cannot leave the cover proxy trusting a prior mirror.
  fetchCoverFromAnnasPage: (pageUrl, outputPath) => fetchCoverFromAnnasPage(pageUrl, outputPath, {
    expectedOrigin: getAnnasConfig().baseUrl
  }),
  resolveOpenLibraryIdentity
});
const deletedBookIds = new Set();
const MAX_DELETED_BOOK_IDS = 200;

// Record a deleted book id, evicting the oldest-inserted entries beyond the cap.
// A Set iterates in insertion order, so the first value is always the oldest.
function rememberDeletedBookId(bookId) {
  deletedBookIds.add(bookId);
  while (deletedBookIds.size > MAX_DELETED_BOOK_IDS) {
    const oldest = deletedBookIds.values().next().value;
    if (oldest === undefined) break;
    deletedBookIds.delete(oldest);
  }
}

// Unified 500 response: log the full error server-side, return a generic public
// message with no raw err.message so internal details are not leaked to clients.
function sendServerError(res, err, publicMessage = 'Something went wrong') {
  console.error(`${publicMessage}:`, err);
  res.status(500).json({ error: publicMessage });
}

// Anna's Archive config — read from file, fallback to hardcoded defaults
function getAnnasConfig() {
  try {
    const data = fsSync.readFileSync(ANNAS_AUTH_FILE, 'utf8');
    const cfg = JSON.parse(data);
    const fileHasKey = typeof cfg.secretKey === 'string' && cfg.secretKey.length > 0;
    return {
      secretKey: cfg.secretKey || process.env.ANNAS_SECRET_KEY || '',
      baseUrl: normalizeAnnasOrigin(cfg.baseUrl || process.env.ANNAS_BASE_URL || DEFAULT_ANNAS_ORIGIN),
      keySource: fileHasKey ? 'settings' : (process.env.ANNAS_SECRET_KEY ? 'environment' : null),
      updatedAt: fileHasKey ? (cfg.updatedAt || null) : null
    };
  } catch {
    try {
      return {
        secretKey: process.env.ANNAS_SECRET_KEY || '',
        baseUrl: normalizeAnnasOrigin(process.env.ANNAS_BASE_URL || DEFAULT_ANNAS_ORIGIN),
        keySource: process.env.ANNAS_SECRET_KEY ? 'environment' : null,
        updatedAt: null
      };
    } catch {
      return { secretKey: '', baseUrl: DEFAULT_ANNAS_ORIGIN, keySource: null, updatedAt: null };
    }
  }
}

function buildAnnasCliEnv(cfg = getAnnasConfig(), baseEnv = process.env) {
  const cliEnv = {
    ...baseEnv,
    ANNAS_SECRET_KEY: cfg.secretKey,
    ANNAS_DOWNLOAD_PATH: CACHE_DIR
  };
  // annas-mcp performs its own current-mirror discovery. A stale app mirror
  // suppresses that discovery and turns a healthy search into an empty result.
  delete cliEnv.ANNAS_BASE_URL;
  return cliEnv;
}

async function downloadFromAnnasDirect(hash, outputPath) {
  const cfg = getAnnasConfig();
  if (!cfg.secretKey) {
    throw new Error('Anna\'s Archive secret key is not configured');
  }

  const origin = normalizeAnnasOrigin(cfg.baseUrl);
  const apiUrl = `${origin}/dyn/api/fast_download.json?md5=${encodeURIComponent(hash)}&key=${encodeURIComponent(cfg.secretKey)}`;
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  const apiRemote = await requestRemote(apiUrl, {
    timeoutMs: 30000,
    maxRedirects: 3,
    proxyUrl: process.env.BOOK_PROXY_URL || undefined,
    headersForUrl: () => headers
  });
  let data;
  try {
    const { response: apiResp } = apiRemote;
    if (!apiResp.ok) {
      // The request URL contains the operator's key. Do not include an
      // upstream response body that could reflect it in local logs.
      throw new Error(`Anna's API failed (${apiResp.status})`);
    }
    data = JSON.parse((await readBoundedBuffer(apiResp, Number(process.env.ANNAS_API_MAX_JSON_BYTES || 2 * 1024 * 1024))).toString('utf8'));
  } finally {
    apiRemote.close();
  }
  if (data.error) throw new Error('Anna\'s API rejected the request');
  if (!data.download_url) throw new Error('Anna\'s API returned no download URL');

  const downloadRemote = await requestRemote(data.download_url, {
    timeoutMs: 120000,
    maxRedirects: 3,
    proxyUrl: process.env.BOOK_PROXY_URL || undefined,
    headersForUrl: () => ({ 'User-Agent': headers['User-Agent'] })
  });
  try {
    const { response: downloadResp } = downloadRemote;
    if (!downloadResp.ok) {
      throw new Error(`Anna's file download failed (${downloadResp.status})`);
    }
    if (!downloadResp.body) throw new Error('Anna\'s file download returned an empty response');
    const maxDownloadBytes = Number(process.env.ANNAS_MAX_DOWNLOAD_BYTES || 1024 * 1024 * 1024);
    const length = declaredLength(downloadResp);
    if (length !== null && length > maxDownloadBytes) {
      throw new Error('Anna\'s file download exceeds the allowed size');
    }
    const partPath = `${outputPath}.part`;
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    try {
      await pipeline(Readable.fromWeb(downloadResp.body), byteLimit(maxDownloadBytes), fsSync.createWriteStream(partPath));
      await fs.rename(partPath, outputPath);
    } catch (error) {
      await fs.unlink(partPath).catch(() => {});
      throw error;
    }
  } finally {
    downloadRemote.close();
  }
}

function annasBrowserSearchPermitted(env = process.env) {
  return env.ANNAS_BROWSER_SEARCH_MODE === 'permitted';
}

function annasSearchTimeoutMs(env = process.env) {
  const configured = Number(env.ANNAS_SEARCH_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured >= 15000 && configured <= 120000) return configured;
  return annasBrowserSearchPermitted(env) ? 75000 : 20000;
}

function annasMcpSearchArgs(query) {
  return ['book-search', query];
}

function annasMcpExecutable(env = process.env, {
  homeDir = os.homedir(),
  existsSync = fsSync.existsSync
} = {}) {
  const configured = typeof env.ANNAS_MCP_BIN === 'string' ? env.ANNAS_MCP_BIN.trim() : '';
  if (configured) return configured;
  const userLocal = path.join(homeDir, '.local', 'bin', 'annas-mcp');
  return existsSync(userLocal) ? userLocal : 'annas-mcp';
}

async function searchAnnasProvider(query) {
  let cliResults = [];
  try {
    const { stdout } = await execFileAsync(
      annasMcpExecutable(), annasMcpSearchArgs(query),
      { timeout: 15000, env: buildAnnasCliEnv() }
    );
    cliResults = parseAnnasResults(stdout);
  } catch {
    // External CLI errors can contain endpoints or credentials. Keep logs stable.
    console.log('annas-mcp search unavailable');
  }
  if (cliResults.length > 0 || !annasBrowserSearchPermitted()) return cliResults;

  try {
    const annasConfig = getAnnasConfig();
    const directResults = await Promise.allSettled(
      SEARCH_FORMATS.map(format => searchAnnasDirect(query, {
        format,
        limit: 8,
        baseUrl: annasConfig.baseUrl
      }))
    );
    return directResults
      .filter(result => result.status === 'fulfilled')
      .flatMap(result => result.value);
  } catch {
    console.error('Anna browser fallback unavailable');
    return [];
  }
}

async function cleanupBookArtifacts(bookId, book = {}) {
  const deleted = [];
  const failed = [];
  const paths = new Set();

  const addPath = (candidate) => {
    if (!candidate || typeof candidate !== 'string') return;
    const resolved = path.resolve(candidate);
    const cacheRoot = path.resolve(CACHE_DIR);
    if (resolved === cacheRoot || !resolved.startsWith(`${cacheRoot}${path.sep}`)) return;
    paths.add(resolved);
  };

  addPath(book.path);
  addPath(book.sourcePath);
  addPath(book.extractedArtifact);
  addPath(book.coverPath);

  const cacheFiles = await fs.readdir(CACHE_DIR).catch(() => []);
  for (const file of cacheFiles) {
    if (file === bookId || file.startsWith(`${bookId}.`) || file.startsWith(`${bookId}_`)) {
      addPath(path.join(CACHE_DIR, file));
    }
  }

  for (const target of paths) {
    try {
      await fs.rm(target, { force: true, recursive: true });
      deleted.push(target);
      invalidateChapterCache(target);
    } catch (err) {
      failed.push({ path: target, error: err.message });
    }
  }

  return { deleted, failed };
}

function scheduleDeletedBookArtifactSweeps(bookId, book = {}) {
  for (const delay of [2000, 10000, 30000]) {
    setTimeout(() => {
      if (!deletedBookIds.has(bookId)) return;
      cleanupBookArtifacts(bookId, book)
        .then(result => {
          if (result.deleted.length > 0 || result.failed.length > 0) {
            console.log(`Post-delete sweep for ${bookId}: removed ${result.deleted.length}, failed ${result.failed.length}`);
          }
        })
        .catch(err => console.error(`Post-delete sweep failed for ${bookId}:`, err));
    }, delay);
  }
}

function normalizeSearchLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  const bracketMatch = raw.match(/\[([a-z]{2,3})\]/i);
  if (bracketMatch) return bracketMatch[1].toLowerCase();

  const names = {
    english: 'en',
    deutsch: 'de',
    german: 'de',
    spanish: 'es',
    espanol: 'es',
    'español': 'es',
    french: 'fr',
    francais: 'fr',
    'français': 'fr',
    italian: 'it',
    italiano: 'it',
    portuguese: 'pt',
    portugues: 'pt',
    'português': 'pt',
    russian: 'ru',
    chinese: 'zh',
    japanese: 'ja'
  };

  if (names[raw]) return names[raw];

  const codeMatch = raw.match(/^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i);
  return codeMatch ? codeMatch[0].split(/[-_]/)[0].toLowerCase() : raw;
}

function bookRecordOpenLibraryFields(identity) {
  if (!identity || !identity.openLibraryWorkKey) return {};
  return {
    openLibraryWorkKey: identity.openLibraryWorkKey,
    openLibraryEditionKey: identity.openLibraryEditionKey,
    isbn: identity.isbn?.length ? identity.isbn : undefined,
    metadataConfidence: identity.confidence
      ? {
          source: 'openlibrary',
          score: identity.confidence.score,
          level: identity.confidence.level
        }
      : undefined
  };
}

function openLibraryValidationPayload(identity) {
  if (!identity) return undefined;
  return {
    workKey: identity.openLibraryWorkKey,
    editionKey: identity.openLibraryEditionKey,
    confidence: identity.confidence?.score || 0,
    level: identity.confidence?.level || 'low',
    matchedFrom: identity.matchedFrom,
    warnings: identity.warnings || []
  };
}

function cleanBookDescription(value) {
  const cleaned = stripHTML(String(value || ''))
    .replace(/[*_`]+/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s*([•—–])\s*/g, ' $1 ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned || /^undefined|null$/i.test(cleaned)) return undefined;
  return cleaned;
}

function publishedYearFromMetadata(metadataDate, fallbackYear) {
  if (!metadataDate) return fallbackYear;
  const year = new Date(metadataDate).getFullYear();
  return Number.isInteger(year) && year >= 1000 && year <= 2999 ? year : fallbackYear;
}

function isAcceptableFallbackMatch(candidate, expected, expectedOpenLibrary) {
  return fallbackCompatibility({
    ...expected,
    openLibraryWorkKey: expectedOpenLibrary?.openLibraryWorkKey || expected?.openLibraryWorkKey,
    metadataConfidence: expectedOpenLibrary?.confidence || expected?.metadataConfidence
  }, candidate).safe;
}

function hasQueryTerm(query, pattern) {
  return pattern.test(String(query || '').toLowerCase());
}

function withTimeout(promise, timeoutMs, fallbackValue, label) {
  let timeoutId;
  const timeout = new Promise(resolve => {
    timeoutId = setTimeout(() => {
      console.warn(`${label} timed out after ${timeoutMs}ms`);
      resolve(fallbackValue);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

const AVAILABLE_VOICES = [
  // Natural (Multilingual) — highest quality
  { id: 'en-US-AndrewMultilingualNeural', name: 'Andrew', gender: 'Male', language: 'English', accent: 'US', depth: 'Warm', provider: 'Edge', tags: ['Warm', 'Confident'], tier: 'natural', top: true },
  { id: 'en-US-AvaMultilingualNeural', name: 'Ava', gender: 'Female', language: 'English', accent: 'US', depth: 'Expressive', provider: 'Edge', tags: ['Expressive', 'Caring'], tier: 'natural' },
  { id: 'en-US-BrianMultilingualNeural', name: 'Brian', gender: 'Male', language: 'English', accent: 'US', depth: 'Lively', provider: 'Edge', tags: ['Approachable', 'Casual'], tier: 'natural' },
  { id: 'en-US-EmmaMultilingualNeural', name: 'Emma', gender: 'Female', language: 'English', accent: 'US', depth: 'Clear', provider: 'Edge', tags: ['Cheerful', 'Clear'], tier: 'natural' },
  // Standard Neural — also good for audiobooks
  { id: 'en-US-AriaNeural', name: 'Aria', gender: 'Female', language: 'English', accent: 'US', depth: 'Expressive', provider: 'Edge', tags: ['Positive', 'Confident'], tier: 'neural' },
  { id: 'en-US-ChristopherNeural', name: 'Christopher', gender: 'Male', language: 'English', accent: 'US', depth: 'Deep', provider: 'Edge', tags: ['Reliable', 'Authority'], tier: 'neural' },
  { id: 'en-US-GuyNeural', name: 'Guy', gender: 'Male', language: 'English', accent: 'US', depth: 'Lively', provider: 'Edge', tags: ['Passionate', 'Lively'], tier: 'neural' },
  { id: 'en-US-JennyNeural', name: 'Jenny', gender: 'Female', language: 'English', accent: 'US', depth: 'Warm', provider: 'Edge', tags: ['Friendly', 'Warm'], tier: 'neural' },
  { id: 'en-US-MichelleNeural', name: 'Michelle', gender: 'Female', language: 'English', accent: 'US', depth: 'Warm', provider: 'Edge', tags: ['Friendly', 'Pleasant'], tier: 'neural' },
  { id: 'en-US-RogerNeural', name: 'Roger', gender: 'Male', language: 'English', accent: 'US', depth: 'Lively', provider: 'Edge', tags: ['Lively', 'Engaging'], tier: 'neural' },
  // Local Chatterbox Turbo voices. Requires m4-server/chatterbox-server.py and a local voice reference.
  { id: 'chatterbox:brick-scott', name: 'Brick Scott', gender: 'Male', language: 'English', accent: 'US', depth: 'Deep', provider: 'Chatterbox', tags: ['Local', 'US', 'Audiobook', 'Premium'], tier: 'chatterbox', top: true, pairedInstantVoice: 'kokoro:am_onyx' },
  // Local Kokoro voices. Requires m4-server/kokoro-server.py to be running.
  { id: 'kokoro:af_alloy', name: 'Kokoro Alloy', gender: 'Female', language: 'English', accent: 'US', depth: 'Clear', provider: 'Kokoro', tags: ['Local', 'US', 'Clear'], tier: 'kokoro' },
  { id: 'kokoro:af_aoede', name: 'Kokoro Aoede', gender: 'Female', language: 'English', accent: 'US', depth: 'Expressive', provider: 'Kokoro', tags: ['Local', 'US', 'Melodic'], tier: 'kokoro' },
  { id: 'kokoro:af_heart', name: 'Kokoro Heart', gender: 'Female', language: 'English', accent: 'US', depth: 'Warm', provider: 'Kokoro', tags: ['Local', 'Warm'], tier: 'kokoro', top: true },
  { id: 'kokoro:af_bella', name: 'Kokoro Bella', gender: 'Female', language: 'English', accent: 'US', depth: 'Expressive', provider: 'Kokoro', tags: ['Local', 'Expressive'], tier: 'kokoro', top: true },
  { id: 'kokoro:af_jessica', name: 'Kokoro Jessica', gender: 'Female', language: 'English', accent: 'US', depth: 'Expressive', provider: 'Kokoro', tags: ['Local', 'US', 'Engaging'], tier: 'kokoro' },
  { id: 'kokoro:af_kore', name: 'Kokoro Kore', gender: 'Female', language: 'English', accent: 'US', depth: 'Lively', provider: 'Kokoro', tags: ['Local', 'US', 'Bright'], tier: 'kokoro' },
  { id: 'kokoro:af_nicole', name: 'Kokoro Nicole', gender: 'Female', language: 'English', accent: 'US', depth: 'Warm', provider: 'Kokoro', tags: ['Local', 'US', 'Soft'], tier: 'kokoro' },
  { id: 'kokoro:af_nova', name: 'Kokoro Nova', gender: 'Female', language: 'English', accent: 'US', depth: 'Lively', provider: 'Kokoro', tags: ['Local', 'US', 'Modern'], tier: 'kokoro' },
  { id: 'kokoro:af_river', name: 'Kokoro River', gender: 'Female', language: 'English', accent: 'US', depth: 'Warm', provider: 'Kokoro', tags: ['Local', 'US', 'Smooth'], tier: 'kokoro' },
  { id: 'kokoro:af_sarah', name: 'Kokoro Sarah', gender: 'Female', language: 'English', accent: 'US', depth: 'Clear', provider: 'Kokoro', tags: ['Local', 'US', 'Professional'], tier: 'kokoro' },
  { id: 'kokoro:af_sky', name: 'Kokoro Sky', gender: 'Female', language: 'English', accent: 'US', depth: 'Lively', provider: 'Kokoro', tags: ['Local', 'US', 'Bright'], tier: 'kokoro' },
  { id: 'kokoro:am_adam', name: 'Kokoro Adam', gender: 'Male', language: 'English', accent: 'US', depth: 'Deep', provider: 'Kokoro', tags: ['Local', 'US', 'Deep'], tier: 'kokoro', top: true },
  { id: 'kokoro:am_echo', name: 'Kokoro Echo', gender: 'Male', language: 'English', accent: 'US', depth: 'Clear', provider: 'Kokoro', tags: ['Local', 'US', 'Clear'], tier: 'kokoro' },
  { id: 'kokoro:am_eric', name: 'Kokoro Eric', gender: 'Male', language: 'English', accent: 'US', depth: 'Deep', provider: 'Kokoro', tags: ['Local', 'US', 'Authoritative'], tier: 'kokoro' },
  { id: 'kokoro:am_fenrir', name: 'Kokoro Fenrir', gender: 'Male', language: 'English', accent: 'US', depth: 'Deep', provider: 'Kokoro', tags: ['Local', 'US', 'Powerful'], tier: 'kokoro' },
  { id: 'kokoro:am_liam', name: 'Kokoro Liam', gender: 'Male', language: 'English', accent: 'US', depth: 'Warm', provider: 'Kokoro', tags: ['Local', 'US', 'Friendly'], tier: 'kokoro' },
  { id: 'kokoro:am_michael', name: 'Kokoro Michael', gender: 'Male', language: 'English', accent: 'US', depth: 'Clear', provider: 'Kokoro', tags: ['Local', 'US', 'Clear'], tier: 'kokoro', top: true },
  { id: 'kokoro:am_onyx', name: 'Kokoro Onyx', gender: 'Male', language: 'English', accent: 'US', depth: 'Deep', provider: 'Kokoro', tags: ['Local', 'US', 'Deep'], tier: 'kokoro' },
  { id: 'kokoro:am_puck', name: 'Kokoro Puck', gender: 'Male', language: 'English', accent: 'US', depth: 'Lively', provider: 'Kokoro', tags: ['Local', 'US', 'Playful'], tier: 'kokoro' },
  { id: 'kokoro:am_santa', name: 'Kokoro Santa', gender: 'Male', language: 'English', accent: 'US', depth: 'Classic', provider: 'Kokoro', tags: ['Local', 'US', 'Character'], tier: 'kokoro' },
  { id: 'kokoro:bf_alice', name: 'Kokoro Alice', gender: 'Female', language: 'English', accent: 'UK', depth: 'Classic', provider: 'Kokoro', tags: ['Local', 'UK', 'Refined'], tier: 'kokoro' },
  { id: 'kokoro:bf_emma', name: 'Kokoro Emma', gender: 'Female', language: 'English', accent: 'UK', depth: 'Classic', provider: 'Kokoro', tags: ['Local', 'UK', 'Proper'], tier: 'kokoro' },
  { id: 'kokoro:bf_isabella', name: 'Kokoro Isabella', gender: 'Female', language: 'English', accent: 'UK', depth: 'Warm', provider: 'Kokoro', tags: ['Local', 'UK', 'Elegant'], tier: 'kokoro' },
  { id: 'kokoro:bf_lily', name: 'Kokoro Lily', gender: 'Female', language: 'English', accent: 'UK', depth: 'Clear', provider: 'Kokoro', tags: ['Local', 'UK', 'Clear'], tier: 'kokoro' },
  { id: 'kokoro:bm_lewis', name: 'Kokoro Lewis', gender: 'Male', language: 'English', accent: 'UK', depth: 'Deep', provider: 'Kokoro', tags: ['Local', 'UK', 'Deep'], tier: 'kokoro' },
  { id: 'kokoro:bm_fable', name: 'Kokoro Fable', gender: 'Male', language: 'English', accent: 'UK', depth: 'Expressive', provider: 'Kokoro', tags: ['Local', 'UK', 'Story'], tier: 'kokoro' },
  { id: 'kokoro:bm_george', name: 'Kokoro George', gender: 'Male', language: 'English', accent: 'UK', depth: 'Classic', provider: 'Kokoro', tags: ['Local', 'UK', 'Classic'], tier: 'kokoro', top: true },
  { id: 'kokoro:bm_daniel', name: 'Kokoro Daniel', gender: 'Male', language: 'English', accent: 'UK', depth: 'Clear', provider: 'Kokoro', tags: ['Local', 'UK', 'Clear'], tier: 'kokoro' },
].map(voice => {
  if (isKokoroVoice(voice.id)) {
    return {
      ...voice,
      kokoroProfile: normalizeKokoroProfile(),
      preferredChunkSize: getKokoroChunkSize(voice.id)
    };
  }
  if (isChatterboxVoice(voice.id)) {
    return {
      ...voice,
      chatterboxProfile: normalizeChatterboxProfile(),
      preferredChunkSize: getChatterboxChunkSize(voice.id)
    };
  }
  return voice;
});

const DEFAULT_EDGE_VOICE = 'en-US-AndrewMultilingualNeural';
const DEFAULT_VOICE = process.env.XANDRIO_DEFAULT_VOICE || DEFAULT_EDGE_VOICE;
const DEFAULT_CHUNK_SIZE = 4000;
const SAMPLE_TEXT = 'The morning sun cast golden light through the library windows, illuminating rows of leather-bound books that lined the walls from floor to ceiling.';
const VOICE_SAMPLES_DIR = path.join(CACHE_DIR, 'voice-samples');
const MAX_BOOK_UPLOAD_SIZE = Number(process.env.MAX_BOOK_UPLOAD_SIZE_BYTES || 250 * 1024 * 1024);
const LARGE_BOOK_WARNING_SIZE = Number(process.env.LARGE_BOOK_WARNING_SIZE_BYTES || 50 * 1024 * 1024);
const XBOOK_DELETE_SOURCE_AFTER_EXTRACT = process.env.XBOOK_DELETE_SOURCE_AFTER_EXTRACT !== 'false';
const XBOOK_VERSION = 1;
const SUPPORTED_BOOK_FORMATS = new Set([
  'epub',
  'mobi',
  'prc',
  'azw',
  'azw3',
  'pdf'
]);
const EBOOK_SEARCH_FORMATS = ['epub', 'mobi', 'azw3'];
const SEARCH_FORMATS = [...EBOOK_SEARCH_FORMATS, 'pdf'];
const standardEbooks = createStandardEbooksProvider();
const opds = createOpdsProvider({
  id: 'opds',
  label: process.env.OPDS_LABEL || 'OPDS',
  feedUrl: process.env.OPDS_FEED_URL,
  username: process.env.OPDS_USER,
  password: process.env.OPDS_PASSWORD,
  requiresAuth: process.env.OPDS_REQUIRE_AUTH === 'true',
  timeoutMs: process.env.OPDS_TIMEOUT_MS,
  downloadTimeoutMs: process.env.OPDS_DOWNLOAD_TIMEOUT_MS
});
const searchProviders = createSearchProviderRegistry({
  annas: {
    search: searchAnnasProvider,
    download: downloadFromAnnasDirect
  },
  zlibrary,
  gutenberg,
  internetArchive,
  opds,
  standardEbooks,
  searchFormats: SEARCH_FORMATS,
  sourceTimeoutMs: Number(process.env.SEARCH_SOURCE_TIMEOUT_MS || 12000),
  sourceTimeoutMsByProvider: { annas: annasSearchTimeoutMs() },
  withTimeout
});
const BOOK_MIME_TYPES = new Map([
  ['application/epub+zip', 'epub'],
  ['application/x-epub', 'epub'],
  ['application/x-epub+zip', 'epub'],
  ['application/x-mobipocket-ebook', 'mobi'],
  ['application/vnd.amazon.ebook', 'azw'],
  ['application/pdf', 'pdf']
]);

const SETTINGS_CACHE_TTL_MS = 250;
let settingsCache = { value: null, expiresAt: 0 };
const FILE_IDENTITY_CACHE_TTL_MS = 250;
const fileIdentityCache = new Map();

function readSettingsSync() {
  const now = Date.now();
  if (settingsCache.value && settingsCache.expiresAt > now) {
    return settingsCache.value;
  }

  try {
    const value = JSON.parse(fsSync.readFileSync(SETTINGS_FILE, 'utf-8'));
    settingsCache = { value, expiresAt: now + SETTINGS_CACHE_TTL_MS };
    return value;
  } catch {
    settingsCache = { value: {}, expiresAt: now + SETTINGS_CACHE_TTL_MS };
    return settingsCache.value;
  }
}

function updateSettingsCache(settings) {
  settingsCache = { value: settings || {}, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
}

async function loadCustomVoiceRegistry() {
  const registry = await loadJSON(CUSTOM_VOICES_FILE, { voices: [] });
  return {
    voices: Array.isArray(registry.voices) ? registry.voices.filter(voice =>
      voice && typeof voice.id === 'string' && typeof voice.name === 'string'
    ) : []
  };
}

function customVoiceEntries(registry) {
  return (registry?.voices || []).map(voice => ({
    id: `chatterbox:${voice.id}`,
    name: voice.name,
    gender: 'Custom',
    language: 'English',
    accent: 'Custom',
    depth: 'Custom',
    provider: 'Chatterbox',
    tags: ['Cloned'],
    tier: 'chatterbox',
    custom: true,
    pairedInstantVoice: voice.pairedInstantVoice || DEFAULT_INSTANT_VOICE,
    createdAt: voice.createdAt
  }));
}

// Progressive premium audio: every premium (Chatterbox) voice pairs with an
// instant Kokoro voice matched for gender/character continuity. Playback
// starts on the instant voice; chapters upgrade to premium in the background.
const DEFAULT_INSTANT_VOICE = process.env.PREMIUM_INSTANT_VOICE || 'kokoro:am_onyx';

function getInstantVoiceFor(voiceId) {
  if (!isChatterboxVoice(voiceId)) return null;
  const entry = AVAILABLE_VOICES.find(v => v.id === voiceId);
  return entry?.pairedInstantVoice || DEFAULT_INSTANT_VOICE;
}

function isPremiumVoiceActive() {
  return isChatterboxVoice(getActiveVoice());
}

function getActiveInstantVoice() {
  return getInstantVoiceFor(getActiveVoice());
}

function isPremiumPrepEnabled() {
  return readSettingsSync().premiumPrepEnabled !== false;
}

async function getAvailableVoices() {
  return [...AVAILABLE_VOICES, ...customVoiceEntries(await loadCustomVoiceRegistry())];
}

function getChatterboxRefVersionSync(voiceId) {
  if (!isChatterboxVoice(voiceId)) return null;
  const localId = String(voiceId).slice('chatterbox:'.length);
  try {
    const registry = JSON.parse(fsSync.readFileSync(CUSTOM_VOICES_FILE, 'utf8'));
    const voices = Array.isArray(registry.voices) ? registry.voices : [];
    return voices.find(voice => voice?.id === localId)?.refVersion || null;
  } catch {
    return null;
  }
}

const narrationRuntime = createNarrationRuntime({
  rootDir: __dirname,
  dataDir: DATA_DIR,
  chatterboxVoiceDir: CHATTERBOX_VOICE_DIR,
  process: {
    rawSpawn: spawn,
    kill: process.kill.bind(process),
    execFileSync
  },
  timers: { setTimeout, clearTimeout },
  healthClient: { fetch, AbortController },
  output: { stdout: process.stdout, stderr: process.stderr }
});

const narrationEngines = createNarrationEngineRegistry({
  defaultChunkSize: DEFAULT_CHUNK_SIZE,
  defaultConcurrency: 2,
  chatterboxRefVersion: getChatterboxRefVersionSync,
  lifecycleBindings: narrationRuntime.lifecycleBindings()
});

async function getFileIdentity(filePath) {
  const now = Date.now();
  const cached = fileIdentityCache.get(filePath);
  if (cached && cached.expiresAt > now) {
    return cached.identity;
  }

  const stat = await fs.stat(filePath);
  const identity = {
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
  fileIdentityCache.set(filePath, {
    identity,
    expiresAt: now + FILE_IDENTITY_CACHE_TTL_MS
  });
  return identity;
}

function invalidateFileIdentity(filePath) {
  if (filePath) fileIdentityCache.delete(filePath);
}

function getTTSVariantKey() {
  return narrationEngines.forVoice(readSettingsSync().voice || DEFAULT_VOICE).variantKey;
}

function getTTSVariantKeyForVoice(voice) {
  return narrationEngines.forVoice(voice || DEFAULT_VOICE).variantKey;
}

function getChunkSizeForVoice(voiceId) {
  return narrationEngines.forVoice(voiceId || DEFAULT_VOICE).chunkSize;
}

function getActiveChunkSize() {
  return getChunkSizeForVoice(readSettingsSync().voice || DEFAULT_VOICE);
}

function getActiveVoice() {
  return readSettingsSync().voice || DEFAULT_VOICE;
}

function getTTSConcurrency() {
  try {
    return narrationEngines.forVoice(getActiveVoice()).concurrency;
  } catch {
    return narrationEngines.forVoice(DEFAULT_VOICE).concurrency;
  }
}

function getChapterGenerationPriority(targetChunk = 0) {
  return (chunkIndex, isFirstPending) => {
    if (chunkIndex === targetChunk) return 'immediate';
    if (chunkIndex === targetChunk + 1) return 'next';
    if (isFirstPending && targetChunk === 0) return 'immediate';
    return 'background';
  };
}

function startProviderServersForVoice(voice) {
  narrationEngines.start(voice);
}

let xbookStore;
const bookDocument = createBookDocument({
  supportedFormats: SUPPORTED_BOOK_FORMATS,
  largeBookWarningSize: LARGE_BOOK_WARNING_SIZE,
  getFileIdentity,
  invalidateFileIdentity,
  getXBookStore: () => xbookStore
});

function getBookFormatFromName(fileName) {
  return bookDocument.getFormatFromName(fileName);
}

function getBookFormat(file) {
  if (!file) return false;
  const fileName = (file.originalname || '').trim().toLowerCase();
  const mimeType = (file.mimetype || '').trim().toLowerCase();
  return getBookFormatFromName(fileName) || BOOK_MIME_TYPES.get(mimeType) || '';
}

function isSupportedBookUpload(file) {
  return !!getBookFormat(file);
}

// The document module routes through this store only when it receives an XBook
// path. The late binding avoids a construction cycle: the store itself uses
// the module to create artifacts from source documents.
xbookStore = createXBookStore({
  cacheDir: CACHE_DIR,
  xbookVersion: XBOOK_VERSION,
  deleteSourceAfterExtract: XBOOK_DELETE_SOURCE_AFTER_EXTRACT,
  getFileIdentity,
  invalidateFileIdentity,
  extractBookMetadata: bookDocument.extractMetadata,
  extractBookChapters: bookDocument.extractChapters,
  extractMobiCover: (sourcePath, _format, outputPath) => bookDocument.extractCover(sourcePath, outputPath),
  getBookFormatFromName
});

const {
  isXBookPath,
  getXBookPath,
  invalidateXBookArtifactCache,
  writeXBookArtifact,
  shouldDiscardSourceAfterExtract
} = xbookStore;

async function removeFileIfExists(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function getFileSize(filePath) {
  const stats = await fs.stat(filePath);
  return stats.size;
}

async function normalizeBookFile(inputPath, originalName, bookId) {
  const inputFormat = getBookFormatFromName(originalName) || getBookFormatFromName(inputPath);
  if (!inputFormat) {
    throw new Error(`Unsupported book format: ${path.extname(originalName || inputPath) || 'unknown'}`);
  }

  const sourceSize = await getFileSize(inputPath);
  const finalPath = path.join(CACHE_DIR, `${bookId}.${inputFormat}`);

  if (path.resolve(inputPath) !== path.resolve(finalPath)) {
    await removeFileIfExists(finalPath);
    await fs.rename(inputPath, finalPath);
  }

  return {
    finalPath,
    filename: path.basename(finalPath),
    originalFormat: inputFormat.toUpperCase(),
    convertedToEpub: false,
    resized: false,
    largeSource: sourceSize > LARGE_BOOK_WARNING_SIZE,
    originalSize: sourceSize,
    finalSize: await getFileSize(finalPath)
  };
}

async function inferGutenbergIdFromBook(bookPath, context = {}) {
  const direct = String(context.gutenbergId || context.hash || '').match(/(?:^pg-|gutenberg\.org\/ebooks\/)(\d+)/i)?.[1];
  if (direct) return direct;

  const metadataText = JSON.stringify(context.metadata || {});
  const metadataMatch = metadataText.match(/(?:gutenberg\.org\/ebooks\/|ebooks\/|pg)(\d{2,})/i);
  if (metadataMatch) return metadataMatch[1];

  if (getBookFormatFromName(bookPath) !== 'epub') return undefined;

  try {
    const { stdout } = await execFileAsync('unzip', ['-Z', '-1', bookPath], { timeout: 5000 });
    const entries = stdout.split(/\r?\n/).filter(Boolean);
    for (const entry of entries) {
      const match = entry.match(/(?:^|\/)(\d{2,})\/(?:content\.opf|toc\.ncx|0\.html|1\.html)$/i);
      if (match) return match[1];
    }
  } catch {}

  try {
    const { stdout } = await execFileAsync('unzip', ['-p', bookPath], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const contentMatch = stdout.match(/gutenberg\.org\/ebooks\/(\d{2,})|Project Gutenberg EBook #?(\d{2,})/i);
    if (contentMatch) return contentMatch[1] || contentMatch[2];
  } catch {}

  return undefined;
}

function isOnlyMissingTocValidation(validation) {
  return validation && !validation.valid &&
    Array.isArray(validation.errors) &&
    validation.errors.length > 0 &&
    validation.errors.every(error => /No table of contents/i.test(error));
}

async function maybeRelaxMissingTocValidation(bookPath, validation, context = {}) {
  if (!isOnlyMissingTocValidation(validation)) return validation;
  const gutenbergId = context.gutenbergId || await inferGutenbergIdFromBook(bookPath, context);
  const publisher = String(context.metadata?.publisher || '').toLowerCase();
  if (!gutenbergId && !publisher.includes('project gutenberg')) return validation;

  try {
    const chapters = await extractBookChapters(bookPath);
    const contentValidation = assessExtractedContent(chapters, {
      format: getBookFormatFromName(bookPath) || 'epub'
    });
    if (!contentValidation.valid) return validation;
    return {
      ...validation,
      valid: true,
      errors: [],
      warnings: [
        ...(validation.warnings || []),
        'Missing EPUB table of contents, but Project Gutenberg content passed chapter validation.'
      ],
      content: contentValidation
    };
  } catch {
    return validation;
  }
}

function validatedLibraryCoverInfo(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  let contentType = null;
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 &&
      buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) {
    contentType = 'image/jpeg';
  } else if (buffer.length >= 33 && buffer.subarray(0, 8).equals(PNG_SIGNATURE) &&
      buffer.subarray(12, 16).equals(Buffer.from('IHDR')) &&
      buffer.subarray(-PNG_IEND_CHUNK.length).equals(PNG_IEND_CHUNK)) {
    contentType = 'image/png';
  }
  if (!contentType) return null;

  try {
    const dimensions = getJpegDimensions(buffer);
    const ratio = dimensions ? dimensions.width / dimensions.height : 0;
    if (!dimensions || dimensions.width < 96 || dimensions.height < 128 || ratio < 0.42 || ratio > 1.12) return null;
    return { contentType, dimensions };
  } catch {
    return null;
  }
}

const DISPLAY_COVER_MIN_WIDTH = 300;
const DISPLAY_COVER_MIN_HEIGHT = 400;

function isDisplayQualityCover(cover) {
  const dimensions = cover?.dimensions;
  return Boolean(dimensions &&
    dimensions.width >= DISPLAY_COVER_MIN_WIDTH &&
    dimensions.height >= DISPLAY_COVER_MIN_HEIGHT);
}

async function readValidatedLibraryCover(coverPath) {
  try {
    const buffer = await fs.readFile(coverPath);
    const info = validatedLibraryCoverInfo(buffer);
    return info ? { ...info, buffer } : null;
  } catch {
    return null;
  }
}

async function ensureBookCover(book, options = {}) {
  const coverPath = options.coverPath || path.join(CACHE_DIR, `${book.id}_cover.jpg`);
  const force = Boolean(options.force);
  if (!force) {
    const existing = await readValidatedLibraryCover(coverPath);
    if (existing) {
      const hasAlternative = Boolean(
        book?.gutenbergId || book?.openLibraryWorkKey ||
        ((book?.sourceFormat || getBookFormatFromName(book?.path || book?.filename) || '').toLowerCase() === 'epub' && book?.path)
      );
      if (isDisplayQualityCover(existing) || !hasAlternative) return coverPath;
    }
    await removeFileIfExists(coverPath);
  }

  const bookFormat = (book.sourceFormat || getBookFormatFromName(book.path || book.filename) || '').toLowerCase();
  const steps = Array.isArray(options.steps)
    ? options.steps
    : coverSourceSteps(book, bookFormat, force);
  let fallback = null;

  for (const step of steps) {
    await removeFileIfExists(coverPath);
    const coverExtracted = await step.fetch(coverPath);
    if (!coverExtracted) continue;
    const candidate = await readValidatedLibraryCover(coverPath);
    if (!candidate) {
      console.warn(`[cover] ${step.label} produced an invalid cover; trying the next source`);
      await removeFileIfExists(coverPath);
      continue;
    }
    if (!isDisplayQualityCover(candidate)) {
      const pixels = candidate.dimensions.width * candidate.dimensions.height;
      if (!fallback || pixels > fallback.pixels) {
        fallback = { buffer: candidate.buffer, source: step.id, pixels };
      }
      console.log(`[cover] ${step.label} is only ${candidate.dimensions.width}x${candidate.dimensions.height}; looking for a sharper source`);
      continue;
    }
    book.coverPath = coverPath;
    book.coverSource = step.id;
    console.log(`[cover] Selected ${step.label} cover for "${book.title}"`);
    return coverPath;
  }

  if (fallback) {
    await fs.writeFile(coverPath, fallback.buffer);
    book.coverPath = coverPath;
    book.coverSource = fallback.source;
    console.log(`[cover] No display-quality cover found; retained best available fallback for "${book.title}"`);
    return coverPath;
  }
  return undefined;
}

function selectedSearchCoverDescriptor(book) {
  const source = book?.downloadSource || book?.sourceProvenance?.provider;
  if (!book?.id || !source || source === 'upload') return null;
  return {
    source,
    hash: book.id,
    title: book.searchedTitle || book.title,
    author: book.searchedAuthor || book.author,
    language: book.language,
    sourcePageUrl: book.sourceProvenance?.sourceUrl,
    gutenbergId: book.gutenbergId,
    iaIdentifier: source === 'internetarchive' ? book.sourceProvenance?.itemId : undefined,
    openLibraryWorkKey: book.openLibraryWorkKey,
    openLibraryEditionKey: book.openLibraryEditionKey,
    isbn: book.isbn
  };
}

async function copySelectedSearchCover(book, outputPath) {
  const descriptor = selectedSearchCoverDescriptor(book);
  if (!descriptor) return false;
  const registered = searchCoverService.register(descriptor);
  return Boolean(registered && await searchCoverService.copyTo(registered.key, outputPath));
}

function coverSourceSteps(book, bookFormat, force = false) {
  const steps = [];
  const hasCatalogIdentity = Boolean(book.gutenbergId || book.openLibraryWorkKey);
  const preferCatalog = force || hasCatalogIdentity;

  const embedded = bookFormat === 'epub' && book.path
    ? { id: 'embedded', label: 'embedded EPUB', fetch: outputPath => extractCover(book.path, outputPath) }
    : null;
  const selectedSearchCover = !force && !hasCatalogIdentity && selectedSearchCoverDescriptor(book)
    ? { id: 'selected-search-result', label: 'selected search result', fetch: outputPath => copySelectedSearchCover(book, outputPath) }
    : null;
  const trustedCatalog = [
    book.gutenbergId
      ? { id: 'gutenberg', label: 'Project Gutenberg', fetch: outputPath => fetchCoverFromGutenbergId(book.gutenbergId, outputPath) }
      : null,
    book.openLibraryWorkKey
      ? { id: 'openlibrary-work', label: 'Open Library work', fetch: outputPath => fetchCoverByOpenLibraryWorkKey(book.openLibraryWorkKey, outputPath) }
      : null
  ].filter(Boolean);
  const genericCatalog = [
    { id: 'openlibrary-search', label: 'Open Library search', fetch: outputPath => fetchCoverFromOpenLibrary(book.title, book.author, outputPath) },
    { id: 'google-books', label: 'Google Books', fetch: outputPath => fetchCoverFromGoogleBooks(book.title, book.author, outputPath) }
  ].filter(Boolean);

  if (selectedSearchCover) steps.push(selectedSearchCover);
  if (!preferCatalog && embedded) steps.push(embedded);
  steps.push(...trustedCatalog);
  if (preferCatalog && embedded) steps.push(embedded);
  steps.push(...genericCatalog);
  return steps;
}

function shouldRefreshCachedCover(book, force = false, cachedCover = null) {
  if (force) return true;
  if (!book) return false;
  const hasCatalogIdentity = Boolean(book.gutenbergId || book.openLibraryWorkKey);
  if (!hasCatalogIdentity) return false;
  const source = String(book.coverSource || '');
  if (!source || source === 'embedded') return true;
  return Boolean(cachedCover && !isDisplayQualityCover(cachedCover));
}

const bookImporter = createBookImporter({
  normalizeBook: ({ sourcePath, originalName, id }) => normalizeBookFile(sourcePath, originalName, id),
  document: {
    validateBook,
    validateExtractedChapters: bookDocument.validateExtractedChapters,
    extractMetadata: bookDocument.extractMetadata,
    extractChapters: bookDocument.extractChapters,
    getChaptersCached: bookDocument.getChaptersCached
  },
  checkChapterQuality,
  relaxValidation: maybeRelaxMissingTocValidation,
  shouldDiscardSourceAfterExtract,
  createArtifact: writeXBookArtifact,
  writeArtifactData: (artifactPath, artifact) => fs.writeFile(artifactPath, JSON.stringify(artifact)),
  assessExtractedContent,
  metadata: {
    resolveSeed: resolveMetadataSeed,
    enrich: enrichBookMetadata,
    trustedTitle: trustedEnrichedTitle,
    isGarbageTitle,
    isGarbageAuthor,
    resolveIdentity: identity => resolveOpenLibraryIdentity(identity, { timeoutMs: 5000 }),
    assessConfidence: input => assessMetadataConfidence({
      ...input,
      openLibrary: openLibraryValidationPayload(input.openLibrary)
    }),
    buildValidation: buildImportValidationReport,
    canonicalWorkKey,
    openLibraryFields: bookRecordOpenLibraryFields,
    cleanDescription: cleanBookDescription,
    normalizeAuthor: normalizeAuthorForDisplay,
    publishedYear: publishedYearFromMetadata
  },
  inferGutenbergId: inferGutenbergIdFromBook,
  ensureBookCover,
  persistBook: async record => {
    let existingBook = null;
    await updateJSON(BOOKS_FILE, books => {
      existingBook = findDuplicateBook(books, record);
      if (existingBook) return jsonStore.SKIP_SAVE;
      books[record.id] = record;
    });
    return { existingBook };
  },
  removeFile: removeFileIfExists,
  afterPersist: (record, bookPath) => {
    if (!PREGENERATE_ON_IMPORT) return;
    console.log(`Pre-generating chapter 1 for ${record.id}`);
    pregenerateChapter1(record.id, bookPath).catch(error => {
      console.error(`Failed to pre-generate chapter 1:`, error);
    });
  }
});

async function probeAudioDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath
    ], { timeout: 10000 });
    const seconds = Number(String(stdout || '').trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

async function recordMeasuredChapterDuration({ bookId, chapterIndex, outputPath }) {
  const seconds = await probeAudioDurationSeconds(outputPath);
  if (!Number.isFinite(seconds) || seconds <= 0) return;

  await updateJSON(BOOKS_FILE, (books) => {
    const book = books[bookId];
    if (!book) return jsonStore.SKIP_SAVE;
    const durations = Array.isArray(book.chapterDurations) ? book.chapterDurations.slice() : [];
    if (Math.abs((Number(durations[chapterIndex]) || 0) - seconds) < 0.25) return jsonStore.SKIP_SAVE;
    durations[chapterIndex] = seconds;
    book.chapterDurations = durations;
    if (Number.isInteger(book.chapterCount) && book.chapterCount > 0) {
      const measured = durations.slice(0, book.chapterCount);
      if (measured.length === book.chapterCount && measured.every(value => Number.isFinite(value) && value > 0)) {
        book.totalDuration = measured.reduce((sum, value) => sum + value, 0);
      }
    }
  });
}

// Initialize TTS queue and chunked TTS system
const generationScheduler = new GenerationScheduler({ capacities: { gpu: 1 } });
const generationJournal = new GenerationJournal(path.join(DATA_DIR, 'generation-state.json'));
const premiumVariantTtsWorkers = new Map();
let pronunciationService = null;
const transformNarrationText = async ({ text, bookId }) => pronunciationService
  ? pronunciationService.apply(text, bookId)
  : text;
async function splitTransformedNarration({ text, bookId, chunkSize, textTransform = transformNarrationText, splitter } = {}) {
  const transformed = await textTransform({ text, bookId });
  return (splitter || chunkedTTS.splitIntoChunks.bind(chunkedTTS))(transformed, chunkSize);
}
async function validateRecordedNarrationVariant({ variantKey, voice }) {
  if (typeof voice !== 'string' || !voice) {
    return { compatible: false, error: 'Recovery record has no voice identity' };
  }
  const voices = await getAvailableVoices();
  return narrationEngines.validateRecordedVariant({
    voice,
    variantKey,
    availableVoiceIds: voices.map(candidate => candidate.id)
  });
}
const ttsQueue = new TTSQueue({
  maxConcurrent: 2,
  maxConcurrentProvider: getTTSConcurrency,
  cacheDir: CACHE_DIR,
  defaultVoice: DEFAULT_VOICE,
  generationScheduler
});
const chunkedTTS = new ChunkedTTS(CACHE_DIR, ttsQueue, {
  variantKeyProvider: getTTSVariantKey,
  outputFormatProvider: () => getTtsOutputFormatForVoice(getActiveVoice()),
  chunkSizeProvider: getActiveChunkSize,
  textTransform: transformNarrationText,
  onChapterConcatenated: recordMeasuredChapterDuration,
  generationJournal,
  validateRecoveryEntry: validateRecordedNarrationVariant
});

// Second instance scoped to the paired instant voice. Shares the queue and
// cache dir; its variant key (and therefore all file names) follow the
// instant voice, so instant and premium audio never collide.
const instantChunkedTTS = new ChunkedTTS(CACHE_DIR, ttsQueue, {
  variantKeyProvider: () => getTTSVariantKeyForVoice(getActiveInstantVoice() || getActiveVoice()),
  outputFormatProvider: () => getTtsOutputFormatForVoice(getActiveInstantVoice() || getActiveVoice()),
  chunkSizeProvider: () => getChunkSizeForVoice(getActiveInstantVoice() || getActiveVoice()),
  textTransform: transformNarrationText,
  onChapterConcatenated: recordMeasuredChapterDuration,
  generationJournal,
  validateRecoveryEntry: validateRecordedNarrationVariant
});

function pronunciationChunkVariants() {
  const variants = [chunkedTTS, instantChunkedTTS].map(tts => ({
    variantSegment: tts.currentVariantSegment(),
    splitIntoChunks: text => tts.splitIntoChunks(text, tts.getActiveChunkSize())
  }));
  return variants.filter((variant, index) => variants.findIndex(candidate => candidate.variantSegment === variant.variantSegment) === index);
}

function quiescePronunciationWorkers(item, workers) {
  return Promise.all([...new Set(workers)].map(tts => tts.quiesceChapterAllVariants(
    item.bookId,
    item.chapterIndex,
    item.fromChunkIndexByVariant,
    0
  )));
}

pronunciationService = createPronunciationService({
  storeFile: PRONUNCIATIONS_FILE,
  jsonStore,
  loadBooks: () => loadJSON(BOOKS_FILE, {}),
  getChapters: (_bookId, book) => getChaptersCached(book.path),
  splitIntoChunks: text => chunkedTTS.splitIntoChunks(text, chunkedTTS.getActiveChunkSize()),
  chunkVariants: pronunciationChunkVariants,
  beforeInvalidate: affected => Promise.all(affected.map(item => quiescePronunciationWorkers(item, [
    chunkedTTS,
    instantChunkedTTS,
    ...premiumVariantTtsWorkers.values()
  ]))),
  invalidateCache: createCacheInvalidator(CACHE_DIR)
});

function ttsForTier(tier) {
  return tier === 'instant' ? instantChunkedTTS : chunkedTTS;
}

function voiceForTier(tier) {
  return tier === 'instant' ? (getActiveInstantVoice() || getActiveVoice()) : getActiveVoice();
}

// A cached manifest with error chunks can only recover through generateChapter
// (it rebuilds from disk and re-enqueues missing chunks); prioritizeChunk
// no-ops on errored chunks, so the hot paths must regenerate in that case.
function manifestNeedsResume(manifest) {
  return Boolean(manifest && chunkedTTS.manifestNeedsResume(manifest));
}


const chapterAudioPrepareJobs = new Map();
const cleanChapterAudioPrepareJobs = new Map();
const importJobs = new Map();
const IMPORT_JOB_TTL_MS = 30 * 60 * 1000;
const IMPORT_STEPS = [
  'Preparing source',
  'Downloading file',
  'Checking file format',
  'Reading book metadata',
  'Validating chapters',
  'Finding cover',
  'Adding to library'
];

function createImportJob() {
  const jobId = crypto.randomBytes(12).toString('hex');
  const job = {
    id: jobId,
    status: 'running',
    step: 1,
    totalSteps: IMPORT_STEPS.length,
    label: IMPORT_STEPS[0],
    detail: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    listeners: new Set(),
    result: null,
    error: null
  };
  importJobs.set(jobId, job);
  setTimeout(() => importJobs.delete(jobId), IMPORT_JOB_TTL_MS).unref?.();
  return job;
}

function importJobSnapshot(job) {
  return {
    jobId: job.id,
    status: job.status,
    step: job.step,
    totalSteps: job.totalSteps,
    label: job.label,
    detail: job.detail,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error
  };
}

function emitImportJob(job, event, payload = {}) {
  job.updatedAt = new Date().toISOString();
  if (payload.step) {
    // Alternative-edition retries re-emit earlier pipeline steps (5 -> 3 -> 5);
    // the job's public step only moves forward so the client checklist never
    // bounces backward. Labels still describe the actual current activity.
    payload = { ...payload, step: Math.max(job.step, payload.step) };
    job.step = payload.step;
  }
  if (payload.label) job.label = payload.label;
  if (payload.detail !== undefined) job.detail = payload.detail;
  const message = { event, data: { ...importJobSnapshot(job), ...payload } };
  job.events.push(message);
  if (job.events.length > 200) job.events.shift();
  for (const listener of job.listeners) listener(message);
}

function progressForImportJob(job) {
  return (step, detail = '') => {
    const label = IMPORT_STEPS[step - 1] || IMPORT_STEPS[0];
    emitImportJob(job, 'progress', { step, label, detail });
  };
}

function writeSseEvent(res, message) {
  res.write(`event: ${message.event}\n`);
  res.write(`data: ${JSON.stringify(message.data)}\n\n`);
}

async function ensureChapterAudioPrepared(bookId, chapterIndex, options = {}) {
  const clean = Boolean(options.clean);
  const priority = options.priority || 'background';
  const tier = options.tier === 'instant' ? 'instant' : 'active';
  const tts = options.tts || ttsForTier(tier);
  const voice = options.voice || voiceForTier(tier);
  const jobs = clean ? cleanChapterAudioPrepareJobs : chapterAudioPrepareJobs;
  const key = `${bookId}:${chapterIndex}:${tts.variantKeyProvider()}`;
  if (jobs.has(key)) return jobs.get(key);

  const job = (async () => {
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];
    if (!book) throw new Error('Book not found');

    const chapters = await getChaptersCached(book.path);
    const chapter = chapters[chapterIndex];
    if (!chapter) throw new Error('Chapter not found');

    const outputPath = clean ? tts.cleanChapterPath(bookId, chapterIndex) : tts.chapterPath(bookId, chapterIndex);
    try {
      await fs.access(outputPath);
      recordMeasuredChapterDuration({ bookId, chapterIndex, outputPath })
        .catch(err => console.warn(`Existing chapter duration probe failed for ${bookId}:${chapterIndex}: ${err.message}`));
      return outputPath;
    } catch {}

    const bookLanguage = book.language || 'en';
    const firstChunkPriority = priority === 'background' ? 'background' : 'immediate';
    let manifest = tts.getChapterManifest(bookId, chapterIndex);
    if (!manifest || manifestNeedsResume(manifest)) {
      manifest = await tts.generateChapter(bookId, chapterIndex, chapter.text, bookLanguage, priority, {
        priorityForChunk: priority === 'background' ? (() => 'background') : getChapterGenerationPriority(0),
        voice
      });
    } else {
      manifest.chunks.forEach((chunk, index) => {
        if (chunk.status !== 'ready') tts.prioritizeChunk(bookId, chapterIndex, index, index === 0 ? firstChunkPriority : 'background');
      });
    }

    const pendingJobs = manifest.chunks
      .filter(chunk => chunk.status !== 'ready' && chunk.jobId)
      .map(chunk => ttsQueue.waitFor(chunk.jobId).catch(() => {}));
    await Promise.all(pendingJobs);

    const refreshed = tts.getChapterManifest(bookId, chapterIndex) || manifest;
    if (!refreshed.chunks.every(chunk => chunk.status === 'ready')) {
      throw new Error('Not all chunks are ready');
    }

    return clean ? tts.concatenateChunksClean(bookId, chapterIndex) : tts.concatenateChunks(bookId, chapterIndex);
  })().finally(() => {
    jobs.delete(key);
  });

  jobs.set(key, job);
  return job;
}

// Feature: warm the NEXT chapter's audio in the background while chapter N
// plays, so auto-advance never stalls. Fire-and-forget — generation is
// coalesced and short-circuited by ensureChapterAudioPrepared (it returns
// immediately when the chapter file is already on disk). A per-(book, next
// chapter, variant, tier) guard stops repeated Range/manifest requests for
// the same chapter from re-triggering the check (each re-trigger would
// otherwise re-run an ffprobe on an already-complete file). The guard entry
// is cleared on failure so a later request can retry (e.g. engine was down).
const nextChapterPrefetchGuard = new Set();
function prefetchNextChapterAudio(bookId, chapterIndex, tier) {
  const resolvedTier = tier === 'instant' ? 'instant' : 'active';
  const nextIndex = Number(chapterIndex) + 1;
  if (!bookId || !Number.isInteger(nextIndex) || nextIndex < 1) return;
  const tts = ttsForTier(resolvedTier);
  let variantKey;
  try { variantKey = tts.variantKeyProvider(); } catch { variantKey = 'default'; }
  const guardKey = `${bookId}:${nextIndex}:${variantKey}:${resolvedTier}`;
  if (nextChapterPrefetchGuard.has(guardKey)) return;
  nextChapterPrefetchGuard.add(guardKey);

  (async () => {
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];
    if (!book) return;
    const chapters = await getChaptersCached(book.path);
    if (nextIndex >= chapters.length) return; // no next chapter to prepare
    await ensureChapterAudioPrepared(bookId, nextIndex, { priority: 'background', tier: resolvedTier });
  })().catch(err => {
    nextChapterPrefetchGuard.delete(guardKey);
    console.warn(`Next-chapter prefetch failed for ${bookId}:${nextIndex}: ${err.message}`);
  });
}

/**
 * Whether the active (premium) variant of a chapter is fully rendered:
 * either the stitched chapter file exists or every expected chunk is on disk.
 */
async function premiumChapterReady(bookId, chapterIndex) {
  try {
    const stat = await fs.stat(chunkedTTS.chapterPath(bookId, chapterIndex));
    if (stat.size > 0) return true;
  } catch {}

  try {
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];
    if (!book) return false;
    const chapters = await getChaptersCached(book.path);
    const chapter = chapters[chapterIndex];
    if (!chapter) return false;
    const expected = (await splitTransformedNarration({
      text: chapter.text,
      bookId,
      chunkSize: chunkedTTS.getActiveChunkSize()
    })).length;
    if (expected === 0) return false;
    const onDisk = await chunkedTTS.getChapterChunks(bookId, chapterIndex);
    return onDisk.length >= expected;
  } catch {
    return false;
  }
}

const PremiumAudioPrep = require('./lib/premium-audio');

async function getPremiumBookInfo(bookId) {
  const books = await loadJSON(BOOKS_FILE, {});
  const book = books[bookId];
  if (!book) throw new Error('Book not found');
  const chapters = await getChaptersCached(book.path);
  return { chapterCount: chapters.length };
}

function premiumVoiceFromVariantKey(variantKey) {
  const match = String(variantKey || '').match(/^(chatterbox:[^:]+)/);
  if (!match) throw new Error('Premium recovery record has an unsupported variant identity');
  return match[1];
}

function premiumChunkSizeFromVariantKey(variantKey) {
  const match = String(variantKey || '').match(/:chunk(\d+):/);
  const value = Number(match?.[1]);
  return Number.isFinite(value) && value > 0 ? value : getChunkSizeForVoice(premiumVoiceFromVariantKey(variantKey));
}

function createPremiumVariantWorker(variantKey) {
  const voice = premiumVoiceFromVariantKey(variantKey);
  const fixedTts = new ChunkedTTS(CACHE_DIR, ttsQueue, {
    variantKeyProvider: () => variantKey,
    chunkSize: premiumChunkSizeFromVariantKey(variantKey),
    textTransform: transformNarrationText,
    onChapterConcatenated: recordMeasuredChapterDuration,
    generationJournal,
    validateRecoveryEntry: validateRecordedNarrationVariant
  });
  premiumVariantTtsWorkers.set(variantKey, fixedTts);
  return {
    getBookInfo: getPremiumBookInfo,
    prepareChapter: (bookId, chapterIndex) => {
      narrationEngines.start(voice);
      return ensureChapterAudioPrepared(bookId, chapterIndex, {
        priority: 'background',
        tts: fixedTts,
        voice
      });
    },
    chapterReady: async (bookId, chapterIndex) => {
      try {
        const stat = await fs.stat(fixedTts.chapterPath(bookId, chapterIndex));
        return stat.size > 0;
      } catch {
        return false;
      }
    },
    isEngineUp: () => narrationEngines.health(voice),
    startEngine: () => narrationEngines.start(voice)
  };
}

const premiumPrep = new PremiumAudioPrep({
  isEnabled: isPremiumPrepEnabled,
  isPremiumActive: isPremiumVoiceActive,
  variantKey: getTTSVariantKey,
  getBookInfo: getPremiumBookInfo,
  prepareChapter: (bookId, chapterIndex) => {
    narrationEngines.start(getActiveVoice());
    return ensureChapterAudioPrepared(bookId, chapterIndex, { priority: 'background', tier: 'active' });
  },
  chapterReady: premiumChapterReady,
  generationScheduler,
  stateStore: generationJournal,
  isEngineUp: () => narrationEngines.health(getActiveVoice()),
  startEngine: () => narrationEngines.start(getActiveVoice()),
  createVariantWorker: createPremiumVariantWorker,
  validateRecoveryRecord: async record => {
    const voice = premiumVoiceFromVariantKey(record.variantKey);
    return validateRecordedNarrationVariant({ variantKey: record.variantKey, voice });
  }
});

// Auto-resume: when Chatterbox comes back after an outage, re-drive
// generateChapter for every chapter whose cached manifest holds error
// chunks. The hot paths already self-heal when a client is polling
// (manifestNeedsResume); this watcher covers the no-client case — the
// desktop player stops polling after the first error, or the tab closed
// mid-generation. Idle cost is a Map walk; the health probe only runs
// while error work exists, and resume fires only on a down→up transition
// so a non-connectivity failure (e.g. truncated audio) isn't re-swept
// every tick.
const ENGINE_RESUME_POLL_MS = 15000;
// Start pessimistic: the first tick that finds error work while the engine
// is up counts as a recovery, so an outage that ends between ticks (or a
// pre-existing error at startup) still gets one resume sweep.
let lastChatterboxUp = false;

async function resumeChapterErrors(tts, tier, bookId, chapterIndex) {
  const books = await loadJSON(BOOKS_FILE, {});
  const book = books[bookId];
  if (!book || deletedBookIds.has(bookId)) return;
  const chapters = await getChaptersCached(book.path);
  const chapter = chapters[chapterIndex];
  if (!chapter) return;
  await tts.generateChapter(bookId, chapterIndex, chapter.text, book.language || 'en', 'background', {
    priorityForChunk: () => 'background',
    voice: voiceForTier(tier)
  });
}

async function engineResumeTick() {
  const errorWork = [
    ...chunkedTTS.listChaptersWithErrors().map(entry => ({ ...entry, tts: chunkedTTS, tier: 'active' })),
    ...instantChunkedTTS.listChaptersWithErrors().map(entry => ({ ...entry, tts: instantChunkedTTS, tier: 'instant' }))
  ];
  if (errorWork.length === 0) return;

  const recoveryVoice = isChatterboxVoice(getActiveVoice()) ? getActiveVoice() : 'chatterbox:brick-scott';
  narrationEngines.start(recoveryVoice);
  const up = await narrationEngines.health(recoveryVoice);
  const cameBack = up && !lastChatterboxUp;
  lastChatterboxUp = up;
  if (!cameBack) return;

  console.log(`Chatterbox back up — resuming ${errorWork.length} chapter(s) with failed chunks`);
  for (const { tts, tier, bookId, chapterIndex } of errorWork) {
    try {
      await resumeChapterErrors(tts, tier, bookId, chapterIndex);
    } catch (err) {
      console.warn(`Auto-resume failed for ${bookId}:${chapterIndex}: ${err.message}`);
    }
  }
}

setInterval(() => {
  engineResumeTick().catch(err => console.warn(`Engine resume tick failed: ${err.message}`));
}, ENGINE_RESUME_POLL_MS).unref();

/**
 * Kick (or reposition) background premium prep for a book from the current
 * listening position. No-op unless a premium voice is active and the
 * "Prepare premium audio in background" setting is on.
 */
function kickPremiumPrep(bookId, fromChapter) {
  try {
    if (deletedBookIds.has(bookId)) return;
    premiumPrep.ensureBookPrep(bookId, fromChapter);
  } catch (err) {
    console.warn(`Premium prep kick failed for ${bookId}:`, err.message);
  }
}

const playbackOrchestrator = createPlaybackOrchestrator({
  isPremiumVoiceActive,
  premiumChapterReady,
  kickPremiumPrep,
  startProviderForVoice: startProviderServersForVoice,
  activeInstantVoice: getActiveInstantVoice,
  ttsForTier,
  voiceForTier,
  manifestNeedsResume,
  generationPriority: getChapterGenerationPriority,
  waitForJob: jobId => ttsQueue.waitFor(jobId),
  ensureChapterAudio: ensureChapterAudioPrepared,
  inspectChapterAudio,
  prefetchNextChapter: prefetchNextChapterAudio,
  warmRemainingChapters: ({ bookId, chapters, startChapterIndex, language, tier, voice }) => {
    setTimeout(() => {
      const tts = ttsForTier(tier);
      for (let index = startChapterIndex; index < chapters.length; index++) {
        if (deletedBookIds.has(bookId)) return;
        if (tts.getChapterManifest(bookId, index)) continue;
        tts.generateChapter(bookId, index, chapters[index].text, language, 'background', {
          priorityForChunk: () => 'background',
          voice
        }).catch(error => console.error(`Background voice warmup failed for chapter ${index}:`, error));
      }
    }, 0);
  },
  getChapterContext: async (bookId, chapterIndex) => {
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];
    if (!book) {
      const error = new Error('Book not found');
      error.statusCode = 404;
      throw error;
    }
    const chapters = await getChaptersCached(book.path);
    const chapter = chapters[chapterIndex];
    if (!chapter) {
      const error = new Error('Chapter not found');
      error.statusCode = 404;
      throw error;
    }
    return { book, chapter, chapters };
  },
  onBackgroundError: (error, context) => console.error(`Look-ahead generation failed for chapter ${context.chapterIndex}:`, error)
});

async function inspectChapterAudio(bookId, chapterIndex, options = {}) {
  const clean = Boolean(options.clean);
  const tier = options.tier === 'instant' ? 'instant' : 'active';
  const tts = ttsForTier(tier);
  const outputPath = clean ? tts.cleanChapterPath(bookId, chapterIndex) : tts.chapterPath(bookId, chapterIndex);
  let ready = false;
  let size = 0;
  try {
    const stat = await fs.stat(outputPath);
    ready = stat.size > 0;
    size = stat.size;
  } catch {}

  const manifest = tts.getChapterManifest(bookId, chapterIndex);
  const totalChunks = manifest ? manifest.totalChunks : 0;
  const readyChunks = manifest ? manifest.chunks.filter(chunk => chunk.status === 'ready').length : 0;
  const errorChunks = manifest ? manifest.chunks.filter(chunk => chunk.status === 'error').length : 0;
  const preparing = (clean ? cleanChapterAudioPrepareJobs : chapterAudioPrepareJobs).has(`${bookId}:${chapterIndex}:${tts.variantKeyProvider()}`);

  const status = {
    ready,
    preparing,
    bookId,
    chapterIndex,
    totalChunks,
    readyChunks,
    errorChunks,
    size,
    clean,
    tier,
    variantKey: tts.variantKeyProvider(),
    url: ready ? (clean ? `/api/audio-ios/${encodeURIComponent(bookId)}/${chapterIndex}` : `/api/audio/${encodeURIComponent(bookId)}/${chapterIndex}`) : null
  };

  return status;
}

// Book Document owns chapter-cache versioning, in-flight deduplication, and
// XBook text repairs. These thin names preserve existing server callers.
async function getChaptersCached(bookPath) {
  return bookDocument.getChaptersCached(bookPath);
}

function invalidateChapterCache(bookPath) {
  bookDocument.invalidateChapterCache(bookPath);
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    cb(null, CACHE_DIR);
  },
  filename: (req, file, cb) => {
    // Generate a unique filename using hash
    const hash = crypto.createHash('md5').update(file.originalname + Date.now()).digest('hex');
    const ext = path.extname(file.originalname) || `.${getBookFormat(file)}`;
    cb(null, `upload_${hash}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (isSupportedBookUpload(file)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported book format'), false);
    }
  },
  limits: {
    fileSize: MAX_BOOK_UPLOAD_SIZE
  }
});

function bookUploadErrorResponse(err) {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return {
      error: 'File too large',
      details: `Maximum upload size is ${Math.floor(MAX_BOOK_UPLOAD_SIZE / 1024 / 1024)}MB`
    };
  }
  return {
    error: err?.message === 'Unsupported book format' ? 'Unsupported book format' : 'Upload failed',
    details: `Supported formats: ${Array.from(SUPPORTED_BOOK_FORMATS).map(f => f.toUpperCase()).join(', ')}.`
  };
}

function uploadRouteErrorResponse(err) {
  if (err?.statusCode === 400 && err?.existingBookId) {
    return {
      error: 'Book already exists in library',
      existingBookId: String(err.existingBookId)
    };
  }
  if (err?.code === 'LIMIT_FILE_SIZE') return bookUploadErrorResponse(err);
  if (err?.code === 'PDF_OCR_REQUIRED') {
    return { error: 'PDF requires OCR', details: 'Enable PDF OCR and retry this scanned or image-only document.' };
  }
  if (err?.code === 'PDF_TEXT_LOW_QUALITY') {
    return { error: 'PDF text quality is too low', details: 'Try a text-based PDF or an EPUB edition.' };
  }
  if (err?.code === 'KINDLE_DRM_PROTECTED') {
    return { error: 'Kindle file is DRM-protected', details: 'Import a DRM-free EPUB, MOBI, AZW, or AZW3 file.' };
  }
  if (err?.code === 'KINDLE_EXTRACTION_FAILED') {
    return { error: 'Kindle file could not be read', details: 'Try another DRM-free edition or EPUB format.' };
  }
  return { error: 'Upload could not be processed' };
}

function uploadSingleEpub(req, res, next) {
  upload.single('epub')(req, res, (err) => {
    if (!err) {
      next();
      return;
    }

    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json(bookUploadErrorResponse(err));
      return;
    }

    const unsupported = err.message === 'Unsupported book format';
    if (!unsupported) console.error('Book upload middleware failed:', err);
    res.status(400).json(bookUploadErrorResponse(err));
  });
}

// Ensure directories exist
async function ensureDirectories() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
}

// Load/save JSON files — atomic writes, serialized per file (lib/json-store).
// Mutations should go through updateJSON so the read-modify-write cycle
// holds the file's lock; loadJSON/saveJSON remain for reads and
// whole-value replacement.
async function loadJSON(filePath, defaultValue = {}) {
  return jsonStore.load(filePath, defaultValue);
}

async function saveJSON(filePath, data) {
  await jsonStore.save(filePath, data);
}

const updateJSON = jsonStore.update;
const downloadImportGate = new ConcurrencyGate(CONCURRENCY_LIMITS.download, { name: 'download' });

function isSafeBookId(value) {
  return requestGuardIsSafeBookId(value);
}

function sanitizeFileStem(value, fallback = 'book') {
  const stem = String(value || fallback)
    .replace(/\.[^.]+$/i, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return stem || fallback;
}

function sanitizeDownloadFilename(filename, fallbackStem = 'book') {
  const base = path.basename(String(filename || ''));
  const ext = getBookFormatFromName(base);
  if (!ext) {
    throw new Error(`Unsupported book format: ${path.extname(base) || 'unknown'}`);
  }
  return `${sanitizeFileStem(base, sanitizeFileStem(fallbackStem))}.${ext}`;
}


// API: Search books on Anna's Archive. The shared endpoint rate limiter above
// bounds this route because it may fan out to remote services or Chromium.

app.get('/api/search/sources', (req, res) => {
  const operatorPolicy = operatorPolicyStatus(readSettingsSync());
  res.json({
    sources: decorateSourceDescriptors(searchProviders.describe(), operatorPolicy),
    operatorPolicy
  });
});

app.get('/api/search-cover/:key', async (req, res) => {
  try {
    const cover = await searchCoverService.resolve(req.params.key, { retry: req.query.retry === '1' });
    if (!cover) {
      res.set({
        'Cache-Control': 'private, no-store',
        'Retry-After': '3'
      });
      return res.status(404).end();
    }
    res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    res.type(cover.contentType);
    res.send(cover.buffer);
  } catch (err) {
    console.warn('[search-cover] Failed to resolve cover:', err.message);
    res.set({
      'Cache-Control': 'private, no-store',
      'Retry-After': '3'
    });
    res.status(503).end();
  }
});

function resultWithSearchCover(result) {
  if (!result) return result;
  const registered = searchCoverService.register(result);
  return {
    ...result,
    coverUrl: registered?.url,
    otherEditions: Array.isArray(result.otherEditions)
      ? result.otherEditions.map(resultWithSearchCover)
      : result.otherEditions
  };
}

app.post('/api/search', async (req, res) => {
  try {
    const { query, language, sources } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'Query required' });
    }
    if (sources !== undefined && !Array.isArray(sources)) {
      return res.status(400).json({ error: 'sources must be an array' });
    }
    const availableSourceIds = new Set(searchProviders.providers().map(provider => provider.id));
    const requestedSources = sources === undefined
      ? [...availableSourceIds]
      : [...new Set(sources.filter(source => typeof source === 'string' && availableSourceIds.has(source)))];
    if (requestedSources.length === 0) {
      return res.status(400).json({ error: 'Choose at least one search source' });
    }
    const operatorPolicy = operatorPolicyStatus(readSettingsSync());
    const blockedSources = blockedSourceIds(requestedSources, operatorPolicy);
    if (sources !== undefined && blockedSources.length > 0) {
      return res.status(409).json({
        error: 'Acknowledge and enable unverified sources for this instance before using them.',
        code: 'SOURCE_ACKNOWLEDGEMENT_REQUIRED',
        blockedSources,
        operatorPolicy
      });
    }
    const selectedSources = requestedSources.filter(source => !blockedSources.includes(source));
    if (selectedSources.length === 0) {
      return res.status(409).json({
        error: 'No enabled search sources are available on this instance.',
        code: 'NO_ENABLED_SOURCES',
        operatorPolicy
      });
    }

    // Ensure cache dir exists before search
    await fs.access(CACHE_DIR).catch(() => fs.mkdir(CACHE_DIR, { recursive: true }));

    const searchContext = { language, sources: selectedSources };
    const providerSearch = await searchCatalogQuery({
      query,
      context: searchContext,
      search: (searchQuery, context) => searchProviders.searchAll(searchQuery, context),
      resolveCorrection: input => resolveSearchQueryCorrection(input, { timeoutMs: 4000 })
    });
    console.log(`Search results — ${Object.values(providerSearch.sourceStatus)
      .map(status => `${status.label}: ${status.count}`)
      .join(', ')}`);

    return res.json(await buildCatalogSearchResponse({
      query: providerSearch.effectiveQuery,
      requestedQuery: query,
      searchCorrection: providerSearch.searchCorrection,
      results: providerSearch.results,
      language,
      sourceStatus: providerSearch.sourceStatus,
      projectEdition: resultWithSearchCover,
      resolveOpenLibraryIdentity: input => resolveOpenLibraryIdentity(input, { timeoutMs: 4000 })
    }));
  } catch (err) {
    console.error('Search error:', err);
    sendServerError(res, err, "Search failed");
  }
});

const ZLIBRARY_DOWNLOAD_ERROR_RESPONSES = Object.freeze({
  ZLIB_NOT_CONFIGURED: [409, 'Connect Z-Library before downloading.', 'Open Settings and connect Z-Library, then try again.'],
  ZLIB_AUTH_INVALID: [401, 'The Z-Library credentials were rejected.', 'Reconnect Z-Library in Settings.'],
  ZLIB_AUTH_EXPIRED: [401, 'Your Z-Library session expired. Reconnect to continue.', 'Reconnect Z-Library in Settings.'],
  ZLIB_TIMEOUT: [504, 'Z-Library did not respond in time.', 'Try again shortly.'],
  ZLIB_UNAVAILABLE: [503, 'Z-Library is temporarily unavailable.', 'Try again shortly.'],
  ZLIB_RATE_LIMITED: [429, 'Z-Library is rate limited. Try again shortly.', 'Try again shortly.'],
  ZLIB_DAILY_LIMIT: [429, 'Z-Library daily download limit reached.', "Try another source, or wait until Z-Library's daily limit resets."],
  ZLIB_PROTOCOL: [502, 'Z-Library returned an unexpected response.', 'Try another version.'],
  ZLIB_DOWNLOAD_INVALID: [502, 'Z-Library returned an invalid download.', 'Try another version.']
});

function zlibraryDownloadErrorResponse(error) {
  const response = ZLIBRARY_DOWNLOAD_ERROR_RESPONSES[error?.code];
  if (!response) return null;
  const [statusCode, message, suggestion] = response;
  const body = { error: message, code: error.code, suggestion };
  if (error.code === 'ZLIB_DAILY_LIMIT' && error.details) {
    if (Number.isFinite(error.details.downloadsToday)) body.downloadsToday = error.details.downloadsToday;
    if (Number.isFinite(error.details.dailyLimit)) body.dailyLimit = error.details.dailyLimit;
  }
  return { statusCode, body };
}

function zlibraryDownloadPreflightResponse(status) {
  if (status?.state === 'connected') {
    if (Number.isFinite(status.downloadsRemaining) && status.downloadsRemaining <= 0) {
      return zlibraryDownloadErrorResponse({
        code: 'ZLIB_DAILY_LIMIT',
        details: { downloadsToday: status.downloadsToday, dailyLimit: status.dailyLimit }
      });
    }
    return null;
  }
  const code = status?.state === 'disconnected'
    ? 'ZLIB_NOT_CONFIGURED'
    : status?.state === 'auth-expired'
      ? 'ZLIB_AUTH_EXPIRED'
      : ZLIBRARY_DOWNLOAD_ERROR_RESPONSES[status?.errorCode]
        ? status.errorCode
        : 'ZLIB_UNAVAILABLE';
  return zlibraryDownloadErrorResponse({ code });
}

async function acquireDownloadSource(input, destination, progress, {
  download = searchProviders.download.bind(searchProviders)
} = {}) {
  const { hash, source, zlibId, gutenbergId, iaIdentifier, iaFile, downloadUrl } = input;
  progress(1, `Source: ${source || 'annas'}`);
  if (source === 'zlibrary' && zlibId) {
    progress(2, 'Downloading from Z-Library');
    try {
      await download({ source, zlibId, hash }, destination);
      return destination;
    } catch (error) {
      const response = zlibraryDownloadErrorResponse(error);
      if (response) {
        throw new BookImportError(response.body.error, {
          statusCode: response.statusCode,
          response: response.body
        });
      }
      throw error;
    }
  }
  if (source === 'gutenberg' && gutenbergId && downloadUrl) {
    progress(2, 'Downloading from Project Gutenberg');
    await download({ source, gutenbergId, downloadUrl, hash }, destination);
    return destination;
  }
  if (source === 'internetarchive' && (downloadUrl || (iaIdentifier && iaFile))) {
    progress(2, 'Downloading from Internet Archive');
    await download({ source, iaIdentifier, iaFile, downloadUrl, hash }, destination);
    return destination;
  }
  if (source === 'standardebooks' && downloadUrl) {
    progress(2, 'Downloading from Standard Ebooks');
    await download({ source, downloadUrl, hash }, destination);
    return destination;
  }

  try {
    progress(2, 'Downloading from Anna\'s Archive');
    await download({ source: 'annas', hash }, destination);
    return destination;
  } catch {
    console.error('Anna\'s Archive download unavailable');
    throw new Error('Download service unavailable');
  }
}

function downloadImportCommand(body, { download = searchProviders.download.bind(searchProviders) } = {}) {
  const { hash, filename, title, author, language, alternatives, source, gutenbergId, description, filePath } = body || {};
  if (!hash || !filename) {
    throw new BookImportError('Hash and filename required', {
      response: { error: 'Hash and filename required' }
    });
  }
  if (!isSafeBookId(hash)) {
    throw new BookImportError('Invalid book identifier', { response: { error: 'Invalid book identifier' } });
  }
  const safeFilename = sanitizeDownloadFilename(filename, title || hash);
  const selected = { title, author, language };
  const expected = {
    title,
    author,
    language,
    publisher: body?.publisher,
    isbn: body?.isbn,
    openLibraryWorkKey: body?.openLibraryWorkKey,
    metadataConfidence: body?.metadataConfidence
  };
  const alternativeCandidates = (Array.isArray(alternatives) ? alternatives : []).map((alternative, index) => {
    const format = SUPPORTED_BOOK_FORMATS.has(String(alternative.format || '').toLowerCase())
      ? String(alternative.format).toLowerCase()
      : 'epub';
    const alternativeFilename = sanitizeDownloadFilename(
      `${sanitizeFileStem(alternative.title || title || 'book')}_alt${index}.${format}`,
      alternative.hash || 'book'
    );
    return {
      id: alternative.hash,
      originalName: alternativeFilename,
      selected: {
        title: alternative.title || title,
        author: alternative.author || author,
        language: alternative.language || language
      },
      source: alternative.source || 'annas',
      sourceFilePath: alternative.filePath,
      sourceProvenance: sourceProvenanceFromSelection(alternative),
      gutenbergId: alternative.gutenbergId,
      shouldTry: selectedIdentity => Boolean(
        alternative.hash && alternative.format && isSafeBookId(alternative.hash) &&
        SUPPORTED_BOOK_FORMATS.has(String(alternative.format).toLowerCase()) &&
        isAcceptableFallbackMatch(alternative, expected, selectedIdentity)
      ),
      acquire: async progress => {
        const alternativePath = path.join(CACHE_DIR, alternativeFilename);
        try {
          await download(alternative, alternativePath);
          return alternativePath;
        } catch (error) {
          await removeFileIfExists(alternativePath).catch(cleanupError => {
            console.error(`Failed to clean up alternative download ${alternativePath}: ${cleanupError.message}`);
          });
          throw error;
        }
      }
    };
  });
  return {
    kind: 'download',
    id: hash,
    originalName: safeFilename,
    selected,
    description,
    downloadSource: source || 'annas',
    sourceFilePath: filePath,
    sourceProvenance: sourceProvenanceFromSelection(body),
    gutenbergId,
    alternatives: alternativeCandidates,
    acquire: progress => acquireDownloadSource(body, path.join(CACHE_DIR, safeFilename), progress)
  };
}

async function importDownloadedBook(body, progress, { addedBy = null } = {}) {
  const command = downloadImportCommand(body);
  if (addedBy) command.addedBy = addedBy;
  deletedBookIds.delete(command.id);
  const result = await bookImporter.import(command, progress);
  if (addedBy && result?.bookId) await addBookToShelf(addedBy, result.bookId);
  return result;
}

// Imports land on the importer's personal shelf automatically.
async function addBookToShelf(userId, bookId) {
  try {
    await updateJSON(SHELVES_FILE, (data) => {
      shelves.addToShelf(data, userId, bookId);
    });
  } catch (err) {
    console.warn(`Failed to add ${bookId} to ${userId}'s shelf:`, err);
  }
}

function downloadImportFailureResponse(error, body) {
  if (error instanceof BookImportError && error.response) {
    if (error.response.retryAlternatives) {
      return {
        ...error.response,
        retryAlternatives: (Array.isArray(body?.alternatives) ? body.alternatives : []).slice(0, 6)
      };
    }
    return error.response;
  }
  const raw = String(error?.message || '');
  const safeExpected = /^(?:Book already exists|Duplicate book|Unsupported book format|Book validation failed|No acceptable|Download service unavailable|Source requires configuration)/i.test(raw)
    ? raw.slice(0, 240)
    : 'Import failed while preparing this version';
  return {
    error: safeExpected,
    suggestion: 'Try a different version from the search results.',
    retryAlternatives: (Array.isArray(body?.alternatives) ? body.alternatives : []).slice(0, 6)
  };
}

// API: Download book
async function handleDownloadRequest(req, res) {
  const progress = req.importProgress || (() => {});
  try {
    const result = await importDownloadedBook(req.body, progress, { addedBy: positionUserId(req) });
    return res.json({
      success: true,
      bookId: result.bookId,
      book: publicBookRecord(result.book),
      usedAlternative: result.usedAlternative,
      validation: result.validation
    });
  } catch (error) {
    const response = downloadImportFailureResponse(error, req.body);
    const statusCode = error instanceof BookImportError && error.response ? error.statusCode : 500;
    return res.status(statusCode).json(response);
  }
}
app.post('/api/download', async (req, res) => {
  const operatorPolicy = operatorPolicyStatus(readSettingsSync());
  const blockedSources = blockedSourceIds([req.body?.source || 'annas'], operatorPolicy);
  if (blockedSources.length > 0) {
    return res.status(409).json({
      error: 'Acknowledge and enable unverified sources for this instance before using them.',
      code: 'SOURCE_ACKNOWLEDGEMENT_REQUIRED',
      blockedSources,
      operatorPolicy
    });
  }
  req.body = {
    ...(req.body || {}),
    alternatives: filterEnabledAlternatives(req.body?.alternatives, operatorPolicy)
  };
  if (req.body?.source === 'zlibrary') {
    try {
      const preflightError = zlibraryDownloadPreflightResponse(await zlibrary.getStatus());
      if (preflightError) return res.status(preflightError.statusCode).json(preflightError.body);
    } catch (error) {
      const publicError = zlibraryDownloadErrorResponse(error) || zlibraryDownloadErrorResponse({ code: 'ZLIB_UNAVAILABLE' });
      return res.status(publicError.statusCode).json(publicError.body);
    }
  }
  const releaseImportPermit = downloadImportGate.tryAcquire();
  if (!releaseImportPermit) {
    res.setHeader('Retry-After', '1');
    return res.status(503).json({
      error: 'Book imports are busy. Try again shortly.',
      code: 'CONCURRENCY_LIMIT'
    });
  }
  const job = createImportJob();
  const progress = progressForImportJob(job);
  progress(1, 'Queued import');

  const importUserId = positionUserId(req);
  setImmediate(async () => {
    try {
      const result = await importDownloadedBook(req.body, progress, { addedBy: importUserId });
      const payload = {
        success: true,
        bookId: result.bookId,
        book: publicBookRecord(result.book),
        usedAlternative: result.usedAlternative,
        validation: result.validation
      };
      job.status = 'complete';
      job.result = payload;
      emitImportJob(job, 'complete', { result: payload });
    } catch (error) {
      console.error(`Background import job ${job.id} failed:`, error);
      job.status = 'failed';
      job.error = downloadImportFailureResponse(error, req.body);
      emitImportJob(job, 'failed', { error: job.error });
    } finally {
      releaseImportPermit();
    }
  });

  res.status(202).json({ jobId: job.id });
});

app.get('/api/download/:jobId/status', (req, res) => {
  const job = importJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  res.json(importJobSnapshot(job));
});

app.get('/api/download/:jobId/events', (req, res) => {
  const job = importJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  for (const event of job.events) writeSseEvent(res, event);
  writeSseEvent(res, { event: 'snapshot', data: importJobSnapshot(job) });

  const listener = message => writeSseEvent(res, message);
  job.listeners.add(listener);
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    job.listeners.delete(listener);
  });
});

async function handleUploadImport(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const originalName = req.file.originalname;
  const bookId = crypto.createHash('md5')
    .update(originalName + Date.now())
    .digest('hex');
  const uploadUserId = positionUserId(req);
  try {
    const result = await bookImporter.import({
      kind: 'upload',
      id: bookId,
      originalName,
      sourcePath: req.file.path,
      selected: { language: 'en' },
      downloadSource: 'upload',
      addedBy: uploadUserId
    });
    if (result?.bookId) await addBookToShelf(uploadUserId, result.bookId);
    return res.json({
      success: true,
      bookId: result.bookId,
      book: publicBookRecord(result.book),
      validation: result.validation
    });
  } catch (error) {
    console.error('Upload error:', error);
    await removeFileIfExists(req.file.path).catch(() => {});
    if (error instanceof BookImportError && error.response) {
      return res.status(error.statusCode).json(error.response);
    }
    if (error.statusCode === 400 || error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json(uploadRouteErrorResponse(error));
    }
    return sendServerError(res, error, 'Upload failed');
  }
}

// API: Upload book file
// API: Upload book file
app.post('/api/upload', uploadSingleEpub, handleUploadImport);
// API: Get library (all downloaded books)
// Strip server-internal fields (absolute paths, import forensics) from
// book records before they leave the API.
function publicBookRecord(book) {
  if (!book || typeof book !== 'object') return book;
  const { path: _path, coverPath, extractedArtifact, sourceHash, importValidation, ...pub } = book;
  pub.hasCover = Boolean(coverPath);
  return pub;
}

function canonicalBookCoverPath(bookId) {
  return path.join(CACHE_DIR, `${bookId}_cover.jpg`);
}

async function publicBookRecordWithCoverArtifact(book, access = fs.access) {
  const pub = publicBookRecord(book);
  if (!pub || pub.hasCover || !isSafeBookId(book?.id)) return pub;
  try {
    await access(canonicalBookCoverPath(book.id));
    pub.hasCover = true;
  } catch {}
  return pub;
}

async function persistCanonicalCoverPath(bookId, coverPath, coverSource = null) {
  await updateJSON(BOOKS_FILE, (books) => {
    const current = books[bookId];
    if (!current) return jsonStore.SKIP_SAVE;
    if (current.coverPath === coverPath && (!coverSource || current.coverSource === coverSource)) return jsonStore.SKIP_SAVE;
    books[bookId] = { ...current, coverPath, ...(coverSource ? { coverSource } : {}) };
  });
}

// Liveness endpoint for uptime monitors (UptimeRobot etc.). Deliberately
// cheap: no disk reads, no engine probes. GETs are auth-exempt.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

app.get('/api/library', async (req, res) => {
  try {
    const userId = positionUserId(req);
    const [books, shelvesStore] = await Promise.all([
      loadJSON(BOOKS_FILE, {}),
      loadJSON(SHELVES_FILE, {})
    ]);
    const shelf = new Set(shelves.shelfForUser(shelvesStore, userId));
    res.json({
      userId,
      shelf: [...shelf].filter(bookId => books[bookId]),
      books: await Promise.all(Object.values(books).map(book => publicBookRecordWithCoverArtifact(book)))
    });
  } catch (err) {
    sendServerError(res, err, "Failed to load library");
  }
});

app.post('/api/shelf/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) return res.status(400).json({ error: 'Invalid book identifier' });
    const books = await loadJSON(BOOKS_FILE, {});
    if (!books[bookId]) return res.status(404).json({ error: 'Book not found' });
    const userId = positionUserId(req);
    await updateJSON(SHELVES_FILE, (data) => {
      shelves.addToShelf(data, userId, bookId);
    });
    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err, "Failed to update shelf");
  }
});

app.delete('/api/shelf/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) return res.status(400).json({ error: 'Invalid book identifier' });
    const userId = positionUserId(req);
    const removed = await updateJSON(SHELVES_FILE, (data) => {
      const found = shelves.removeFromShelf(data, userId, bookId);
      return found || jsonStore.SKIP_SAVE;
    });
    if (removed === jsonStore.SKIP_SAVE) return res.status(404).json({ error: 'Book is not on your shelf' });
    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err, "Failed to update shelf");
  }
});

// API: Delete book
app.delete('/api/book/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    let forbidden = false;
    const deletion = await updateJSON(BOOKS_FILE, async (books) => {
      const book = books[bookId];
      if (!book) return jsonStore.SKIP_SAVE;

      // Members may delete only books they added; shared books (no addedBy)
      // and other users' books are admin-only deletions.
      if (req.user?.role === 'member' && book.addedBy !== req.user.id) {
        forbidden = true;
        return jsonStore.SKIP_SAVE;
      }

      rememberDeletedBookId(bookId);

      const cancelledJobs = chunkedTTS.cancelBook(bookId) + instantChunkedTTS.cancelBook(bookId);
      premiumPrep.stopBook(bookId);
      const artifactCleanup = await cleanupBookArtifacts(bookId, book);
      scheduleDeletedBookArtifactSweeps(bookId, book);
      if (artifactCleanup.failed.length > 0) {
        console.warn(`Book deletion left ${artifactCleanup.failed.length} artifact(s):`, artifactCleanup.failed);
      }

      delete books[bookId];
      return { cancelledJobs, artifactCleanup };
    });

    if (forbidden) {
      return res.status(403).json({ error: 'Only the book owner or an admin can delete this book' });
    }
    if (deletion === jsonStore.SKIP_SAVE) {
      return res.status(404).json({ error: 'Book not found' });
    }
    const { cancelledJobs, artifactCleanup } = deletion;

    // Remove saved positions for this book across all sync users.
    await updateJSON(POSITIONS_FILE, (positions) => {
      removeBookPositions(positions, bookId);
    });
    // Remove saved bookmarks for this book across all sync users.
    await updateJSON(BOOKMARKS_FILE, (bookmarks) => {
      removeBookBookmarks(bookmarks, bookId);
    });
    // Remove the book from every user's shelf.
    await updateJSON(SHELVES_FILE, (data) => {
      shelves.removeBookFromAllShelves(data, bookId);
    });
    res.json({
      success: true,
      message: 'Book deleted successfully',
      deletedArtifacts: artifactCleanup.deleted.length,
      failedArtifacts: artifactCleanup.failed,
      cancelledJobs
    });
  } catch (err) {
    console.error('Delete book error:', err);
    sendServerError(res, err, "Failed to delete book");
  }
});

// API: Refresh metadata for a book
app.post('/api/refresh-metadata/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];
    
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    // Extract fresh metadata from the stored book file
    if (isXBookPath(book.path)) {
      invalidateXBookArtifactCache(book.path);
    }
    const metadata = await extractBookMetadata(book.path);
    
    // Clean and enrich
    const metadataSeed = resolveMetadataSeed(
      metadata,
      book.title,
      book.author,
      book.originalFilename || book.uploadedFile || book.filename
    );
    const cleanTitle = metadataSeed.title;
    const cleanAuthor = metadataSeed.author;
    const enrichedMetadata = await enrichBookMetadata(cleanTitle, cleanAuthor);
    const enrichedTitle = trustedEnrichedTitle(enrichedMetadata.title, cleanTitle, metadataSeed);
    const openLibraryIdentity = await resolveOpenLibraryIdentity({
      title: cleanTitle,
      author: cleanAuthor,
      language: metadata.language || book.language,
      isbn: metadata.isbn
    }, { timeoutMs: 5000 });
    
    const epubTitleIsGarbage = isGarbageTitle(metadata.title) || metadataSeed.embeddedLooksWrong;
    const epubAuthorIsGarbage = isGarbageAuthor(metadata.author);
    const refreshedChapters = await getChaptersCached(book.path);

    // Refreshed fields (prefer Open Library when EPUB data is garbage) —
    // applied under the library lock so a concurrent writer isn't clobbered.
    const refreshedAuthorCandidate = epubAuthorIsGarbage
      ? (enrichedMetadata.author || cleanAuthor || book.author)
      : (metadata.author || enrichedMetadata.author || book.author);
    const refreshedStructureKey = chapterStructureKey(refreshedChapters);
    const structureIntroduced = Boolean(refreshedStructureKey) && !book.chapterStructureKey;
    const structureChanged = Boolean(refreshedStructureKey && book.chapterStructureKey) &&
      refreshedStructureKey !== book.chapterStructureKey;
    const refreshedFields = {
      title: epubTitleIsGarbage
        ? (enrichedTitle || cleanTitle || book.title)
        : (metadata.title || enrichedTitle || book.title),
      author: normalizeAuthorForDisplay(refreshedAuthorCandidate),
      publisher: metadata.publisher || enrichedMetadata.publisher,
      publishedDate: publishedYearFromMetadata(metadata.date, enrichedMetadata.publishedDate),
      description: cleanBookDescription(metadata.description || enrichedMetadata.description),
      subjects: enrichedMetadata.subjects || [],
      language: metadata.language || book.language || 'en',
      chapterCount: refreshedChapters.length,
      chapterStructureKey: refreshedStructureKey || book.chapterStructureKey,
      // A refresh may repair chapter ordering/types. Any preload indices from
      // the previous structure are no longer trustworthy.
      chapter1Ready: false,
      preloadedThrough: null,
      ...bookRecordOpenLibraryFields(openLibraryIdentity),
      metadataRefreshed: new Date().toISOString()
    };
    refreshedFields.workKey = canonicalWorkKey(refreshedFields.title, refreshedFields.author) || book.workKey;

    const updatedBook = await updateJSON(BOOKS_FILE, (books) => {
      const current = books[bookId];
      if (!current) return jsonStore.SKIP_SAVE;
      books[bookId] = { ...current, ...refreshedFields };
      return books[bookId];
    });

    if (updatedBook === jsonStore.SKIP_SAVE) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const titleChanged = updatedBook.title !== book.title || updatedBook.author !== book.author;
    if (titleChanged) {
      await removeFileIfExists(path.join(CACHE_DIR, `${bookId}_cover.jpg`));
    }
    if (structureChanged) {
      await updateJSON(POSITIONS_FILE, positions => removeBookPositions(positions, bookId));
    } else if (structureIntroduced) {
      await updateJSON(POSITIONS_FILE, positions =>
        setBookPositionsStructureKey(positions, bookId, refreshedStructureKey));
    }

    res.json({ success: true, book: publicBookRecord(updatedBook) });
  } catch (err) {
    console.error('Metadata refresh error:', err);
    sendServerError(res, err, "Failed to refresh metadata");
  }
});

// API: Get book details and chapters
app.get('/api/book/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];
    
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    // Extract chapters from the stored book/artifact (cached)
    const chapters = await getChaptersCached(book.path);
    const displayChapters = chapters.map(ch => ({
      ...ch,
      rawTitle: ch.rawTitle || ch.title,
      title: normalizeChapterTitleForDisplay(ch.title || `Chapter ${ch.index + 1}`)
    }));

    // Backfill totalDuration/chapterCount if missing
    if (book.totalDuration === undefined || book.chapterCount === undefined) {
      if (book.totalDuration === undefined) {
        book.totalDuration = chapters.reduce((sum, ch) => sum + (ch.estimatedDuration || 0), 0);
      }
      if (book.chapterCount === undefined) {
        book.chapterCount = chapters.length;
      }
      const totalDuration = book.totalDuration;
      const chapterCount = book.chapterCount;
      updateJSON(BOOKS_FILE, (books) => {
        const current = books[bookId];
        if (!current) return jsonStore.SKIP_SAVE;
        let updated = false;
        if (current.totalDuration === undefined) {
          current.totalDuration = totalDuration;
          updated = true;
        }
        if (current.chapterCount === undefined) {
          current.chapterCount = chapterCount;
          updated = true;
        }
        if (!updated) return jsonStore.SKIP_SAVE;
      }).catch(err => console.warn(`book metadata backfill failed for ${bookId}: ${err.message}`));
    }

    // Check if cover exists
    const publicBook = await publicBookRecordWithCoverArtifact(book);
    res.json({ book: publicBook, chapters: displayChapters, hasCover: publicBook.hasCover });
  } catch (err) {
    console.error('Book details error:', err);
    sendServerError(res, err, "Failed to load book");
  }
});

// API: Get book cover image
app.get('/api/cover/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];
    
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const coverPath = canonicalBookCoverPath(bookId);
    const force = req.query.force === '1'; // ?force=1 to re-fetch
    const cachedCover = await readValidatedLibraryCover(coverPath);
    const refreshCachedCover = shouldRefreshCachedCover(book, force, cachedCover);
    
    // Check if cover already cached and meets quality standards
    if (!refreshCachedCover) {
      if (cachedCover) {
        await persistCanonicalCoverPath(bookId, coverPath);
        return res.type(cachedCover.contentType).send(cachedCover.buffer);
      }
      // A stale `.jpg` extension is not proof that the bytes are an image.
      // Delete invalid/truncated data before resolution so it cannot be served
      // or short-circuit a fallback source.
      await removeFileIfExists(coverPath);
    } else if (cachedCover) {
      await removeFileIfExists(coverPath);
    }

    console.log(`[cover] Fetching cover for: "${book.title}" by ${book.author}`);
    const fetchedCoverPath = await ensureBookCover(book, { coverPath, force });
    
    if (fetchedCoverPath) {
      const fetchedCover = await readValidatedLibraryCover(fetchedCoverPath);
      if (!fetchedCover) {
        await removeFileIfExists(fetchedCoverPath);
        return res.status(404).json({ error: 'No cover found' });
      }
      console.log(`[cover] Final cover: ${fetchedCover.dimensions.width}x${fetchedCover.dimensions.height} for "${book.title}"`);
      await persistCanonicalCoverPath(bookId, coverPath, book.coverSource);
      return res.type(fetchedCover.contentType).send(fetchedCover.buffer);
    } else {
      res.status(404).json({ error: 'No cover found' });
    }
  } catch (err) {
    console.error('Cover extraction error:', err);
    sendServerError(res, err, "Failed to load cover");
  }
});

// API: Test chunked audio generation (legacy endpoint, updated for new chunked system)
app.get('/api/audio-chunked/:bookId/:chapterIndex', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }
    const startTime = Date.now();
    const response = await playbackOrchestrator.prepareFirstChunk({
      bookId,
      chapterIndex,
      requestedTier: req.query.tier
    });
    res.json({ ...response, generationTime: Date.now() - startTime });
    
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    console.error('Chunked audio generation error:', err);
    sendServerError(res, err, "Failed to load audio");
  }
});

// API: Serve audio chunks
app.get('/api/serve-chunk/:filename', (req, res) => {
  const redirect = playbackOrchestrator.legacyChunkRedirect(req.params.filename);
  if (!redirect) {
    return res.status(403).json({ error: 'Invalid chunk filename' });
  }
  res.redirect(307, redirect);
});

// API: Get audio for chapter (backward-compatible, now uses chunked generation as backend)
app.get('/api/audio/:bookId/:chapterIndex', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }
    const { path: preparedPath, servedTier } = await playbackOrchestrator.prepareChapterAudio({
      bookId,
      chapterIndex,
      requestedTier: req.query.tier,
      priority: 'immediate'
    });
    if (servedTier) res.set('X-Served-Tier', servedTier);
    return await serveAudioFile(req, res, preparedPath);
  } catch (err) {
    if (err.message === 'Book not found' || err.message === 'Chapter not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Audio generation error:', err);
    sendServerError(res, err, "Failed to load audio");
  }
});


// API: Get clean iOS chapter audio.
app.get('/api/audio-ios/:bookId/:chapterIndex', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }

    const { path: preparedPath, servedTier } = await playbackOrchestrator.prepareChapterAudio({
      bookId,
      chapterIndex,
      requestedTier: req.query.tier,
      clean: true,
      priority: 'immediate'
    });
    if (servedTier) res.set('X-Served-Tier', servedTier);
    return await serveAudioFile(req, res, preparedPath);
  } catch (err) {
    console.error('iOS audio generation error:', err);
    sendServerError(res, err, "Failed to load audio");
  }
});

// =========================================================================
// Chunk API endpoints (new chunked TTS system)
// =========================================================================

// API: Get chapter chunk manifest (triggers generation if needed)
app.get('/api/chunks/:bookId/:chapterIndex/manifest', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }
    const response = await playbackOrchestrator.preparePlayback({
      bookId,
      chapterIndex,
      requestedTier: req.query.tier,
      targetChunk: 0
    });
    res.json(response);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    console.error('Chunk manifest error:', err);
    sendServerError(res, err, "Failed to load chunk manifest");
  }
});


// API: Get status for reliable single-file chapter audio.
app.get('/api/chunks/:bookId/:chapterIndex/chapter-audio-status', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }
    res.json(await playbackOrchestrator.chapterAudioStatus({
      bookId,
      chapterIndex,
      requestedTier: req.query.tier,
      clean: req.query.clean === '1'
    }));
  } catch (err) {
    console.error('Chapter audio status error:', err);
    sendServerError(res, err, "Failed to get chapter audio status");
  }
});

// API: Prepare reliable single-file chapter audio in the background.
app.post('/api/chunks/:bookId/:chapterIndex/prepare-chapter-audio', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }

    const clean = req.query.clean === '1' || req.body?.clean === true;
    const status = await playbackOrchestrator.startChapterAudio({
      bookId,
      chapterIndex,
      requestedTier: req.query.tier || req.body?.tier,
      clean
    });
    res.status(202).json(status);
  } catch (err) {
    console.error('Chapter audio prepare error:', err);
    sendServerError(res, err, "Failed to prepare chapter audio");
  }
});

// API: Prepare the current chapter after a voice change without forcing a full chapter regen first.
app.post('/api/chunks/:bookId/:chapterIndex/prepare', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    const requestedTargetChunk = Math.max(0, parseInt(req.body?.targetChunk ?? 0) || 0);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }
    res.json(await playbackOrchestrator.prepareCurrentChapter({
      bookId,
      chapterIndex,
      requestedTier: req.query.tier || req.body?.tier,
      targetChunk: requestedTargetChunk
    }));
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    console.error('Chunk prepare error:', err);
    sendServerError(res, err, "Failed to prepare chunks");
  }
});

// Explicit user retry: automatic startup recovery respects quarantine, while
// this action clears it for the currently requested playback tier and starts
// a fresh generation attempt.
app.post('/api/chunks/:bookId/:chapterIndex/retry', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }
    const resolution = await playbackOrchestrator.resolveTier(bookId, chapterIndex, req.query.tier || req.body?.tier);
    const tts = ttsForTier(resolution.tier);
    const variantKey = String(tts.variantKeyProvider() || 'default');
    await generationJournal.clearChapterQuarantine(bookId, chapterIndex, variantKey);
    const prepared = await playbackOrchestrator.prepareCurrentChapter({
      bookId,
      chapterIndex,
      requestedTier: req.query.tier || req.body?.tier,
      targetChunk: Math.max(0, parseInt(req.body?.targetChunk ?? 0) || 0)
    });
    res.json({ retried: true, ...prepared });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    console.error('Chunk retry error:', err);
    sendServerError(res, err, 'Failed to retry chapter narration');
  }
});

app.get('/api/voice-cache/:bookId/:chapterIndex', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];

    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const chapters = await getChaptersCached(book.path);
    const chapter = chapters[chapterIndex];

    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' });
    }

    const voices = await getAvailableVoices();
    const narrationText = await transformNarrationText({ text: chapter.text, bookId });
    const summaries = await Promise.all(voices.map(async voice => {
      const chunkSize = getChunkSizeForVoice(voice.id);
      const chunkTexts = chunkedTTS.splitIntoChunks(narrationText, chunkSize);
      const variantKey = getTTSVariantKeyForVoice(voice.id);
      let readyChunks = 0;

      await Promise.all(chunkTexts.map(async (_text, index) => {
        const chunkPath = chunkedTTS.chunkPathForVariant(
          bookId,
          chapterIndex,
          index,
          variantKey,
          getTtsOutputFormatForVoice(voice.id)
        );
        try {
          await fs.access(chunkPath);
          readyChunks++;
        } catch {}
      }));

      return {
        voiceId: voice.id,
        totalChunks: chunkTexts.length,
        readyChunks,
        status: readyChunks === 0 ? 'uncached' : (readyChunks === chunkTexts.length ? 'ready' : 'partial')
      };
    }));

    res.json({ bookId, chapterIndex, voices: summaries });
  } catch (err) {
    console.error('Voice cache status error:', err);
    sendServerError(res, err, "Failed to read voice cache status");
  }
});

// API: Get chunk generation status for a chapter
app.get('/api/chunks/:bookId/:chapterIndex/status', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }

    const status = await playbackOrchestrator.chunkStatus({
      bookId,
      chapterIndex,
      requestedTier: req.query.tier
    });
    const resolution = await playbackOrchestrator.resolveTier(bookId, chapterIndex, req.query.tier);
    const variantKey = String(ttsForTier(resolution.tier).variantKeyProvider() || 'default');
    const quarantined = (await generationJournal.listQuarantinedChapters()).find(entry =>
      entry.bookId === bookId && entry.chapterIndex === chapterIndex && entry.variantKey === variantKey
    );
    res.json({
      ...status,
      recovery: quarantined ? {
        quarantined: true,
        attempts: quarantined.attempts || 0,
        message: 'Generation paused after repeated failures. Use retry after correcting the voice or engine.'
      } : { quarantined: false }
    });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    console.error('Chunk status error:', err);
    sendServerError(res, err, "Failed to get chunk status");
  }
});

// --- Progressive premium audio: book-level background prep -----------------

// Status for the book prep panel and chapter-sheet readiness dots.
app.get('/api/premium-prep/:bookId/status', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];
    if (!book) return res.status(404).json({ error: 'Book not found' });

    const enabled = isPremiumPrepEnabled();
    const premiumActive = isPremiumVoiceActive();
    if (!premiumActive) {
      return res.json({ enabled, premiumActive, status: 'idle' });
    }

    const chapters = await getChaptersCached(book.path);
    // Chapter-file existence only: cheap stats, and the prep pipeline always
    // concatenates, so this is the authoritative "fully premium" signal.
    const readiness = await Promise.all(chapters.map(async (_, index) => {
      try {
        const stat = await fs.stat(chunkedTTS.chapterPath(bookId, index));
        return stat.size > 0;
      } catch {
        return false;
      }
    }));
    const readyChapters = readiness.filter(Boolean).length;

    const state = premiumPrep.getState(bookId);
    let status = state && state.variantKey === getTTSVariantKey() ? state.status : 'idle';
    if (readyChapters === chapters.length) status = 'ready';

    res.json({
      enabled,
      premiumActive,
      instantVoice: getActiveInstantVoice(),
      status,
      readyChapters,
      totalChapters: chapters.length,
      currentChapter: state?.currentChapter ?? null,
      error: state?.error || null,
      chapters: readiness
    });
  } catch (err) {
    console.error('Premium prep status error:', err);
    sendServerError(res, err, "Failed to get premium prep status");
  }
});

// Start, reposition, or retry book prep (also the panel's Retry action).
app.post('/api/premium-prep/:bookId/start', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    if (!isPremiumVoiceActive()) {
      return res.status(409).json({ error: 'Active voice has no premium tier' });
    }
    const fromChapter = parseNonNegativeInteger(String(req.body?.fromChapter ?? 0)) ?? 0;
    const retry = Boolean(req.body?.retry);
    const state = retry
      ? premiumPrep.retry(bookId, fromChapter)
      : premiumPrep.ensureBookPrep(bookId, fromChapter);
    res.json({ started: Boolean(state), status: state?.status || 'idle' });
  } catch (err) {
    console.error('Premium prep start error:', err);
    sendServerError(res, err, "Failed to start premium prep");
  }
});

app.get('/api/premium-prep/settings', (req, res) => {
  res.json({ enabled: isPremiumPrepEnabled() });
});

// Single settings toggle: "Prepare premium audio in background" (default on).
app.post('/api/premium-prep/settings', async (req, res) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const settings = await updateJSON(SETTINGS_FILE, current => {
      current.premiumPrepEnabled = enabled;
      return current;
    });
    updateSettingsCache(settings);
    res.json({ enabled });
  } catch (err) {
    console.error('Premium prep settings error:', err);
    sendServerError(res, err, "Failed to save premium prep settings");
  }
});

// API: Prioritize a queued chunk, usually after seeking into an uncached voice variant
app.post('/api/chunks/:bookId/:chapterIndex/:chunkIndex/prioritize', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    const chunkIndex = parseNonNegativeInteger(req.params.chunkIndex);

    if (!isSafeBookId(bookId) || chapterIndex === null || chunkIndex === null) {
      return res.status(400).json({ error: 'Invalid chunk' });
    }

    const result = await playbackOrchestrator.prioritizeChunk({
      bookId,
      chapterIndex,
      chunkIndex,
      requestedTier: req.query.tier
    });
    if (!result) {
      return res.status(404).json({ error: 'Chunk not found' });
    }
    res.json(result);
  } catch (err) {
    console.error('Chunk prioritize error:', err);
    sendServerError(res, err, "Failed to prioritize chunk");
  }
});

// API: Serve individual playback audio chunk
app.get('/api/chunks/:bookId/:chapterIndex/:chunkIndex', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    const chunkIndex = parseNonNegativeInteger(req.params.chunkIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null || chunkIndex === null) {
      return res.status(400).json({ error: 'Invalid chunk' });
    }

    const access = await playbackOrchestrator.chunkAccess({
      bookId,
      chapterIndex,
      chunkIndex,
      requestedTier: req.query.tier
    });
    const chunkFilePath = access.path;
    if (access.servedTier) res.set('X-Served-Tier', access.servedTier);

    // Check if chunk file exists on disk
    try {
      await fs.access(chunkFilePath);
    } catch {
      // File not on disk — check manifest for status
      if (access.status !== 'missing') {
        if (access.status === 'queued' || access.status === 'generating') {
          return res.status(202).json({ status: 'generating' });
        }
        if (access.status === 'error') {
          return res.status(500).json({ status: 'error', error: 'Chunk generation failed' });
        }
      }
      return res.status(404).json({ error: 'Chunk not found' });
    }

    // Serve the chunk with range request support
    const stat = await fs.stat(chunkFilePath);
    const fileSize = stat.size;

    // Guard against 0-byte files (failed TTS generation)
    if (fileSize === 0) {
      // Delete the corrupt file so it can be regenerated
      try { await fs.unlink(chunkFilePath); } catch {}
      return res.status(202).json({ status: 'generating', error: 'Chunk was empty, queued for regeneration' });
    }

    await serveAudioFile(req, res, chunkFilePath);
  } catch (err) {
    console.error('Chunk serve error:', err);
    sendServerError(res, err, "Failed to load chunk");
  }
});

// API: Get TTS queue status
app.get('/api/queue/status', (req, res) => {
  res.json(ttsQueue.getQueueStatus());
});

// =========================================================================

// API: Save/load playback position
const userLibraryState = createUserLibraryState({ crypto });
const {
  DEFAULT_USER_ID,
  PAIRING_CODE_TTL_MS,
  sanitizeSyncId,
  userIdFromRequest: positionUserId,
  deviceIdFromRequest: syncDeviceId,
  syncDisplayName,
  newUserId,
  normalizeUsersStore,
  upsertDevice,
  publicProfile: publicSyncProfile,
  normalizePositionsStore,
  removeBookPositions,
  setBookPositionsStructureKey,
  migratePositions,
  positionForBook,
  positionsForUser,
  positionsForBooks,
  normalizePairingCode,
  hashPairingCode,
  createPairingCode,
  recordPosition
} = userLibraryState;

app.get('/api/sync/profile', async (req, res) => {
  try {
    const userId = positionUserId(req);
    const deviceId = syncDeviceId(req);
    let user = null;
    await updateJSON(USERS_FILE, (data) => {
      const users = normalizeUsersStore(data);
      user = users.users[userId] || null;
      if (!user) return jsonStore.SKIP_SAVE;
      upsertDevice(user, deviceId, req.headers['x-xandrio-device-name']);
    });
    res.json({ userId, deviceId, profile: publicSyncProfile(user, deviceId) });
  } catch (err) {
    sendServerError(res, err, "Failed to load profile");
  }
});

app.post('/api/sync/profile', async (req, res) => {
  try {
    const now = new Date().toISOString();
    // Account sessions always operate on their own profile; only trusted-LAN
    // and legacy shared-token callers may still self-assert a profile id.
    const requestedUserId = sanitizeSyncId(req.body?.userId, '');
    const userId = req.user?.id
      || (requestedUserId && requestedUserId !== DEFAULT_USER_ID ? requestedUserId : newUserId());
    const deviceId = syncDeviceId(req);
    const deviceName = req.body?.deviceName || req.headers['x-xandrio-device-name'];
    const profileName = syncDisplayName(req.body?.name, 'My Library', 80);
    const user = await updateJSON(USERS_FILE, (data) => {
      const users = normalizeUsersStore(data);
      const record = users.users[userId] || {
        id: userId,
        name: profileName,
        createdAt: now,
        devices: {}
      };
      record.name = profileName;
      upsertDevice(record, deviceId, deviceName);
      users.users[userId] = record;
      return record;
    });

    let migrateFromUserId = sanitizeSyncId(req.body?.migrateFromUserId, '');
    // Account sessions may only absorb the shared legacy "default" data;
    // merging from another account would expose that user's positions.
    if (req.user?.id && migrateFromUserId !== DEFAULT_USER_ID) migrateFromUserId = '';
    if (migrateFromUserId && migrateFromUserId !== userId) {
      await updateJSON(POSITIONS_FILE, (data) => {
        migratePositions(data, migrateFromUserId, userId);
      });
    }

    res.json({ success: true, userId, deviceId, profile: publicSyncProfile(user, deviceId) });
  } catch (err) {
    sendServerError(res, err, "Failed to save profile");
  }
});

app.post('/api/sync/device', async (req, res) => {
  try {
    const userId = positionUserId(req);
    const deviceId = syncDeviceId(req);
    const user = await updateJSON(USERS_FILE, (data) => {
      const users = normalizeUsersStore(data);
      const now = new Date().toISOString();
      const record = users.users[userId] || {
        id: userId,
        name: syncDisplayName(req.body?.profileName, 'My Library', 80),
        createdAt: now,
        devices: {}
      };
      upsertDevice(record, deviceId, req.body?.deviceName || req.headers['x-xandrio-device-name']);
      users.users[userId] = record;
      return record;
    });
    res.json({ success: true, userId, deviceId, profile: publicSyncProfile(user, deviceId) });
  } catch (err) {
    sendServerError(res, err, "Failed to register device");
  }
});

app.post('/api/position', async (req, res) => {
  try {
    const { bookId, chapterIndex, timestamp, chunkIndex, chunkTime, chapterStructureKey: suppliedStructureKey, playbackRate, wasPlaying, updatedAt, allowBackward, finished } = req.body;
    const parsedChapterIndex = parseNonNegativeInteger(chapterIndex);
    const parsedTimestamp = Number(timestamp);
    const parsedChunkIndex = chunkIndex === undefined ? null : parseNonNegativeInteger(chunkIndex);
    const parsedChunkTime = chunkTime === undefined ? null : Number(chunkTime);
    if (!isSafeBookId(bookId) || parsedChapterIndex === null || !Number.isFinite(parsedTimestamp) || parsedTimestamp < 0) {
      return res.status(400).json({ error: 'Invalid playback position' });
    }
    if (chunkIndex !== undefined && parsedChunkIndex === null) {
      return res.status(400).json({ error: 'Invalid playback chunk' });
    }
    if (chunkTime !== undefined && (!Number.isFinite(parsedChunkTime) || parsedChunkTime < 0)) {
      return res.status(400).json({ error: 'Invalid playback chunk time' });
    }

    const userId = positionUserId(req);
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];
    if (!book) return res.status(404).json({ error: 'Book not found' });
    if (!positionMatchesChapterStructure({ chapterStructureKey: suppliedStructureKey }, book)) {
      const existing = positionForBook(await loadJSON(POSITIONS_FILE, {}), userId, bookId);
      return res.json({
        success: true,
        ignored: true,
        reason: 'chapter-structure-changed',
        position: positionMatchesChapterStructure(existing, book) ? existing : null
      });
    }
    let outcome;
    await updateJSON(POSITIONS_FILE, (data) => {
      outcome = recordPosition(data, {
        userId,
        bookId,
        chapterIndex: parsedChapterIndex,
        timestamp: parsedTimestamp,
        chunkIndex: parsedChunkIndex ?? undefined,
        chunkTime: parsedChunkTime ?? undefined,
        chapterStructureKey: book.chapterStructureKey || undefined,
        playbackRate,
        wasPlaying,
        finished,
        allowBackward,
        updatedAtMs: updatedAt
      });
      return outcome.ignored ? jsonStore.SKIP_SAVE : undefined;
    });
    res.json(outcome);
  } catch (err) {
    sendServerError(res, err, "Failed to save position");
  }
});

app.get('/api/position/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const userId = positionUserId(req);
    const [positions, books] = await Promise.all([
      loadJSON(POSITIONS_FILE, {}),
      loadJSON(BOOKS_FILE, {})
    ]);
    const position = positionForBook(positions, userId, bookId);
    res.json({ position: positionMatchesChapterStructure(position, books[bookId]) ? position : null });
  } catch (err) {
    sendServerError(res, err, "Failed to load position");
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const userId = positionUserId(req);
    const [positions, books] = await Promise.all([loadJSON(POSITIONS_FILE, {}), loadJSON(BOOKS_FILE, {})]);
    const currentPositions = Object.fromEntries(Object.entries(positionsForUser(positions, userId))
      .filter(([bookId, position]) => positionMatchesChapterStructure(position, books[bookId])));
    res.json({ userId, positions: currentPositions });
  } catch (err) {
    sendServerError(res, err, "Failed to load positions");
  }
});

// Listening-history / stats surface. Auth-exempt like other GETs. Aggregates
// the current sync user's per-book positions against book metadata into
// hours-listened, finished/in-progress counts, and a recently-listened rail.
app.get('/api/stats', async (req, res) => {
  try {
    const userId = positionUserId(req);
    const books = await loadJSON(BOOKS_FILE, {});
    const storedPositions = positionsForUser(await loadJSON(POSITIONS_FILE, {}), userId);
    const currentPositions = Object.fromEntries(Object.entries(storedPositions)
      .filter(([bookId, position]) => positionMatchesChapterStructure(position, books[bookId])));
    const stats = computeListeningStats(books, currentPositions, { recentLimit: 5 });
    res.json({ userId, stats });
  } catch (err) {
    sendServerError(res, err, "Failed to load stats");
  }
});

app.post('/api/positions/batch', async (req, res) => {
  try {
    const bookIds = Array.isArray(req.body?.bookIds) ? req.body.bookIds : [];
    if (bookIds.length > 500) {
      return res.status(400).json({ error: 'Too many book identifiers' });
    }
    const safeIds = [];
    for (const bookId of bookIds) {
      if (!isSafeBookId(bookId)) {
        return res.status(400).json({ error: 'Invalid book identifier' });
      }
      safeIds.push(bookId);
    }
    const userId = positionUserId(req);
    const [storedPositions, books] = await Promise.all([loadJSON(POSITIONS_FILE, {}), loadJSON(BOOKS_FILE, {})]);
    const positions = positionsForBooks(storedPositions, userId, safeIds);
    for (const bookId of safeIds) {
      if (!positionMatchesChapterStructure(positions[bookId], books[bookId])) positions[bookId] = null;
    }
    res.json({ userId, positions });
  } catch (err) {
    sendServerError(res, err, "Failed to load positions");
  }
});

async function extractBookChapters(bookPath) {
  return bookDocument.extractChapters(bookPath);
}

async function extractBookMetadata(bookPath) {
  return bookDocument.extractMetadata(bookPath);
}

// Helper: Pre-generate first content chapter for instant playback (uses chunked system)
async function pregenerateChapter1(bookId, bookPath) {
  try {
    // Parse chapters (also warms the disk cache)
    const chapters = await getChaptersCached(bookPath);
    if (chapters.length === 0) return;
    
    // Most listeners skip epigraphs, author notes, introductions, and other
    // frontmatter. Prefer explicit Chapter 1 variants before generic content.
    const targetIndex = findPreferredAudioStartChapterIndex(chapters);
    
    // Pre-generate: the target chapter + one more after it (for seamless next-chapter)
    const endIndex = Math.min(targetIndex + 1, chapters.length - 1);
    
    console.log(`[pre-gen] Pre-generating chapters ${targetIndex}-${endIndex} for "${chapters[targetIndex].title}" (skipping ${targetIndex} preceding sections)`);
    
    const books = await loadJSON(BOOKS_FILE, {});
    const bookLanguage = books[bookId]?.language || 'en';
    if (!books[bookId] || deletedBookIds.has(bookId)) return;
    
    // Use chunked TTS to pre-generate target chapters
    for (let i = targetIndex; i <= endIndex; i++) {
      if (deletedBookIds.has(bookId)) return;
      const chapter = chapters[i];
      if (chapter.text.length === 0) {
        console.log(`  Skipping chapter ${i}: "${chapter.title}" (empty)`);
        continue;
      }
      console.log(`  Queueing chapter ${i}: "${chapter.title}" (${chapter.text.length} chars)`);
      await chunkedTTS.generateChapter(bookId, i, chapter.text, bookLanguage, 'immediate', {
        voice: getActiveVoice()
      });
    }
    
    // Update book status
    if (!deletedBookIds.has(bookId)) {
      await updateJSON(BOOKS_FILE, (current) => {
        const record = current[bookId];
        if (!record || deletedBookIds.has(bookId)) return jsonStore.SKIP_SAVE;
        record.chapter1Ready = true;
        record.preloadedThrough = endIndex;
      });
    }
    
    console.log(`[pre-gen] Queued through chapter ${endIndex} ("${chapters[endIndex].title}")`);
  } catch (err) {
    console.error(`[pre-gen] Failed for ${bookId}:`, err);
  }
}

// Helper: Get appropriate voice for language
function getVoiceForLanguage(language, overrideVoice) {
  const voices = {
    'en': { voice: 'en-US-AndrewMultilingualNeural', lang: 'en-US' },
    'de': { voice: 'de-DE-FlorianMultilingualNeural', lang: 'de-DE' },
    'es': { voice: 'es-ES-AlvaroNeural', lang: 'es-ES' },
    'fr': { voice: 'fr-FR-RemyMultilingualNeural', lang: 'fr-FR' },
    'it': { voice: 'it-IT-GiuseppeMultilingualNeural', lang: 'it-IT' },
    'pt': { voice: 'pt-BR-AntonioNeural', lang: 'pt-BR' },
    'ru': { voice: 'ru-RU-DmitryNeural', lang: 'ru-RU' },
    'zh': { voice: 'zh-CN-YunxiNeural', lang: 'zh-CN' },
    'ja': { voice: 'ja-JP-KeitaNeural', lang: 'ja-JP' }
  };
  const base = voices[language] || voices['en'];
  // For English, allow user override
  if ((!language || language === 'en' || language === 'en-us') && overrideVoice && !overrideVoice.startsWith('kokoro:')) {
    return { voice: overrideVoice, lang: 'en-US' };
  }
  return base;
}

// Helper: Generate audio using Edge TTS
async function generateAudio(text, outputPath, language = 'en') {
  const { EdgeTTS } = require('node-edge-tts');

  // Load user's voice preference for English
  let userVoice = null;
  try {
    const settings = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf-8'));
    userVoice = settings.voice || null;
  } catch {}

  const voiceConfig = getVoiceForLanguage(language, userVoice);

  const tts = new EdgeTTS({
    voice: voiceConfig.voice,
    lang: voiceConfig.lang,
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    timeout: 120000
  });

  await tts.ttsPromise(text, outputPath);
}

// Backfill totalDuration/chapterCount for books missing them (runs once on startup, non-blocking)
async function backfillDurations() {
  try {
    // Compute durations outside the lock (chapter parsing is slow),
    // then apply them under it.
    const books = await loadJSON(BOOKS_FILE, {});
    const metadata = {};
    for (const bookId of Object.keys(books)) {
      const book = books[bookId];
      if (book.totalDuration !== undefined && book.chapterCount !== undefined) continue;
      try {
        const chapters = await getChaptersCached(book.path);
        metadata[bookId] = {
          chapterCount: chapters.length,
          totalDuration: chapters.reduce((sum, ch) => sum + (ch.estimatedDuration || 0), 0)
        };
      } catch (err) {
        // Skip books that fail to parse
      }
    }
    if (Object.keys(metadata).length > 0) {
      await updateJSON(BOOKS_FILE, (current) => {
        let updated = false;
        for (const [bookId, fields] of Object.entries(metadata)) {
          const record = current[bookId];
          if (!record) continue;
          if (record.totalDuration === undefined) {
            record.totalDuration = fields.totalDuration;
            updated = true;
          }
          if (record.chapterCount === undefined) {
            record.chapterCount = fields.chapterCount;
            updated = true;
          }
        }
        if (!updated) return jsonStore.SKIP_SAVE;
      });
    }
  } catch (err) {
    console.error('Duration backfill error:', err.message);
  }
}

// Feature: measure per-chapter durations that were never recorded. A duration
// is only captured when a chapter is concatenated live (recordMeasuredChapter-
// Duration via onChapterConcatenated), so most books have few. Here we probe
// any COMPLETE chapter audio file already sitting in cache/ whose duration is
// still missing, and persist it — so progress %/time-left stop running on
// estimates. Reuses chunkedTTS.chapterPath (variant-scoped naming) and
// probeAudioDurationSeconds; writes go through a single batched updateJSON.
// Runs after listen, non-blocking, tiny concurrency; skips cleanly when
// ffprobe is unavailable (every probe returns null → nothing measured).
async function backfillChapterDurations() {
  try {
    const books = await loadJSON(BOOKS_FILE, {});

    // Build the work list first (only chapters missing a duration whose
    // concatenated audio file actually exists on disk).
    const targets = [];
    for (const [bookId, book] of Object.entries(books)) {
      const count = Number(book.chapterCount);
      if (!Number.isInteger(count) || count <= 0) continue;
      const durations = Array.isArray(book.chapterDurations) ? book.chapterDurations : [];
      for (let i = 0; i < count; i++) {
        const have = Number(durations[i]);
        if (Number.isFinite(have) && have > 0) continue; // already measured
        let filePath;
        try { filePath = chunkedTTS.chapterPath(bookId, i); } catch { continue; }
        try { await fs.access(filePath); } catch { continue; } // no complete audio on disk
        targets.push({ bookId, chapterIndex: i, filePath });
      }
    }
    if (targets.length === 0) return;

    // Probe with tiny concurrency (2). probeAudioDurationSeconds swallows all
    // errors and returns null, so a missing ffprobe simply yields no results.
    const results = [];
    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const t = targets[cursor++];
        const seconds = await probeAudioDurationSeconds(t.filePath);
        if (seconds !== null) results.push({ bookId: t.bookId, chapterIndex: t.chapterIndex, seconds });
      }
    }
    await Promise.all([worker(), worker()]);
    if (results.length === 0) return; // ffprobe unavailable, or files unreadable

    // Persist every measurement in one locked write. Mirrors the dedup/total-
    // Duration recompute in recordMeasuredChapterDuration.
    let measured = 0;
    const booksTouched = new Set();
    await updateJSON(BOOKS_FILE, (current) => {
      let updated = false;
      for (const { bookId, chapterIndex, seconds } of results) {
        const book = current[bookId];
        if (!book) continue;
        const durations = Array.isArray(book.chapterDurations) ? book.chapterDurations.slice() : [];
        if (Math.abs((Number(durations[chapterIndex]) || 0) - seconds) < 0.25) continue;
        durations[chapterIndex] = seconds;
        book.chapterDurations = durations;
        if (Number.isInteger(book.chapterCount) && book.chapterCount > 0) {
          const full = durations.slice(0, book.chapterCount);
          if (full.length === book.chapterCount && full.every(v => Number.isFinite(v) && v > 0)) {
            book.totalDuration = full.reduce((sum, v) => sum + v, 0);
          }
        }
        measured++;
        booksTouched.add(bookId);
        updated = true;
      }
      if (!updated) return jsonStore.SKIP_SAVE;
    });

    if (measured > 0) {
      console.log(`[backfill] measured ${measured} chapter duration${measured === 1 ? '' : 's'} across ${booksTouched.size} book${booksTouched.size === 1 ? '' : 's'}`);
    }
  } catch (err) {
    console.error('Chapter-duration backfill error:', err.message);
  }
}

registerPreferencesRoutes(app, {
  annasAuthFile: ANNAS_AUTH_FILE,
  availableVoices: AVAILABLE_VOICES,
  cacheDir: CACHE_DIR,
  customVoicesFile: CUSTOM_VOICES_FILE,
  customVoiceDir: CHATTERBOX_VOICE_DIR,
  dataDir: DATA_DIR,
  defaultVoice: DEFAULT_VOICE,
  getAvailableVoices,
  getAnnasConfig,
  getCurrentVoice: getActiveVoice,
  getEngineProcessHints: () => ({
    kokoro: narrationEngines.processHint('kokoro:am_onyx'),
    chatterbox: narrationEngines.processHint('chatterbox:brick-scott')
  }),
  gutenberg,
  loadJSON,
  onVoiceSelected: startProviderServersForVoice,
  prepareVoiceProvider: startProviderServersForVoice,
  sampleText: SAMPLE_TEXT,
  saveJSON,
  settingsFile: SETTINGS_FILE,
  TTSQueue,
  updateSettingsCache,
  voiceSamplesDir: VOICE_SAMPLES_DIR,
  zlibrary
});

registerBookmarksRoutes(app, {
  bookmarksFile: BOOKMARKS_FILE,
  clientSettingsFile: CLIENT_SETTINGS_FILE,
  jsonStore,
  loadJSON,
  updateJSON
});

registerOperatorPolicyRoutes(app, {
  settingsFile: SETTINGS_FILE,
  jsonStore,
  updateSettingsCache
});

registerPronunciationRoutes(app, { pronunciationService });

function createConfiguredServer() {
  const keyPath = process.env.HTTPS_KEY_FILE || process.env.SSL_KEY_FILE;
  const certPath = process.env.HTTPS_CERT_FILE || process.env.SSL_CERT_FILE;

  if (!keyPath && !certPath) {
    return { server: http.createServer(app), protocol: 'http' };
  }

  if (!keyPath || !certPath) {
    throw new Error('Both HTTPS_KEY_FILE and HTTPS_CERT_FILE are required to enable HTTPS.');
  }

  return {
    server: https.createServer({
      key: fsSync.readFileSync(keyPath),
      cert: fsSync.readFileSync(certPath)
    }, app),
    protocol: 'https'
  };
}

let runningServer = null;

if (require.main === module) {
  // Start server
  ensureDirectories().then(async () => {
    narrationEngines.start('kokoro:af_heart');
    narrationEngines.start('chatterbox:brick-scott');
    startProviderServersForVoice(getActiveVoice());
    await premiumPrep.restore().catch(err => console.warn(`Premium prep recovery failed: ${err.message}`));
    const ordinaryRecovery = await Promise.all([
      chunkedTTS.resumePendingChapters({ recoverAllVariants: true })
    ]).catch(err => {
      console.warn(`Chapter generation recovery failed: ${err.message}`);
      return [];
    });
    const resumedChapters = ordinaryRecovery.reduce((count, report) => count + (report.resumed?.length || 0), 0);
    const failedChapters = ordinaryRecovery.reduce((count, report) => count + (report.failed?.length || 0), 0);
    if (resumedChapters || failedChapters) {
      console.log(`Chapter generation recovery: ${resumedChapters} resumed, ${failedChapters} failed`);
    }
    const { server, protocol } = createConfiguredServer();
    runningServer = server;
    server.listen(PORT, HOST, () => {
      console.log(`Xandrio running at ${protocol}://${HOST}:${PORT}`);
      // Non-blocking backfill
      backfillDurations()
        .catch(err => console.error('Backfill failed:', err.message))
        .then(() => backfillChapterDurations())
        .catch(err => console.error('Chapter-duration backfill failed:', err.message));
    });
  }).catch(err => {
    console.error('Failed to start Xandrio:', err.message);
    shutdown(1);
  });
}

const shutdownController = createGracefulShutdown({
  getServer: () => runningServer,
  isIdle: () => {
    const queue = ttsQueue.getQueueStatus();
    return requestConcurrencyLimiter.isIdle() && downloadImportGate.active === 0 &&
      queue.active === 0 && queue.queued === 0;
  },
  cleanup: async ({ drained }) => {
    if (!drained) console.warn('Shutdown drain deadline reached; durable generation state will recover on restart.');
    try {
      await searchCoverService.flush();
    } catch (err) {
      console.warn(`Search-cover descriptor flush failed: ${err.message}`);
    }
    narrationEngines.stopAll();
    // Give the scraper's Chromium a moment to close, but never block exit.
    try {
      await Promise.race([
        closeAnnasBrowser(),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    } catch {}
  }
});

function shutdown(code) {
  return shutdownController.shutdown(code);
}

process.on('SIGINT', () => { shutdown(0); });
process.on('SIGTERM', () => { shutdown(0); });

// Last-resort handlers: log instead of crashing on stray rejections, and
// make sure the child processes don't outlive us on a fatal error.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, shutting down:', err);
  shutdown(1);
});

// Check if a book has good chapter structure for audiobook playback
async function checkChapterQuality(epubPath) {
  try {
    const chapters = await extractBookChapters(epubPath);
    let tocCount = 0;
    let conversionSource = false;
    if (getBookFormatFromName(epubPath) === 'epub') {
      const epub = await parseEpub(epubPath);
      const toc = epub.toc ? epub.toc.length : 0;
      // Conversion fingerprint: spine files named like Calibre format
      // conversions ("…(RTF)_split_003.htm") combined with a TOC too
      // small to navigate by. Content is usually intact but structure,
      // titles and drop caps are degraded — prefer another edition.
      const spineHrefs = (epub.flow || []).map(item => String(item.href || '').toLowerCase());
      const conversionMarkers = spineHrefs.filter(href =>
        /_split_\d+|\((rtf|doc|docx|txt|html?)\)/.test(href)
      ).length;
      tocCount = toc;
      conversionSource = spineHrefs.length >= 5 &&
        conversionMarkers >= spineHrefs.length * 0.5 &&
        toc <= 2;
    }

    const quality = buildChapterQuality(chapters, tocCount);
    if (conversionSource) {
      quality.isGoodStructure = false;
      quality.conversionSource = true;
      quality.reasons = [...(quality.reasons || []), 'Format-conversion source (RTF/DOC/HTML re-save) with unusable TOC'];
    }
    return quality;
  } catch (err) {
    console.error('Chapter quality check failed:', err);
    return { isGoodStructure: true, reasons: ['Check failed, assuming OK'] }; // Don't block on errors
  }
}

async function validateBook(bookPath) {
  return bookDocument.validateBook(bookPath);
}

async function validateEPUB(epubPath) {
  return bookDocument.validateEpub(epubPath);
}

// API: Validate existing book (diagnostic)
app.post('/api/validate/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const books = await loadJSON(BOOKS_FILE, {});
    const book = books[bookId];
    
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }
    
    console.log(`Validating existing book: ${book.title}`);
    const validation = await validateBook(book.path);
    
    res.json({
      bookId,
      title: book.title,
      validation
    });
  } catch (err) {
    console.error('Validation error:', err);
    sendServerError(res, err, "Failed to validate book");
  }
});

module.exports.app = app;
module.exports.__test = {
  buildPdfPageGroups: pdfExtractionTestHooks.buildPdfPageGroups,
  createPairingCode,
  hashPairingCode,
  normalizePairingCode,
  normalizePositionsStore,
  normalizeUsersStore,
  positionUserId,
  publicSyncProfile,
  removeBookPositions,
  sanitizeSyncId,
  cleanBookDescription,
  normalizeSearchLanguage,
  publishedYearFromMetadata,
  inferGutenbergIdFromBook,
  maybeRelaxMissingTocValidation,
  validateBook,
  validateEPUB,
  coverSourceSteps,
  shouldRefreshCachedCover,
  ensureBookCover,
  validatedLibraryCoverInfo,
  createImportJob,
  downloadImportCommand,
  progressForImportJob,
  importJobSnapshot,
  emitImportJob,
  validatePdfChapterGuess: pdfExtractionTestHooks.validatePdfChapterGuess,
  scorePdfExtractionCandidate: pdfExtractionTestHooks.scorePdfExtractionCandidate,
  selectPdfExtractionCandidate: pdfExtractionTestHooks.selectPdfExtractionCandidate,
  sendServerError,
  premiumVoiceFromVariantKey,
  premiumChunkSizeFromVariantKey,
  quiescePronunciationWorkers,
  bookUploadErrorResponse,
  uploadRouteErrorResponse,
  zlibraryDownloadErrorResponse,
  zlibraryDownloadPreflightResponse,
  publicBookRecordWithCoverArtifact,
  splitTransformedNarration,
  bookDocument,
  xbookStore,
  rememberDeletedBookId,
  deletedBookIds,
  MAX_DELETED_BOOK_IDS,
  concurrencyLimits: CONCURRENCY_LIMITS,
  getAnnasConfig,
  annasBrowserSearchPermitted,
  annasSearchTimeoutMs,
  annasMcpSearchArgs,
  annasMcpExecutable,
  buildAnnasCliEnv,
  acquireDownloadSource
};
