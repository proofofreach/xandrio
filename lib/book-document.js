const fsPromises = require('fs').promises;
const fsSyncDefault = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { extractChapters: extractEpubChapters } = require('./chapter-extraction');
const {
  splitOversizedChapters,
  repairTextArtifacts,
  normalizeChapterType,
  normalizeChapterSequence,
  validateExtractedChapters
} = require('./chapter-utils');
const {
  extractPdfChapters,
  extractPdfMetadata
} = require('./pdf-extraction');
const {
  extractKindleChapters,
  extractKindleMetadata,
  extractKindleCover
} = require('./kindle-extraction');
const { getChapterText } = require('./chapter-extraction');
const { extractCover: extractEpubCover } = require('./cover-service');
const { assessExtractedContent } = require('./import-validation');
const { parseEpub } = require('./epub-parser');

const execFileAsync = promisify(execFile);
const DEFAULT_FORMATS = new Set(['epub', 'mobi', 'prc', 'azw', 'azw3', 'pdf']);
const KINDLE_FORMATS = new Set(['mobi', 'prc', 'azw', 'azw3']);

async function defaultExtractEpubMetadata(epubPath, log = console) {
  try {
    const epub = await parseEpub(epubPath);
    const metadata = {
      title: epub.metadata.title,
      author: epub.metadata.creator,
      publisher: epub.metadata.publisher,
      date: epub.metadata.date,
      language: epub.metadata.language,
      description: epub.metadata.description
    };
    log.log('Extracted EPUB metadata:', metadata);
    return metadata;
  } catch (err) {
    log.error('Metadata extraction error:', err);
    return {};
  }
}

function createEpub(epubPath) {
  return parseEpub(epubPath);
}

