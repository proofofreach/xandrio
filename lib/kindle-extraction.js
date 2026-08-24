const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

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
const {
  fromLegacyChapters,
  hasMeaningfulNarration,
  createMutationCollector,
  attachMutationActivations
} = require('./extraction-result');
const { normalizePlainText, estimateDuration } = require('./chapters/text-sanitization');

const KINDLE_FORMATS = new Set(['mobi', 'prc', 'azw', 'azw3']);
const PRIMARY_BY_FORMAT = {
  azw3: 'kf8',
  azw: 'mobi',
  mobi: 'mobi',
  prc: 'mobi'
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_CHUNK = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const KINDLE_REPLACEMENT_REVIEW_THRESHOLD = 25;

// The pinned @lingo-reader/mobi-parser dependency is fully synchronous
// (readFileSync-based decompression) and has no size/time/output bounds of
// its own, so a crafted MOBI/AZW3 can pin a CPU core for minutes or spin
// forever (see docs/audit finding
// kindle-mobi-parser-decompression-bomb-and-infinite-loop-dos). None of
// that can be interrupted from the calling thread, so real parsing runs in
// an isolated worker with a hard wall-clock timeout; a worker that runs
// past the deadline is forcibly terminated (verified this stops a
// synchronous infinite loop within ~1ms of the deadline) and treated as a
// failed candidate instead of hanging the server forever.
//
// The `maxOldGenerationSizeMb` cap below only bounds V8-managed heap
// objects. The bomb's actual growth is in raw Uint8Array/ArrayBuffer
// backing memory, which V8 allocates outside that tracked heap — so this
// cap does NOT reliably stop the memory-amplification variant of the bomb
// (measured: unbounded even with a 64MB cap). It's kept as a backstop for
// ordinary heap-object growth. The timeout still bounds *how long* a
// worker (and its memory growth) can run before being killed, and — unlike
// a same-thread hang — the rest of the server keeps serving requests while
// it does. Fully closing the memory-amplification path would need OS-level
// process isolation (subprocess + ulimit/cgroups) or an upstream cap in
// the decompressor; that's a larger change than this fix covers.
function resolvePositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}
const KINDLE_PARSE_TIMEOUT_MS = resolvePositiveInt(process.env.XANDRIO_KINDLE_PARSE_TIMEOUT_MS, 30000);
const KINDLE_PARSE_MEMORY_MB = resolvePositiveInt(process.env.XANDRIO_KINDLE_PARSE_MEMORY_MB, 1024);
const KINDLE_WORKER_SCRIPT = path.join(__dirname, 'kindle-extraction-worker.js');

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


// EXTH metadata records (title/author/publisher/description/subjects) are
// attacker-controlled bytes from an untrusted file. The underlying parser's
// getMetadata() also HTML-entity-decodes some of these fields, so text an
// upstream producer safely encoded (e.g. "&lt;img onerror=...&gt;") can
// arrive as live markup. Treat every field as untrusted: strip HTML with
// the same tag-stripper used for chapter text (it strips tags both before
// and after entity decoding, so a decode-then-reveal payload like the one
// above is still neutralized) and cap length before it is ever persisted.
const KINDLE_METADATA_MAX_CHARS = {
  title: 500,
  author: 500,
  publisher: 300,
  date: 100,
  language: 20,
  description: 20000,
  subject: 200
};

