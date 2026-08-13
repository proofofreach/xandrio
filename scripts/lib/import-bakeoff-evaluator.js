const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { evaluateImportUx } = require('./import-benchmark-ux');

const FORMATS = new Set(['epub', 'mobi', 'prc', 'azw', 'azw3', 'pdf']);
const RAW_HTML_TAG = /<\/?(?:html|head|body|title|meta|link|style|script|section|article|aside|nav|main|header|footer|p|div|span|h[1-6]|ol|ul|li|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|code|a|img|picture|figure|figcaption|br|hr|em|strong|b|i|u|sup|sub)\b[^>]*>/gi;

function versionModule(versionRoot, relativePath) {
  return require(path.join(versionRoot, relativePath));
}

function normalizedNarration(chapters = []) {
  return chapters
    .map(chapter => String(chapter?.text || ''))
    .join('\n\n')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function defectCount(chapters = []) {
  let count = 0;
  let previousText = '';
  for (const chapter of chapters) {
    const title = String(chapter?.title || '').trim();
    const text = String(chapter?.text || '');
    count += (text.match(RAW_HTML_TAG) || []).length;
    count += (text.match(/\uFFFD/g) || []).length;
    count += (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) || []).length;
    if (text.trim() && !title) count += 1;
    const normalized = text.replace(/\s+/gu, ' ').trim();
    if (normalized && normalized === previousText) count += 1;
    previousText = normalized;
  }
  return count;
}

function diagnosticValues(value) {
  if (Array.isArray(value)) return value.flatMap(diagnosticValues);
  if (value && typeof value === 'object') return [value.code || value.message || JSON.stringify(value)];
  return String(value || '').split(';').map(part => part.trim()).filter(Boolean);
}

function diagnosticKeys(values, kind) {
  return [...new Set(diagnosticValues(values).map(value => crypto
    .createHash('sha256')
    .update(`${kind}:${String(value).replace(/\s+/gu, ' ').trim()}`)
    .digest('hex')))].sort();
}

function publishedYear(value, fallback) {
  const match = String(value || '').match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  if (match) return Number(match[1]);
  const fallbackNumber = Number(fallback);
  return Number.isInteger(fallbackNumber) ? fallbackNumber : undefined;
}

