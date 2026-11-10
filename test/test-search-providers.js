/**
 * Search provider registry tests.
 *
 * Run: node test/test-search-providers.js
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSearchProviderRegistry } = require('../lib/search-providers');

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

async function testSearchAllNormalizesExistingProviders() {
  const registry = createSearchProviderRegistry({
    annas: {
      search: async () => [{ title: 'Anna Book', hash: 'a1' }],
      download: async () => {}
    },
    zlibrary: {
      hasStoredSession: () => true,
      search: async () => [{ title: 'Z Book', hash: 'z1', source: 'zlibrary' }],
      getStatus: async () => ({ configured: true, state: 'connected' }),
      download: async () => {}
    },
    gutenberg: {
      isEnabled: () => true,
      search: async () => [{ title: 'G Book', hash: 'g1', source: 'gutenberg' }],
      getCachedSearch: async () => [],
      downloadBook: async () => {}
    },
    internetArchive: {
      search: async () => [{ title: 'IA Book', hash: 'ia1', source: 'internetarchive' }],
      download: async () => {}
    },
    withTimeout: promise => promise
  });

  const result = await registry.searchAll('book', { language: 'en' });
  assertEqual(result.results.length, 4, 'searchAll combines configured provider results');
  assert(result.results.some(item => item.source === 'annas'), 'Anna results are tagged with source');
  assertEqual(result.sourceStatus.annas.count, 1, 'sourceStatus counts Anna results');
  assertEqual(result.sourceStatus.zlibrary.count, 1, 'sourceStatus counts Z-Library results');
  assertEqual(result.sourceStatus.gutenberg.count, 1, 'sourceStatus counts Gutenberg results');
  assertEqual(result.sourceStatus.internetarchive.count, 1, 'sourceStatus counts Internet Archive results');
  assertEqual(result.sourceStatus.internetarchive.rightsStatus, 'unverified',
    'sourceStatus exposes the provider rights category');
  assertEqual(result.results.find(item => item.source === 'gutenberg').sourceRightsStatus, 'provider-metadata',
    'search results retain their provider rights category');
}

async function testGutenbergCachedFallback() {
  const registry = createSearchProviderRegistry({
    gutenberg: {
      isEnabled: () => true,
      search: async () => [{ title: 'Fresh', hash: 'fresh', source: 'gutenberg' }],
      getCachedSearch: async () => [{ title: 'Cached', hash: 'cached', source: 'gutenberg' }],
      downloadBook: async () => {}
    },
    withTimeout: async (_promise, _timeout, fallback) => fallback
  });

  const result = await registry.searchAll('cached', { language: 'en' });
  assertEqual(result.results[0].hash, 'cached', 'Gutenberg uses cached fallback on timeout');
}

async function testSearchAllHonorsSelectedSources() {
  const calls = [];
  const registry = createSearchProviderRegistry({
    annas: {
      search: async () => {
        calls.push('annas');
        return [{ title: 'Anna Book', hash: 'a1' }];
      },
      download: async () => {}
    },
    internetArchive: {
      search: async () => {
        calls.push('internetarchive');
        return [{ title: 'Archive Book', hash: 'ia1', source: 'internetarchive' }];
      },
      download: async () => {}
    },
    withTimeout: promise => promise
  });

  const result = await registry.searchAll('book', { sources: ['annas'] });
  assertEqual(calls.join(','), 'annas', 'searchAll only invokes selected providers');
  assertEqual(result.results.length, 1, 'searchAll returns only selected provider results');
  assertEqual(Object.keys(result.sourceStatus).join(','), 'annas', 'sourceStatus only reports selected providers');
}

function testProviderDescriptions() {
  const registry = createSearchProviderRegistry({
    annas: { search: async () => [], download: async () => {} },
    zlibrary: {
      hasStoredSession: () => false,
      search: async () => [],
      getStatus: async () => ({ configured: false, state: 'disconnected' }),
      download: async () => {}
    },
    opds: {
      id: 'opds', label: 'Private catalog', configured: () => false,
      search: async () => [], download: async () => {}
    }
  });
  const descriptions = registry.describe();
  assertEqual(descriptions.find(item => item.id === 'annas').configured, true, 'describe marks available providers configured');
  assertEqual(descriptions.find(item => item.id === 'zlibrary').configured, true, 'describe keeps Z-Library available for anonymous search');
  assertEqual(descriptions.find(item => item.id === 'annas').rightsStatus, 'unverified',
    'describe marks Anna rights status as unverified');
  assertEqual(descriptions.find(item => item.id === 'zlibrary').requiresOperatorAcknowledgement, true,
    'describe requires operator acknowledgement for unverified-rights providers');
  assertEqual(descriptions.find(item => item.id === 'opds').rightsStatus, 'operator-configured',
    'describe preserves an operator-configured OPDS catalog');
  assertEqual(descriptions.find(item => item.id === 'opds').configured, false,
    'OPDS remains visible but disabled until the operator supplies a feed');
}

async function testZlibraryAnonymousSearchDoesNotRequireStoredSession() {
  let searchCalls = 0;
  const registry = createSearchProviderRegistry({
    zlibrary: {
      hasStoredSession: () => false,
      getStatus: async () => ({ configured: false, state: 'disconnected' }),
      search: async () => {
        searchCalls++;
        return [{ title: 'Anonymous Z Book', hash: 'z-anon', source: 'zlibrary' }];
      },
      download: async () => {}
    },
    withTimeout: promise => promise
  });

  const result = await registry.searchAll('book', { sources: ['zlibrary'] });
  assertEqual(searchCalls, 1, 'Z-Library anonymous search is invoked without a stored session');
  assertEqual(result.results.length, 1, 'Z-Library anonymous search results are exposed');
  assertEqual(result.sourceStatus.zlibrary.configured, true, 'anonymous Z-Library search remains available in sourceStatus');
}

async function testZlibraryReceivesSelectedLanguageBeforeResultLimit() {
  let searchOptions;
  const registry = createSearchProviderRegistry({
    zlibrary: {
      getStatus: async () => ({ configured: false, state: 'disconnected' }),
      search: async (_query, options) => {
        searchOptions = options;
        return [];
      },
      download: async () => {}
    },
    withTimeout: promise => promise
  });

  await registry.searchAll('murakami', { language: 'en', sources: ['zlibrary'] });
  assertEqual(
    JSON.stringify(searchOptions?.languages),
    JSON.stringify(['english']),
    'Z-Library applies the selected language before its 20-result limit'
  );
}

async function testDownloadRoutingAndLimitErrors() {
  const calls = [];
  const registry = createSearchProviderRegistry({
    annas: {
      search: async () => [],
      download: async (hash, destPath) => {
        calls.push(['annas', hash, destPath]);
        fs.writeFileSync(destPath, 'anna fixture');
      }
    },
    zlibrary: {
      hasStoredSession: () => true,
      search: async () => [],
      getStatus: async () => ({ configured: true, state: 'connected' }),
      download: async (result, destPath) => calls.push(['zlibrary', result, destPath])
    },
    gutenberg: {
      isEnabled: () => true,
      search: async () => [],
      getCachedSearch: async () => [],
      downloadBook: async (id, url, destPath) => calls.push(['gutenberg', id, url, destPath])
    },
    internetArchive: {
      search: async () => [],
      download: async (result, destPath) => calls.push(['internetarchive', result.iaIdentifier, destPath])
    }
  });

  const annasPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-providers-')), 'a.epub');
  const annasMd5 = crypto.createHash('md5').update('anna fixture').digest('hex');
  await registry.download({ source: 'annas', hash: annasMd5 }, annasPath);
  await registry.download({ source: 'gutenberg', gutenbergId: '123', downloadUrl: 'https://example.test/book.epub' }, '/tmp/g.epub');
  await registry.download({ source: 'internetarchive', iaIdentifier: 'abc', iaFile: 'abc.epub' }, '/tmp/ia.epub');
  assertEqual(calls[0][0], 'annas', 'download routes Anna source');
  assertEqual(calls[1][0], 'gutenberg', 'download routes Gutenberg source');
  assertEqual(calls[2][0], 'internetarchive', 'download routes Internet Archive source');

  const zlibraryResult = { source: 'zlibrary', zlibId: 'z1', hash: 'h1' };
  await registry.download(zlibraryResult, '/tmp/z.epub');
  assertEqual(calls[3][0], 'zlibrary', 'download routes Z-Library source');
  assertEqual(calls[3][1], zlibraryResult, 'Z-Library download receives the opaque result');
  assertEqual(calls[3][2], '/tmp/z.epub', 'Z-Library download receives the destination path');
}

// A download used to fall back to Anna's Archive for an unknown source or a
// source without its download fields, while the record kept the requested
// source. The registry now refuses those selections outright.
async function testDownloadRefusesUnknownOrIncompleteSources() {
  const calls = [];
  const registry = createSearchProviderRegistry({
    annas: {
      search: async () => [],
      download: async hash => calls.push(['annas', hash])
    },
    gutenberg: {
      isEnabled: () => true,
      search: async () => [],
      getCachedSearch: async () => [],
      downloadBook: async id => calls.push(['gutenberg', id])
    }
  });
  const md5 = 'a'.repeat(32);
  for (const selection of [
    { source: 'gutenberg', hash: md5 },
    { source: 1, hash: md5 },
    { source: 'upload', hash: md5 },
    { source: 'calibre', hash: md5 },
    { source: 'zlibrary', zlibId: 'z1', hash: md5 },
    { source: ['annas'], hash: md5 }
  ]) {
    const error = await rejection(registry.download(selection, '/tmp/never.epub'));
    assertEqual(error?.code, 'INVALID_DOWNLOAD_SOURCE', `download refuses ${JSON.stringify(selection.source)} without its provider fields`);
    assertEqual(error?.statusCode, 400, `refused ${JSON.stringify(selection.source)} download is a client error`);
  }
  assertEqual(calls.length, 0, 'a refused download contacts no provider, Anna\'s Archive included');
  assertEqual(registry.resolveDownloadSource({ hash: md5 }), 'annas', 'an absent source still defaults to Anna\'s Archive');
  assertEqual(registry.resolveDownloadSource({ source: 'gutenberg', gutenbergId: '1', downloadUrl: 'https://x.test/ebooks/1.epub' }),
    'gutenberg', 'a complete Gutenberg selection resolves to Gutenberg');
}

async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

// The download hash becomes the book id. Each provider must bind it to the
// fields the download actually fetches by, or one user could file any file
// under a popular book's id and block that id for everyone.
async function testDownloadBindsBookIdToProviderIdentity() {
  const calls = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-provider-ids-'));
  const registry = createSearchProviderRegistry({
    downloadDir: tempDir,
    annas: {
      search: async () => [],
      download: async (hash, destPath) => {
        calls.push(['annas', hash]);
        fs.writeFileSync(destPath, 'served bytes');
      }
    },
    gutenberg: {
      isEnabled: () => true,
      search: async () => [],
      getCachedSearch: async () => [],
      downloadBook: async id => calls.push(['gutenberg', id])
    },
    internetArchive: {
      search: async () => [],
      bookId: require('../lib/search-providers/internet-archive').bookId,
      download: async result => calls.push(['internetarchive', result.iaIdentifier])
    }
  });
  const popularMd5 = 'a'.repeat(32);
  try {
    const servedMd5 = crypto.createHash('md5').update('served bytes').digest('hex');
    const annasPath = path.join(tempDir, 'ok.epub');
    await registry.download({ source: 'annas', hash: servedMd5.toUpperCase() }, annasPath);
    assert(fs.existsSync(annasPath), "an Anna's download whose bytes hash to its id is kept");

    const mismatchPath = path.join(tempDir, 'mismatch.epub');
    const mismatch = await rejection(registry.download({ source: 'annas', hash: popularMd5 }, mismatchPath));
    assertEqual(mismatch?.code, 'BOOK_ID_MISMATCH', "an Anna's download whose bytes hash elsewhere is refused");
    assert(!fs.existsSync(mismatchPath), "a refused Anna's download is removed");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-provider-outside-'));
    const outsidePath = path.join(outside, 'outside.epub');
    await rejection(registry.download({ source: 'annas', hash: popularMd5 }, outsidePath));
    assert(fs.existsSync(outsidePath), 'a refused download outside the download directory is never deleted');
    fs.rmSync(outside, { recursive: true, force: true });
    assertEqual((await rejection(registry.download({ source: 'annas', hash: 'pg-1342' }, path.join(tempDir, 'x'))))?.code,
      'BOOK_ID_MISMATCH', "an Anna's id that is not an md5 is refused before download");

    const gutenbergUrl = 'https://www.gutenberg.org/ebooks/1342.epub3.images';
    await registry.download({ source: 'gutenberg', hash: 'pg-1342', gutenbergId: '1342', downloadUrl: gutenbergUrl }, path.join(tempDir, 'g'));
    await registry.download({ source: 'gutenberg', hash: 'pg-71001', gutenbergId: '71001',
      downloadUrl: 'https://gutendex.com/files/71001/pg71001-images.epub' }, path.join(tempDir, 'g2'));
    await registry.download({ source: 'gutenberg', hash: 'pg-84', gutenbergId: '84',
      downloadUrl: 'https://www.gutenberg.org/cache/epub/84/pg84-images-3.epub' }, path.join(tempDir, 'g3'));
    assertEqual(calls.filter(call => call[0] === 'gutenberg').length, 3, 'Gutenberg ids derived from the book number download');
    for (const [label, result] of [
      ['a Gutenberg download claiming an md5 id', { hash: popularMd5, gutenbergId: '1342', downloadUrl: gutenbergUrl }],
      ['a Gutenberg id for another book number', { hash: 'pg-11', gutenbergId: '1342', downloadUrl: gutenbergUrl }],
      ['a Gutenberg URL for another book number', { hash: 'pg-11', gutenbergId: '11', downloadUrl: gutenbergUrl }]
    ]) {
      assertEqual((await rejection(registry.download({ source: 'gutenberg', ...result }, path.join(tempDir, 'g'))))?.code,
        'BOOK_ID_MISMATCH', `${label} is refused`);
    }

    await registry.download({ source: 'internetarchive', hash: 'ia-moby_dick', iaIdentifier: 'moby_dick', iaFile: 'm.epub',
      downloadUrl: 'https://archive.org/download/moby_dick/m.epub' }, path.join(tempDir, 'ia'));
    assertEqual(calls.at(-1)?.[1], 'moby_dick', 'an Internet Archive id derived from the item downloads');
    for (const [label, result] of [
      ['an Internet Archive download claiming an md5 id', { hash: popularMd5, iaIdentifier: 'moby_dick', iaFile: 'm.epub' }],
      ['an Internet Archive URL for a different item', { hash: 'ia-moby_dick', iaIdentifier: 'moby_dick',
        downloadUrl: 'https://archive.org/download/other_item/o.epub' }]
    ]) {
      assertEqual((await rejection(registry.download({ source: 'internetarchive', ...result }, path.join(tempDir, 'ia'))))?.code,
        'BOOK_ID_MISMATCH', `${label} is refused`);
    }
    // Only the md5 check needs the bytes; every other refusal precedes the download.
    assertEqual(calls.map(call => call[0]).join(','), 'annas,annas,annas,gutenberg,gutenberg,gutenberg,internetarchive',
      'no derived-id refusal reaches a provider download');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testZlibraryFailurePreservesOtherResultsAndIsSafe() {
  const registry = createSearchProviderRegistry({
    annas: {
      search: async () => [{ title: 'Anna Book', hash: 'a1' }],
      download: async () => {}
    },
    zlibrary: {
      hasStoredSession: () => true,
      getStatus: async () => ({ configured: true, state: 'connected' }),
      search: async () => {
        const error = new Error('upstream response leaked a token=secret');
        error.code = 'ZLIB_TIMEOUT';
        error.publicMessage = 'Z-Library timed out. Try again shortly.';
        throw error;
      },
      download: async () => {}
    },
    withTimeout: promise => promise
  });

  const result = await registry.searchAll('book');
  assertEqual(result.results.length, 1, 'Z-Library failure preserves results from other sources');
  assertEqual(result.sourceStatus.zlibrary.ok, false, 'Z-Library failure marks only its source unhealthy');
  assertEqual(result.sourceStatus.zlibrary.error, 'Z-Library timed out. Try again shortly.', 'sourceStatus uses the safe public error');
  assertEqual(result.sourceStatus.zlibrary.errorCode, 'ZLIB_TIMEOUT', 'sourceStatus retains the stable error code');
  assert(!JSON.stringify(result.sourceStatus.zlibrary).includes('token=secret'), 'sourceStatus does not expose raw error messages');
}

async function testNonZlibraryFailuresDoNotExposeRawProviderErrors() {
  const registry = createSearchProviderRegistry({
    annas: {
      search: async () => { throw new Error('upstream URL includes token=secret'); },
      download: async () => {}
    },
    withTimeout: promise => promise
  });

  const result = await registry.searchAll('book');
  assertEqual(result.sourceStatus.annas.error, 'Anna\'s Archive search is unavailable right now.',
    'non-Z-Library failures use a stable provider-specific message');
  assertEqual(result.sourceStatus.annas.errorCode, 'ANNAS_SEARCH_UNAVAILABLE',
    'non-Z-Library failures expose a stable error code');
  assert(!JSON.stringify(result.sourceStatus.annas).includes('token=secret'),
    'non-Z-Library failures do not expose raw error messages');
}

async function testZlibraryStatusDelegatesToClient() {
  const expected = { configured: true, state: 'connected', downloadsRemaining: 7 };
  const registry = createSearchProviderRegistry({
    zlibrary: {
      hasStoredSession: () => true,
      getStatus: async () => expected,
      search: async () => [],
      download: async () => {}
    }
  });

  const status = await registry.get('zlibrary').status();
  assertEqual(status, expected, 'Z-Library status delegates directly to the client');
}

(async () => {
  console.log('\n━━━ Search providers ━━━');
  await testSearchAllNormalizesExistingProviders();
  await testGutenbergCachedFallback();
  await testSearchAllHonorsSelectedSources();
  testProviderDescriptions();
  await testZlibraryAnonymousSearchDoesNotRequireStoredSession();
  await testZlibraryReceivesSelectedLanguageBeforeResultLimit();
  await testDownloadRoutingAndLimitErrors();
  await testDownloadBindsBookIdToProviderIdentity();
  await testDownloadRefusesUnknownOrIncompleteSources();
  await testZlibraryFailurePreservesOtherResultsAndIsSafe();
  await testNonZlibraryFailuresDoNotExposeRawProviderErrors();
  await testZlibraryStatusDelegatesToClient();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
