#!/usr/bin/env node
'use strict';

// Collect actual production extractor output before labeling or model evaluation.
// This performs no inference and does not modify source books.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const pdf = require('../lib/pdf-extraction').__test;
const kindle = require('../lib/kindle-extraction').__test;
const { createBookDocument } = require('../lib/book-document');

async function collect(filename) {
  const sourcePath = path.resolve(filename);
  const format = path.extname(sourcePath).slice(1).toLowerCase();
  const bytes = await fs.readFile(sourcePath);
  const started = performance.now();
  const document = createBookDocument({ log: { log() {}, warn() {}, error() {} } });
  const result = {
    source: path.basename(sourcePath), format,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    collectedAt: new Date().toISOString(),
    nodeVersion: process.version
  };
  if (format === 'pdf') {
    const info = await pdf.readPdfInfo(sourcePath);
    const extraction = await pdf.runPdfExtractionCandidates(sourcePath, path.basename(sourcePath), fs, info);
    result.candidates = extraction.candidates;
    result.selected = extraction.selected.name;
    result.status = extraction.status;
    result.sourceDocument = extraction.sourceDocument;
  } else if (['azw3', 'mobi', 'azw', 'prc'].includes(format)) {
    const candidates = [];
    for (const spec of kindle.buildKindleCandidateSpecs(format)) {
      candidates.push(await kindle.runKindleExtractionCandidate(sourcePath, path.basename(sourcePath), spec, { format }));
    }
    const ranked = kindle.selectKindleExtractionCandidate(candidates);
    result.candidates = ranked.candidates;
    result.selected = ranked.selected?.name;
    result.status = kindle.classifyKindleExtractionStatus(ranked.selected);
  }
  try {
    // Includes real format-specific classification and sequence normalization.
    const imported = await document.extractResult(sourcePath);
    result.import = imported;
  } catch (error) {
    result.importError = { code: error.code, message: error.message };
  }
  result.elapsedMs = performance.now() - started;
  const output = `${sourcePath}.extraction.json`;
  await fs.writeFile(output, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  return {
    output, elapsedMs: result.elapsedMs,
    chapters: result.import?.chapters?.length, importError: result.importError,
    candidates: result.candidates?.map(c => ({ name: c.name, ok: c.ok, score: c.quality?.score, chars: c.quality?.stats?.totalChars })),
    selected: result.selected
  };
}

if (require.main === module) {
  (async () => {
    if (!process.argv[2]) throw new Error('Usage: node scripts/collect-real-book-judgments.js <book> [...]');
    for (const filename of process.argv.slice(2)) console.log(JSON.stringify(await collect(filename)));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { collect };