function sanitizeKindleMetadataText(value, maxChars) {
  const cleaned = stripHTML(String(value == null ? '' : value)).replace(/\s+/g, ' ').trim();
  return maxChars && cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

function normalizeMetadataValue(value, maxChars) {
  if (Array.isArray(value)) {
    return value
      .filter(Boolean)
      .map(entry => sanitizeKindleMetadataText(entry, maxChars))
      .filter(Boolean)
      .join(', ');
  }
  return value == null ? value : sanitizeKindleMetadataText(value, maxChars);
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

function canonicalMobiFilepos(href = '') {
  const match = String(href).trim().match(/^filepos:\s*0*(\d+)$/i);
  if (!match) return null;
  return `filepos:${match[1].replace(/^0+(?=\d)/, '')}`;
}

function recoverMissingMobiTocLabels(tocEntries, loadedHtmlBySpineId) {
  const labelsByFilepos = new Map();
  const ambiguousFilepos = new Set();
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;

  for (const html of loadedHtmlBySpineId.values()) {
    for (const match of String(html || '').matchAll(anchorPattern)) {
      const filepos = canonicalMobiFilepos(match[2]);
      if (!filepos) continue;
      const label = stripHTML(match[3]).replace(/\s+/g, ' ').trim();
      if (!label || label.length > 200) continue;
      const previous = labelsByFilepos.get(filepos);
      if (previous && previous !== label) {
        ambiguousFilepos.add(filepos);
        labelsByFilepos.delete(filepos);
      } else if (!ambiguousFilepos.has(filepos)) {
        labelsByFilepos.set(filepos, label);
      }
    }
  }

  let recoveredCount = 0;
  const entries = tocEntries.map(entry => {
    if (entry.label) return entry;
    const label = labelsByFilepos.get(canonicalMobiFilepos(entry.href));
    if (!label) return entry;
    recoveredCount += 1;
    return { ...entry, label, recoveredLabel: true };
  });
  return { entries, recoveredCount };
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
  if (options.resourceSaveDir) return init(bookPath, options.resourceSaveDir);

  // Without an explicit resourceSaveDir the parser writes to cwd-relative
  // './images', which fails on read-only deployments (ProtectSystem=strict).
  // Always hand it an isolated temp dir and remove it when the parser is
  // destroyed.
  const fs = (options.fs && options.fs.mkdtemp && options.fs.rm) ? options.fs : require('fs').promises;
  const resourceSaveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-kindle-'));
  const removeResourceDir = () => fs.rm(resourceSaveDir, { recursive: true, force: true }).catch(() => {});
  let parser;
  try {
    parser = await init(bookPath, resourceSaveDir);
  } catch (error) {
    await removeResourceDir();
    throw error;
  }
  const originalDestroy = typeof parser.destroy === 'function' ? parser.destroy.bind(parser) : null;
  parser.destroy = async () => {
    try {
      if (originalDestroy) await originalDestroy();
    } finally {
      await removeResourceDir();
    }
  };
  return parser;
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
  const rawLanguage = Array.isArray(metadata.language) ? metadata.language[0] : metadata.language;
  const rawSubjects = metadata.subject || metadata.subjects || [];
  return {
    title: normalizeMetadataValue(metadata.title, KINDLE_METADATA_MAX_CHARS.title),
    author: normalizeMetadataValue(metadata.author, KINDLE_METADATA_MAX_CHARS.author),
    publisher: normalizeMetadataValue(metadata.publisher, KINDLE_METADATA_MAX_CHARS.publisher),
    date: normalizeMetadataValue(metadata.published || metadata.date, KINDLE_METADATA_MAX_CHARS.date),
    language: rawLanguage == null ? rawLanguage : sanitizeKindleMetadataText(rawLanguage, KINDLE_METADATA_MAX_CHARS.language),
    description: normalizeMetadataValue(metadata.description, KINDLE_METADATA_MAX_CHARS.description),
    subjects: (Array.isArray(rawSubjects) ? rawSubjects : [rawSubjects])
      .filter(Boolean)
      .slice(0, 50)
      .map(subject => sanitizeKindleMetadataText(subject, KINDLE_METADATA_MAX_CHARS.subject))
      .filter(Boolean)
  };
}

function buildKindleChaptersFromParser(parser, sourceLabel, parserKind) {
  const spine = parser?.getSpine ? parser.getSpine() || [] : [];
  const toc = parser?.getToc ? parser.getToc() || [] : [];
  const guide = parser?.getGuide ? parser.getGuide() || [] : [];
  const metadata = parser?.getMetadata ? normalizeKindleMetadata(parser.getMetadata() || {}) : {};
  const loadedHtmlBySpineId = new Map();
  let loadFailures = 0;
  for (const item of spine) {
    try {
      const loaded = parser?.loadChapter ? parser.loadChapter(item?.id) : null;
      loadedHtmlBySpineId.set(item?.id, loaded?.html || item?.text || '');
    } catch {
      loadFailures++;
    }
  }
  const recoveredToc = recoverMissingMobiTocLabels(flattenToc(toc), loadedHtmlBySpineId);
  const tocEntries = recoveredToc.entries;
  const tocBySpineId = tocEntryFromTocBySpineId(parser, tocEntries);
  const usePositionalToc = tocBySpineId.size === 0 && tocEntries.length === spine.length;
  const mappedSpineIndices = spine
    .map((item, index) => tocBySpineId.has(item?.id) ? index : -1)
    .filter(index => index >= 0);
  const lastMappedSpineIndex = mappedSpineIndices.at(-1) ?? -1;
  const chapters = [];
  let skippedEmpty = 0;
  let structuralRepairCount = 0;
  let positionalTocCount = 0;
  const mutationCollector = createMutationCollector();

  for (let i = 0; i < spine.length; i++) {
    const item = spine[i] || {};
    if (!loadedHtmlBySpineId.has(item.id)) continue;
    const html = loadedHtmlBySpineId.get(item.id);
    const text = normalizePlainText(stripHTML(html, { mutationRecorder: mutationCollector.record }));
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
      tocTitleSource: matchedToc ? 'href' : (positionalToc ? 'position' : undefined),
      fromToc: Boolean(tocEntry),
      authoredBoundary: Boolean(tocEntry)
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
    chapters: attachMutationActivations(
      renumberGenericContentChapters(chapters).map(normalizeChapterType),
      mutationCollector.values()
    ),
    stats: {
      spineCount: spine.length,
      tocCount: tocEntries.length,
      mappedTocCount: tocBySpineId.size,
      recoveredTocLabelCount: recoveredToc.recoveredCount,
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
  // Blocking DRM classification requires explicit encryption evidence. Words
  // such as "rights" or "protected" occur in ordinary metadata errors.
  if (/\b(?:drm|encrypted|encryption)\b/i.test(message)) return 'drm-protected';
  if (/unsupported|not.+mobi|invalid|malformed|unknown format|parse/i.test(message)) return 'unsupported';
  return 'failed';
}

async function buildKindleExtractionCandidate(bookPath, sourceLabel, spec, options = {}) {
  let parser;
  try {
    parser = await initKindleParser(bookPath, spec.parserKind, options);
    const extracted = buildKindleChaptersFromParser(parser, sourceLabel, spec.parserKind);
    const chapters = attachMutationActivations(
      splitOversizedChapters(extracted.chapters),
      extracted.chapters.mutationActivations || []
    );
    return {
      ok: true,
      name: spec.name,
      mode: spec.name,
      parserKind: spec.parserKind,
      ...extracted,
      chapters
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
    if (parser && typeof parser.destroy === 'function') await parser.destroy();
  }
}

// Test suites inject a fake `parserFactories` (or a fake `fs`) to run
// against in-memory fixtures instead of the real dependency; functions
// can't cross the worker boundary (structured clone), so those doubles run
// the parser in-process exactly as before. Real production calls (no
// injected doubles) always go through the isolated worker.
function usesInjectedKindleTestDoubles(options = {}) {
  return Boolean(options.parserFactories || options.fs);
}

function runInKindleWorker(workerData) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`Kindle parsing timed out after ${KINDLE_PARSE_TIMEOUT_MS}ms`));
    }, KINDLE_PARSE_TIMEOUT_MS);
    try {
      worker = new Worker(KINDLE_WORKER_SCRIPT, {
        workerData,
        resourceLimits: { maxOldGenerationSizeMb: KINDLE_PARSE_MEMORY_MB }
      });
    } catch (err) {
      finish(reject, err);
      return;
    }
    worker.once('message', message => {
      if (message && message.ok) finish(resolve, message.result);
      else finish(reject, new Error(message?.error || 'Kindle worker failed'));
    });
    worker.once('error', err => finish(reject, err));
    worker.once('exit', code => {
      if (code !== 0) finish(reject, new Error(`Kindle worker exited with code ${code}`));
    });
  });
}

