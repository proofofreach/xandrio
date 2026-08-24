const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./write-file-atomic');
const { reprocessPdfSourceDocument } = require('./pdf-extraction');
const { PROCESSING_VERSION } = require('./extraction-result');
const { buildChapterTransition } = require('./chapter-reprocess');
const { chapterStructureKey } = require('./chapter-structure');

function normalizedChapterText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function retainedSourceChapterKey(chapter) {
  const originalIndex = Number(chapter?.originalIndex);
  const spineId = String(chapter?.sourceSpineId || '').trim();
  if (!Number.isInteger(originalIndex) || originalIndex < 0 || !spineId) return null;
  return `${originalIndex}:${spineId}`;
}

function contiguousSourceGroups(chapters) {
  const groups = [];
  const closed = new Set();
  for (const chapter of chapters || []) {
    const key = retainedSourceChapterKey(chapter);
    if (!key) return null;
    const current = groups.at(-1);
    if (current?.key === key) {
      current.chapters.push(chapter);
      continue;
    }
    if (closed.has(key)) return null;
    if (current) closed.add(current.key);
    groups.push({ key, chapters: [chapter] });
  }
  return groups;
}

function nearestSpace(text, desired, minimum, maximum) {
  for (let distance = 0; distance <= text.length; distance++) {
    const left = desired - distance;
    if (left >= minimum && left <= maximum && text[left] === ' ') return left;
    const right = desired + distance;
    if (right >= minimum && right <= maximum && text[right] === ' ') return right;
    if (left < minimum && right > maximum) break;
  }
  return -1;
}

