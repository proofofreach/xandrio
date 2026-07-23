const crypto = require('crypto');
const {
  normalizeMetadataText,
  titleTokenOverlap,
  isGarbageTitle,
  isGarbageAuthor
} = require('./metadata-service');
const { buildChapterQuality } = require('./chapter-utils');

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
  const format = String(options.format || '').toLowerCase();
  const quality = buildChapterQuality(chapters || [], options.tocCount || 0);
  const totalChars = (chapters || []).reduce((sum, chapter) => sum + (chapter.text || '').trim().length, 0);
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
  if (totalChars < 50000) {
    errors.push(`Insufficient content for audiobook: only ${totalChars} chars total`);
  }
  if (quality.maxChapterSize > 150000) {
    errors.push(`Giant section detected (${quality.maxChapterSize} chars); chapter extraction is likely broken`);
  } else if (quality.maxChapterSize > 100000) {
    warnings.push(`Large section detected (${quality.maxChapterSize} chars); chapter extraction may be coarse`);
  }
  if (quality.contentChapters < 3 && totalChars >= 50000) {
    warnings.push(`Only ${quality.contentChapters} substantial sections found`);
  }
  if ((chapters || []).length > 0 && quality.emptyChapters / chapters.length > 0.5) {
    warnings.push(`${Math.floor((quality.emptyChapters / chapters.length) * 100)}% of sections are empty or very short`);
  }
  if (replacementChars > 10) {
    warnings.push(`Found ${replacementChars} replacement characters in extracted text`);
  }
  if (suspiciousOcrTokens > 50) {
    warnings.push(`Found ${suspiciousOcrTokens} suspicious OCR-like tokens after cleanup`);
  }
  if (nonWhitespace > 0 && alnumRatio < 0.65) {
    warnings.push(`Low readable character ratio (${Math.round(alnumRatio * 100)}%)`);
  }

  if (format === 'pdf' && pdfExtraction) {
    if (pdfExtraction.status === 'ocr-required') {
      errors.push('PDF appears to be scanned or image-only; OCR is required before audiobook generation');
    } else if (pdfExtraction.status === 'failed') {
      errors.push(`PDF extraction failed quality checks: score ${pdfExtraction.score}`);
    } else if (pdfExtraction.score < PDF_MIN_SCORE) {
      errors.push(`Low-confidence PDF extraction score: ${pdfExtraction.score}`);
    } else if (pdfExtraction.status === 'review-needed' || pdfExtraction.score < PDF_REVIEW_SCORE) {
      warnings.push(`PDF extraction needs review: score ${pdfExtraction.score}`);
    }
    for (const warning of pdfExtraction.warnings || []) {
      warnings.push(`PDF extraction: ${warning}`);
    }
  }

  if (['mobi', 'prc', 'azw', 'azw3'].includes(format) && kindleExtraction) {
    if (kindleExtraction.status === 'drm-protected') {
      errors.push('Kindle file appears to be DRM-protected and cannot be imported');
    } else if (kindleExtraction.status === 'unsupported') {
      errors.push('Kindle file is unsupported or malformed');
    } else if (kindleExtraction.status === 'failed') {
      errors.push(`Kindle extraction failed quality checks: score ${kindleExtraction.score}`);
    } else if (kindleExtraction.score < KINDLE_MIN_SCORE) {
      errors.push(`Low-confidence Kindle extraction score: ${kindleExtraction.score}`);
    } else if (kindleExtraction.status === 'review-needed' || kindleExtraction.score < KINDLE_REVIEW_SCORE) {
      warnings.push(`Kindle extraction needs review: score ${kindleExtraction.score}`);
    }
    for (const warning of kindleExtraction.warnings || []) {
      warnings.push(`Kindle extraction: ${warning}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [...new Set(warnings)],
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
  let needsReview = false;
  const trustedTitle = selectedTitle || filenameTitle;

  if (trustedTitle && embeddedTitle && !isGarbageTitle(embeddedTitle)) {
    const overlap = titleTokenOverlap(embeddedTitle, trustedTitle);
    if (overlap < 0.25) {
      warnings.push(`Embedded title conflicts with selected title: "${embeddedTitle}" vs "${trustedTitle}"`);
      needsReview = true;
    }
  }

  if (trustedTitle && enrichedTitle) {
    const overlap = titleTokenOverlap(enrichedTitle, trustedTitle);
    if (overlap < 0.25) {
      warnings.push(`Remote metadata title conflicts with selected title: "${enrichedTitle}" vs "${trustedTitle}"`);
      needsReview = true;
    }
  }

  if (selectedAuthor && embeddedAuthor && !isGarbageAuthor(embeddedAuthor)) {
    const overlap = titleTokenOverlap(embeddedAuthor, selectedAuthor);
    if (overlap < 0.25) {
      warnings.push(`Embedded author conflicts with selected author: "${embeddedAuthor}" vs "${selectedAuthor}"`);
      needsReview = true;
    }
  }

  if (selectedAuthor && enrichedAuthor) {
    const overlap = titleTokenOverlap(enrichedAuthor, selectedAuthor);
    if (overlap < 0.25) {
      warnings.push(`Remote metadata author conflicts with selected author: "${enrichedAuthor}" vs "${selectedAuthor}"`);
      needsReview = true;
    }
  }

  if (openLibrary?.confidence?.level === 'conflict') {
    warnings.push(...(openLibrary.warnings || ['Open Library metadata conflicts with selected book']));
    needsReview = true;
  }

  return { warnings, needsReview, openLibrary };
}

function buildImportValidationReport(parts = {}) {
  const warnings = [
    ...(parts.file?.warnings || []),
    ...(parts.content?.warnings || []),
    ...(parts.metadata?.warnings || [])
  ];
  const errors = [
    ...(parts.file?.errors || []),
    ...(parts.content?.errors || [])
  ];

  return {
    valid: errors.length === 0,
    needsReview: Boolean(parts.needsReview || parts.metadata?.needsReview || warnings.some(w => /needs review|conflicts/i.test(w))),
    errors,
    warnings: [...new Set(warnings)],
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
