#!/usr/bin/env node
// Re-importing a book the reader already has must return that book, never
// replace or delete its files, and never rewrite its library record. Two
// identical download requests sent together must share one import job.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-owned-import-'));
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.CACHE_DIR = path.join(testRoot, 'cache');
process.env.XANDRIO_PREGENERATE_ON_IMPORT = 'false';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.CACHE_DIR, { recursive: true });

const remoteFetch = require('../lib/remote-fetch');
remoteFetch.requestRemote = async () => { throw new Error('network disabled in test'); };

// Every Gutenberg "download" copies the file the test chooses.
const gutenberg = require('../lib/gutenberg');
let nextDownload = null;
let downloads = 0;
let downloadGate = null;
gutenberg.isEnabled = () => true;
gutenberg.downloadBook = async (_id, _url, destPath) => {
  downloads++;
  if (downloadGate) await downloadGate;
  fs.copyFileSync(nextDownload, destPath);
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

function readBooks() {
  return JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'books.json'), 'utf8'));
}

function liveFiles(record) {
  return [...new Set([record.path, record.extractedArtifact, record.sourcePath, record.retainedSourcePath]
    .filter(Boolean))];
}

(async () => {
  console.log('\n--- Re-importing an owned book ---');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const startImport = hash => fetch(`${base}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hash, filename: 'owned.epub', title: 'Owned Book', source: 'gutenberg',
      gutenbergId: '1', downloadUrl: 'https://www.gutenberg.org/ebooks/1.epub'
    })
  }).then(async response => ({ status: response.status, body: await response.json() }));
  const waitForJob = async jobId => {
    let status;
    for (let attempt = 0; attempt < 600; attempt++) {
      status = await (await fetch(`${base}/api/download/${jobId}/status`)).json();
      if (status.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return status;
  };

  try {
    nextDownload = await createSyntheticImportEpub(fs.mkdtempSync(path.join(testRoot, 'fixture-')));
    const first = await startImport('owned-book');
    const firstStatus = await waitForJob(first.body.jobId);
    test(firstStatus?.status === 'complete',
      `the first import completes (${firstStatus?.status}: ${firstStatus?.error?.error || ''})`);

    // Fields set after import that a wholesale refresh would erase.
    const booksFile = path.join(process.env.DATA_DIR, 'books.json');
    const books = readBooks();
    books['owned-book'].coverSource = 'manual';
    books['owned-book'].studyGuideCategory = 'fiction';
    fs.writeFileSync(booksFile, JSON.stringify(books));
    const before = readBooks()['owned-book'];
    const filesBefore = new Map(liveFiles(before).map(file => [file, fs.readFileSync(file)]));
    test(filesBefore.size > 0, 'the imported book has files on disk');

    // The re-download is not a valid book: before the fix it replaced the live
    // source and then deleted it as a failed candidate.
    const invalid = path.join(testRoot, 'invalid.epub');
    fs.writeFileSync(invalid, 'not an EPUB archive');
    nextDownload = invalid;
    const downloadsBefore = downloads;
    const second = await startImport('owned-book');
    const secondStatus = await waitForJob(second.body.jobId);
    test(secondStatus?.error?.existingBookId === 'owned-book',
      `the re-import reports the existing book (${secondStatus?.status}: ${JSON.stringify(secondStatus?.error)})`);
    test(downloads === downloadsBefore, 'the re-import does not download the book again');
    for (const [file, content] of filesBefore) {
      test(fs.existsSync(file) && fs.readFileSync(file).equals(content),
        `the live file ${path.basename(file)} is unchanged`);
    }
    test(JSON.stringify(readBooks()['owned-book']) === JSON.stringify(before),
      'the library record is unchanged (addedAt, cover source and guide category kept)');

    console.log('\n--- Identical download requests sent together ---');
    let openGate;
    downloadGate = new Promise(resolve => { openGate = resolve; });
    nextDownload = invalid;
    const pair = await Promise.all([startImport('double-book'), startImport('double-book')]);
    test(pair.every(result => result.status === 202) && pair[0].body.jobId === pair[1].body.jobId,
      `both requests share one import job (${pair.map(result => result.body.jobId).join(', ')})`);
    openGate();
    downloadGate = null;
    await Promise.all(pair.map(result => waitForJob(result.body.jobId)));
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
