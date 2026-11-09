const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { SOURCE_RIGHTS_POLICIES, sourceRightsPolicy } = require('../source-provenance');

// A download's `hash` becomes the book id: cache/<id>.<ext>, the record key
// and sourceHash. The client supplies it, while most providers fetch by other
// fields, so naming one book's id beside another book's download fields used
// to file the second book under the first's id and block that id for every
// user. Each provider below binds the two: md5-addressed sources prove the
// bytes hash to the id, and the others derive the id from the same native
// identifier the download uses.
class BookIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BookIdentityError';
    this.code = 'BOOK_ID_MISMATCH';
    this.statusCode = 400;
  }
}

const MD5_BOOK_ID = /^[a-f0-9]{32}$/i;
// Gutendex publishes /ebooks/<id>.epub3.images, /cache/epub/<id>/... and
// gutendex.com/files/<id>/... download URLs.
const GUTENBERG_URL_ID = /\/(?:ebooks|cache\/epub|files)\/(\d+)(?=[./]|$)/;

async function fileMd5(filePath) {
  const hash = crypto.createHash('md5');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function gutenbergBookId(result = {}) {
  const id = String(result.gutenbergId || '');
  if (!/^\d+$/.test(id)) return null;
  if (result.downloadUrl) {
    let pathname;
    try {
      pathname = new URL(result.downloadUrl).pathname;
    } catch {
      return null;
    }
    if (pathname.match(GUTENBERG_URL_ID)?.[1] !== id) return null;
  }
  return `pg-${id}`;
}

const ZLIBRARY_LANGUAGE_NAMES = Object.freeze({
  en: 'english',
  de: 'german',
  es: 'spanish',
  fr: 'french',
  it: 'italian',
  pt: 'portuguese',
  ru: 'russian',
  zh: 'chinese',
  ja: 'japanese'
});

function zlibrarySearchLanguages(value) {
  const normalized = String(value || '').trim().toLowerCase().split(/[-_]/, 1)[0];
  if (!normalized || normalized === 'all') return [];
  const language = ZLIBRARY_LANGUAGE_NAMES[normalized] ||
    Object.values(ZLIBRARY_LANGUAGE_NAMES).find(name => name === normalized);
  return language ? [language] : [];
}

function createSearchProviderRegistry(options = {}) {
  const {
    annas,
    zlibrary,
    gutenberg,
    internetArchive,
    opds,
    standardEbooks,
    searchFormats = ['epub'],
    sourceTimeoutMs = 12000,
    sourceTimeoutMsByProvider = {},
    withTimeout = (promise) => promise
  } = options;

  const providers = [];

  if (annas) {
    providers.push({
      id: 'annas',
      label: "Anna's Archive",
      configured: () => true,
      async search(query) {
        const results = await annas.search(query);
        return results.map(result => ({ ...result, source: 'annas' }));
      },
      bookId: result => (MD5_BOOK_ID.test(String(result?.hash || '')) ? result.hash : null),
      async download(result, destPath) {
        await annas.download(result.hash, destPath);
      },
      // Anna's and LibGen address a file by the md5 of its bytes.
      async verifyDownload(result, destPath) {
        const actual = await fileMd5(destPath);
        if (actual !== String(result.hash).toLowerCase()) {
          throw new BookIdentityError("Anna's Archive download does not match the requested book");
        }
      }
    });
  }

  if (zlibrary) {
    providers.push({
      id: 'zlibrary',
      label: 'Z-Library',
      // Searching is anonymous; only status and downloads require a session.
      configured: () => true,
      async status() {
        return zlibrary.getStatus();
      },
      async search(query, context = {}) {
        return zlibrary.search(query, {
          limit: 20,
          extensions: searchFormats,
          languages: zlibrarySearchLanguages(context.language)
        });
      },
      async download(result, destPath) {
        await zlibrary.download(result, destPath);
      }
    });
  }

  if (gutenberg) {
    providers.push({
      id: 'gutenberg',
      label: 'Project Gutenberg',
      configured: () => gutenberg.isEnabled(),
      async search(query, context = {}) {
        if (!gutenberg.isEnabled()) return [];
        return gutenberg.search(query, { language: context.language });
      },
      async cachedSearch(query, context = {}) {
        return gutenberg.getCachedSearch(query, context.language);
      },
      bookId: gutenbergBookId,
      async download(result, destPath) {
        await gutenberg.downloadBook(result.gutenbergId, result.downloadUrl, destPath);
      }
    });
  }

  if (internetArchive) {
    providers.push({
      id: 'internetarchive',
      label: 'Internet Archive',
      configured: () => true,
      async search(query, context = {}) {
        return internetArchive.search(query, context);
      },
      ...(internetArchive.bookId ? { bookId: result => internetArchive.bookId(result) } : {}),
      async download(result, destPath) {
        await internetArchive.download(result, destPath);
      }
    });
  }

  if (standardEbooks) {
    providers.push({
      id: 'standardebooks',
      label: 'Standard Ebooks',
      configured: () => standardEbooks.configured(),
      async search(query, context = {}) {
        if (!standardEbooks.configured()) return [];
        return standardEbooks.search(query, context);
      },
      async download(result, destPath) {
        await standardEbooks.download(result, destPath);
      }
    });
  }

  if (opds) {
    providers.push({
      id: opds.id || 'opds',
      label: opds.label || 'OPDS',
      configured: () => opds.configured(),
      async search(query, context = {}) {
        if (!opds.configured()) return [];
        return opds.search(query, context);
      },
      async download(result, destPath) {
        await opds.download(result, destPath);
      }
    });
  }

  const byId = new Map(providers.map(provider => [provider.id, provider]));

  function providerConfigured(provider) {
    try {
      return provider.configured ? Boolean(provider.configured()) : true;
    } catch {
      return false;
    }
  }

  function describe() {
    return providers.map(provider => ({
      id: provider.id,
      label: provider.label,
      configured: providerConfigured(provider),
      ...sourceRightsPolicy(provider.id)
    }));
  }

  function sourceError(provider, error) {
    if (provider.id !== 'zlibrary') {
      const publicErrors = {
        annas: {
          error: "Anna's Archive search is unavailable right now.",
          errorCode: 'ANNAS_SEARCH_UNAVAILABLE'
        },
        gutenberg: {
          error: 'Project Gutenberg search is unavailable right now.',
          errorCode: 'GUTENBERG_SEARCH_UNAVAILABLE'
        },
        internetarchive: {
          error: 'Internet Archive search is unavailable right now.',
          errorCode: 'INTERNET_ARCHIVE_SEARCH_UNAVAILABLE'
        },
        standardebooks: {
          error: 'Standard Ebooks search is unavailable right now. If this persists, the OPDS feed credentials may be missing or expired.',
          errorCode: 'STANDARD_EBOOKS_SEARCH_UNAVAILABLE'
        }
      };
      return publicErrors[provider.id] || {
        error: 'Search provider is unavailable right now.',
        errorCode: 'SEARCH_PROVIDER_UNAVAILABLE'
      };
    }

    const publicMessages = {
      ZLIB_AUTH_EXPIRED: 'Reconnect required',
      ZLIB_TIMEOUT: 'Z-Library timed out. Try again shortly.',
      ZLIB_UNAVAILABLE: 'Z-Library is temporarily unavailable.',
      ZLIB_RATE_LIMITED: 'Z-Library is rate limited. Try again shortly.',
      ZLIB_PROTOCOL: 'Z-Library returned an unexpected response.'
    };
    return {
      error: error.publicMessage || publicMessages[error.code] || 'Z-Library search is unavailable right now.',
      ...(error.code ? { errorCode: error.code } : {})
    };
  }

  function describeResult(provider, result) {
    const source = result?.source || provider.id;
    return {
      ...result,
      source,
      sourceRightsStatus: sourceRightsPolicy(source).rightsStatus
    };
  }

  async function searchAll(query, context = {}) {
    const selectedSources = Array.isArray(context.sources)
      ? new Set(context.sources)
      : null;
    const activeProviders = selectedSources
      ? providers.filter(provider => selectedSources.has(provider.id))
      : providers;
    const searches = activeProviders.map(async provider => {
      if (!providerConfigured(provider)) {
        return { provider, results: [], error: null };
      }
      try {
        const fallback = provider.cachedSearch
          ? await provider.cachedSearch(query, context).catch(() => [])
          : [];
        const providerTimeout = Number(sourceTimeoutMsByProvider[provider.id]);
        const timeout = Number.isFinite(providerTimeout) && providerTimeout > 0
          ? providerTimeout
          : provider.id === 'gutenberg'
            ? Math.min(sourceTimeoutMs, 8000)
            : sourceTimeoutMs;
        const results = await withTimeout(
          provider.search(query, context),
          timeout,
          fallback,
          `${provider.label} search`
        );
        return { provider, results: results.map(result => describeResult(provider, result)), error: null };
      } catch (err) {
        return { provider, results: [], error: err };
      }
    });

    const settled = await Promise.all(searches);
    return {
      resultsByProvider: Object.fromEntries(settled.map(entry => [entry.provider.id, entry.results])),
      sourceStatus: Object.fromEntries(settled.map(entry => [entry.provider.id, {
        id: entry.provider.id,
        label: entry.provider.label,
        configured: providerConfigured(entry.provider),
        ...sourceRightsPolicy(entry.provider.id),
        ok: !entry.error,
        count: entry.results.length,
        ...(entry.error ? sourceError(entry.provider, entry.error) : {})
      }])),
      results: settled.flatMap(entry => entry.results)
    };
  }

  async function download(result, destPath) {
    const source = result.source || 'annas';
    const provider = byId.get(source) || byId.get('annas');
    if (!provider) throw new Error(`Unsupported source: ${source}`);
    // Z-Library requests the file by (zlibId, hash), so its id is bound by the
    // request itself; OPDS providers check the id against their feed.
    if (result.hash !== undefined && provider.bookId && provider.bookId(result) !== result.hash) {
      throw new BookIdentityError(`${provider.label} result does not match its book identifier`);
    }
    await provider.download(result, destPath);
    if (provider.verifyDownload) {
      try {
        await provider.verifyDownload(result, destPath);
      } catch (error) {
        await fs.promises.rm(destPath, { force: true }).catch(() => {});
        throw error;
      }
    }
  }

  return {
    providers: () => providers.slice(),
    describe,
    get: id => byId.get(id),
    searchAll,
    download
  };
}

module.exports = { createSearchProviderRegistry, BookIdentityError, SOURCE_RIGHTS_POLICIES, sourceRightsPolicy };
