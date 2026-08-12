const fs = require('node:fs/promises');
const path = require('node:path');
const {
  assessNarration,
  assessTextIntegrity
} = require('../../lib/extraction-result');
const { chapterStructureKey } = require('../../lib/chapter-structure');
const {
  kindleParserConfig,
  pdfSourceDocument
} = require('./import-benchmark-fixtures');
const { evaluateImportUx } = require('./import-benchmark-ux');

const RAW_HTML_TAG = /<\/?(?:html|head|body|title|meta|link|style|script|section|article|aside|nav|main|header|footer|p|div|span|h[1-6]|ol|ul|li|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|code|a|img|picture|figure|figcaption|br|hr|em|strong|b|i|u|sup|sub)\b[^>]*>/gi;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function contentDefectCount(chapters = []) {
  let count = 0;
  let previousText = '';
  for (const chapter of chapters || []) {
    const title = String(chapter?.title || '').trim();
    const text = String(chapter?.text || '');
    count += (text.match(RAW_HTML_TAG) || []).length;
    count += (text.match(/\uFFFD/g) || []).length;
    count += (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) || []).length;
    if (text.trim() && !title) count++;
    const normalized = text.replace(/\s+/gu, ' ').trim();
    if (normalized && normalized === previousText) count++;
    previousText = normalized;
  }
  return count;
}

function publicCase({
  id,
  chapters,
  expectedImportable,
  expectedDiagnosticCodes,
  expectedSelectedId,
  sourceDefectCount = 0,
  selectedId,
  importable,
  mustConserveNarration = true,
  diagnosticCodes = [],
  warningCount = 0,
  errorCount = 0
}) {
  const narration = assessNarration(chapters);
  const integrity = assessTextIntegrity(chapters);
  return {
    id,
    expectedImportable: Boolean(expectedImportable),
    expectedDiagnosticCodes: Array.isArray(expectedDiagnosticCodes)
      ? [...expectedDiagnosticCodes].sort()
      : undefined,
    expectedSelectedId,
    sourceDefectCount: Number(sourceDefectCount || 0),
    selectedId,
    mustConserveNarration: Boolean(mustConserveNarration),
    importable: Boolean(importable),
    narrationValid: Boolean(narration.valid),
    normalizedHash: integrity.normalizedHash,
    normalizedChars: integrity.normalizedChars,
    chapterCount: chapters.length,
    structureKey: chapterStructureKey(chapters),
    maxChapterChars: chapters.reduce(
      (maximum, chapter) => Math.max(maximum, String(chapter?.text || '').length),
      0
    ),
    defectCount: contentDefectCount(chapters),
    diagnosticCodes: [...diagnosticCodes].sort(),
    warningCount: Number(warningCount || 0),
    errorCount: Number(errorCount || 0)
  };
}

function metadataAdapter() {
  return {
    resolveSeed: embedded => ({
      title: embedded?.title || 'Synthetic Benchmark Book',
      author: embedded?.author || 'Fixture Author',
      filenameMetadata: {},
      embeddedLooksWrong: false
    }),
    enrich: async () => ({}),
    trustedTitle: (_value, fallback) => fallback,
    isGarbageTitle: () => false,
    isGarbageAuthor: () => false,
    normalizeAuthor: value => value,
    resolveIdentity: async () => ({ openLibraryWorkKey: 'benchmark-work' }),
    assessConfidence: () => ({ warnings: [], diagnostics: [], needsReview: false }),
    buildValidation: parts => ({
      valid: true,
      warnings: [...(parts.file?.warnings || []), ...(parts.content?.warnings || [])],
      diagnostics: parts.content?.diagnostics || [],
      needsReview: false,
      ...parts
    }),
    canonicalWorkKey: () => 'benchmark-work',
    openLibraryFields: identity => ({ openLibraryWorkKey: identity?.openLibraryWorkKey }),
    cleanDescription: value => value || '',
    publishedYear: () => undefined
  };
}

function attachPolicyDiagnostics(versionRoot, chapters, fixture) {
  const diagnostics = clone(fixture.diagnostics || []);
  if (diagnostics.length === 0) return chapters;
  try {
    const { createExtractionResult } = require(path.join(versionRoot, 'lib', 'extraction-result.js'));
    createExtractionResult({ chapters, diagnostics, sourceFormat: fixture.sourceFormat });
    return chapters;
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  }

  const codes = new Set(diagnostics.map(value => value.code));
  if (codes.has('invalid.drm-protected')) {
    const chapter = chapters[0] || { index: 0, title: 'Protected content', type: 'content', text: '' };
    chapter.kindleExtraction = { status: 'drm-protected', score: 0 };
    if (!chapters.length) chapters.push(chapter);
  }
  if (codes.has('text.ocr-required')) {
    const chapter = chapters[0] || { index: 0, title: 'Scanned pages', type: 'content', text: '' };
    chapter.pdfExtraction = { status: 'ocr-required', score: 0 };
    if (!chapters.length) chapters.push(chapter);
  }
  return chapters;
}

