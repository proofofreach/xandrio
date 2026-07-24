/**
 * OPDS provider tests.
 *
 * Run: node test/test-opds-provider.js
 */

const { __test, createOpdsProvider } = require('../lib/search-providers/opds');
const { createStandardEbooksProvider } = require('../lib/search-providers/standard-ebooks');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

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

function assertDeepEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

async function assertRejects(promise, pattern, message) {
  try {
    await promise;
    assert(false, message);
  } catch (error) {
    assert(pattern.test(error.message), message);
  }
}

console.log('\n━━━ OPDS provider ━━━');

const feed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
  <entry>
    <id>https://standardebooks.org/ebooks/james-joyce/dubliners</id>
    <title>Dubliners</title>
    <author><name>James Joyce</name></author>
    <dc:language>en</dc:language>
    <summary>Stories of Dublin.</summary>
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" href="/ebooks/james-joyce/dubliners/download" />
  </entry>
  <entry>
    <id>no-download</id>
    <title>No Download</title>
  </entry>
</feed>`;

const parsed = __test.parseOpdsFeed(feed, {
  source: 'standardebooks',
  label: 'Standard Ebooks',
  feedUrl: 'https://standardebooks.org/feeds/opds'
});

assertEqual(parsed.length, 1, 'parses downloadable OPDS entries');
assertEqual(parsed[0].title, 'Dubliners', 'parses title');
assertEqual(parsed[0].author, 'James Joyce', 'parses author');
assertEqual(parsed[0].source, 'standardebooks', 'sets source');
assertEqual(parsed[0].format, 'EPUB', 'sets EPUB format');
assert(parsed[0].downloadUrl.startsWith('https://standardebooks.org/ebooks/'), 'resolves relative acquisition URL');
assert(__test.matchesQuery(parsed[0], 'joyce dubliners'), 'matches title and author query words');

const standard = createStandardEbooksProvider({ username: '', password: '' });
assertEqual(standard.configured(), true, 'Standard Ebooks public feed is configured without credentials');
const configured = createStandardEbooksProvider({ username: 'reader@example.test', password: '' });
assertEqual(configured.configured(), true, 'Standard Ebooks is configured with username');
const privateFeed = createStandardEbooksProvider({ requiresAuth: true, username: '', password: '' });
assertEqual(privateFeed.configured(), false, 'an explicitly authenticated Standard Ebooks mirror requires credentials');

async function securityTests() {
  let fetches = 0;
  const unsafeDns = createOpdsProvider({
    id: 'unsafe-dns',
    feedUrl: 'https://catalog.example/feed.xml',
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('must not fetch a private address');
    }
  });
  try {
    await unsafeDns.search('book');
    assert(false, 'rejects an OPDS hostname resolving to a private address');
  } catch (error) {
    assert(/unsafe|public|private|remote/i.test(error.message), 'rejects an OPDS hostname resolving to a private address');
    assertEqual(fetches, 0, 'does not send the private OPDS request');
  }

  const requests = [];
  const redirectedFeed = createOpdsProvider({
    id: 'redirected',
    feedUrl: 'https://catalog.example/feed.xml',
    username: 'reader', password: 'secret',
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (url, options) => {
      requests.push([String(url), options.redirect, options.headers.Authorization]);
      if (requests.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/feed.xml' } });
      return new Response(feed);
    }
  });
  assertEqual((await redirectedFeed.search('dubliners')).length, 1, 'follows a validated public OPDS redirect');
  assertDeepEqual(requests, [
    ['https://catalog.example/feed.xml', 'manual', 'Basic cmVhZGVyOnNlY3JldA=='],
    ['https://cdn.example/feed.xml', 'manual', undefined]
  ], 'does not forward OPDS credentials across origins');

  const downloadRequests = [];
  const credentialedFeed = createOpdsProvider({
    id: 'credentialed-download',
    feedUrl: 'https://catalog.example/feed.xml',
    username: 'reader', password: 'secret',
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (url, options) => {
      downloadRequests.push([String(url), options.headers.Authorization]);
      return new Response(Buffer.from('epub fixture'));
    }
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-opds-'));
  try {
    await credentialedFeed.download({ downloadUrl: 'https://attacker.example/book.epub' }, path.join(tempDir, 'book.epub'));
    assertDeepEqual(downloadRequests, [
      ['https://attacker.example/book.epub', undefined]
    ], 'does not send feed credentials to a feed-controlled acquisition origin');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const oversizedFeed = createOpdsProvider({
    id: 'oversized', feedUrl: 'https://catalog.example/feed.xml', maxFeedBytes: 16,
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => new Response(feed)
  });
  await assertRejects(oversizedFeed.search('book'), /allowed size/, 'rejects an OPDS feed larger than its response limit');
}

securityTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
