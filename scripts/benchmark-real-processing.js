#!/usr/bin/env node
'use strict';

// Local real-book regression gate. Golden hashes describe the reviewed baseline;
// independently checked source passages/verse/pages are a separate, narrower
// source-truth gate. This runner never downloads, calls models, or updates goldens.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { evaluateBakeoffVersion } = require('./lib/import-bakeoff-evaluator');
const { normalizedNarrationText } = require('../lib/extraction-result');
const { parseEpub } = require('../lib/epub-parser');
const { getChapterHtml } = require('../lib/chapter-extraction');
const { createBookDocument } = require('../lib/book-document');

const root = path.resolve(__dirname, '..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = text => String(text).normalize('NFKC').replace(/\s+/gu, ' ').trim();
const exactText = chapters => chapters.map(chapter => chapter.text || '').join('\n\n');
const check = (id, passed) => ({ id, passed: Boolean(passed) });
let externalCalls = 0;
function disableNetwork(onAttempt) {
  const denied = () => { onAttempt(); throw new Error('External calls are disabled in the real processing benchmark'); };
  globalThis.fetch = denied;
  for (const name of ['node:http', 'node:https']) {
    const transport = require(name);
    transport.request = denied;
    transport.get = denied;
  }
  const net = require('node:net');
  net.connect = denied;
  net.createConnection = denied;
  net.Socket.prototype.connect = denied;
  require('node:tls').connect = denied;
  require('node:dgram').createSocket = denied;
}
disableNetwork(() => { externalCalls++; });

function argumentsFor(argv) {
  const options = { manifest: path.join(root, 'test/fixtures/processing-real-corpus.json'),
    output: path.join(root, 'output/playback-processing',
      `real-processing-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`), sourceRoot: root };
  for (let i = 0; i < argv.length; i++) {
    const key = { '--manifest': 'manifest', '--output': 'output', '--source-root': 'sourceRoot', '--case': 'case' }[argv[i]];
    if (!key || !argv[i + 1]) throw new Error('Usage: benchmark-real-processing.js [--manifest file] [--source-root directory] [--case id] [--output file]');
    options[key] = key === 'case' ? argv[++i] : path.resolve(argv[++i]);
  }
  return options;
}

function unsafeReport() {
  return Object.assign(new Error('REPORT_OUTPUT_UNSAFE'), { code: 'REPORT_OUTPUT_UNSAFE' });
}

function contains(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalPath(filename) {
  let current = path.resolve(filename);
  const suffix = [];
  for (;;) {
    try { await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) throw unsafeReport();
      suffix.unshift(path.basename(current));
      current = path.dirname(current);
      continue;
    }
    try { return path.join(await fs.realpath(current), ...suffix); }
    catch { throw unsafeReport(); }
  }
}

async function safeReportPath(filename, directories) {
  const absolute = path.resolve(filename);
  try {
    await fs.lstat(absolute);
    throw unsafeReport();
  } catch (error) {
    if (error.code !== 'ENOENT') throw unsafeReport();
  }
  const canonical = await canonicalPath(absolute);
  if (path.extname(canonical).toLowerCase() !== '.json' ||
      directories.some(directory => contains(directory, absolute) || contains(directory, canonical))) throw unsafeReport();
  return canonical;
}

async function writeReport(filename, directories, report) {
  const canonical = await safeReportPath(filename, directories);
  await fs.mkdir(path.dirname(canonical), { recursive: true });
  if (await safeReportPath(canonical, directories) !== canonical) throw unsafeReport();
  const handle = await fs.open(canonical, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

function validManifest(manifest) {
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const https = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };
  if (manifest?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.baselineRevision || '') ||
      !manifest.referenceContract || !Array.isArray(manifest.cases) || !manifest.cases.length) return false;
  const ids = new Set();
  return manifest.cases.every(row => {
    if (!row?.id || ids.has(row.id)) return false;
    ids.add(row.id);
    return /^[a-z0-9-]+$/.test(row.id) && typeof row.source === 'string' && !path.isAbsolute(row.source) &&
      !row.source.split(/[\\/]/).includes('..') && ['epub', 'mobi', 'pdf'].includes(row.format) &&
      /^[a-z]{2}$/.test(row.language || '') && row.feature && row.rights && https(row.sourceUrl) && https(row.sourcePage) &&
      sha(row.sourceSha256) && Number.isInteger(row.sourceBytes) && row.sourceBytes > 0 &&
      sha(row.expected?.normalizedHash) && sha(row.expected?.exactTextHash) &&
      Number.isInteger(row.expected?.chapterCount) && row.expected.chapterCount > 0 &&
      row.referenceVerification && Array.isArray(row.references) && row.references.length && row.references.every(reference =>
        ['passage', 'verse', 'footnote', 'page'].includes(reference.kind) &&
        Number.isInteger(reference.occurrences) && reference.occurrences > 0 &&
        (reference.kind === 'verse' ? Array.isArray(reference.lines) && reference.lines.length > 1 && reference.lines.every(line => typeof line === 'string' && line.trim())
          : typeof reference.text === 'string' && reference.text.trim()) &&
        (row.format === 'pdf' ? reference.sourceUnit?.kind === 'scanned-page' && Number.isInteger(reference.sourceUnit.pageNumber) && reference.sourceUnit.pageNumber > 0
          : reference.sourceUnit?.kind === `${row.format}-spine` && typeof reference.sourceUnit.id === 'string'));
  });
}

function referencePositions(text, reference) {
  if (reference.kind === 'verse') {
    const lines = String(text).normalize('NFKC').split('\n').map(line => line.trim());
    const wanted = reference.lines.map(line => line.normalize('NFKC').trim());
    const positions = [];
    for (let i = 0; i <= lines.length - wanted.length; i++) {
      if (wanted.every((line, offset) => lines[i + offset] === line)) positions.push(i);
    }
    return positions;
  }
  const haystack = normalized(text), needle = normalized(reference.text);
  const positions = [];
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) positions.push(i);
  return positions;
}

