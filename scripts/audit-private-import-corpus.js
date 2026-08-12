#!/usr/bin/env node

/**
 * One-time local migration gate for recent private imports.
 *
 * Output is deliberately opaque: no title, author, path, filename, text,
 * diagnostic evidence, or content hash is printed.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { createBookDocument } = require('../lib/book-document');
const { chapterStructureKey } = require('../lib/chapter-structure');
const { createExtractionResult, isExtractionImportable } = require('../lib/extraction-result');

const root = path.join(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const booksFile = path.join(dataDir, 'books.json');
const requestedLimit = Number(process.argv[2] || 5);
const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 5;
const RAW_HTML_TAG = /<\/?(?:html|head|body|title|meta|link|style|script|section|article|aside|nav|main|header|footer|p|div|span|h[1-6]|ol|ul|li|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|code|a|img|picture|figure|figcaption|br|hr|em|strong|b|i|u|sup|sub)\b[^>]*>/i;

function token(bookId) {
  return crypto.createHash('sha256')
    .update(`xandrio-private-import-audit-v1:${String(bookId || '')}`)
    .digest('hex')
    .slice(0, 12);
}

function artifactStore() {
  return {
    isXBookPath: filePath => /\.xbook\.json$/i.test(filePath || ''),
    async readXBookArtifact(filePath) {
      const artifact = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!Number.isInteger(artifact?._xbookVersion) || !Array.isArray(artifact?.chapters)) {
        throw new Error('invalid-xbook-artifact');
      }
      return artifact;
    }
  };
}

function opaqueIssue(code, severity = 'error') {
  return { code, severity };
}

async function auditBook(book, document, store) {
  const issues = [];
  const bookPath = String(book?.path || '');
  let artifact = null;
  if (store.isXBookPath(bookPath)) artifact = await store.readXBookArtifact(bookPath);

  const extraction = await document.extractResult(bookPath);
  const chapters = await document.getChaptersCached(bookPath);
  const playback = createExtractionResult({
    chapters,
    diagnostics: extraction.diagnostics,
    mutations: extraction.mutations,
    sourceFormat: extraction.sourceFormat,
    processingVersion: extraction.processingVersion
  });
  const validation = document.validateExtractedChapters(chapters, {
    format: extraction.sourceFormat
  });

  if (!isExtractionImportable(playback)) issues.push(opaqueIssue('not-importable'));
  if (!playback.narration.valid) issues.push(opaqueIssue('narration-plan-invalid'));
  if (!validation.valid) issues.push(opaqueIssue('chapter-validation-invalid'));
  if (chapters.some((chapter, index) => chapter?.index !== index)) {
    issues.push(opaqueIssue('non-sequential-chapter-index'));
  }
  if (chapters.some(chapter => !String(chapter?.title || '').trim())) {
    issues.push(opaqueIssue('empty-chapter-title'));
  }
  if (chapters.some(chapter => RAW_HTML_TAG.test(String(chapter?.text || '')))) {
    issues.push(opaqueIssue('raw-html-in-narration'));
  }
  if (Number.isInteger(book?.chapterCount) && book.chapterCount !== chapters.length) {
    issues.push(opaqueIssue('legacy-chapter-count-drift', 'warning'));
  }

  const actualStructureKey = chapterStructureKey(chapters);
  if (book?.chapterStructureKey && book.chapterStructureKey !== actualStructureKey) {
    issues.push(opaqueIssue('chapter-structure-key-mismatch'));
  } else if (!book?.chapterStructureKey) {
    issues.push(opaqueIssue('legacy-structure-key-absent', 'warning'));
  }

  if (artifact?.sourceDeleted && !artifact?.sourceDocument) {
    issues.push(opaqueIssue('legacy-source-not-rebuildable', 'warning'));
  }

  const errors = issues.filter(issue => issue.severity === 'error');
  return {
    token: token(book?.id),
    format: String(artifact?.sourceFormat || path.extname(bookPath).slice(1) || 'unknown').toLowerCase(),
    chapterCount: chapters.length,
    processingVersion: Number(extraction.processingVersion) || 0,
    importable: isExtractionImportable(playback),
    narrationValid: playback.narration.valid,
    issueCodes: issues.map(issue => issue.code),
    passed: errors.length === 0
  };
}

(async () => {
  const raw = JSON.parse(await fs.readFile(booksFile, 'utf8'));
  const books = (Array.isArray(raw) ? raw : Object.values(raw || {}))
    .sort((left, right) => String(right?.addedAt || '').localeCompare(String(left?.addedAt || '')))
    .slice(0, limit);
  const store = artifactStore();
  const document = createBookDocument({
    getXBookStore: () => store,
    log: { log() {}, warn() {}, error() {} }
  });
  const records = [];
  for (const book of books) {
    try {
      records.push(await auditBook(book, document, store));
    } catch (error) {
      records.push({
        token: token(book?.id),
        format: path.extname(String(book?.path || '')).slice(1).toLowerCase() || 'unknown',
        issueCodes: ['audit-extraction-failed'],
        passed: false
      });
    }
  }

  const failed = records.filter(record => !record.passed).length;
  console.log(JSON.stringify({
    schemaVersion: 1,
    privacy: 'opaque-no-book-metadata-or-content',
    requested: limit,
    audited: records.length,
    passed: records.length - failed,
    failed,
    records
  }, null, 2));
  if (failed > 0 || records.length !== Math.min(limit, (Array.isArray(raw) ? raw : Object.keys(raw || {})).length)) {
    process.exit(1);
  }
})().catch(error => {
  console.error(JSON.stringify({
    schemaVersion: 1,
    privacy: 'opaque-no-book-metadata-or-content',
    failed: 1,
    issueCodes: ['audit-initialization-failed']
  }));
  process.exit(1);
});