function createBookDocument(options = {}) {
  const fileSystem = options.fs || fsPromises;
  const fsSync = options.fsSync || fsSyncDefault;
  const log = options.log || console;
  const formats = options.supportedFormats || DEFAULT_FORMATS;
  const chapterCacheVersion = options.chapterCacheVersion || 16;
  const maxChapterMemoryCacheEntries = options.maxChapterMemoryCacheEntries || 16;
  const maxExtractedChapterCacheEntries = options.maxExtractedChapterCacheEntries || 32;
  const largeBookWarningSize = options.largeBookWarningSize || 50 * 1024 * 1024;
  const getIdentity = options.getFileIdentity || (async filePath => {
    const stat = await fileSystem.stat(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  });
  const invalidateIdentity = options.invalidateFileIdentity || (() => {});
  const chapterExtractor = options.extractEpubChapters || extractEpubChapters;
  const pdfChapterExtractor = options.extractPdfChapters || extractPdfChapters;
  const kindleChapterExtractor = options.extractKindleChapters || extractKindleChapters;
  const epubMetadataExtractor = options.extractEpubMetadata || (source => defaultExtractEpubMetadata(source, log));
  const pdfMetadataExtractor = options.extractPdfMetadata || extractPdfMetadata;
  const kindleMetadataExtractor = options.extractKindleMetadata || extractKindleMetadata;
  const epubCoverExtractor = options.extractEpubCover || extractEpubCover;
  const kindleCoverExtractor = options.extractKindleCover || extractKindleCover;
  const splitChapters = options.splitOversizedChapters || splitOversizedChapters;
  const repairText = options.repairTextArtifacts || repairTextArtifacts;
  const normalizeType = options.normalizeChapterType || normalizeChapterType;
  const normalizeSequence = options.normalizeChapterSequence || normalizeChapterSequence;
  const validateChapters = options.validateExtractedChapters || validateExtractedChapters;
  const assessContent = options.assessExtractedContent || assessExtractedContent;
  const readChapterText = options.getEpubChapterText || getChapterText;
  const runCommand = options.execFileAsync || execFileAsync;
  const makeEpub = options.createEpub || createEpub;
  const getXBookStore = options.getXBookStore || (() => null);

  const extractedChapterCache = new Map();
  const extractedChapterInflight = new Map();
  const chapterMemoryCache = new Map();
  const chapterInflightReads = new Map();
  const repairedXBookChapters = new WeakMap();

  function xbookStore() {
    return getXBookStore() || null;
  }

  function isXBookPath(bookPath) {
    const store = xbookStore();
    return store?.isXBookPath?.(bookPath) || /\.xbook\.json$/i.test(bookPath || '');
  }

  function getFormatFromName(fileName) {
    const extension = path.extname(fileName || '').toLowerCase().replace(/^\./, '');
    return formats.has(extension) ? extension : '';
  }

  function getChapterCachePath(bookPath) {
    return bookPath.replace(/\.[^.]+$/i, '') + '.chapters.json';
  }

  function rememberChapterMemory(cachePath, entry) {
    if (chapterMemoryCache.has(cachePath)) {
      chapterMemoryCache.delete(cachePath);
    } else if (chapterMemoryCache.size >= maxChapterMemoryCacheEntries) {
      const oldest = chapterMemoryCache.keys().next().value;
      if (oldest !== undefined) chapterMemoryCache.delete(oldest);
    }
    chapterMemoryCache.set(cachePath, entry);
  }

  function rememberExtractedChapters(cacheKey, entry) {
    if (extractedChapterCache.size >= maxExtractedChapterCacheEntries) {
      const firstKey = extractedChapterCache.keys().next().value;
      if (firstKey) extractedChapterCache.delete(firstKey);
    }
    extractedChapterCache.set(cacheKey, entry);
  }

  async function readXBookArtifact(bookPath) {
    const store = xbookStore();
    if (!store?.readXBookArtifact) throw new Error('XBook store is unavailable');
    return store.readXBookArtifact(bookPath);
  }

  async function extractChapters(bookPath) {
    if (isXBookPath(bookPath)) {
      const xbook = await readXBookArtifact(bookPath);
      return normalizeSequence(splitChapters(xbook.chapters));
    }

    const format = getFormatFromName(bookPath);
    const identity = await getIdentity(bookPath).catch(() => null);
    const cacheKey = identity ? `${bookPath}:${identity.mtimeMs}:${identity.size}` : null;
    if (cacheKey) {
      const cached = extractedChapterCache.get(cacheKey);
      if (cached) return cached.chapters;
      if (extractedChapterInflight.has(cacheKey)) return extractedChapterInflight.get(cacheKey);
    }

    const extraction = (async () => {
      let chapters;
      if (format === 'epub') {
        chapters = await chapterExtractor(bookPath);
      } else if (format === 'pdf') {
        chapters = await pdfChapterExtractor(bookPath);
      } else if (KINDLE_FORMATS.has(format)) {
        chapters = await kindleChapterExtractor(bookPath, format);
      } else {
        throw new Error(`Unsupported book format: ${format || 'unknown'}`);
      }

      chapters = normalizeSequence(splitChapters(chapters));
      if (cacheKey) rememberExtractedChapters(cacheKey, { chapters });
      return chapters;
    })();

    if (!cacheKey) return extraction;
    extractedChapterInflight.set(cacheKey, extraction);
    try {
      return await extraction;
    } finally {
      extractedChapterInflight.delete(cacheKey);
    }
  }

  async function getChaptersCached(bookPath) {
    if (isXBookPath(bookPath)) {
      const xbook = await readXBookArtifact(bookPath);
      let repaired = repairedXBookChapters.get(xbook.chapters);
      if (!repaired) {
        repaired = normalizeSequence(splitChapters(xbook.chapters.map(chapter => {
          const repairedChapter = chapter && typeof chapter.text === 'string'
            ? { ...chapter, text: repairText(chapter.text) }
            : chapter;
          return normalizeType(repairedChapter);
        })));
        repairedXBookChapters.set(xbook.chapters, repaired);
      }
      return repaired;
    }

    const cachePath = getChapterCachePath(bookPath);
    try {
      const [bookIdentity, cacheIdentity] = await Promise.all([
        getIdentity(bookPath),
        getIdentity(cachePath).catch(() => null)
      ]);
      if (cacheIdentity && cacheIdentity.mtimeMs > bookIdentity.mtimeMs) {
        const memoryEntry = chapterMemoryCache.get(cachePath);
        if (
          memoryEntry &&
          memoryEntry.version === chapterCacheVersion &&
          memoryEntry.sourceMtimeMs === bookIdentity.mtimeMs &&
          memoryEntry.cacheMtimeMs === cacheIdentity.mtimeMs
        ) {
          rememberChapterMemory(cachePath, memoryEntry);
          return memoryEntry.chapters;
        }

        const inflightKey = `chapter-cache:${cachePath}:${bookIdentity.mtimeMs}:${cacheIdentity.mtimeMs}`;
        if (chapterInflightReads.has(inflightKey)) return chapterInflightReads.get(inflightKey);

        const readPromise = (async () => {
          const data = JSON.parse(await fileSystem.readFile(cachePath, 'utf-8'));
          if (data._cacheVersion === chapterCacheVersion) {
            rememberChapterMemory(cachePath, {
              version: chapterCacheVersion,
              sourceMtimeMs: bookIdentity.mtimeMs,
              cacheMtimeMs: cacheIdentity.mtimeMs,
              chapters: data.chapters
            });
            return data.chapters;
          }
          return null;
        })();
        chapterInflightReads.set(inflightKey, readPromise);
        try {
          const chapters = await readPromise;
          if (chapters) return chapters;
        } finally {
          chapterInflightReads.delete(inflightKey);
        }
      }
    } catch {
      // A cache failure never blocks reading the source document.
    }

    const chapters = await extractChapters(bookPath);
    try {
      await fileSystem.writeFile(cachePath, JSON.stringify({ _cacheVersion: chapterCacheVersion, chapters }));
      invalidateIdentity(cachePath);
      const [bookIdentity, cacheIdentity] = await Promise.all([
        getIdentity(bookPath),
        getIdentity(cachePath)
      ]);
      rememberChapterMemory(cachePath, {
        version: chapterCacheVersion,
        sourceMtimeMs: bookIdentity.mtimeMs,
        cacheMtimeMs: cacheIdentity.mtimeMs,
        chapters
      });
    } catch (err) {
      log.error('Failed to write chapter cache:', err.message);
    }
    return chapters;
  }

  function invalidateChapterCache(bookPath) {
    const cachePath = getChapterCachePath(bookPath);
    chapterMemoryCache.delete(cachePath);
    invalidateIdentity(cachePath);
    fileSystem.unlink(cachePath).catch(() => {});
  }

  async function extractMetadata(bookPath) {
    if (isXBookPath(bookPath)) {
      const xbook = await readXBookArtifact(bookPath);
      return xbook.metadata || {};
    }
    const format = getFormatFromName(bookPath);
    if (format === 'epub') return epubMetadataExtractor(bookPath);
    if (format === 'pdf') return pdfMetadataExtractor(bookPath);
    if (KINDLE_FORMATS.has(format)) return kindleMetadataExtractor(bookPath, format);
    return {};
  }

  async function extractCover(bookPath, outputPath) {
    if (isXBookPath(bookPath)) return Boolean((await readXBookArtifact(bookPath)).embeddedCover);
    const format = getFormatFromName(bookPath);
    if (format === 'epub') return epubCoverExtractor(bookPath, outputPath);
    if (KINDLE_FORMATS.has(format)) return kindleCoverExtractor(bookPath, format, outputPath);
    return false;
  }

  async function analyzeEpubChapterContent(epubPath, flow, epub) {
    const minSubstantialChapterLength = 500;
    const minTotalTextForAudiobook = 50000;
    const minContentRatioForAudiobook = 0.6;
    let totalTextLength = 0;
    let chaptersWithContent = 0;
    let emptyChapters = 0;
    let consecutiveEmpty = 0;
    let maxConsecutiveEmpty = 0;
    const chaptersToCheck = Math.min(flow.length, 50);

    for (let index = 0; index < chaptersToCheck; index++) {
      try {
        const text = await readChapterText(epub, flow[index].id);
        totalTextLength += text.length;
        if (text.length >= minSubstantialChapterLength) {
          chaptersWithContent++;
          consecutiveEmpty = 0;
        } else {
          emptyChapters++;
          consecutiveEmpty++;
          maxConsecutiveEmpty = Math.max(maxConsecutiveEmpty, consecutiveEmpty);
        }
      } catch {
        emptyChapters++;
        consecutiveEmpty++;
        maxConsecutiveEmpty = Math.max(maxConsecutiveEmpty, consecutiveEmpty);
      }
    }

    const contentRatio = chaptersWithContent / chaptersToCheck;
    const result = {
      isAudiobookSuitable: true,
      warnings: [],
      error: null,
      stats: {
        totalChapters: flow.length,
        chaptersChecked: chaptersToCheck,
        chaptersWithContent,
        emptyChapters,
        contentRatio: Math.floor(contentRatio * 100),
        totalTextLength,
        avgChapterLength: Math.floor(totalTextLength / chaptersToCheck),
        maxConsecutiveEmpty
      }
    };

    log.log(`Content analysis: ${chaptersWithContent}/${chaptersToCheck} substantial chapters`);
    log.log(`Empty/short chapters: ${emptyChapters}, Max consecutive: ${maxConsecutiveEmpty}`);
    log.log(`Total text: ${totalTextLength} chars, Average: ${Math.floor(totalTextLength / chaptersToCheck)} chars/chapter`);

    if (totalTextLength < minTotalTextForAudiobook) {
      result.isAudiobookSuitable = false;
      result.error = `Insufficient content for audiobook: only ${totalTextLength} chars total (minimum ${minTotalTextForAudiobook} required). This file appears corrupted or is not a complete book.`;
      return result;
    }
    if (contentRatio < minContentRatioForAudiobook) {
      if (totalTextLength < minTotalTextForAudiobook * 2) {
        result.isAudiobookSuitable = false;
        result.error = `Too many empty chapters for audiobook playback: only ${Math.floor(contentRatio * 100)}% have substantial content (minimum ${Math.floor(minContentRatioForAudiobook * 100)}% required). This would result in choppy, broken audio with many silent gaps.`;
        result.warnings.push("Try finding a different version that's properly formatted for reading.");
        return result;
      }
      result.warnings.push(`${Math.floor(contentRatio * 100)}% of chapters are empty or very short. Consider finding a better formatted edition.`);
    }
    if (maxConsecutiveEmpty >= 3) {
      result.warnings.push(`Found ${maxConsecutiveEmpty} consecutive empty/short chapters. Audio playback may have noticeable gaps.`);
    }
    if (contentRatio < 0.7) {
      result.warnings.push(`${Math.floor((1 - contentRatio) * 100)}% of chapters are empty or very short. Consider finding a better formatted edition.`);
    }
    return result;
  }

  async function validateEpub(epubPath) {
    const validationResult = { valid: false, errors: [], warnings: [] };
    try {
      let stats;
      try {
        stats = await fileSystem.stat(epubPath);
      } catch {
        validationResult.errors.push('File does not exist');
        return validationResult;
      }
      if (stats.size < 10 * 1024) {
        validationResult.errors.push(`File too small (${stats.size} bytes) - likely corrupted`);
        return validationResult;
      }
      if (stats.size < 50 * 1024) {
        validationResult.warnings.push(`File is small (${stats.size} bytes) - may be incomplete`);
      }
      try {
        await runCommand('unzip', ['-t', epubPath], { maxBuffer: 128 * 1024 * 1024 });
      } catch {
        validationResult.errors.push('Invalid ZIP structure - file is corrupted');
        return validationResult;
      }
      const epub = await makeEpub(epubPath);
      const epubData = { metadata: epub.metadata, toc: epub.toc, flow: epub.flow };
      if (!epubData.metadata || !epubData.metadata.title) validationResult.warnings.push('No title in metadata');
      if (!epubData.flow || epubData.flow.length === 0) {
        validationResult.errors.push('No readable content - book is empty');
        return validationResult;
      }
      if (!epubData.toc || epubData.toc.length === 0) {
        const chapters = await extractChapters(epubPath);
        const contentValidation = assessContent(chapters, { format: 'epub', tocCount: 0 });
        if (!contentValidation.valid) {
          validationResult.errors.push(...contentValidation.errors);
          validationResult.warnings.push(...contentValidation.warnings);
          validationResult.content = contentValidation;
          return validationResult;
        }
        validationResult.warnings.push('Missing EPUB table of contents; using spine-based chapter extraction.');
        validationResult.warnings.push(...contentValidation.warnings);
        validationResult.content = contentValidation;
        validationResult.valid = true;
        return validationResult;
      }
      log.log('Analyzing content depth for audiobook playback...');
      const chapterAnalysis = await analyzeEpubChapterContent(epubPath, epubData.flow, epub);
      if (!chapterAnalysis.isAudiobookSuitable) {
        validationResult.errors.push(chapterAnalysis.error);
        if (chapterAnalysis.warnings) validationResult.warnings.push(...chapterAnalysis.warnings);
        return validationResult;
      }
      if (chapterAnalysis.warnings?.length) validationResult.warnings.push(...chapterAnalysis.warnings);
      validationResult.valid = true;
      return validationResult;
    } catch (err) {
      validationResult.errors.push(`Validation error: ${err.message}`);
      return validationResult;
    }
  }

  async function validateBook(bookPath) {
    if (isXBookPath(bookPath)) {
      const validationResult = { valid: false, errors: [], warnings: [] };
      try {
        const xbook = await readXBookArtifact(bookPath);
        const contentValidation = assessContent(splitChapters(xbook.chapters), {
          format: xbook.sourceFormat || 'xbook'
        });
        validationResult.errors.push(...contentValidation.errors);
        validationResult.warnings.push(...contentValidation.warnings);
        validationResult.content = contentValidation;
        if (!contentValidation.valid) return validationResult;
        validationResult.valid = true;
        return validationResult;
      } catch (err) {
        validationResult.errors.push(`Validation error: ${err.message}`);
        return validationResult;
      }
    }
    const format = getFormatFromName(bookPath);
    if (format === 'epub') return validateEpub(bookPath);
    const validationResult = { valid: false, errors: [], warnings: [] };
    try {
      if (!fsSync.existsSync(bookPath)) {
        validationResult.errors.push('File does not exist');
        return validationResult;
      }
      const stats = fsSync.statSync(bookPath);
      if (stats.size < 10 * 1024) {
        validationResult.errors.push(`File too small (${stats.size} bytes) - likely corrupted`);
        return validationResult;
      }
      if (stats.size > largeBookWarningSize) {
        validationResult.warnings.push(`Large ${format.toUpperCase()} file (${Math.round(stats.size / 1024 / 1024)}MB); extraction may be slower`);
      }
      const chapters = await extractChapters(bookPath);
      return validateChapters(chapters, {
        format,
        fileSize: stats.size,
        largeBookWarningSize
      });
    } catch (err) {
      validationResult.errors.push(`Validation error: ${err.message}`);
      return validationResult;
    }
  }

  return {
    getFormatFromName,
    getChapterCachePath,
    isXBookPath,
    extractChapters,
    getChaptersCached,
    invalidateChapterCache,
    extractMetadata,
    extractCover,
    validateExtractedChapters: validateChapters,
    validateBook,
    validateEpub
  };
}

module.exports = { createBookDocument };
