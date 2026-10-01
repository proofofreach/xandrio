#!/usr/bin/env node
'use strict';

// Read-only evidence gathering. A matching historical rewrite is not a repair
// authorization: saved positions still need a separately proven correction map.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HISTORICAL_REVISION = '6cc4d30e5cd445020aa45351c276720bd6afee95';
// Reviewed against HISTORICAL_REVISION: preparation and both dependencies are
// identical; splitOversizedText only delegates its unchanged boundary loop to
// splitSourceText. Pin the entire current files, including constants and helpers.
// Future speech changes disable replay until that equivalence is reviewed again.
const TRANSFORM_PINS = Object.freeze({
  'lib/tts-text.js': 'dcb613eba068e100fc40597dfc797444290b36bcca2ca42606bef0ccf8b53716',
  'lib/tts-number-words.js': '3fc019fd4c2b6e7aab201f904fc72733c2fa01b99747d9ba265c61b217bed917',
  'lib/tts-legal-text.js': 'a5a8da978e905e68f55729ec43b0eae92592debb5fb475f1620409ccba801024'
});
const CLASSIFICATIONS = [
  'source-preserved', 'known-legacy-rewrite', 'unexplained-mismatch',
  'source-unavailable', 'unsupported-transform'
];

function auditError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function opaqueId(value) {
  return digest(`xandrio-legacy-partition-audit-v1:${value}`).slice(0, 12);
}

function normalizedText(chapters) {
  return chapters.map(chapter => chapter.text).join('\n\n').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function argumentsFor(argv) {
  const args = {
    dataDir: path.join(ROOT, 'data'),
    output: path.join(ROOT, 'output/playback-processing',
      `legacy-partition-audit-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`)
  };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help' || argv[index] === '-h') return { help: true };
    if (!['--data-dir', '--output'].includes(argv[index]) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw auditError('AUDIT_ARGUMENTS_INVALID');
    }
    args[argv[index] === '--data-dir' ? 'dataDir' : 'output'] = path.resolve(argv[++index]);
  }
  return args;
}

function contains(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Resolve the existing ancestor without creating anything. A dangling symlink
// is not a trusted output ancestor and is refused rather than followed later.
async function canonicalDestination(filename) {
  let current = path.resolve(filename);
  const suffix = [];
  for (;;) {
    try {
      await fs.lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) throw auditError('AUDIT_OUTPUT_UNSAFE');
      suffix.unshift(path.basename(current));
      current = path.dirname(current);
      continue;
    }
    try {
      return path.join(await fs.realpath(current), ...suffix);
    } catch {
      throw auditError('AUDIT_OUTPUT_UNSAFE');
    }
  }
}

function inputPath(value) {
  return typeof value === 'string' && value && !value.includes('\0') ? path.resolve(ROOT, value) : null;
}

async function protectedDirectories(dataDir, books) {
  const directories = new Set([path.resolve(dataDir), path.join(ROOT, 'data'), path.join(ROOT, 'cache')]);
  for (const book of books) {
    for (const value of [book.path, book.sourcePath, book.retainedSourcePath]) {
      const filename = inputPath(value);
      if (!filename) continue;
      directories.add(path.dirname(filename));
      // A retained source or its cache may itself be a symlink to another
      // location. Protect that location as well as the path in the manifest.
      for (const candidate of [filename, filename.replace(/\.[^.]+$/i, '.chapters.json')]) {
        const resolved = await fs.realpath(candidate).catch(() => null);
        if (resolved) directories.add(path.dirname(resolved));
      }
    }
  }
  for (const directory of [...directories]) directories.add(await canonicalDestination(directory));
  return [...directories];
}

async function safeOutput(filename, directories) {
  const absolute = path.resolve(filename);
  // Never replace an existing report, data file, hard link, or final symlink.
  try {
    await fs.lstat(absolute);
    throw auditError('AUDIT_OUTPUT_UNSAFE');
  } catch (error) {
    if (error.code !== 'ENOENT') throw auditError('AUDIT_OUTPUT_UNSAFE');
  }
  const canonical = await canonicalDestination(absolute);
  if (path.extname(canonical).toLowerCase() !== '.json' ||
      directories.some(directory => contains(directory, absolute) || contains(directory, canonical))) {
    throw auditError('AUDIT_OUTPUT_UNSAFE');
  }
  return canonical;
}