async function runImporterCase({
  versionRoot,
  id,
  format,
  chaptersById,
  primaryId = id,
  alternatives = [],
  expectedImportable,
  expectedDiagnosticCodes,
  expectedSelectedId = primaryId,
  sourceDefectCount = 0,
  mustConserveNarration = true
}) {
  const { createBookImporter } = require(path.join(versionRoot, 'lib', 'book-importer.js'));
  const { assessExtractedContent } = require(path.join(versionRoot, 'lib', 'import-validation.js'));
  const { buildChapterQuality } = require(path.join(versionRoot, 'lib', 'chapter-utils.js'));
  let persisted = null;
  const sourceId = source => path.basename(String(source)).split('.')[0];
  const sourceChapters = source => chaptersById[sourceId(source)] || [];
  const importer = createBookImporter({
    normalizeBook: async ({ sourcePath, id: candidateId }) => ({
      finalPath: `/benchmark/${candidateId}.${format}`,
      filename: `${candidateId}.${format}`,
      originalFormat: String(format).toUpperCase(),
      originalSize: 64 * 1024,
      finalSize: 64 * 1024,
      largeSource: false,
      resized: false,
      sourcePath
    }),
    document: {
      validateBook: async () => ({ valid: true, errors: [], warnings: [] }),
      validateExtractedChapters: () => ({ valid: true, errors: [], warnings: [] }),
      extractMetadata: async () => ({
        title: 'Synthetic Benchmark Book', author: 'Fixture Author', language: 'en'
      }),
      extractChapters: async source => sourceChapters(source),
      getChaptersCached: async source => sourceChapters(source)
    },
    checkChapterQuality: async source => {
      const chapters = sourceChapters(source);
      return {
        ...buildChapterQuality(chapters, 0),
        structureKey: chapterStructureKey(chapters)
      };
    },
    shouldDiscardSourceAfterExtract: () => false,
    assessExtractedContent,
    metadata: metadataAdapter(),
    persistBook: async record => {
      persisted = record;
      return { record };
    },
    removeFile: async () => undefined,
    ensureBookCover: async () => undefined,
    now: () => '2026-08-12T00:00:00.000Z',
    log: { log() {}, warn() {}, error() {} }
  });
  const command = {
    kind: 'download',
    id: primaryId,
    originalName: `${primaryId}.${format}`,
    sourcePath: `/benchmark-source/${primaryId}.${format}`,
    selected: { title: 'Synthetic Benchmark Book', author: 'Fixture Author', language: 'en' },
    selectedIdentity: { openLibraryWorkKey: 'benchmark-work' },
    alternatives: alternatives.map(value => ({
      id: value.id,
      originalName: `${value.id}.${format}`,
      acquire: async () => `/benchmark-source/${value.id}.${format}`,
      shouldTry: async identity => value.compatible !== false && identity?.openLibraryWorkKey === 'benchmark-work'
    }))
  };

  let importable = false;
  let errorCount = 0;
  try {
    await importer.import(command);
    importable = true;
  } catch {
    errorCount = 1;
  }
  const selectedId = persisted?.id || primaryId;
  const selectedChapters = chaptersById[selectedId] || chaptersById[primaryId] || [];
  const content = assessExtractedContent(selectedChapters, { format });
  return publicCase({
    id,
    chapters: selectedChapters,
    expectedImportable,
    expectedDiagnosticCodes,
    expectedSelectedId,
    sourceDefectCount,
    selectedId,
    importable,
    mustConserveNarration,
    diagnosticCodes: (content.diagnostics || []).map(value => value.code),
    warningCount: (content.warnings || []).length,
    errorCount: Math.max(errorCount, (content.errors || []).length)
  });
}

function kindleParser(config) {
  return {
    getSpine: () => config.spine,
    getToc: () => config.toc,
    getGuide: () => [],
    getMetadata: () => ({ title: 'Synthetic Kindle', author: ['Fixture Author'], language: ['en'] }),
    resolveHref: href => config.resolve[href],
    loadChapter: id => ({ html: config.chapters[id], css: [] }),
    destroy() {}
  };
}

async function evaluateFormatCases(versionRoot, formatFixtures) {
  if (!formatFixtures?.epubPath) return [];
  const { extractChapters } = require(path.join(versionRoot, 'lib', 'chapter-extraction.js'));
  const { reprocessPdfSourceDocument } = require(path.join(versionRoot, 'lib', 'pdf-extraction.js'));
  const { extractKindleChapters } = require(path.join(versionRoot, 'lib', 'kindle-extraction.js'));
  const epub = await extractChapters(formatFixtures.epubPath);
  const pdf = await reprocessPdfSourceDocument(pdfSourceDocument(), { warn: false, sourceLabel: 'Synthetic PDF' });
  const config = kindleParserConfig();
  const kindle = await extractKindleChapters('/synthetic/book.azw3', {
    format: 'azw3',
    warn: false,
    container: { available: true, extension: 'azw3', likelyKf8: true },
    parserFactories: {
      initKf8File: async () => kindleParser(config),
      initMobiFile: async () => { throw new Error('not a MOBI file'); }
    }
  });
  const values = [
    ['format:epub-authored', epub, 'epub', ['text.short-content']],
    ['format:pdf-source-document', pdf, 'pdf', ['text.short-content']],
    [
      'format:kindle-container',
      kindle,
      'azw3',
      ['structure.low-confidence', 'text.short-content']
    ]
  ];
  return Promise.all(values.map(([id, chapters, format, expectedDiagnosticCodes]) => runImporterCase({
    versionRoot,
    id,
    format,
    chaptersById: { [id]: chapters },
    expectedImportable: true,
    expectedDiagnosticCodes,
    expectedSelectedId: id
  })));
}

