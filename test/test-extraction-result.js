const assert = require('assert');
const {
  DIAGNOSTIC_CODES,
  ALLOWED_TEXT_MUTATIONS,
  attachMutationActivations,
  createExtractionResult,
  fromLegacyChapters,
  getExtractionResult,
  isExtractionImportable
} = require('../lib/extraction-result');

function chapter(text, extra = {}) {
  return { index: 0, title: 'Chapter 1', type: 'chapter', text, ...extra };
}

const meaningful = 'A complete sentence with readable narration. '.repeat(30);
const lowConfidence = fromLegacyChapters([
  chapter(meaningful, {
    pdfExtraction: { status: 'failed', score: 25, warnings: ['low structure confidence'] }
  })
], { sourceFormat: 'pdf' });

assert(isExtractionImportable(lowConfidence),
  'a low extraction score cannot reject meaningful narratable text');
assert(isExtractionImportable(createExtractionResult({
  chapters: [chapter('A short but complete poem.')],
  sourceFormat: 'epub'
})), 'short narratable works are not rejected by a book-length heuristic');
assert(lowConfidence.diagnostics.some(diagnostic =>
  diagnostic.code === DIAGNOSTIC_CODES.STRUCTURE_LOW_CONFIDENCE && diagnostic.severity === 'warning'),
'low confidence is a typed nonblocking diagnostic');
assert(lowConfidence.narration.valid && lowConfidence.narration.maxChunkChars <= 4000,
  'accepted extraction text produces narration-safe chunks');
assert.strictEqual(getExtractionResult(lowConfidence.chapters), lowConfidence,
  'chapter-array compatibility retains the non-enumerable extraction result');
assert(!Object.keys(lowConfidence.chapters).includes('extractionResult'),
  'the compatibility attachment does not leak into serialized chapter arrays');

const drm = createExtractionResult({
  chapters: [],
  sourceFormat: 'azw3',
  diagnostics: [{
    code: DIAGNOSTIC_CODES.DRM_PROTECTED,
    severity: 'error',
    category: 'invalid-input',
    recoverability: 'none'
  }]
});
assert(!isExtractionImportable(drm), 'typed verified invalid input blocks import');

const partialDrm = createExtractionResult({
  chapters: [chapter(meaningful)],
  sourceFormat: 'azw3',
  diagnostics: [{
    code: DIAGNOSTIC_CODES.DRM_PROTECTED,
    severity: 'warning',
    category: 'structure-confidence',
    recoverability: 'automatic'
  }]
});
assert(!isExtractionImportable(partialDrm) &&
  partialDrm.diagnostics[0].severity === 'error' &&
  partialDrm.diagnostics[0].category === 'invalid-input',
'registered diagnostic policy cannot be weakened by incomplete or inconsistent caller fields');

const normalizedPdf = fromLegacyChapters([
  chapter(meaningful, {
    normalization: {
      whitespaceFixes: 1,
      paragraphLineJoins: 2,
      pageNumberLinesRemoved: 1,
      hyphenJoins: 1,
      ligatureFixes: 2,
      spacedCapsFixes: 1,
      repeatedHeaderFooterLinesRemoved: 3,
      ocrRepairsApplied: 1
    }
  })
], { sourceFormat: 'pdf' });
assert.strictEqual(normalizedPdf.mutations.length, 7,
  'legacy PDF normalization emits typed mutation activations');
assert(normalizedPdf.mutations.every(mutation => mutation.bound && mutation.count > 0),
  'every mutation activation includes its bound and positive count');

const directlyRecorded = [chapter(meaningful)];
attachMutationActivations(directlyRecorded, [{
  code: ALLOWED_TEXT_MUTATIONS.INVISIBLE_CHARACTER_REMOVAL.code,
  count: 2
}]);
assert(fromLegacyChapters(directlyRecorded, { sourceFormat: 'epub' }).mutations.some(mutation =>
  mutation.code === ALLOWED_TEXT_MUTATIONS.INVISIBLE_CHARACTER_REMOVAL.code && mutation.count === 2),
'extractor-site mutation activations survive the compatibility adapter');

assert.throws(() => createExtractionResult({
  chapters: [chapter(meaningful)],
  mutations: [{ code: 'mutation.title-specific-fix', count: 1 }]
}), /Unregistered text mutation/,
'unregistered and title-specific mutation classes are rejected');
assert.throws(() => createExtractionResult({
  chapters: [chapter(meaningful)],
  mutations: [{ code: ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION.code, count: 0 }]
}), /positive integer count/,
'mutation activations cannot omit a measurable positive count');

console.log('13 passed, 0 failed');
