const fs = require('fs').promises;
const path = require('path');
const { reprocessPdfSourceDocument } = require('./pdf-extraction');
const { PROCESSING_VERSION } = require('./extraction-result');
const { buildChapterTransition } = require('./chapter-reprocess');
const { chapterStructureKey } = require('./chapter-structure');

function createXBookStore({
  cacheDir,
  xbookVersion = 1,
  deleteSourceAfterExtract = true,
  getFileIdentity,
  invalidateFileIdentity,
  extractBookMetadata,
  extractBookChapters,
  extractMobiCover,
  getBookFormatFromName,
  reprocessPdfDocument = reprocessPdfSourceDocument
}) {
  const supportedXBookVersions = new Set([1, xbookVersion]);
  const xbookMemoryCache = new Map();
  const xbookInflightReads = new Map();
  const maxMemoryCacheEntries = 32;

  function isXBookPath(filePath) {
    return /\.xbook\.json$/i.test(filePath || '');
  }

  function getXBookPath(bookId) {
    return path.join(cacheDir, `${bookId}.xbook.json`);
  }

  function rememberXBookArtifact(cacheKey, artifact) {
    if (xbookMemoryCache.size >= maxMemoryCacheEntries) {
      const firstKey = xbookMemoryCache.keys().next().value;
      if (firstKey) xbookMemoryCache.delete(firstKey);
    }
    xbookMemoryCache.set(cacheKey, artifact);
  }

  function invalidateXBookArtifactCache(xbookPath) {
    if (!xbookPath) return;
    invalidateFileIdentity(xbookPath);
    for (const key of xbookMemoryCache.keys()) {
      if (key.startsWith(`${xbookPath}:`)) xbookMemoryCache.delete(key);
    }
    for (const key of xbookInflightReads.keys()) {
      if (key.startsWith(`${xbookPath}:`)) xbookInflightReads.delete(key);
    }
  }

  async function readXBookArtifact(xbookPath) {
    const identity = await getFileIdentity(xbookPath);
    const cacheKey = `${xbookPath}:${identity.mtimeMs}:${identity.size}`;
    const cached = xbookMemoryCache.get(cacheKey);
    if (cached) return cached;

    if (xbookInflightReads.has(cacheKey)) {
      return xbookInflightReads.get(cacheKey);
    }

    const readPromise = (async () => {
      const data = JSON.parse(await fs.readFile(xbookPath, 'utf-8'));
      if (!supportedXBookVersions.has(data._xbookVersion) || !Array.isArray(data.chapters)) {
        throw new Error('Unsupported or invalid XBook artifact');
      }
      rememberXBookArtifact(cacheKey, data);
      return data;
    })();

    xbookInflightReads.set(cacheKey, readPromise);
    try {
      return await readPromise;
    } finally {
      xbookInflightReads.delete(cacheKey);
    }
  }

  async function writeXBookArtifact(bookId, sourcePath, sourceInfo = {}) {
    const metadata = sourceInfo.metadata || await extractBookMetadata(sourcePath);
    const chapters = sourceInfo.chapters || await extractBookChapters(sourcePath);
    const sourceFormat = sourceInfo.originalFormat || getBookFormatFromName(sourcePath).toUpperCase();
    let embeddedCover = false;
    if (['MOBI', 'PRC', 'AZW', 'AZW3'].includes(sourceFormat)) {
      embeddedCover = await extractMobiCover(
        sourcePath,
        sourceFormat.toLowerCase(),
        path.join(cacheDir, `${bookId}_cover.jpg`)
      );
    }

    const artifact = {
      _xbookVersion: xbookVersion,
      processingVersion: Number.isInteger(sourceInfo.processingVersion)
        ? sourceInfo.processingVersion
        : PROCESSING_VERSION,
      id: bookId,
      sourceFormat,
      sourceFilename: sourceInfo.originalFilename || path.basename(sourcePath),
      sourceSize: sourceInfo.originalSize,
      sourceDeleted: false,
      extractedAt: new Date().toISOString(),
      embeddedCover,
      metadata,
      chapters,
      sourceDocument: sourceInfo.sourceDocument || chapters?.sourceDocument || undefined
    };

    const xbookPath = getXBookPath(bookId);
    await fs.writeFile(xbookPath, JSON.stringify(artifact));
    invalidateXBookArtifactCache(xbookPath);
    const identity = await getFileIdentity(xbookPath);
    rememberXBookArtifact(`${xbookPath}:${identity.mtimeMs}:${identity.size}`, artifact);
    return { xbookPath, artifact };
  }

  function shouldDiscardSourceAfterExtract(normalizedBook) {
    if (!deleteSourceAfterExtract) return false;
    return normalizedBook.originalFormat !== 'EPUB';
  }

  function retainedSourcePath(artifact) {
    if (artifact?.sourceDeleted !== false || !artifact?.sourcePath) return null;
    const cacheRoot = path.resolve(cacheDir);
    const sourcePath = path.resolve(String(artifact.sourcePath));
    const relative = path.relative(cacheRoot, sourcePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const detectedFormat = String(getBookFormatFromName(sourcePath) || '').toUpperCase();
    const recordedFormat = String(artifact.sourceFormat || '').toUpperCase();
    if (!detectedFormat || detectedFormat !== recordedFormat) return null;
    return sourcePath;
  }

  async function canRebuildXBookArtifact(xbookPath) {
    const artifact = await readXBookArtifact(xbookPath);
    if (String(artifact.sourceFormat || '').toUpperCase() === 'PDF' &&
        artifact.sourceDocument?.pages?.length) {
      return true;
    }
    const sourcePath = retainedSourcePath(artifact);
    if (!sourcePath) return false;
    try {
      await fs.access(sourcePath);
      return true;
    } catch {
      return false;
    }
  }

  async function planXBookRebuild(xbookPath, options = {}) {
    const artifact = await readXBookArtifact(xbookPath);
    const sourceFormat = String(artifact.sourceFormat || '').toUpperCase();
    let chapters;
    if (sourceFormat === 'PDF' && artifact.sourceDocument?.pages?.length) {
      chapters = await reprocessPdfDocument(artifact.sourceDocument, {
        sourceLabel: artifact.metadata?.title || artifact.sourceFilename || 'PDF',
        ...options
      });
    } else {
      const sourcePath = retainedSourcePath(artifact);
      if (!sourcePath) {
        const error = new Error('This XBook does not contain an eligible retained source document');
        error.code = sourceFormat === 'PDF'
          ? 'PDF_SOURCE_DATA_UNAVAILABLE'
          : 'XBOOK_REPROCESS_UNSUPPORTED';
        throw error;
      }
      try {
        await fs.access(sourcePath);
      } catch {
        const error = new Error('The retained source document is unavailable');
        error.code = 'XBOOK_REPROCESS_UNSUPPORTED';
        throw error;
      }
      chapters = await extractBookChapters(sourcePath);
    }
    const candidate = {
      ...artifact,
      _xbookVersion: xbookVersion,
      processingVersion: PROCESSING_VERSION,
      chapters,
      sourceDocument: chapters.sourceDocument || artifact.sourceDocument,
      reprocessedAt: new Date().toISOString()
    };
    const transition = buildChapterTransition(artifact.chapters, chapters);
    const previousStructureKey = chapterStructureKey(artifact.chapters) || undefined;
    const nextStructureKey = chapterStructureKey(chapters) || undefined;
    return {
      xbookPath,
      safe: transition.safe,
      reason: transition.safe ? undefined : transition.reason,
      changed: transition.safe && (
        previousStructureKey !== nextStructureKey ||
        (Number.isInteger(artifact.processingVersion) ? artifact.processingVersion : 0) < PROCESSING_VERSION
      ),
      artifact,
      candidate,
      transition,
      previousStructureKey,
      nextStructureKey,
      canRebuild: true
    };
  }

  return {
    isXBookPath,
    getXBookPath,
    invalidateXBookArtifactCache,
    readXBookArtifact,
    writeXBookArtifact,
    shouldDiscardSourceAfterExtract,
    canRebuildXBookArtifact,
    planXBookRebuild
  };
}

module.exports = { createXBookStore };
