const crypto = require('crypto');
const {
  normalizeMetadataText,
  titleTokenOverlap,
  isGarbageTitle,
  isGarbageAuthor
} = require('./metadata-service');
const {
  buildChapterQuality,
  OVERSIZED_CHAPTER_THRESHOLD,
  UNUSABLE_CHAPTER_THRESHOLD
} = require('./chapter-utils');
const { assessReadableContentLength } = require('./content-length-policy');
const {
  DIAGNOSTIC_CODES,
  diagnostic,
  fromLegacyChapters,
  isBlockingDiagnostic
} = require('./extraction-result');

// Extractors keep these thresholds to classify and rank candidates. Import
// acceptance no longer treats a score as proof that meaningful text is invalid.
const PDF_MIN_SCORE = 55;
const PDF_REVIEW_SCORE = 70;
const KINDLE_MIN_SCORE = 55;
const KINDLE_REVIEW_SCORE = 70;

function normalizeWorkText(value) {
  return normalizeMetadataText(String(value || '').replace(/\s*:\s*.*/g, ' '))
    .replace(/\b(volume|vol|book|edition|ed|revised|complete|unabridged)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalWorkKey(title, author) {
  const normTitle = normalizeWorkText(title);
  const normAuthor = normalizeWorkText(author);
  if (!normTitle) return null;
  return crypto
    .createHash('sha1')
    .update(`${normTitle}|${normAuthor}`)
    .digest('hex')
    .slice(0, 20);
}

function findDuplicateBook(books, bookRecord) {
  const incomingKey = canonicalWorkKey(bookRecord.title, bookRecord.author);
  const incomingTitle = normalizeWorkText(bookRecord.title);
  const incomingAuthor = normalizeWorkText(bookRecord.author);

  for (const book of Object.values(books || {})) {
    if (!book || book.id === bookRecord.id) continue;
    if (bookRecord.openLibraryWorkKey && book.openLibraryWorkKey &&
        bookRecord.openLibraryWorkKey === book.openLibraryWorkKey) {
      return book;
    }
    if (bookRecord.sourceHash && book.sourceHash === bookRecord.sourceHash) return book;
    if (incomingKey && book.workKey && incomingKey === book.workKey) return book;

    const existingTitle = normalizeWorkText(book.title);
    const existingAuthor = normalizeWorkText(book.author);
    if (!incomingTitle || !existingTitle) continue;

    const titleOverlap = titleTokenOverlap(incomingTitle, existingTitle);
    const authorOverlap = incomingAuthor && existingAuthor
      ? titleTokenOverlap(incomingAuthor, existingAuthor)
      : 0;
    const sameUnknownAuthor = (!incomingAuthor || incomingAuthor === 'unknown') &&
      (!existingAuthor || existingAuthor === 'unknown');

    if (titleOverlap >= 0.9 && (authorOverlap >= 0.8 || sameUnknownAuthor)) {
      return book;
    }
  }

  return null;
}

function getChapterPdfExtraction(chapters) {
  return (chapters || []).find(chapter => chapter?.pdfExtraction)?.pdfExtraction || null;
}

function getChapterKindleExtraction(chapters) {
  return (chapters || []).find(chapter => chapter?.kindleExtraction)?.kindleExtraction || null;
}

function assessExtractedContent(chapters, options = {}) {
  const warnings = [];
  const errors = [];
  const diagnostics = [];
  const format = String(options.format || '').toLowerCase();
  const quality = buildChapterQuality(chapters || [], options.tocCount || 0);
  const totalChars = (chapters || []).reduce((sum, chapter) => sum + (chapter.text || '').trim().length, 0);
  const substantialSections = (chapters || []).filter(
    chapter => String(chapter?.text || '').trim().length >= 500
  ).length;
  const text = (chapters || []).map(chapter => chapter.text || '').join('\n\n');
  const replacementChars = (text.match(/\uFFFD/g) || []).length;
  const suspiciousOcrTokens = (text.match(/\b(?:1s|th1s|hght|w1th|rnay|sorne|frorn)\b/gi) || []).length;
  const nonWhitespace = (text.match(/\S/g) || []).length;
  const lettersAndNumbers = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const alnumRatio = nonWhitespace ? lettersAndNumbers / nonWhitespace : 0;
  const pdfExtraction = getChapterPdfExtraction(chapters);
  const kindleExtraction = getChapterKindleExtraction(chapters);

  if (!chapters || chapters.length === 0) {
    errors.push('No readable content - book is empty or unsupported');
  }
  const lengthAssessment = assessReadableContentLength({
    totalChars,
    // Type and chapter boundaries are derived structure. A misclassified but
    // readable section must not become an import rejection.
    substantialSections
  });
  if (!lengthAssessment.valid) errors.push(lengthAssessment.error);
  else if (lengthAssessment.warning) {
    warnings.push(lengthAssessment.warning);
    diagnostics.push(diagnostic({
      code: DIAGNOSTIC_CODES.SHORT_CONTENT,
      severity: 'warning',
      category: 'text-integrity',
      recoverability: 'none',
      evidence: { totalChars }
    }));
  }
  if (quality.maxChapterSize > UNUSABLE_CHAPTER_THRESHOLD) {
    warnings.push(`Large playable section detected (${quality.maxChapterSize} chars); narration will use bounded chunks`);
    diagnostics.push(diagnostic({
      code: DIAGNOSTIC_CODES.STRUCTURE_LOW_CONFIDENCE,
      severity: 'warning',
      category: 'structure-confidence',
      recoverability: 'automatic',
      evidence: { maxChapterSize: quality.maxChapterSize }
    }));
  } else if (quality.maxChapterSize > OVERSIZED_CHAPTER_THRESHOLD) {
    warnings.push(`Large section detected (${quality.maxChapterSize} chars); chapter extraction may be coarse`);
    diagnostics.push(diagnostic({
      code: DIAGNOSTIC_CODES.STRUCTURE_LOW_CONFIDENCE,
      severity: 'warning',
      category: 'structure-confidence',
      recoverability: 'automatic',
      evidence: { maxChapterSize: quality.maxChapterSize }
    }));
  }
  let sparseSections = false;
  if (quality.contentChapters < 3 && totalChars >= 50000) {
    warnings.push(`Only ${quality.contentChapters} substantial sections found`);
    sparseSections = true;
  }
  if ((chapters || []).length > 0 && quality.emptyChapters / chapters.length > 0.5) {
    warnings.push(`${Math.floor((quality.emptyChapters / chapters.length) * 100)}% of sections are empty or very short`);
    sparseSections = true;
  }
  if (sparseSections) {
    diagnostics.push(diagnostic({
      code: DIAGNOSTIC_CODES.SPARSE_SECTIONS,
      severity: 'warning',
      category: 'structure-confidence',
      recoverability: 'automatic',
      evidence: {
        totalSections: quality.totalChapters,
        substantialSections: quality.contentChapters,
        emptySections: quality.emptyChapters
      }
    }));
  }
  if (replacementChars > 10) {
    warnings.push(`Found ${replacementChars} replacement characters in extracted text`);
  }
  if (suspiciousOcrTokens > 50) {
    warnings.push(`Found ${suspiciousOcrTokens} suspicious OCR-like tokens after cleanup`);
    diagnostics.push(diagnostic({
      code: DIAGNOSTIC_CODES.OCR_SUSPECT,
      severity: 'warning',
      category: 'text-integrity',
      recoverability: 'different-candidate',
      evidence: { count: suspiciousOcrTokens }
    }));
  }
  if (nonWhitespace > 0 && alnumRatio < 0.65) {
    warnings.push(`Low readable character ratio (${Math.round(alnumRatio * 100)}%)`);
    diagnostics.push(diagnostic({
      code: DIAGNOSTIC_CODES.LOW_READABLE_RATIO,
      severity: 'warning',
      category: 'text-integrity',
      recoverability: 'different-candidate',
      evidence: { ratio: alnumRatio }
    }));
  }

  const extractionResult = fromLegacyChapters(chapters || [], { sourceFormat: format });
  diagnostics.push(...extractionResult.diagnostics);
  for (const item of extractionResult.diagnostics) {
    if (!isBlockingDiagnostic(item)) continue;
    if (item.code === DIAGNOSTIC_CODES.DRM_PROTECTED) {
      errors.push('Kindle file appears to be DRM-protected and cannot be imported');
    } else if (item.code === DIAGNOSTIC_CODES.UNSUPPORTED_FORMAT) {
      errors.push('Book file is unsupported or malformed');
    } else if (item.code === DIAGNOSTIC_CODES.OCR_REQUIRED) {
      errors.push('No narratable PDF text was extracted; OCR is required');
    } else if (!errors.length) {
      errors.push('No meaningful narratable text was extracted');
    }
  }
  if (pdfExtraction?.status && pdfExtraction.status !== 'ready') {
    warnings.push('PDF chapter structure was inferred automatically');
  }
  if (kindleExtraction?.status && kindleExtraction.status !== 'ready') {
    warnings.push('Kindle chapter structure was inferred automatically');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [...new Set(warnings)],
    diagnostics: [...new Map(diagnostics.map(item => [item.code, item])).values()],
    extractionResult,
    quality,
    stats: {
      totalChars,
      replacementChars,
      suspiciousOcrTokens,
      alnumRatio,
      pdfExtraction,
      kindleExtraction
    }
  };
}

function assessMetadataConfidence({ selectedTitle, selectedAuthor, embeddedTitle, embeddedAuthor, filenameTitle, enrichedTitle, enrichedAuthor, openLibrary }) {
  const warnings = [];
  const conflicts = [];
  let needsReview = false;
  const trustedTitle = selectedTitle || filenameTitle;

  if (trustedTitle && embeddedTitle && !isGarbageTitle(embeddedTitle)) {
    const overlap = titleTokenOverlap(embeddedTitle, trustedTitle);
    if (overlap < 0.25) {
      warnings.push(`Embedded title conflicts with selected title: "${embeddedTitle}" vs "${trustedTitle}"`);
      conflicts.push({ source: 'embedded', field: 'title', overlap });
      needsReview = true;
    }
  }

  if (trustedTitle && enrichedTitle) {
    const overlap = titleTokenOverlap(enrichedTitle, trustedTitle);
    if (overlap < 0.25) {
      warnings.push(`Remote metadata title conflicts with selected title: "${enrichedTitle}" vs "${trustedTitle}"`);
      conflicts.push({ source: 'remote', field: 'title', overlap });
      needsReview = true;
    }
  }

  if (selectedAuthor && embeddedAuthor && !isGarbageAuthor(embeddedAuthor)) {
    const overlap = titleTokenOverlap(embeddedAuthor, selectedAuthor);
    if (overlap < 0.25) {
      warnings.push(`Embedded author conflicts with selected author: "${embeddedAuthor}" vs "${selectedAuthor}"`);
      conflicts.push({ source: 'embedded', field: 'author', overlap });
      needsReview = true;
    }
  }

  if (selectedAuthor && enrichedAuthor) {
    const overlap = titleTokenOverlap(enrichedAuthor, selectedAuthor);
    if (overlap < 0.25) {
      warnings.push(`Remote metadata author conflicts with selected author: "${enrichedAuthor}" vs "${selectedAuthor}"`);
      conflicts.push({ source: 'remote', field: 'author', overlap });
      needsReview = true;
    }
  }

  if (openLibrary?.confidence?.level === 'conflict') {
    warnings.push(...(openLibrary.warnings || ['Open Library metadata conflicts with selected book']));
    conflicts.push({ source: 'openlibrary', field: 'work', overlap: 0 });
    needsReview = true;
  }

  const diagnostics = conflicts.length > 0 ? [diagnostic({
    code: DIAGNOSTIC_CODES.METADATA_CONFLICT,
    severity: 'warning',
    category: 'metadata-confidence',
    recoverability: 'automatic',
    evidence: { conflicts }
  })] : [];

  return { warnings, diagnostics, needsReview, openLibrary };
}

// File-level EPUB analysis counts raw spine documents — covers, dedications,
// figure and exercise pages — against a fixed length bar, while playback uses
// extracted chapters that group those fragments into real chapters. When the
// two disagree, extraction has the ground truth.
const SPINE_GRANULARITY_WARNING = /empty or very short|consecutive empty\/short/i;

function extractionContradictsSpineWarnings(quality) {
  return Boolean(quality &&
    quality.totalChapters > 0 &&
    quality.contentChapters >= 3 &&
    quality.emptyChapters / quality.totalChapters <= 0.2);
}

function buildImportValidationReport(parts = {}) {
  const fileWarnings = extractionContradictsSpineWarnings(parts.content?.quality)
    ? (parts.file?.warnings || []).filter(warning => !SPINE_GRANULARITY_WARNING.test(warning))
    : (parts.file?.warnings || []);
  const warnings = [
    ...fileWarnings,
    ...(parts.content?.warnings || []),
    ...(parts.metadata?.warnings || [])
  ];
  const errors = [
    ...(parts.file?.errors || []),
    ...(parts.content?.errors || [])
  ];
  const diagnostics = [
    ...(parts.content?.diagnostics || []),
    ...(parts.metadata?.diagnostics || [])
  ];

  return {
    valid: errors.length === 0,
    needsReview: Boolean(parts.needsReview || parts.metadata?.needsReview),
    errors,
    warnings: [...new Set(warnings)],
    diagnostics: [...new Map(diagnostics.map(item => [item.code, item])).values()],
    file: parts.file || undefined,
    content: parts.content || undefined,
    metadata: parts.metadata || undefined,
    source: parts.source || undefined
  };
}

module.exports = {
  PDF_MIN_SCORE,
  PDF_REVIEW_SCORE,
  KINDLE_MIN_SCORE,
  KINDLE_REVIEW_SCORE,
  canonicalWorkKey,
  findDuplicateBook,
  assessExtractedContent,
  assessMetadataConfidence,
  buildImportValidationReport
};
