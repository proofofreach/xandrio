const {
  SUBSTANTIAL_SECTION_CHARS,
  assessReadableContentLength
} = require('../content-length-policy');
const { FRONT_MATTER_TYPES } = require('./classification');

function buildChapterQuality(chapters, tocCount = 0, options = {}) {
  const narrativeChapters = chapters.filter(chapter => !FRONT_MATTER_TYPES.has(chapter?.type));
  const measuredChapters = narrativeChapters.length > 0 ? narrativeChapters : chapters;
  const contentChapters = measuredChapters.filter(ch => ch.text && ch.text.length > 500);
  const emptyChapters = chapters.filter(ch => !ch.text || ch.text.length <= 500);
  const maxChapterSize = Math.max(...measuredChapters.map(ch => ch.text ? ch.text.length : 0), 0);
  const totalChars = chapters.reduce((sum, chapter) => sum + String(chapter?.text || '').trim().length, 0);
  const replacementChars = chapters.reduce(
    (sum, chapter) => sum + (String(chapter?.text || '').match(/\uFFFD/g) || []).length,
    0
  );
  const hasGiantChapters = maxChapterSize > 100000;
  const tooFewContentChapters = contentChapters.length < 3;
  const spineTocMismatch = tocCount > chapters.length * 2;
  const nonLinearSpineIndexes = options.nonLinearSpineIndexes instanceof Set
    ? options.nonLinearSpineIndexes
    : new Set(options.nonLinearSpineIndexes || []);
  const leakedNonLinearIndexes = new Set(
    chapters
      .map(chapter => chapter?.originalIndex)
      .filter(index => nonLinearSpineIndexes.has(index))
  );
  const nonLinearLeakCount = leakedNonLinearIndexes.size;
  const isGoodStructure = !hasGiantChapters &&
    !spineTocMismatch &&
    !tooFewContentChapters &&
    nonLinearLeakCount === 0;

  return {
    isGoodStructure,
    structureVerified: nonLinearLeakCount === 0,
    totalChapters: chapters.length,
    narrativeChapters: measuredChapters.length,
    contentChapters: contentChapters.length,
    emptyChapters: emptyChapters.length,
    maxChapterSize,
    totalChars,
    replacementChars,
    tocEntries: tocCount,
    nonLinearLeakCount,
    reasons: [
      hasGiantChapters ? `Giant chapter: ${Math.floor(maxChapterSize / 1000)}K chars` : null,
      spineTocMismatch ? `TOC has ${tocCount} entries but only ${chapters.length} spine items` : null,
      tooFewContentChapters ? `Only ${contentChapters.length} content chapters` : null,
      nonLinearLeakCount > 0
        ? `${nonLinearLeakCount} non-linear spine ${nonLinearLeakCount === 1 ? 'document leaked' : 'documents leaked'} into sequential chapters`
        : null
    ].filter(Boolean)
  };
}

function validateExtractedChapters(chapters, options = {}) {
  const validationResult = {
    valid: false,
    errors: [],
    warnings: []
  };

  const format = options.format || 'book';
  const fileSize = options.fileSize || 0;
  const largeBookWarningSize = options.largeBookWarningSize || 50 * 1024 * 1024;
  if (fileSize > largeBookWarningSize) {
    validationResult.warnings.push(`Large ${format.toUpperCase()} file (${Math.round(fileSize / 1024 / 1024)}MB); extraction may be slower`);
  }

  if (!chapters || chapters.length === 0) {
    validationResult.errors.push('No readable content - book is empty or unsupported');
    return validationResult;
  }

  const totalChars = chapters.reduce((sum, chapter) => sum + (chapter.text || '').trim().length, 0);
  const substantialChapters = chapters.filter(
    chapter => (chapter.text || '').trim().length >= SUBSTANTIAL_SECTION_CHARS
  ).length;
  const lengthAssessment = assessReadableContentLength({
    totalChars,
    substantialSections: substantialChapters
  });
  if (!lengthAssessment.valid) {
    validationResult.errors.push(lengthAssessment.error);
    return validationResult;
  }
  if (lengthAssessment.warning) validationResult.warnings.push(lengthAssessment.warning);

  if (substantialChapters / chapters.length < 0.5) {
    validationResult.warnings.push(`${Math.floor((1 - substantialChapters / chapters.length) * 100)}% of sections are empty or very short`);
  }

  const repairedSections = new Set(
    chapters
      .filter(chapter => chapter?.splitFromOversizedChapter)
      .map(chapter => chapter.sourceChapterIndex ?? chapter.sourceTitle ?? chapter.title)
  ).size;
  if (repairedSections > 0) {
    validationResult.warnings.push(
      `Split ${repairedSections} oversized source ${repairedSections === 1 ? 'section' : 'sections'} into audiobook-sized chapters`
    );
  }

  validationResult.valid = true;
  return validationResult;
}

module.exports = {
  buildChapterQuality,
  validateExtractedChapters
};
