// Failure modes recorded before implementation:
// - Duplicate provider editions repeat identical catalog identity requests and
//   multiply the provider searches performed inside each resolution.
// - A cover without Content-Length is downloaded in full before its 8 MiB
//   limit is checked.
//
// This fixture uses real local HTTP providers. It never contacts an external
// catalog service. The default run verifies both accepted fixes. A named phase
// produces a repeatable aggregate ledger without replacing baseline artifacts:
//   node scripts/verify-search-resource-lifecycle-e2e.js --phase release
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildCatalogSearchResponse } = require('../lib/catalog-search');
const { resolveOpenLibraryIdentity: resolveProductionIdentity } = require('../lib/metadata-service');
const { createSearchCoverService } = require('../lib/search-cover-service');

const phaseIndex = process.argv.indexOf('--phase');
const phase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : 'after';
const caseIndex = process.argv.indexOf('--case');
const caseName = caseIndex >= 0 ? process.argv[caseIndex + 1] : 'all';
const outputDir = path.join(__dirname, '..', 'output', 'server-performance', 'search');
const artifactPath = path.join(outputDir, `${phase}.json`);
const mebibyte = 1024 * 1024;

function result(title, author, hash) {
  return {
    title,
    author,
    hash,
    format: 'EPUB',
    size: '2 MB',
    publisher: 'Fixture Press, 2026',
    language: 'en',
    source: 'fixture'
  };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function verifyCoverByteBound() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-search-cover-'));
  const totalBytes = 12 * mebibyte;
  const chunkBytes = 64 * 1024;
  const streams = {
    unadvertised: { bytesSent: 0, closed: false },
    advertised: { bytesSent: 0, closed: false },
    valid: { bytesSent: 0, closed: false }
  };
  let server;
  try {
    server = http.createServer((req, res) => {
      const name = req.url.includes('advertised')
        ? 'advertised'
        : req.url.includes('valid') ? 'valid' : 'unadvertised';
      const stat = streams[name];
      if (name === 'valid') {
        const buffer = Buffer.alloc(2048);
        buffer[0] = 0xff;
        buffer[1] = 0xd8;
        stat.bytesSent = buffer.length;
        res.once('close', () => { stat.closed = true; });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(buffer.length) });
        return res.end(buffer);
      }
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        ...(name === 'advertised' ? { 'content-length': String(totalBytes) } : {})
      });
      res.once('close', () => { stat.closed = true; });
      const send = () => {
        if (res.destroyed || res.writableEnded) return;
        if (stat.bytesSent >= totalBytes) return res.end();
        const size = Math.min(chunkBytes, totalBytes - stat.bytesSent);
        const chunk = Buffer.alloc(size);
        if (stat.bytesSent === 0) {
          chunk[0] = 0xff;
          chunk[1] = 0xd8;
          chunk[2] = 0xff;
          chunk[3] = 0xe0;
        }
        stat.bytesSent += size;
        res.write(chunk);
        setTimeout(send, 2);
      };
      send();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const service = createSearchCoverService({
      cacheDir: tempDir,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (url, init) => {
        const response = await fetch(`${origin}${new URL(url).pathname}`, { signal: init.signal });
        // Keep the real HTTP body while hiding the fixture's private URL from
        // the production redirect/SSRF check. Production sees the original
        // public URL here because its fetch implementation does not rewrite it.
        return new Response(response.body, { status: response.status, headers: response.headers });
      },
      getDimensions: () => ({ width: 600, height: 900 })
    });
    const unadvertised = service.register({
      source: 'standardebooks',
      title: 'Oversized Cover Fixture',
      author: 'Fixture Author',
      coverUrl: 'https://covers.example.test/oversized-cover.jpg'
    });
    const advertised = service.register({
      source: 'standardebooks',
      title: 'Advertised Oversized Cover Fixture',
      author: 'Fixture Author',
      coverUrl: 'https://covers.example.test/advertised-cover.jpg'
    });
    const valid = service.register({
      source: 'standardebooks',
      title: 'Valid Cover Fixture',
      author: 'Fixture Author',
      coverUrl: 'https://covers.example.test/valid-cover.jpg'
    });
    const unadvertisedResult = await service.resolve(unadvertised.key);
    const advertisedResult = await service.resolve(advertised.key);
    const validResult = await service.resolve(valid.key);
    await new Promise(resolve => setTimeout(resolve, 60));
    const evidence = {
      phase,
      case: 'cover-byte-bound',
      passed: false,
      totalProviderBytes: totalBytes,
      streams,
      unadvertisedResolved: Boolean(unadvertisedResult),
      advertisedResolved: Boolean(advertisedResult),
      validResolvedBytes: validResult?.buffer?.length || 0
    };
    const failures = [];
    if (streams.unadvertised.bytesSent > 9 * mebibyte) {
      failures.push(`expected the 8 MiB limit to stop provider I/O by 9 MiB, observed ${streams.unadvertised.bytesSent} bytes`);
    }
    if (!streams.unadvertised.closed) failures.push('expected the unadvertised oversized response to close');
    if (streams.advertised.bytesSent > chunkBytes * 2) failures.push('expected advertised oversize to stop before body download');
    if (!streams.advertised.closed) failures.push('expected the advertised oversized response to close');
    if (unadvertisedResult || advertisedResult) failures.push('expected oversized covers to be rejected');
    if (validResult?.buffer?.length !== 2048) failures.push('expected the below-limit cover bytes to be preserved');
    evidence.failures = failures;
    evidence.passed = failures.length === 0;
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(artifactPath, JSON.stringify(evidence, null, 2));
    assert.deepEqual(failures, [], failures.join('; '));
    console.log(`PASS search cover byte bound (${phase}): ${artifactPath}`);
  } finally {
    await closeServer(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runChildCase(childCase) {
  const childPhase = `${phase}-${childCase}`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--case', childCase, '--phase', childPhase], {
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${childCase} verification exited ${code}`)));
  });
  return JSON.parse(await fs.readFile(path.join(outputDir, `${childPhase}.json`), 'utf8'));
}

async function verifyAllCases() {
  const identity = await runChildCase('identity');
  const cover = await runChildCase('cover');
  const evidence = { phase, passed: identity.passed && cover.passed, identity, cover };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify(evidence, null, 2));
  assert.equal(evidence.passed, true);
  console.log(`PASS search resource lifecycle (${phase}): ${artifactPath}`);
}

(async () => {
  if (caseName === 'all') return verifyAllCases();
  if (caseName === 'cover') return verifyCoverByteBound();
  let server;
  const requests = [];
  let activeRequests = 0;
  let peakActiveRequests = 0;
  let resolverCalls = 0;
  let retryHttpRequests = 0;
  const startedAt = Date.now();
  const duplicate = result('Repeated Work', 'Shared Author', 'duplicate-1');
  const results = [
    duplicate,
    ...Array.from({ length: 3 }, (_, index) => ({ ...duplicate, hash: `duplicate-${index + 2}` })),
    result('Distinct Work Two', 'Author Two', 'distinct-2'),
    result('Distinct Work Three', 'Author Three', 'distinct-3'),
    result('Distinct Work Four', 'Author Four', 'distinct-4'),
    result('Distinct Work Five', 'Author Five', 'distinct-5')
  ];
  const catalog = [result('Fixture Query', '', 'query'), ...results];

  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/flaky-identity') {
        retryHttpRequests += 1;
        if (retryHttpRequests === 1) {
          res.writeHead(503, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'fixture unavailable' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          openLibraryWorkKey: '/works/OL_RETRY_W',
          title: 'Retry Work',
          primaryAuthor: 'Retry Author',
          confidence: { score: 0.95, level: 'high' },
          matchedFrom: 'fixture-retry'
        }));
      }
      activeRequests += 1;
      peakActiveRequests = Math.max(peakActiveRequests, activeRequests);
      const query = String(url.searchParams.get('q') || '').trim();
      const book = catalog.find(candidate =>
        query === candidate.title || query === `${candidate.title} ${candidate.author}`.trim()
      ) || result(query, '', 'unknown');
      requests.push({
        query,
        title: book.title,
        author: book.author,
        startedAtMs: Date.now() - startedAt
      });
      setTimeout(() => {
        activeRequests -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          docs: [{
            key: `/works/${Buffer.from(book.title).toString('hex').slice(0, 12)}W`,
            title: book.title,
            author_name: book.author ? [book.author] : [],
            edition_key: [`${Buffer.from(book.hash).toString('hex').slice(0, 12)}M`],
            language: ['eng']
          }]
        }));
      }, 40);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const resolveOpenLibraryIdentity = async input => {
      resolverCalls += 1;
      return resolveProductionIdentity(input, {
        timeoutMs: 1000,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: url => {
          const query = new URL(url).searchParams.get('q') || '';
          return fetch(`${origin}/openlibrary?q=${encodeURIComponent(query)}`);
        }
      });
    };
    const response = await buildCatalogSearchResponse({
      query: 'Fixture Query',
      language: 'en',
      results,
      sourceStatus: { fixture: { id: 'fixture', ok: true, count: results.length } },
      resolveOpenLibraryIdentity
    });

    const retryResults = [
      result('Retry Work', 'Retry Author', 'retry-1'),
      result('Retry Work', 'Retry Author', 'retry-2')
    ];
    const retryResolver = async input => {
      if (input.title === 'Retry Query') return { confidence: { score: 0, level: 'low' } };
      const retryResponse = await fetch(`${origin}/flaky-identity`);
      if (!retryResponse.ok) throw new Error(`fixture identity failed: ${retryResponse.status}`);
      return retryResponse.json();
    };
    const rejectedLookupResponse = await buildCatalogSearchResponse({
      query: 'Retry Query',
      results: retryResults,
      sourceStatus: {},
      resolveOpenLibraryIdentity: retryResolver
    });
    const retriedLookupResponse = await buildCatalogSearchResponse({
      query: 'Retry Query',
      results: retryResults,
      sourceStatus: {},
      resolveOpenLibraryIdentity: retryResolver
    });

    const evidence = {
      phase,
      passed: false,
      elapsedMs: Date.now() - startedAt,
      inputEditions: results.length,
      outputEditions: response.totalEditions,
      resolverCalls,
      providerHttpRequests: requests.length,
      peakActiveProviderRequests: peakActiveRequests,
      repeatedWorkProviderRequests: requests.filter(request =>
        request.query === 'Repeated Work' || request.query.includes('Shared Author')
      ).length,
      rejectedLookupEditions: rejectedLookupResponse.totalEditions,
      retryHttpRequests,
      retriedWorkKey: retriedLookupResponse.works[0]?.openLibraryWorkKey,
      requestStarts: requests
    };
    const failures = [];
    if (resolverCalls > 6) failures.push(`expected at most 6 identity resolutions, observed ${resolverCalls}`);
    if (requests.length > 16) failures.push(`expected at most 16 provider HTTP requests, observed ${requests.length}`);
    if (peakActiveRequests > 5) failures.push(`expected at most 5 concurrent provider requests, observed ${peakActiveRequests}`);
    if (evidence.repeatedWorkProviderRequests > 3) {
      failures.push(`expected three repeated-work searches, observed ${evidence.repeatedWorkProviderRequests}`);
    }
    if (response.totalEditions !== results.length) {
      failures.push(`expected ${results.length} output editions, observed ${response.totalEditions}`);
    }
    if (rejectedLookupResponse.totalEditions !== retryResults.length) {
      failures.push('expected a rejected shared lookup to preserve provider editions');
    }
    if (retryHttpRequests !== 2 || retriedLookupResponse.works[0]?.openLibraryWorkKey !== 'works/ol_retry_w') {
      failures.push('expected a new search request to retry a previously rejected shared lookup');
    }
    evidence.failures = failures;
    evidence.passed = failures.length === 0;
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(artifactPath, JSON.stringify(evidence, null, 2));
    assert.deepEqual(failures, [], failures.join('; '));
    console.log(`PASS search resource lifecycle (${phase}): ${artifactPath}`);
  } finally {
    await closeServer(server);
  }
})().catch(async error => {
  await fs.mkdir(outputDir, { recursive: true });
  try {
    const existing = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
    existing.passed = false;
    existing.error = error.message;
    await fs.writeFile(artifactPath, JSON.stringify(existing, null, 2));
  } catch {
    await fs.writeFile(artifactPath, JSON.stringify({ phase, passed: false, error: error.message }, null, 2));
  }
  console.error(`FAIL search resource lifecycle (${phase}): ${error.message}`);
  process.exitCode = 1;
});
