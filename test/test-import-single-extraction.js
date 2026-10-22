#!/usr/bin/env node
// A real upload must extract an EPUB once: validation, the quality check,
// persistence and the first open all share that extraction.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-single-extraction-'));
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.CACHE_DIR = path.join(testRoot, 'cache');
process.env.XANDRIO_PREGENERATE_ON_IMPORT = 'false';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.CACHE_DIR, { recursive: true });

// No outbound catalog or cover requests; every lookup fails immediately.
const remoteFetch = require('../lib/remote-fetch');
remoteFetch.requestRemote = async () => { throw new Error('network disabled in test'); };
const chapterExtraction = require('../lib/chapter-extraction');
const originalExtract = chapterExtraction.extractChapters;
let epubExtractions = 0;
chapterExtraction.extractChapters = async (...args) => {
  epubExtractions++;
  return originalExtract(...args);
};

const { createSyntheticImportEpub } = require('../scripts/lib/import-benchmark-fixtures');
const { app } = require('../server');

let passed = 0;
let failed = 0;

function test(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

(async () => {
  console.log('\n--- Single extraction per uploaded EPUB ---');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const epubPath = await createSyntheticImportEpub(fs.mkdtempSync(path.join(testRoot, 'fixture-')));
    const form = new FormData();
    form.append('epub', new Blob([fs.readFileSync(epubPath)]), 'synthetic-import.epub');
    const started = await fetch(`${base}/api/upload`, { method: 'POST', headers: { Prefer: 'respond-async' }, body: form });
    const { jobId } = await started.json();
    test(started.status === 202 && Boolean(jobId), 'the upload returns a trackable import job');

    let status;
    for (let attempt = 0; attempt < 600; attempt++) {
      status = await (await fetch(`${base}/api/download/${jobId}/status`)).json();
      if (status.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    test(status?.status === 'complete', `the import completes (${status?.status}: ${status?.error?.error || ''})`);
    test(epubExtractions === 1, `the import extracts the EPUB once (${epubExtractions})`);

    const bookId = status?.result?.bookId;
    const opened = await fetch(`${base}/api/book/${encodeURIComponent(bookId)}`);
    const body = await opened.json();
    test(opened.status === 200 && Array.isArray(body.chapters) && body.chapters.length > 0,
      'the imported book opens with its chapters');
    test(epubExtractions === 1, `the first open reuses the import extraction (${epubExtractions})`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    chapterExtraction.extractChapters = originalExtract;
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
