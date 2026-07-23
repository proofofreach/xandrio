const fs = require('fs').promises;
const path = require('path');

function createXBookStore({
  cacheDir,
  xbookVersion = 1,
  deleteSourceAfterExtract = true,
  getFileIdentity,
  invalidateFileIdentity,
  extractBookMetadata,
  extractBookChapters,
  extractMobiCover,
  getBookFormatFromName
}) {
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
      if (data._xbookVersion !== xbookVersion || !Array.isArray(data.chapters)) {
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
      id: bookId,
      sourceFormat,
      sourceFilename: sourceInfo.originalFilename || path.basename(sourcePath),
      sourceSize: sourceInfo.originalSize,
      sourceDeleted: false,
      extractedAt: new Date().toISOString(),
      embeddedCover,
      metadata,
      chapters
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

  return {
    isXBookPath,
    getXBookPath,
    invalidateXBookArtifactCache,
    readXBookArtifact,
    writeXBookArtifact,
    shouldDiscardSourceAfterExtract
  };
}

module.exports = { createXBookStore };