// Only plain, structured-cloneable fields may cross into the worker.
function sanitizeKindleWorkerOptions(options = {}) {
  const safe = {};
  if (typeof options.resourceSaveDir === 'string') safe.resourceSaveDir = options.resourceSaveDir;
  return safe;
}

async function attemptKindleMetadata(bookPath, spec, options = {}) {
  let parser;
  try {
    parser = await initKindleParser(bookPath, spec.parserKind, options);
    return parser.getMetadata ? normalizeKindleMetadata(parser.getMetadata() || {}) : {};
  } finally {
    if (parser && typeof parser.destroy === 'function') await parser.destroy();
  }
}

async function runKindleExtractionCandidate(bookPath, sourceLabel, spec, options = {}) {
  if (usesInjectedKindleTestDoubles(options)) {
    return buildKindleExtractionCandidate(bookPath, sourceLabel, spec, options);
  }
  try {
    return await runInKindleWorker({
      action: 'candidate',
      bookPath,
      sourceLabel,
      spec,
      options: sanitizeKindleWorkerOptions(options)
    });
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
  }
}

async function runKindleMetadataAttempt(bookPath, spec, options = {}) {
  if (usesInjectedKindleTestDoubles(options)) {
    return attemptKindleMetadata(bookPath, spec, options);
  }
  return runInKindleWorker({
    action: 'metadata',
    bookPath,
    spec,
    options: sanitizeKindleWorkerOptions(options)
  });
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
  const replacementChars = Number(quality.stats?.replacementChars) || 0;
  if (replacementChars >= KINDLE_REPLACEMENT_REVIEW_THRESHOLD) {
    return {
      status: 'review-needed',
      reason: `replacement character loss (${replacementChars})`
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

async function extractKindleResult(bookPath, formatOrOptions = {}, extraOptions = {}) {
  const options = normalizeKindleOptions(formatOrOptions, extraOptions);
  const format = normalizeKindleFormat(options.format, bookPath);
  const sourceLabel = options.sourceLabel || path.basename(bookPath, path.extname(bookPath));
  const fs = options.fs || require('fs').promises;
  const container = options.container || await detectKindleContainer(bookPath, format, fs);
  const specs = options.candidateSpecs || buildKindleCandidateSpecs(format);
  const candidates = [];

  for (const spec of specs) {
    candidates.push(await runKindleExtractionCandidate(bookPath, sourceLabel, spec, options));
  }

  const { selected, candidates: scoredCandidates } = selectKindleExtractionCandidate(candidates);
  const status = classifyKindleExtractionStatus(selected);
  const extractionReport = buildKindleExtractionReport(selected, scoredCandidates, status, container);

  if (selected?.chapters?.[0]) {
    selected.chapters[0].kindleExtraction = extractionReport;
  }

  const meaningful = hasMeaningfulNarration(selected?.chapters || []);
  if (!selected || !selected.ok || status.status === 'unsupported' || status.status === 'drm-protected' ||
      (status.status === 'failed' && !meaningful)) {
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

  return fromLegacyChapters(selected.chapters, { sourceFormat: format });
}

async function extractKindleChapters(bookPath, formatOrOptions = {}, extraOptions = {}) {
  return (await extractKindleResult(bookPath, formatOrOptions, extraOptions)).chapters;
}

async function extractKindleMetadata(bookPath, formatOrOptions = {}, extraOptions = {}) {
  const options = normalizeKindleOptions(formatOrOptions, extraOptions);
  const format = normalizeKindleFormat(options.format, bookPath);
  const specs = options.candidateSpecs || buildKindleCandidateSpecs(format);

  for (const spec of specs) {
    try {
      const metadata = await runKindleMetadataAttempt(bookPath, spec, options);
      return {
        ...metadata,
        title: metadata.title || path.basename(bookPath, path.extname(bookPath)),
        language: metadata.language || 'en'
      };
    } catch {
      // Try the next parser candidate.
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
  extractKindleResult,
  extractKindleChapters,
  extractKindleMetadata,
  extractKindleCover,
  // Consumed by kindle-extraction-worker.js to run the real (uninjected)
  // parse inside an isolated, resource-limited worker thread.
  __internal: {
    buildKindleExtractionCandidate,
    attemptKindleMetadata
  },
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