function sourceMarkupText(html) {
  let text = String(html || ''), previous;
  // Complete markup removal without applying production text repair. A removed
  // fragment must not leave another tag for a later consumer to interpret.
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text;
}

async function referenceSourceUnits(source, row, artifact, temporary) {
  const units = new Map();
  if (row.format === 'epub') {
    const epub = await parseEpub(source);
    for (const reference of row.references) {
      const id = reference.sourceUnit.id;
      if (units.has(id)) continue;
      // Preserve authored line breaks. This source oracle removes markup only;
      // it does not invoke extraction repair, partitioning or speech preparation.
      const html = await getChapterHtml(epub, id);
      units.set(id, sourceMarkupText(html));
    }
  } else if (row.format === 'mobi') {
    const { initMobiFile } = await import('@lingo-reader/mobi-parser');
    const resources = path.join(temporary, 'reference-resources');
    await fs.mkdir(resources);
    const parser = await initMobiFile(source, resources);
    try {
      for (const reference of row.references) {
        const id = reference.sourceUnit.id;
        const spine = parser.getSpine().find(item => String(item.id) === id);
        if (spine) units.set(id, sourceMarkupText(parser.loadChapter(spine.id).html));
      }
    } finally { parser.destroy?.(); }
  } else {
    for (const page of artifact.sourceDocument?.pages || []) units.set(String(page.pageNumber), page.text);
  }
  return units;
}