async function evaluateBakeoffVersion({
  versionRoot,
  cases = [],
  scratchRoot,
  evaluateUx = evaluateImportUx
} = {}) {
  if (!versionRoot || !scratchRoot) throw new Error('Bake-off evaluation requires versionRoot and scratchRoot');
  const cacheDir = path.join(scratchRoot, 'cache');
  await fs.mkdir(cacheDir, { recursive: true });

  const { createBookImporter } = versionModule(versionRoot, 'lib/book-importer.js');
  const { createBookDocument } = versionModule(versionRoot, 'lib/book-document.js');
  const { createXBookStore } = versionModule(versionRoot, 'lib/xbook-store.js');
  const chapterUtils = versionModule(versionRoot, 'lib/chapter-utils.js');
  const { chapterStructureKey } = versionModule(versionRoot, 'lib/chapter-structure.js');
  const { parseEpub } = versionModule(versionRoot, 'lib/epub-parser.js');
  const importValidation = versionModule(versionRoot, 'lib/import-validation.js');
  const metadataService = versionModule(versionRoot, 'lib/metadata-service.js');
  const { planNarration } = versionModule(versionRoot, 'lib/tts-text.js');
  let proveArtifactRecovery = async () => ({ proven: false, reason: 'recovery-data-unavailable' });
  try {
    ({ proveArtifactRecovery } = versionModule(versionRoot, 'lib/extraction-recovery.js'));
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  }

  const getFileIdentity = async filePath => {
    const stats = await fs.stat(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  };
  let xbookStore;
  const document = createBookDocument({
    supportedFormats: FORMATS,
    getFileIdentity,
    invalidateFileIdentity: () => undefined,
    getXBookStore: () => xbookStore,
    log: { log() {}, warn() {}, error() {} }
  });
  xbookStore = createXBookStore({
    cacheDir,
    xbookVersion: 2,
    deleteSourceAfterExtract: true,
    getFileIdentity,
    invalidateFileIdentity: () => undefined,
    extractBookMetadata: document.extractMetadata,
    extractBookChapters: document.extractChapters,
    extractMobiCover: (sourcePath, _format, outputPath) => document.extractCover(sourcePath, outputPath),
    getBookFormatFromName: document.getFormatFromName
  });

  async function checkChapterQuality(sourcePath) {
    try {
      const chapters = await document.extractChapters(sourcePath);
      let tocCount = 0;
      let conversionSource = false;
      let spineLinearityVerified = true;
      let nonLinearSpineIndexes = new Set();
      if (document.getFormatFromName(sourcePath) === 'epub') {
        const epub = await parseEpub(sourcePath);
        spineLinearityVerified = epub.spineLinearityVerified === true;
        tocCount = epub.toc ? epub.toc.length : 0;
        const spine = epub.flow || [];
        const hrefs = spine.map(item => String(item.href || '').toLowerCase());
        nonLinearSpineIndexes = new Set(spine
          .map((item, index) => item.linear === false ? index : -1)
          .filter(index => index >= 0));
        const conversionMarkers = hrefs.filter(href =>
          /_split_\d+|\((rtf|doc|docx|txt|html?)\)/.test(href)
        ).length;
        conversionSource = hrefs.length >= 5 && conversionMarkers >= hrefs.length * 0.5 && tocCount <= 2;
      }
      const quality = chapterUtils.buildChapterQuality(chapters, tocCount, { nonLinearSpineIndexes });
      quality.structureKey = chapterStructureKey(chapters);
      if (!spineLinearityVerified) {
        quality.isGoodStructure = false;
        quality.structureVerified = false;
        quality.reasons.push('EPUB spine reading order could not be verified');
      }
      if (conversionSource) {
        quality.isGoodStructure = false;
        quality.conversionSource = true;
        quality.reasons = [...(quality.reasons || []), 'Format-conversion source with unusable TOC'];
      }
      return quality;
    } catch {
      return {
        isGoodStructure: false,
        structureVerified: false,
        reasons: ['Chapter quality check failed; edition was not structure-verified']
      };
    }
  }

  const persisted = new Map();
  const importer = createBookImporter({
    normalizeBook: async ({ sourcePath, originalName, id }) => {
      const format = document.getFormatFromName(originalName) || document.getFormatFromName(sourcePath);
      if (!format) throw new Error('Unsupported book format');
      const stats = await fs.stat(sourcePath);
      const finalPath = path.join(cacheDir, `${id}.${format}`);
      await fs.copyFile(sourcePath, finalPath);
      return {
        finalPath,
        filename: path.basename(finalPath),
        originalFormat: format.toUpperCase(),
        convertedToEpub: false,
        resized: false,
        largeSource: stats.size > 50 * 1024 * 1024,
        originalSize: stats.size,
        finalSize: stats.size
      };
    },
    document: {
      validateBook: document.validateBook,
      validateExtractedChapters: document.validateExtractedChapters,
      extractMetadata: document.extractMetadata,
      extractChapters: document.extractChapters,
      getChaptersCached: document.getChaptersCached
    },
    checkChapterQuality,
    relaxValidation: async (sourcePath, validation, context = {}) => {
      if (validation?.valid || !(validation?.errors || []).every(error => /No table of contents/i.test(error))) {
        return validation;
      }
      const publisher = String(context.metadata?.publisher || '').toLowerCase();
      if (!publisher.includes('project gutenberg')) return validation;
      const chapters = await document.extractChapters(sourcePath);
      const content = importValidation.assessExtractedContent(chapters, { format: 'epub' });
      return content.valid ? {
        ...validation,
        valid: true,
        errors: [],
        warnings: [...(validation.warnings || []), 'Missing table of contents; content passed validation']
      } : validation;
    },
    shouldDiscardSourceAfterExtract: xbookStore.shouldDiscardSourceAfterExtract,
    createArtifact: xbookStore.writeXBookArtifact,
    writeArtifactData: (filePath, artifact) => fs.writeFile(filePath, JSON.stringify(artifact)),
    assessExtractedContent: importValidation.assessExtractedContent,
    proveArtifactRecovery,
    metadata: {
      resolveSeed: metadataService.resolveMetadataSeed,
      enrich: async () => ({}),
      trustedTitle: metadataService.trustedEnrichedTitle,
      isGarbageTitle: metadataService.isGarbageTitle,
      isGarbageAuthor: metadataService.isGarbageAuthor,
      resolveIdentity: async () => ({}),
      assessConfidence: importValidation.assessMetadataConfidence,
      buildValidation: importValidation.buildImportValidationReport,
      canonicalWorkKey: importValidation.canonicalWorkKey,
      openLibraryFields: () => ({}),
      cleanDescription: value => String(value || '').trim(),
      normalizeAuthor: metadataService.normalizeAuthorForDisplay,
      publishedYear
    },
    ensureBookCover: async () => undefined,
    persistBook: async record => {
      persisted.set(record.id, record);
      return { record };
    },
    removeFile: async filePath => fs.rm(filePath, { force: true }),
    log: { log() {}, warn() {}, error() {} },
    now: () => '2026-08-12T00:00:00.000Z'
  });

  const results = [];
  for (let index = 0; index < cases.length; index += 1) {
    const value = cases[index];
    const processingId = `bakeoff-${index + 1}`;
    let chapters = [];
    let importable = false;
    const warnings = [];
    const errors = [];
    const diagnostics = [];
    try {
      const response = await importer.import({
        kind: 'upload',
        id: processingId,
        originalName: `${processingId}.${value.format}`,
        sourcePath: value.path
      });
      importable = true;
      const record = response.book || persisted.get(processingId);
      chapters = await document.extractChapters(record.path);
      warnings.push(...(record.importValidation?.warnings || []));
      errors.push(...(record.importValidation?.errors || []));
      diagnostics.push(...(record.importValidation?.diagnostics || []));
    } catch (error) {
      warnings.push(...(error?.response?.warnings || []));
      errors.push(
        error?.response?.error || error?.code || error?.name || 'import-failed',
        ...diagnosticValues(error?.response?.details)
      );
      try {
        chapters = await document.extractChapters(value.path);
      } catch {}
    }
    const content = importValidation.assessExtractedContent(chapters, { format: value.format });
    warnings.push(...(content.warnings || []));
    diagnostics.push(...(content.diagnostics || []));
    if (!importable) errors.push(...(content.errors || []));
    const text = normalizedNarration(chapters);
    const chunks = chapters.flatMap(chapter => planNarration(chapter?.text || '', { maxChars: 4000 }).chunks || []);
    const minimumNormalizedChars = Math.max(1, Number(value.minimumNormalizedChars) || 1);
    const warningKeys = diagnosticKeys(warnings, 'warning');
    const errorKeys = diagnosticKeys(errors, 'error');
    const diagnosticIdentityKeys = diagnosticKeys(diagnostics, 'diagnostic');
    results.push({
      id: value.id,
      expectedImportable: value.expectedImportable !== false,
      importable,
      narrationValid: text.length >= minimumNormalizedChars &&
        chunks.length > 0 &&
        chunks.every(chunk => String(chunk?.text || '').length <= 4000),
      normalizedHash: crypto.createHash('sha256').update(text).digest('hex'),
      normalizedChars: text.length,
      chapterCount: chapters.length,
      structureKey: chapterStructureKey(chapters),
      maxChapterChars: chapters.reduce(
        (maximum, chapter) => Math.max(maximum, String(chapter?.text || '').length),
        0
      ),
      defectCount: defectCount(chapters),
      warningCount: warningKeys.length,
      errorCount: errorKeys.length,
      diagnosticCount: diagnosticIdentityKeys.length,
      warningKeys,
      errorKeys,
      diagnosticKeys: diagnosticIdentityKeys
    });
  }

  return {
    cases: results,
    ux: await evaluateUx(versionRoot)
  };
}

module.exports = { defectCount, evaluateBakeoffVersion, normalizedNarration };