function artifactStore() {
  return {
    isXBookPath: filePath => /\.xbook\.json$/i.test(String(filePath || '')),
    async readXBookArtifact(filePath) {
      const artifact = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!Number.isInteger(artifact?._xbookVersion) || !Array.isArray(artifact?.chapters)) {
        throw new Error('invalid-xbook-artifact');
      }
      return artifact;
    }
  };
}

async function evaluatePrivateCases(versionRoot, privateBooks) {
  if (!privateBooks?.length) return [];
  const { createBookDocument } = require(path.join(versionRoot, 'lib', 'book-document.js'));
  const document = createBookDocument({
    getXBookStore: () => artifactStore(),
    log: { log() {}, warn() {}, error() {} }
  });
  const results = [];
  for (const book of privateBooks) {
    try {
      const chapters = await document.extractChapters(book.path);
      results.push(await runImporterCase({
        versionRoot,
        id: book.id,
        format: book.format,
        chaptersById: { [book.id]: chapters },
        expectedImportable: true,
        expectedSelectedId: book.id
      }));
    } catch {
      results.push(publicCase({
        id: book.id,
        chapters: [],
        expectedImportable: true,
        expectedSelectedId: book.id,
        selectedId: book.id,
        importable: false,
        errorCount: 1
      }));
    }
  }
  return results;
}

async function evaluateImportVersion({
  versionRoot,
  policyCases = [],
  formatFixtures,
  privateBooks = [],
  evaluateUx = evaluateImportUx
} = {}) {
  if (!versionRoot) throw new Error('Import benchmark evaluation requires versionRoot');
  const cases = [];
  for (const value of policyCases) {
    let chapters = attachPolicyDiagnostics(versionRoot, clone(value.chapters || []), value);
    if (value.splitOversized) {
      const versionChapterUtils = require(path.join(versionRoot, 'lib', 'chapter-utils.js'));
      chapters = versionChapterUtils.splitOversizedChapters(chapters);
    }
    cases.push(await runImporterCase({
      versionRoot,
      id: `policy:${value.id}`,
      primaryId: `policy-${value.id}`,
      format: value.sourceFormat,
      chaptersById: { [`policy-${value.id}`]: chapters },
      expectedImportable: value.expected?.importable,
      expectedDiagnosticCodes: value.expected?.importDiagnosticCodes || [],
      expectedSelectedId: `policy-${value.id}`,
      sourceDefectCount: value.expected?.sourceDefectCount || 0,
      mustConserveNarration: Boolean(value.expected?.importable)
    }));
  }

  const damaged = attachPolicyDiagnostics(versionRoot, clone(
    policyCases.find(value => value.id === 'epub-decode-loss-readable')?.chapters || []
  ), policyCases.find(value => value.id === 'epub-decode-loss-readable') || {});
  if (damaged.length) {
    const cleaner = clone(damaged).map(chapter => ({
      ...chapter,
      text: String(chapter.text || '').replace(/\uFFFD/g, 'e')
    }));
    const noisyLonger = clone(damaged);
    noisyLonger[noisyLonger.length - 1].text += ' Extra.';
    cases.push(await runImporterCase({
      versionRoot,
      id: 'candidate:decode-loss-cleaner',
      primaryId: 'decode-loss-primary',
      format: 'epub',
      chaptersById: {
        'decode-loss-wrong-work': cleaner,
        'decode-loss-primary': damaged,
        'decode-loss-noisy-longer': noisyLonger,
        'decode-loss-cleaner': cleaner
      },
      alternatives: [
        { id: 'decode-loss-wrong-work', compatible: false },
        { id: 'decode-loss-noisy-longer' },
        { id: 'decode-loss-cleaner' }
      ],
      expectedImportable: true,
      expectedDiagnosticCodes: ['text.short-content'],
      expectedSelectedId: 'decode-loss-cleaner',
      mustConserveNarration: false
    }));
  }

  cases.push(...await evaluateFormatCases(versionRoot, formatFixtures));
  cases.push(...await evaluatePrivateCases(versionRoot, privateBooks));
  return {
    cases,
    ux: await evaluateUx(versionRoot)
  };
}

module.exports = {
  contentDefectCount,
  evaluateImportVersion,
  publicCase,
  runImporterCase
};
