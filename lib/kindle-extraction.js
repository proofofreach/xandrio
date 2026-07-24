const path = require('path');

const {
  stripHTML,
  shouldFilterChapter,
  isChapterLikeTitle,
  normalizeAllCapsTitle,
  normalizeChapterTitleForDisplay,
  normalizeChapterType,
  buildChapterQuality,
  splitOversizedChapters
} = require('./chapter-utils');
const { KINDLE_MIN_SCORE, KINDLE_REVIEW_SCORE } = require('./import-validation');

const KINDLE_FORMATS = new Set(['mobi', 'prc', 'azw', 'azw3']);
const PRIMARY_BY_FORMAT = {
  azw3: 'kf8',
  azw: 'mobi',
  mobi: 'mobi',
  prc: 'mobi'
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_CHUNK = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function isSupportedKindleCoverBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  const jpeg = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 &&
    buffer[2] === 0xff && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  const png = buffer.length >= 33 && buffer.subarray(0, 8).equals(PNG_SIGNATURE) &&
    buffer.subarray(-PNG_IEND_CHUNK.length).equals(PNG_IEND_CHUNK);
  return jpeg || png;
}

function normalizeKindleFormat(format, bookPath = '') {
  const value = String(format || path.extname(bookPath).replace(/^\./, '') || '').toLowerCase();
  return KINDLE_FORMATS.has(value) ? value : '';
}

function isKindleFormat(format) {
  return KINDLE_FORMATS.has(String(format || '').toLowerCase());
}

function normalizeKindleOptions(formatOrOptions = {}, extra = {}) {
  if (typeof formatOrOptions === 'string') {
    return { ...extra, format: formatOrOptions };
  }
  return { ...(formatOrOptions || {}), ...extra };
}

function estimateDuration(text) {
  return Math.ceil(String(text || '').length / 1000 * 60);
}

function normalizePlainText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeMetadataValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return value;
}

function flattenToc(toc, result = [], depth = 0) {
  for (const item of toc || []) {
    if (item && (item.label || item.href)) {
      result.push({
        label: String(item.label || '').replace(/\s+/g, ' ').trim(),
        href: item.href || '',
        depth
      });
    }
    if (item?.children) flattenToc(item.children, result, depth + 1);
  }
  return result;
}

function firstHeadingFromHtml(html) {
  const match = String(html || '').match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (!match) return '';
  const heading = stripHTML(match[1]).replace(/\s+/g, ' ').trim();
  return heading.length <= 120 ? normalizeChapterTitleForDisplay(heading) : '';
}

function tocEntryFromTocBySpineId(parser, tocEntries) {
  const byId = new Map();
  if (!parser || typeof parser.resolveHref !== 'function') return byId;

  for (const item of tocEntries) {
    if (!item.label || !item.href) continue;
    try {
      const resolved = parser.resolveHref(item.href);
      if (resolved?.id && !byId.has(resolved.id)) {
        byId.set(resolved.id, {
          ...item,
          label: normalizeAllCapsTitle(item.label)
        });
      }
    } catch {
      // Some malformed TOC hrefs fail to resolve. A full one-to-one TOC may
      // still use positional alignment, but a partial map must remain sparse.
    }
  }
  return byId;
}

function classifyKindleChapter(title, text) {
  if (shouldFilterChapter({ title, text })) return 'frontmatter';
  if (isChapterLikeTitle(title)) return 'chapter';
  return 'content';
}

function renumberGenericContentChapters(chapters = []) {
  let contentOrdinal = 0;

  return chapters.map(chapter => {
    const isReaderContent = !shouldFilterChapter(chapter) && String(chapter.text || '').trim().length >= 100;
    if (!isReaderContent) return chapter;

    contentOrdinal += 1;
    const rawTitle = String(chapter.title || '').replace(/\s+/g, ' ').trim();
    const genericMatch = rawTitle.match(/^chapter\s+(\d+)$/i);
    if (!genericMatch) {
      if (contentOrdinal === 1 && /^first\s+page$/i.test(rawTitle)) {
        return {
          ...chapter,
          sourceTitle: chapter.sourceTitle || chapter.title,
          title: 'Chapter 1'
        };
      }
      return chapter;
    }

    const sourceNumber = Number(genericMatch[1]);
    if (!Number.isFinite(sourceNumber) || sourceNumber <= contentOrdinal + 1) return chapter;

    return {
      ...chapter,
      sourceTitle: chapter.sourceTitle || chapter.title,
      title: `Chapter ${contentOrdinal}`
    };
  });
}