function repartitionNarration(text, targetChapters) {
  if (targetChapters.length === 1) return [text];
  const weights = targetChapters.map(chapter => Math.max(1, normalizedChapterText(chapter?.text).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const parts = [];
  let cursor = 0;
  let consumedWeight = 0;
  for (let index = 0; index < targetChapters.length - 1; index++) {
    consumedWeight += weights[index];
    const desired = Math.round(text.length * consumedWeight / totalWeight);
    const remainingParts = targetChapters.length - index - 1;
    const cut = nearestSpace(text, desired, cursor + 1, text.length - (remainingParts * 2));
    if (cut < 0) return null;
    parts.push(text.slice(cursor, cut));
    cursor = cut + 1;
  }
  parts.push(text.slice(cursor));
  return parts.every(Boolean) ? parts : null;
}

// Legacy oversized-section splitting prepared text for TTS before persisting
// it. A later extraction can therefore recover better source structure while
// differing from the stored narration by punctuation normalization. In that
// case, adopt only the fresh structural metadata and repartition the exact
// stored narration stream. Prefer stable, contiguous source identities. A
// legacy artifact that lost those identities is accepted only when every
// ordered word and number still matches case-insensitively; otherwise the
// ordinary text-conservation gate remains fail-closed.
function preserveArtifactNarrationBySource(previousChapters, structuralChapters) {
  const previousGroups = contiguousSourceGroups(previousChapters);
  const structuralGroups = contiguousSourceGroups(structuralChapters);
  if (!previousGroups || !structuralGroups || previousGroups.length !== structuralGroups.length) return null;
  if (previousGroups.some((group, index) => group.key !== structuralGroups[index].key)) return null;

  const rebuilt = [];
  for (let groupIndex = 0; groupIndex < previousGroups.length; groupIndex++) {
    const previous = previousGroups[groupIndex].chapters;
    const structural = structuralGroups[groupIndex].chapters;
    let texts;
    if (previous.length === structural.length) {
      texts = previous.map(chapter => chapter.text);
    } else {
      const narration = previous.map(chapter => normalizedChapterText(chapter?.text)).join(' ');
      texts = repartitionNarration(narration, structural);
    }
    if (!texts) return null;
    const previousDuration = previous.reduce((sum, chapter) => sum + Math.max(0, Number(chapter?.estimatedDuration) || 0), 0);
    const totalChars = texts.reduce((sum, text) => sum + normalizedChapterText(text).length, 0);
    structural.forEach((chapter, index) => {
      const textChars = normalizedChapterText(texts[index]).length;
      rebuilt.push({
        ...chapter,
        text: texts[index],
        estimatedDuration: previous.length === structural.length
          ? previous[index].estimatedDuration
          : Math.round(previousDuration * textChars / Math.max(1, totalChars))
      });
    });
  }
  return rebuilt.map((chapter, index) => ({ ...chapter, index }));
}

function narrationTokenMatches(text) {
  return [...String(text || '').matchAll(/[\p{L}\p{N}]+/gu)];
}

function orderedNarrationWordsMatch(previousChapters, structuralChapters) {
  const words = chapters => narrationTokenMatches(
    chapters.map(chapter => normalizedChapterText(chapter?.text)).join(' ')
  ).map(token => token[0].toLocaleLowerCase('en-US'));
  const previous = words(previousChapters);
  const structural = words(structuralChapters);
  return previous.length > 0 &&
    previous.length === structural.length &&
    previous.every((word, index) => word === structural[index]);
}

function preserveArtifactNarrationByTokens(previousChapters, structuralChapters) {
  const previousText = previousChapters.map(chapter => normalizedChapterText(chapter?.text)).join(' ');
  const structuralTexts = structuralChapters.map(chapter => normalizedChapterText(chapter?.text));
  const previousTokens = narrationTokenMatches(previousText);
  const structuralTokenGroups = structuralTexts.map(narrationTokenMatches);
  if (!previousTokens.length || structuralTokenGroups.some(tokens => !tokens.length)) return null;
  const structuralTokens = structuralTokenGroups.flat();
  if (previousTokens.length !== structuralTokens.length) return null;
  if (previousTokens.some((token, index) =>
    token[0].toLocaleLowerCase('en-US') !== structuralTokens[index][0].toLocaleLowerCase('en-US'))) {
    return null;
  }

  const texts = [];
  let cursor = 0;
  let tokenCursor = 0;
  for (let index = 0; index < structuralChapters.length - 1; index++) {
    tokenCursor += structuralTokenGroups[index].length;
    const previousToken = previousTokens[tokenCursor - 1];
    const nextToken = previousTokens[tokenCursor];
    const gapStart = previousToken.index + previousToken[0].length;
    const gap = previousText.slice(gapStart, nextToken.index);
    const separatorOffset = gap.lastIndexOf(' ');
    if (separatorOffset < 0) return null;
    const cut = gapStart + separatorOffset;
    texts.push(previousText.slice(cursor, cut));
    cursor = cut + 1;
  }
  texts.push(previousText.slice(cursor));
  if (texts.some(text => !text) || texts.join(' ') !== previousText) return null;

  const previousDuration = previousChapters.reduce(
    (sum, chapter) => sum + Math.max(0, Number(chapter?.estimatedDuration) || 0), 0
  );
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
  return structuralChapters.map((chapter, index) => ({
    ...chapter,
    index,
    text: texts[index],
    estimatedDuration: Math.round(previousDuration * texts[index].length / Math.max(1, totalChars))
  }));
}

function preserveArtifactNarration(previousChapters, structuralChapters) {
  if (!orderedNarrationWordsMatch(previousChapters, structuralChapters)) return null;
  return preserveArtifactNarrationBySource(previousChapters, structuralChapters) ||
    preserveArtifactNarrationByTokens(previousChapters, structuralChapters);
}

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

  const cacheRoot = path.resolve(cacheDir);

  function assertSafeBookId(bookId) {
    if (typeof bookId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(bookId) ||
        bookId.includes('..') ||
        bookId.includes('/') ||
        bookId.includes('\\')) {
      throw new Error('Invalid book ID');
    }
  }

  function resolveExistingPath(filePath) {
    try {
      return fsSync.realpathSync(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(filePath);
      try {
        return path.join(fsSync.realpathSync(parent), path.basename(filePath));
      } catch {
        return path.resolve(filePath);
      }
    }
  }

  function assertContainedCachePath(filePath) {
    const resolvedPath = path.resolve(filePath);
    const cacheReal = resolveExistingPath(cacheRoot);
    const targetReal = resolveExistingPath(resolvedPath);
    const relativePath = path.relative(cacheReal, targetReal);
    if (!relativePath ||
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)) {
      throw new Error('XBook artifact path must stay inside the cache directory');
    }
    return resolvedPath;
  }

  function getCacheArtifactPath(filename) {
    return assertContainedCachePath(path.join(cacheDir, filename));
  }

  async function writeXBookArtifactAtomically(xbookPath, artifact) {
    await writeFileAtomic(xbookPath, JSON.stringify(artifact));
  }

  function getXBookPath(bookId) {
    assertSafeBookId(bookId);
    return getCacheArtifactPath(`${bookId}.xbook.json`);
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
    xbookPath = assertContainedCachePath(xbookPath);
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
    assertSafeBookId(bookId);
    const metadata = sourceInfo.metadata || await extractBookMetadata(sourcePath);
    const chapters = sourceInfo.chapters || await extractBookChapters(sourcePath);
    const sourceFormat = sourceInfo.originalFormat || getBookFormatFromName(sourcePath).toUpperCase();
    let embeddedCover = false;
    if (['MOBI', 'PRC', 'AZW', 'AZW3'].includes(sourceFormat)) {
      embeddedCover = await extractMobiCover(
        sourcePath,
        sourceFormat.toLowerCase(),
        getCacheArtifactPath(`${bookId}_cover.jpg`)
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
    await writeXBookArtifactAtomically(xbookPath, artifact);
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
    xbookPath = assertContainedCachePath(xbookPath);
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
    xbookPath = assertContainedCachePath(xbookPath);
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
    let transition = buildChapterTransition(artifact.chapters, chapters);
    let narrationPreserved = false;
    if (!transition.safe && ['MOBI', 'PRC', 'AZW', 'AZW3'].includes(sourceFormat)) {
      const preservedChapters = preserveArtifactNarration(artifact.chapters, chapters);
      const preservedTransition = preservedChapters
        ? buildChapterTransition(artifact.chapters, preservedChapters)
        : null;
      if (preservedTransition?.safe) {
        chapters = preservedChapters;
        transition = preservedTransition;
        narrationPreserved = true;
      }
    }
    const candidate = {
      ...artifact,
      _xbookVersion: xbookVersion,
      processingVersion: PROCESSING_VERSION,
      chapters,
      sourceDocument: chapters.sourceDocument || artifact.sourceDocument,
      narrationPreservedDuringRebuild: narrationPreserved || undefined,
      reprocessedAt: new Date().toISOString()
    };
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
      narrationPreserved,
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
