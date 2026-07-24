const { SOURCE_RIGHTS_POLICIES, sourceRightsPolicy } = require('../source-provenance');

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
      async download(result, destPath) {
        await annas.download(result.hash, destPath);
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
          error: 'Standard Ebooks search is unavailable right now.',
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
    await provider.download(result, destPath);
  }

  return {
    providers: () => providers.slice(),
    describe,
    get: id => byId.get(id),
    searchAll,
    download
  };
}

module.exports = { createSearchProviderRegistry, SOURCE_RIGHTS_POLICIES, sourceRightsPolicy };
