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

// A catalog whose acquisition link points at a separate CDN origin -- the
// legitimate case that a plain host pin would break.
const cdnFeed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
  <entry>
    <id>cdn-hosted</id>
    <title>Dubliners</title>
    <author><name>James Joyce</name></author>
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" href="https://cdn.example/book.epub" />
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

// The id was the sanitized entry id cut at 110 characters, so two long ids
// sharing a prefix (two translations of one long-titled work) became one
// book. Ids that fit keep exactly their old form.
const { isSafeBookId } = require('../lib/request-guards');
const longBase = `https://standardebooks.org/ebooks/${'leo-tolstoy/'.repeat(4)}war-and-peace-${'x'.repeat(40)}`;
const twinFeed = ['louise-and-aylmer-maude', 'constance-garnett'].map(translator =>
  `<entry><id>${longBase}/${translator}</id><title>War and Peace</title>` +
  `<link rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" href="/w/${translator}.epub"/></entry>`).join('');
const twins = __test.parseOpdsFeed(`<feed>${twinFeed}</feed>`, { source: 'standardebooks', feedUrl: 'https://standardebooks.org/feeds/opds' });
assert(twins.length === 2 && twins[0].hash !== twins[1].hash, 'long OPDS ids sharing a prefix get distinct book ids');
assert(twins.every(twin => isSafeBookId(twin.hash)), 'hashed OPDS ids stay valid book ids');
assertEqual(parsed[0].hash, 'standardebooks-https_standardebooks_org_ebooks_james-joyce_dubliners',
  'an OPDS id that fits keeps its existing book id');
const longSource = __test.parseOpdsFeed(feed, { source: `catalog-${'x'.repeat(90)}`, feedUrl: 'https://standardebooks.org/feeds/opds' })[0];
assert(isSafeBookId(longSource.hash), 'a long provider id cannot push an OPDS book id past 128 characters');

// The entry regex rescanned to the end of the feed from every unclosed
// <entry, quadratic over the 4 MB feed bound.
{
  const hostile = '<entry>'.repeat(570_000);
  assert(hostile.length >= 3_990_000, 'the hostile feed is the size of the feed bound');
  const started = process.hrtime.bigint();
  const blocks = __test.entryBlocks(hostile);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert(blocks.length === 0 && elapsedMs < 500, `unclosed entries scan linearly (${elapsedMs.toFixed(0)}ms)`);
  assertDeepEqual(__test.entryBlocks('<entry>a</entry><ENTRY id="2">b</Entry><entryx>c</entry><entry>open'),
    ['<entry>a</entry>', '<ENTRY id="2">b</Entry>'], 'entry blocks match the previous regex');
}

const standard = createStandardEbooksProvider({ username: '', password: '' });
assertEqual(standard.configured(), false, 'the patrons-only Standard Ebooks feed is unconfigured without credentials');
const configured = createStandardEbooksProvider({ username: 'reader@example.test', password: '' });
assertEqual(configured.configured(), true, 'Standard Ebooks is configured with username');
const privateFeed = createStandardEbooksProvider({ requiresAuth: true, username: '', password: '' });
assertEqual(privateFeed.configured(), false, 'an explicitly authenticated Standard Ebooks mirror requires credentials');
const publicMirror = createStandardEbooksProvider({ requiresAuth: false, username: '', password: '' });
assertEqual(publicMirror.configured(), true, 'an explicitly public OPDS mirror needs no credentials');

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
      return String(url) === 'https://catalog.example/feed.xml'
        ? new Response(cdnFeed)
        : new Response(Buffer.from('epub fixture'));
    }
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-opds-'));
  try {
    // The feed itself publishes this cross-origin acquisition link, so the
    // download proceeds -- but without the feed's Basic credentials.
    await credentialedFeed.download({ downloadUrl: 'https://cdn.example/book.epub' }, path.join(tempDir, 'book.epub'));
    assertDeepEqual(downloadRequests, [
      ['https://catalog.example/feed.xml', 'Basic cmVhZGVyOnNlY3JldA=='],
      ['https://cdn.example/book.epub', undefined]
    ], 'does not send feed credentials to a feed-controlled acquisition origin');

    // The hash becomes the book id; a published entry fixes it.
    const cdnEntry = __test.parseOpdsFeed(cdnFeed, { source: 'credentialed-download', feedUrl: 'https://catalog.example/feed.xml' })[0];
    await credentialedFeed.download({ downloadUrl: cdnEntry.downloadUrl, hash: cdnEntry.hash }, path.join(tempDir, 'id.epub'));
    await assertRejects(
      credentialedFeed.download({ downloadUrl: cdnEntry.downloadUrl, hash: 'a'.repeat(32) }, path.join(tempDir, 'squat.epub')),
      /does not match its book identifier/,
      'refuses a published download filed under another book id'
    );

    // The client supplies downloadUrl on POST /api/download, so naming this
    // provider must not turn the server into a fetcher for arbitrary hosts.
    await assertRejects(
      credentialedFeed.download({ downloadUrl: 'https://attacker.example/book.epub' }, path.join(tempDir, 'evil.epub')),
      /not served by/,
      'refuses a download URL the feed does not publish'
    );
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