function freshProcessRoundtrip(filename) {
  const code = `
    const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
    let calls=0; (${disableNetwork.toString()})(()=>{calls++;});
    (async()=>{
      const root=process.argv[1],filename=process.argv[2];
      const {createBookDocument}=require(path.join(root,'lib/book-document'));
      const {createXBookStore}=require(path.join(root,'lib/xbook-store'));
      const {normalizedNarrationText}=require(path.join(root,'lib/extraction-result'));
      const store=createXBookStore({cacheDir:path.dirname(filename),xbookVersion:2,getFileIdentity:async p=>{const s=await fs.stat(p);return {mtimeMs:s.mtimeMs,size:s.size};}});
      const doc=createBookDocument({getXBookStore:()=>store,log:{log(){},warn(){},error(){}}});
      const chapters=await doc.extractChapters(filename);
      const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
      console.log(JSON.stringify({normalizedHash:hash(normalizedNarrationText(chapters)),exactTextHash:hash(chapters.map(c=>c.text||'').join('\\n\\n')),chapterCount:chapters.length,externalCalls:calls}));
    })().catch(()=>process.exitCode=1);
  `;
  const result = spawnSync(process.execPath, ['-e', code, root, filename], { encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw new Error('Fresh process artifact read failed');
  return JSON.parse(result.stdout.trim());
}

(async () => {
  const options = argumentsFor(process.argv.slice(2));
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(options.manifest, 'utf8')); } catch {}
  const directories = new Set([path.join(root, 'data'), path.join(root, 'cache'), path.join(root, 'test'),
    path.join(options.sourceRoot, 'data'), path.join(options.sourceRoot, 'cache')]);
  for (const row of Array.isArray(manifest?.cases) ? manifest.cases : []) {
    if (typeof row?.source !== 'string') continue;
    const filename = path.resolve(options.sourceRoot, row.source);
    directories.add(path.dirname(filename));
    for (const candidate of [filename, filename.replace(/\.[^.]+$/i, '.chapters.json')]) {
      const resolved = await fs.realpath(candidate).catch(() => null);
      if (resolved) directories.add(path.dirname(resolved));
    }
  }
  // Protect canonical aliases as well as lexical paths, including source files
  // reached through symlinks. Existing reports/manifests are never replaced.
  for (const directory of [...directories]) directories.add(await canonicalPath(directory));
  const output = await safeReportPath(options.output, [...directories]);
  const report = { schemaVersion: 1, passed: false, createdAt: new Date().toISOString(),
    scope: 'Production importer and disk artifacts in scratch storage; no browser UI or physical-device claim',
    checks: [], cases: [], externalCalls: 0 };
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-real-processing-'));
  try {
    const valid = validManifest(manifest) && (!options.case || manifest.cases.some(row => row.id === options.case));
    report.checks.push(check('manifest-valid', valid));
    if (!valid) return;
    report.baselineRevision = manifest.baselineRevision;
    report.manifestSha256 = hash(await fs.readFile(options.manifest));
    report.referenceContract = manifest.referenceContract;
    report.selection = options.case || 'complete-corpus';
    report.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    report.workingTreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
    report.implementationHashes = Object.fromEntries(await Promise.all([
      'scripts/benchmark-real-processing.js', 'scripts/lib/import-bakeoff-evaluator.js',
      'lib/book-document.js', 'lib/chapters/partitioning.js', 'lib/chapters/text-sanitization.js',
      'lib/chapter-extraction.js', 'lib/kindle-extraction.js', 'lib/pdf-extraction.js'
    ].map(async relative => [relative, hash(await fs.readFile(path.join(root, relative)))])));
    for (const row of manifest.cases.filter(row => !options.case || row.id === options.case)) {
      const result = { id: row.id, format: row.format, language: row.language, feature: row.feature, checks: [] };
      report.cases.push(result);
      const source = path.resolve(options.sourceRoot, row.source);
      const bytes = await fs.readFile(source).catch(() => null);
      result.checks.push(check('source-available', bytes));
      if (!bytes) { result.status = 'unavailable'; continue; }
      result.checks.push(check('source-checksum', bytes.length === row.sourceBytes && hash(bytes) === row.sourceSha256));
      if (!result.checks.at(-1).passed) { result.status = 'source-drift'; continue; }
      const scratch = path.join(temporary, row.id);
      try {
        const evaluated = await evaluateBakeoffVersion({ versionRoot: root, scratchRoot: scratch,
          cases: [{ id: row.id, format: row.format, path: source, minimumNormalizedChars: 1 }],
          evaluateUx: async () => ({ skipped: true, reason: 'Processing gate; no UI claim' }) });
        result.checks.push(check('importable', evaluated.cases[0].importable && evaluated.cases[0].narrationValid));
        const cache = path.join(scratch, 'cache');
        if (row.format === 'epub') {
          // EPUB imports retain the original; the application creates its disk
          // chapter cache on first read. Exercise that actual persistence path.
          await createBookDocument({ log: { log() {}, warn() {}, error() {} } })
            .getChaptersCached(path.join(cache, 'bakeoff-1.epub'));
        }
        const artifactName = row.format === 'epub' ? 'bakeoff-1.chapters.json' : 'bakeoff-1.xbook.json';
        const artifact = JSON.parse(await fs.readFile(path.join(cache, artifactName), 'utf8'));
        const chapters = artifact.chapters;
        result.checks.push(check('persisted-artifact', Array.isArray(chapters) && chapters.length > 0));
        result.normalizedHash = hash(normalizedNarrationText(chapters));
        result.exactTextHash = hash(exactText(chapters));
        result.checks.push(check('normalized-text', result.normalizedHash === row.expected.normalizedHash));
        result.checks.push(check('exact-text', result.exactTextHash === row.expected.exactTextHash));
        result.checks.push(check('chapter-count', chapters.length === row.expected.chapterCount));
        const units = await referenceSourceUnits(source, row, artifact, scratch);
        const text = exactText(chapters);
        let lastPosition = -1;
        for (const reference of row.references) {
          const unitId = String(reference.sourceUnit.id ?? reference.sourceUnit.pageNumber);
          const sourceMatches = referencePositions(units.get(unitId) || '', reference);
          const positions = referencePositions(text, reference);
          result.checks.push(check('source-reference', sourceMatches.length > 0));
          result.checks.push(check('reference-occurrences', positions.length === reference.occurrences));
          result.checks.push(check('reference-order', positions.length > 0 && positions[0] > lastPosition));
          if (positions.length) lastPosition = positions[0];
          if (reference.chapterTitle) {
            const matching = chapters.filter(chapter => chapter.title === reference.chapterTitle);
            result.checks.push(check('reference-chapter', matching.length === 1 && referencePositions(matching[0].text, reference).length === reference.occurrences));
          }
        }
        const persistedPath = path.join(cache, row.format === 'epub' ? 'bakeoff-1.epub' : artifactName);
        const roundtrip = freshProcessRoundtrip(persistedPath);
        externalCalls += roundtrip.externalCalls;
        result.checks.push(check('fresh-process-roundtrip', roundtrip.normalizedHash === result.normalizedHash &&
          roundtrip.exactTextHash === result.exactTextHash && roundtrip.chapterCount === chapters.length));
        result.status = result.checks.every(value => value.passed) ? 'passed' : 'failed';
      } catch (error) {
        result.checks.push(check('processing-completed', false));
        result.status = 'failed';
        result.errorCode = error.code || error.name;
      }
      result.passed = result.checks.every(value => value.passed);
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${row.id}: ${result.checks.filter(value => !value.passed).map(value => value.id).join(', ') || 'all gates'}`);
    }
    report.checks.push(check('no-external-calls', externalCalls === 0));
    report.passed = report.cases.length > 0 && report.checks.every(value => value.passed) &&
      report.cases.every(row => row.checks.length > 0 && row.checks.every(value => value.passed));
  } finally {
    report.externalCalls = externalCalls;
    try { await writeReport(output, [...directories], report); }
    finally { await fs.rm(temporary, { recursive: true, force: true }); }
    console.log(`Evidence: ${output}`);
    if (!report.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