function detectKindleContainerFromBuffer(buffer, format = '') {
  const ascii = Buffer.from(buffer || []).toString('latin1');
  const hasBookMobi = ascii.includes('BOOKMOBI');
  const hasMobi = ascii.includes('MOBI');
  const hasKf8Markers = ascii.includes('BOUNDARY') || ascii.includes('FDST') || ascii.includes('RESC') || ascii.includes('KF8');
  const normalizedFormat = normalizeKindleFormat(format);

  return {
    extension: normalizedFormat || undefined,
    hasMobiHeader: hasBookMobi || hasMobi || undefined,
    likelyKf8: normalizedFormat === 'azw3' || hasKf8Markers || undefined,
    likelyMobi7: Boolean((normalizedFormat === 'mobi' || normalizedFormat === 'prc' || normalizedFormat === 'azw') && !hasKf8Markers) || undefined
  };
}

async function detectKindleContainer(bookPath, format = '', fs = require('fs').promises) {
  try {
    const file = await fs.open(bookPath, 'r');
    try {
      const buffer = Buffer.alloc(512 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return {
        available: true,
        ...detectKindleContainerFromBuffer(buffer.subarray(0, bytesRead), format)
      };
    } finally {
      await file.close();
    }
  } catch (err) {
    return {
      available: false,
      extension: normalizeKindleFormat(format, bookPath) || undefined,
      error: err.message
    };
  }
}

async function getParserFactories(options = {}) {
  if (options.parserFactories) return options.parserFactories;
  const parser = await import('@lingo-reader/mobi-parser');
  return {
    initMobiFile: parser.initMobiFile,
    initKf8File: parser.initKf8File
  };
}

async function initKindleParser(bookPath, parserKind, options = {}) {
  const factories = await getParserFactories(options);
  const init = parserKind === 'kf8' ? factories.initKf8File : factories.initMobiFile;
  if (typeof init !== 'function') {
    throw new Error(`Kindle parser ${parserKind} is unavailable`);
  }
  return init(bookPath, options.resourceSaveDir);
}

function buildKindleCandidateSpecs(format) {
  const primary = PRIMARY_BY_FORMAT[normalizeKindleFormat(format)] || 'mobi';
  const fallback = primary === 'kf8' ? 'mobi' : 'kf8';
  return [
    { name: `${primary}-primary`, parserKind: primary },
    { name: `${fallback}-fallback`, parserKind: fallback }
  ];
}

function normalizeKindleMetadata(metadata = {}) {
  return {
    title: normalizeMetadataValue(metadata.title),
    author: normalizeMetadataValue(metadata.author),
    publisher: normalizeMetadataValue(metadata.publisher),
    date: normalizeMetadataValue(metadata.published || metadata.date),
    language: Array.isArray(metadata.language) ? metadata.language[0] : metadata.language,
    description: normalizeMetadataValue(metadata.description),
    subjects: metadata.subject || metadata.subjects || []
  };
}

function buildKindleChaptersFromParser(parser, sourceLabel, parserKind) {
  const spine = parser?.getSpine ? parser.getSpine() || [] : [];
  const toc = parser?.getToc ? parser.getToc() || [] : [];
  const guide = parser?.getGuide ? parser.getGuide() || [] : [];
  const metadata = parser?.getMetadata ? normalizeKindleMetadata(parser.getMetadata() || {}) : {};
  const tocEntries = flattenToc(toc);
  const tocBySpineId = tocEntryFromTocBySpineId(parser, tocEntries);
  const usePositionalToc = tocBySpineId.size === 0 && tocEntries.length === spine.length;
  const mappedSpineIndices = spine
    .map((item, index) => tocBySpineId.has(item?.id) ? index : -1)
    .filter(index => index >= 0);
  const lastMappedSpineIndex = mappedSpineIndices.at(-1) ?? -1;
  const chapters = [];
  let skippedEmpty = 0;
  let loadFailures = 0;
  let structuralRepairCount = 0;
  let positionalTocCount = 0;

  for (let i = 0; i < spine.length; i++) {
    const item = spine[i] || {};
    let loaded;
    try {
      loaded = parser?.loadChapter ? parser.loadChapter(item.id) : null;
    } catch {
      loadFailures++;
      continue;
    }

    const html = loaded?.html || item.text || '';
    const text = normalizePlainText(stripHTML(html));
    if (!text) {
      skippedEmpty++;
      continue;
    }

    const matchedToc = tocBySpineId.get(item.id);
    const positionalToc = usePositionalToc ? tocEntries[i] : null;
    if (positionalToc) positionalTocCount++;
    const tocEntry = matchedToc || positionalToc;
    const title = normalizeAllCapsTitle(
      tocEntry?.label ||
      item.title ||
      firstHeadingFromHtml(html) ||
      `Chapter ${chapters.length + 1}`
    );
    const extractedType = classifyKindleChapter(title, text);
    const normalized = normalizeChapterType({
      index: chapters.length,
      originalIndex: i,
      title,
      text,
      estimatedDuration: estimateDuration(text),
      type: extractedType,
      kindleExtractor: parserKind,
      sourceSpineId: item.id,
      sourceHref: tocEntry?.href || undefined,
      tocTitleSource: matchedToc ? 'href' : (positionalToc ? 'position' : undefined)
    });
    if (normalized.title !== title || normalized.type !== extractedType) {
      structuralRepairCount++;
    }
    if (!tocEntry && lastMappedSpineIndex >= 0 && i > lastMappedSpineIndex &&
        !['cover', 'copyright', 'toc', 'frontmatter', 'backmatter', 'author', 'divider'].includes(normalized.type)) {
      normalized.type = 'backmatter';
    }
    chapters.push(normalized);
  }

  return {
    chapters: renumberGenericContentChapters(chapters).map(normalizeChapterType),
    stats: {
      spineCount: spine.length,
      tocCount: tocEntries.length,
      mappedTocCount: tocBySpineId.size,
      positionalTocCount,
      structuralRepairCount,
      guideCount: Array.isArray(guide) ? guide.length : 0,
      skippedEmpty,
      loadFailures
    },
    tocEntries,
    metadata
  };
}

function classifyKindleParserError(err) {
  const message = String(err?.message || err || '');
  if (/drm|encrypted|rights|protected/i.test(message)) return 'drm-protected';
  if (/unsupported|not.+mobi|invalid|malformed|unknown format|parse/i.test(message)) return 'unsupported';
  return 'failed';
}

async function buildKindleExtractionCandidate(bookPath, sourceLabel, spec, options = {}) {
  let parser;
  try {
    parser = await initKindleParser(bookPath, spec.parserKind, options);
    const extracted = buildKindleChaptersFromParser(parser, sourceLabel, spec.parserKind);
    return {
      ok: true,
      name: spec.name,
      mode: spec.name,
      parserKind: spec.parserKind,
      ...extracted,
      chapters: splitOversizedChapters(extracted.chapters)
    };
  } catch (err) {
    return {
      ok: false,
      name: spec.name,
      mode: spec.name,
      parserKind: spec.parserKind,
      error: err.message,
      failureStatus: classifyKindleParserError(err),
      chapters: [],
      stats: {}
    };
  } finally {
    if (parser && typeof parser.destroy === 'function') parser.destroy();
  }
}

function repeatedLineStats(text) {
  const counts = new Map();
  const lines = String(text || '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length >= 4 && line.length <= 120);

  for (const line of lines) {
    const key = line.toLowerCase().replace(/\b\d{1,5}\b/g, '#').replace(/\s+/g, ' ');
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const repeatedCount = [...counts.values()]
    .filter(count => count >= 4)
    .reduce((sum, count) => sum + count, 0);

  return {
    lineCount: lines.length,
    repeatedLineRatio: lines.length ? repeatedCount / lines.length : 0
  };
}

function scoreKindleExtractionCandidate(candidate) {
  if (!candidate.ok) {
    return {
      score: 0,
      warnings: [candidate.error || 'candidate failed'],
      stats: {}
    };
  }

  const chapters = candidate.chapters || [];
  const text = chapters.map(chapter => chapter.text || '').join('\n\n');
  const totalChars = text.trim().length;
  const quality = buildChapterQuality(chapters, candidate.stats?.tocCount || 0);
  const repeated = repeatedLineStats(text);
  const replacementChars = (text.match(/\uFFFD/g) || []).length;
  const suspiciousOcr = (text.match(/\b(?:1s|th1s|hght|w1th|rnay|sorne|frorn)\b/gi) || []).length;
  const nonWhitespace = (text.match(/\S/g) || []).length;
  const lettersAndNumbers = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const alnumRatio = nonWhitespace ? lettersAndNumbers / nonWhitespace : 0;
  const avgChapterChars = chapters.length ? totalChars / chapters.length : 0;
  const warnings = [];
  let score = 100;

  if (totalChars < 50000) {
    score -= 35;
    warnings.push(`low text length: ${totalChars}`);
  }
  if (chapters.length === 0) {
    score -= 60;
    warnings.push('no extracted chapters');
  }
  if (quality.maxChapterSize > 150000) {
    score -= 30;
    warnings.push(`giant section: ${quality.maxChapterSize}`);
  } else if (quality.maxChapterSize > 100000) {
    score -= 15;
    warnings.push(`large section: ${quality.maxChapterSize}`);
  }
  if (quality.contentChapters < 3 && totalChars >= 50000) {
    score -= 15;
    warnings.push(`few substantial sections: ${quality.contentChapters}`);
  }
  if ((candidate.stats?.tocCount || 0) > chapters.length * 2 && chapters.length > 0) {
    score -= 15;
    warnings.push(`TOC/spine mismatch: ${candidate.stats.tocCount} TOC entries for ${chapters.length} chapters`);
  }
  if ((candidate.stats?.spineCount || 0) > 0 && chapters.length / candidate.stats.spineCount < 0.4) {
    score -= 15;
    warnings.push(`many empty spine items: ${chapters.length}/${candidate.stats.spineCount} yielded text`);
  }
  if ((candidate.stats?.loadFailures || 0) > 0) {
    score -= Math.min(15, candidate.stats.loadFailures * 3);
    warnings.push(`chapter load failures: ${candidate.stats.loadFailures}`);
  }
  if ((candidate.stats?.mappedTocCount || 0) > 0 && candidate.stats.mappedTocCount < (candidate.stats?.tocCount || 0)) {
    const unresolved = candidate.stats.tocCount - candidate.stats.mappedTocCount;
    score -= Math.min(12, unresolved * 2);
    warnings.push(`unresolved TOC links: ${unresolved}`);
  }
  if ((candidate.stats?.structuralRepairCount || 0) > 0) {
    score -= Math.min(8, candidate.stats.structuralRepairCount);
    warnings.push(`repaired structural section labels: ${candidate.stats.structuralRepairCount}`);
  }
  if (repeated.repeatedLineRatio > 0.15) {
    score -= Math.min(20, Math.round(repeated.repeatedLineRatio * 100));
    warnings.push(`high repeated-line ratio: ${repeated.repeatedLineRatio.toFixed(2)}`);
  }
  if (replacementChars > 0) {
    score -= Math.min(15, replacementChars);
    warnings.push(`replacement characters: ${replacementChars}`);
  }
  if (suspiciousOcr >= 25) {
    score -= Math.min(12, Math.ceil(suspiciousOcr / 25) * 3);
    warnings.push(`suspicious OCR-like tokens: ${suspiciousOcr}`);
  }
  if (alnumRatio < 0.65) {
    score -= 20;
    warnings.push(`low alphanumeric ratio: ${alnumRatio.toFixed(2)}`);
  }
  if (candidate.metadata && !candidate.metadata.title) {
    score -= 3;
    warnings.push('missing embedded title');
  }
  if (candidate.metadata && !candidate.metadata.author) {
    score -= 3;
    warnings.push('missing embedded author');
  }
  if (candidate.parserKind === 'kf8') score += 2;

  return {
    score: Math.max(0, Math.min(100, score)),
    warnings,
    stats: {
      ...(candidate.stats || {}),
      totalChars,
      chapters: chapters.length,
      contentChapters: quality.contentChapters,
      emptyChapters: quality.emptyChapters,
      maxSectionChars: quality.maxChapterSize,
      avgChapterChars,
      repeatedLineRatio: repeated.repeatedLineRatio,
      replacementChars,
      suspiciousOcr,
      alnumRatio
    }
  };
}

function selectKindleExtractionCandidate(candidates) {
  const scored = candidates.map(candidate => ({
    ...candidate,
    quality: scoreKindleExtractionCandidate(candidate)
  }));
  scored.sort((a, b) => {
    if (b.quality.score !== a.quality.score) return b.quality.score - a.quality.score;
    return (b.quality.stats?.totalChars || 0) - (a.quality.stats?.totalChars || 0);
  });
  return { selected: scored[0], candidates: scored };
}

function classifyKindleExtractionStatus(selected) {
  if (!selected || !selected.ok) {
    return {
      status: selected?.failureStatus || 'failed',
      reason: selected?.error || 'all extraction candidates failed'
    };
  }

  const quality = selected.quality || scoreKindleExtractionCandidate(selected);
  if (quality.score < KINDLE_MIN_SCORE) {
    return {
      status: 'failed',
      reason: quality.warnings.join('; ') || 'low extraction confidence'
    };
  }
  if (quality.score < KINDLE_REVIEW_SCORE) {
    return {
      status: 'review-needed',
      reason: `score below review threshold (${quality.score})`
    };
  }
  return { status: 'ready', reason: '' };
}

function buildKindleExtractionReport(selected, candidates, status, container = {}) {
  const stats = selected?.quality?.stats || {};
  const warnings = [...(selected?.quality?.warnings || [])];
  if (status.reason && status.status !== 'ready') warnings.push(status.reason);

  return {
    selected: selected?.name,
    status: status.status,
    statusReason: status.reason || undefined,
    score: selected?.quality?.score || 0,
    warnings: [...new Set(warnings)],
    parserKind: selected?.parserKind,
    formatDetected: container.likelyKf8 ? 'kf8' : (container.likelyMobi7 ? 'mobi7' : container.extension),
    container: container.available ? {
      extension: container.extension,
      hasMobiHeader: container.hasMobiHeader,
      likelyKf8: container.likelyKf8,
      likelyMobi7: container.likelyMobi7
    } : undefined,
    chapterCount: stats.chapters,
    tocCount: stats.tocCount,
    spineCount: stats.spineCount,
    totalChars: stats.totalChars,
    avgChapterChars: Number.isFinite(stats.avgChapterChars) ? stats.avgChapterChars : undefined,
    metadata: selected?.metadata ? {
      title: selected.metadata.title,
      author: selected.metadata.author,
      language: selected.metadata.language,
      publisher: selected.metadata.publisher
    } : undefined,
    candidates: candidates.map(candidate => ({
      name: candidate.name,
      ok: candidate.ok,
      parserKind: candidate.parserKind,
      score: candidate.quality.score,
      warnings: candidate.quality.warnings,
      stats: candidate.quality.stats,
      error: candidate.error || undefined,
      failureStatus: candidate.failureStatus || undefined
    }))
  };
}

async function extractKindleChapters(bookPath, formatOrOptions = {}, extraOptions = {}) {
  const options = normalizeKindleOptions(formatOrOptions, extraOptions);
  const format = normalizeKindleFormat(options.format, bookPath);
  const sourceLabel = options.sourceLabel || path.basename(bookPath, path.extname(bookPath));
  const fs = options.fs || require('fs').promises;
  const container = options.container || await detectKindleContainer(bookPath, format, fs);
  const specs = options.candidateSpecs || buildKindleCandidateSpecs(format);
  const candidates = [];

  for (const spec of specs) {
    candidates.push(await buildKindleExtractionCandidate(bookPath, sourceLabel, spec, options));
  }

  const { selected, candidates: scoredCandidates } = selectKindleExtractionCandidate(candidates);
  const status = classifyKindleExtractionStatus(selected);
  const extractionReport = buildKindleExtractionReport(selected, scoredCandidates, status, container);

  if (selected?.chapters?.[0]) {
    selected.chapters[0].kindleExtraction = extractionReport;
  }

  if (!selected || !selected.ok || status.status === 'failed' || status.status === 'unsupported' || status.status === 'drm-protected') {
    const err = new Error(
      status.status === 'drm-protected'
        ? 'Kindle file appears to be DRM-protected and cannot be imported'
        : `Kindle extraction failed: ${status.reason || 'low confidence'}`
    );
    err.statusCode = 400;
    err.code = status.status === 'drm-protected' ? 'KINDLE_DRM_PROTECTED' : 'KINDLE_EXTRACTION_FAILED';
    err.kindleExtraction = extractionReport;
    throw err;
  }

  if (status.status === 'review-needed' && options.warn !== false) {
    console.warn(`Kindle extraction needs review for ${sourceLabel} (${selected.name}): ${status.reason}`);
  }

  return selected.chapters;
}

async function extractKindleMetadata(bookPath, formatOrOptions = {}, extraOptions = {}) {
  const options = normalizeKindleOptions(formatOrOptions, extraOptions);
  const format = normalizeKindleFormat(options.format, bookPath);
  const specs = options.candidateSpecs || buildKindleCandidateSpecs(format);

  for (const spec of specs) {
    let parser;
    try {
      parser = await initKindleParser(bookPath, spec.parserKind, options);
      const metadata = parser.getMetadata ? normalizeKindleMetadata(parser.getMetadata() || {}) : {};
      return {
        ...metadata,
        title: metadata.title || path.basename(bookPath, path.extname(bookPath)),
        language: metadata.language || 'en'
      };
    } catch {
      // Try the next parser candidate.
    } finally {
      if (parser && typeof parser.destroy === 'function') parser.destroy();
    }
  }

  return {
    title: path.basename(bookPath, path.extname(bookPath)),
    language: 'en'
  };
}

async function extractKindleCover(bookPath, formatOrOutputPath, outputPathOrOptions = {}, maybeOptions = {}) {
  const oldCallShape = isKindleFormat(formatOrOutputPath);
  const outputPath = oldCallShape ? outputPathOrOptions : formatOrOutputPath;
  const options = oldCallShape
    ? normalizeKindleOptions(formatOrOutputPath, maybeOptions)
    : normalizeKindleOptions(outputPathOrOptions);
  const fs = options.fs || require('fs').promises;
  const format = normalizeKindleFormat(options.format, bookPath);
  const specs = options.candidateSpecs || buildKindleCandidateSpecs(format);
  const resourceSaveDir = options.resourceSaveDir || path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath, path.extname(outputPath))}_resources`
  );

  try {
    for (const spec of specs) {
      let parser;
      try {
        parser = await initKindleParser(bookPath, spec.parserKind, { ...options, resourceSaveDir });
        const coverPath = parser.getCoverImage ? parser.getCoverImage() : '';
        if (!coverPath) continue;
        const imageBuffer = await fs.readFile(coverPath);
        if (!isSupportedKindleCoverBuffer(imageBuffer)) continue;
        await fs.writeFile(outputPath, imageBuffer);
        return true;
      } catch {
        // Try the next parser candidate.
      } finally {
        if (parser && typeof parser.destroy === 'function') parser.destroy();
      }
    }
    return false;
  } finally {
    await fs.rm(resourceSaveDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  extractKindleChapters,
  extractKindleMetadata,
  extractKindleCover,
  __test: {
    buildKindleCandidateSpecs,
    buildKindleChaptersFromParser,
    buildKindleExtractionReport,
    classifyKindleExtractionStatus,
    classifyKindleParserError,
    detectKindleContainerFromBuffer,
    flattenToc,
    normalizeKindleFormat,
    renumberGenericContentChapters,
    scoreKindleExtractionCandidate,
    selectKindleExtractionCandidate
  }
};