async function writeReport(filename, directories, report) {
  const canonical = await safeOutput(filename, directories);
  await fs.mkdir(path.dirname(canonical), { recursive: true });
  // Recheck after directory creation; write to the resolved path, not a user
  // supplied symlink alias. O_EXCL and O_NOFOLLOW prevent replacing any file.
  if (await safeOutput(canonical, directories) !== canonical) throw auditError('AUDIT_OUTPUT_UNSAFE');
  let handle;
  try {
    handle = await fs.open(canonical, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function supportedTransform() {
  for (const [relative, expected] of Object.entries(TRANSFORM_PINS)) {
    try {
      if (digest(await fs.readFile(path.join(ROOT, relative))) !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function disableNetwork() {
  const denied = () => { throw auditError('AUDIT_NETWORK_DISABLED'); };
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

// The historical partitioning policy is only these thresholds and part
// assignments. Extraction is fresh; EPUB sequence normalization changes display
// metadata, not the text/identities compared here. Speech preparation remains
// in the pinned production splitter instead of a copied historical module.
function partitionForEvidence(chapters, splitter) {
  const result = [];
  for (const chapter of chapters) {
    const text = chapter.text.trim();
    const threshold = (chapter.fromToc || chapter.authoredBoundary) && String(chapter.title || '').trim()
      ? 150000 : 100000;
    const parts = text.length > threshold ? splitter(text, 90000) : [];
    if (parts.length < 2 || parts.some(part => part.length > 100000)) {
      result.push({ ...chapter, index: result.length });
      continue;
    }
    for (let index = 0; index < parts.length; index++) {
      result.push({
        ...chapter,
        index: result.length,
        text: parts[index],
        sourceTitle: chapter.sourceTitle || chapter.title,
        sourceChapterIndex: chapter.sourceChapterIndex ?? chapter.index,
        splitFromOversizedChapter: true,
        splitPart: index + 1,
        splitPartCount: parts.length
      });
    }
  }
  return result;
}

function samePartition(actual, expected) {
  if (actual.length !== expected.length) return false;
  return expected.every((chapter, index) => {
    const stored = actual[index];
    if (stored.index !== index || !Number.isInteger(chapter.originalIndex) || chapter.originalIndex < 0 ||
        stored.originalIndex !== chapter.originalIndex) return false;
    for (const field of ['sourceSpineId', 'sourceHref', 'sourceChapterIndex']) {
      if ((stored[field] ?? null) !== (chapter[field] ?? null)) return false;
    }
    if (Boolean(stored.splitFromOversizedChapter) !== Boolean(chapter.splitFromOversizedChapter)) return false;
    if (chapter.splitFromOversizedChapter) {
      if (stored.splitFromOversizedChapter !== true || stored.splitPart !== chapter.splitPart ||
          stored.splitPartCount !== chapter.splitPartCount || stored.sourceTitle !== chapter.sourceTitle) return false;
    } else if (stored.splitPart != null || stored.splitPartCount != null) return false;
    return normalizedText([stored]) === normalizedText([chapter]);
  });
}

function sameFileState(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

async function quietExtraction(extract, sourcePath) {
  const methods = ['log', 'warn', 'error', 'info', 'debug'];
  const saved = new Map(methods.map(method => [method, console[method]]));
  for (const method of methods) console[method] = () => {};
  try {
    return await extract(sourcePath);
  } finally {
    for (const [method, original] of saved) console[method] = original;
  }
}

async function auditBook(book, { extractChapters, splitOversizedText, splitSourceText }) {
  const record = { id: opaqueId(book.id) };
  const outcome = (classification, reason, extra = {}) => ({ ...record, classification, reason, ...extra });
  const sourcePath = inputPath(book.path);
  const cachePath = sourcePath.replace(/\.[^.]+$/i, '.chapters.json');
  let cacheBefore;
  let artifact;
  try {
    cacheBefore = await fs.stat(cachePath, { bigint: true });
    if (!cacheBefore.isFile()) return outcome('unexplained-mismatch', 'cache-not-regular-file');
    artifact = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  } catch (error) {
    return error.code === 'ENOENT'
      ? outcome('source-unavailable', 'persisted-cache-unavailable')
      : outcome('unexplained-mismatch', 'persisted-cache-unreadable');
  }
  if (!Number.isInteger(artifact?._cacheVersion) || !Array.isArray(artifact.chapters) || !artifact.chapters.length ||
      artifact.chapters.some(chapter => !chapter || typeof chapter.text !== 'string')) {
    return outcome('unexplained-mismatch', 'invalid-cache-schema');
  }
  const cached = artifact.chapters;
  record.cacheVersion = artifact._cacheVersion;
  record.cachedChapters = cached.length;
  record.oversizedParts = cached.filter(chapter => chapter.splitFromOversizedChapter === true).length;
  let sourceBefore;
  let raw;
  try {
    sourceBefore = await fs.stat(sourcePath, { bigint: true });
    if (!sourceBefore.isFile()) return outcome('source-unavailable', 'source-not-regular-file');
    raw = await quietExtraction(extractChapters, sourcePath);
    if (!Array.isArray(raw) || !raw.length || raw.some(chapter => !chapter || typeof chapter.text !== 'string')) {
      return outcome('source-unavailable', 'source-unreadable');
    }
    const [sourceAfter, cacheAfter] = await Promise.all([
      fs.stat(sourcePath, { bigint: true }), fs.stat(cachePath, { bigint: true })
    ]);
    if (!sameFileState(sourceBefore, sourceAfter) || !sameFileState(cacheBefore, cacheAfter)) {
      return outcome('unexplained-mismatch', 'inputs-changed-during-audit');
    }
  } catch {
    return outcome('source-unavailable', 'source-unavailable-or-unreadable');
  }
  record.sourceChapters = raw.length;
  const historical = partitionForEvidence(raw, splitOversizedText);
  const current = partitionForEvidence(raw, splitSourceText);
  const cachedText = normalizedText(cached);
  const sourceText = normalizedText(raw);
  record.cachedNormalizedChars = cachedText.length;
  record.sourceNormalizedChars = sourceText.length;
  const historicalMatch = samePartition(cached, historical) && cachedText === normalizedText(historical);
  if (cachedText === sourceText && (samePartition(cached, current) || historicalMatch)) {
    return outcome('source-preserved', 'exact-normalized-source-and-partition-match');
  }
  if (record.oversizedParts > 0 && historicalMatch && sourceText !== cachedText) {
    return outcome('known-legacy-rewrite', 'exact-historical-parts-and-stream-match');
  }
  return outcome('unexplained-mismatch', 'source-or-historical-partition-mismatch');
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node scripts/audit-legacy-partition.js [--data-dir <library-data>] [--output <new-report.json>]\n' +
      'Read-only retained EPUB/cache audit. It never repairs books. Default reports go to output/playback-processing/.\n');
    return;
  }
  let books;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(args.dataDir, 'books.json'), 'utf8'));
    if (!raw || typeof raw !== 'object') throw new Error('invalid manifest');
    const entries = Array.isArray(raw) ? raw.map((book, index) => [String(index), book]) : Object.entries(raw);
    books = entries.map(([key, book]) => {
      if (!book || typeof book !== 'object' || Array.isArray(book)) throw new Error('invalid book');
      return { ...book, id: String(book.id ?? key) };
    });
    if (new Set(books.map(book => book.id)).size !== books.length) throw new Error('duplicate identity');
  } catch {
    throw auditError('AUDIT_LIBRARY_UNREADABLE');
  }
  const directories = await protectedDirectories(args.dataDir, books);
  const output = await safeOutput(args.output, directories);
  const eligible = books.filter(book => inputPath(book.path) && /\.epub$/i.test(book.path));
  let transformSupported = await supportedTransform();
  let records = [];
  if (transformSupported) {
    disableNetwork();
    // Use only the pure EPUB extractor and pinned splitters. Loading the server,
    // document cache service or importer could migrate artifacts or call providers.
    const { extractChapters } = require('../lib/chapter-extraction');
    const { splitOversizedText, splitSourceText } = require('../lib/tts-text');
    for (const book of eligible) records.push(await auditBook(book, { extractChapters, splitOversizedText, splitSourceText }));
    transformSupported = await supportedTransform();
  }
  if (!transformSupported) {
    records = eligible.map(book => ({ id: opaqueId(book.id), classification: 'unsupported-transform', reason: 'reviewed-transform-fingerprint-mismatch' }));
  }
  const report = {
    schemaVersion: 1,
    audit: 'legacy-oversized-epub-partition',
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    historicalRevision: HISTORICAL_REVISION,
    transformSupported,
    completed: transformSupported,
    scope: 'Retained EPUB files and persisted chapter caches; normalized text and ordered part identities only',
    repairsImplemented: false,
    skippedUnsupportedBooks: books.length - eligible.length,
    counts: Object.fromEntries(CLASSIFICATIONS.map(classification => [classification,
      records.filter(record => record.classification === classification).length])),
    records
  };
  await writeReport(output, directories, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!transformSupported) process.exitCode = 2;
}

main().catch(error => {
  // Parser and filesystem errors can contain private filenames or book text.
  const allowed = new Set(['AUDIT_ARGUMENTS_INVALID', 'AUDIT_LIBRARY_UNREADABLE', 'AUDIT_OUTPUT_UNSAFE']);
  process.stderr.write(`${allowed.has(error.code) ? error.code : 'AUDIT_FAILED'}\n`);
  process.exitCode = 2;
});
