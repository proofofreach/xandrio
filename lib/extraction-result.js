const crypto = require('crypto');
const { planNarration } = require('./tts-text');

const PROCESSING_VERSION = 1;
const DEFAULT_NARRATION_CHUNK_LIMIT = 4000;

const DIAGNOSTIC_CODES = Object.freeze({
  DRM_PROTECTED: 'invalid.drm-protected',
  SOURCE_UNREADABLE: 'invalid.source-unreadable',
  UNSUPPORTED_FORMAT: 'invalid.unsupported-format',
  NO_NARRATABLE_TEXT: 'text.no-narratable-content',
  OCR_REQUIRED: 'text.ocr-required',
  DESTRUCTIVE_CORRUPTION: 'text.destructive-corruption',
  SHORT_CONTENT: 'text.short-content',
  REPLACEMENT_CHARACTERS: 'text.replacement-characters',
  LOW_READABLE_RATIO: 'text.low-readable-ratio',
  OCR_SUSPECT: 'text.ocr-suspect',
  SPARSE_SECTIONS: 'structure.sparse-sections',
  STRUCTURE_LOW_CONFIDENCE: 'structure.low-confidence',
  STRUCTURE_UNKNOWN: 'structure.unknown',
  METADATA_CONFLICT: 'metadata.conflict',
  RECOVERY_SOURCE_RETAINED: 'recovery.source-retained'
});

const DIAGNOSTIC_POLICIES = Object.freeze({
  [DIAGNOSTIC_CODES.DRM_PROTECTED]: Object.freeze({ severity: 'error', category: 'invalid-input', recoverability: 'none' }),
  [DIAGNOSTIC_CODES.SOURCE_UNREADABLE]: Object.freeze({ severity: 'error', category: 'invalid-input', recoverability: 'different-source' }),
  [DIAGNOSTIC_CODES.UNSUPPORTED_FORMAT]: Object.freeze({ severity: 'error', category: 'invalid-input', recoverability: 'different-source' }),
  [DIAGNOSTIC_CODES.NO_NARRATABLE_TEXT]: Object.freeze({ severity: 'error', category: 'text-integrity', recoverability: 'different-source' }),
  [DIAGNOSTIC_CODES.OCR_REQUIRED]: Object.freeze({ severity: 'error', category: 'text-integrity', recoverability: 'ocr' }),
  [DIAGNOSTIC_CODES.DESTRUCTIVE_CORRUPTION]: Object.freeze({ severity: 'error', category: 'text-integrity', recoverability: 'different-source' }),
  [DIAGNOSTIC_CODES.SHORT_CONTENT]: Object.freeze({ severity: 'warning', category: 'text-integrity', recoverability: 'none' }),
  [DIAGNOSTIC_CODES.REPLACEMENT_CHARACTERS]: Object.freeze({ severity: 'warning', category: 'text-integrity', recoverability: 'different-candidate' }),
  [DIAGNOSTIC_CODES.LOW_READABLE_RATIO]: Object.freeze({ severity: 'warning', category: 'text-integrity', recoverability: 'different-candidate' }),
  [DIAGNOSTIC_CODES.OCR_SUSPECT]: Object.freeze({ severity: 'warning', category: 'text-integrity', recoverability: 'different-candidate' }),
  [DIAGNOSTIC_CODES.SPARSE_SECTIONS]: Object.freeze({ severity: 'warning', category: 'structure-confidence', recoverability: 'automatic' }),
  [DIAGNOSTIC_CODES.STRUCTURE_LOW_CONFIDENCE]: Object.freeze({ severity: 'warning', category: 'structure-confidence', recoverability: 'automatic' }),
  [DIAGNOSTIC_CODES.STRUCTURE_UNKNOWN]: Object.freeze({ severity: 'warning', category: 'structure-confidence', recoverability: 'automatic' }),
  [DIAGNOSTIC_CODES.METADATA_CONFLICT]: Object.freeze({ severity: 'warning', category: 'metadata-confidence', recoverability: 'automatic' }),
  [DIAGNOSTIC_CODES.RECOVERY_SOURCE_RETAINED]: Object.freeze({ severity: 'warning', category: 'recovery-integrity', recoverability: 'automatic' })
});

const BLOCKING_CATEGORIES = new Set(['invalid-input', 'text-integrity']);

// This registry is intentionally closed. A mutation must be added here with a
// generic characterization test before extraction code may rely on it.
const ALLOWED_TEXT_MUTATIONS = Object.freeze({
  WHITESPACE_NORMALIZATION: Object.freeze({ code: 'mutation.whitespace-normalization', bound: 'whitespace-only' }),
  SEMANTIC_PAGE_MARKER_REMOVAL: Object.freeze({ code: 'mutation.semantic-page-marker-removal', bound: 'matched-marker-only' }),
  EXACT_DUPLICATE_REMOVAL: Object.freeze({ code: 'mutation.exact-duplicate-removal', bound: 'exact-duplicate-only' }),
  INVISIBLE_CHARACTER_REMOVAL: Object.freeze({ code: 'mutation.invisible-character-removal', bound: 'unicode-format-characters-only' }),
  RECOGNIZED_BOILERPLATE_REMOVAL: Object.freeze({ code: 'mutation.recognized-boilerplate-removal', bound: 'matched-fixture-class-only' }),
  LINE_WRAP_DEHYPHENATION: Object.freeze({ code: 'mutation.line-wrap-dehyphenation', bound: 'letter-linebreak-letter-only' }),
  LIGATURE_NORMALIZATION: Object.freeze({ code: 'mutation.ligature-normalization', bound: 'unicode-ligature-codepoints-only' }),
  SPACED_CAPS_NORMALIZATION: Object.freeze({ code: 'mutation.spaced-caps-normalization', bound: 'three-or-more-single-capitals-only' }),
  REPEATED_HEADER_FOOTER_REMOVAL: Object.freeze({ code: 'mutation.repeated-header-footer-removal', bound: 'same-edge-line-on-three-or-more-pages' }),
  OCR_TOKEN_REPAIR: Object.freeze({ code: 'mutation.ocr-token-repair', bound: 'allowlisted-token-and-context-only' })
});

const ALLOWED_MUTATION_BY_CODE = new Map(
  Object.values(ALLOWED_TEXT_MUTATIONS).map(value => [value.code, value])
);

function normalizedNarrationText(chapters = []) {
  return (chapters || [])
    .map(chapter => String(chapter?.text || ''))
    .join('\n\n')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function assessTextIntegrity(chapters = []) {
  const text = normalizedNarrationText(chapters);
  const replacementChars = (text.match(/\uFFFD/g) || []).length;
  const nonWhitespace = (text.match(/\S/gu) || []).length;
  const alphanumeric = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  return {
    normalizedChars: text.length,
    normalizedHash: crypto.createHash('sha256').update(text).digest('hex'),
    replacementChars,
    replacementRatio: text.length ? replacementChars / text.length : 0,
    alphanumericRatio: nonWhitespace ? alphanumeric / nonWhitespace : 0
  };
}

function assessNarration(chapters = [], maxChunkChars = DEFAULT_NARRATION_CHUNK_LIMIT) {
  const chunks = [];
  for (const chapter of chapters || []) {
    const plan = planNarration(chapter?.text || '', { maxChars: maxChunkChars });
    chunks.push(...plan.chunks);
  }
  const max = chunks.reduce((value, chunk) => Math.max(value, chunk.text.length), 0);
  return {
    valid: chunks.length > 0 && max <= maxChunkChars,
    chunkCount: chunks.length,
    maxChunkChars: max,
    limit: maxChunkChars
  };
}

function hasMeaningfulNarration(chapters = []) {
  const text = normalizedNarrationText(chapters);
  // Length is not evidence that a readable work is invalid. The narration
  // planner is the authority on whether non-empty extracted text can play.
  return Boolean(text && assessNarration(chapters).valid);
}

function diagnostic(value) {
  const code = String(value?.code || '');
  const policy = DIAGNOSTIC_POLICIES[code];
  if (!policy) throw new TypeError(`Unregistered extraction diagnostic: ${code}`);
  return {
    code,
    ...policy,
    ...(value.evidence === undefined ? {} : { evidence: value.evidence })
  };
}

function mutationActivation(value) {
  const policy = ALLOWED_MUTATION_BY_CODE.get(String(value?.code || ''));
  if (!policy) throw new TypeError(`Unregistered text mutation: ${String(value?.code || '')}`);
  const count = Number(value?.count);
  if (!Number.isInteger(count) || count <= 0) {
    throw new TypeError(`Text mutation ${policy.code} requires a positive integer count`);
  }
  return {
    code: policy.code,
    bound: policy.bound,
    count,
    ...(value.evidence === undefined ? {} : { evidence: value.evidence })
  };
}

function mergeMutationActivations(values = []) {
  const counts = new Map();
  for (const value of values || []) {
    const activation = mutationActivation(value);
    counts.set(activation.code, (counts.get(activation.code) || 0) + activation.count);
  }
  return [...counts.entries()].map(([code, count]) => mutationActivation({ code, count }));
}

function createMutationCollector() {
  const values = [];
  return {
    record(value) {
      const activation = mutationActivation(value);
      values.push(activation);
      return activation;
    },
    values() {
      return mergeMutationActivations(values);
    }
  };
}

function attachMutationActivations(chapters, mutations = []) {
  if (!Array.isArray(chapters)) return chapters;
  Object.defineProperty(chapters, 'mutationActivations', {
    value: mergeMutationActivations(mutations),
    enumerable: false,
    configurable: true
  });
  return chapters;
}

function mutationsFromNormalization(normalization) {
  if (!normalization) return [];
  const definitions = [
    [ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION.code,
      Number(normalization.whitespaceFixes || 0) + Number(normalization.paragraphLineJoins || 0)],
    [ALLOWED_TEXT_MUTATIONS.SEMANTIC_PAGE_MARKER_REMOVAL.code, Number(normalization.pageNumberLinesRemoved || 0)],
    [ALLOWED_TEXT_MUTATIONS.LINE_WRAP_DEHYPHENATION.code, Number(normalization.hyphenJoins || 0)],
    [ALLOWED_TEXT_MUTATIONS.LIGATURE_NORMALIZATION.code, Number(normalization.ligatureFixes || 0)],
    [ALLOWED_TEXT_MUTATIONS.SPACED_CAPS_NORMALIZATION.code, Number(normalization.spacedCapsFixes || 0)],
    [ALLOWED_TEXT_MUTATIONS.REPEATED_HEADER_FOOTER_REMOVAL.code,
      Number(normalization.repeatedHeaderFooterLinesRemoved || 0)],
    [ALLOWED_TEXT_MUTATIONS.OCR_TOKEN_REPAIR.code, Number(normalization.ocrRepairsApplied || 0)]
  ];
  return definitions
    .filter(([, count]) => Number.isInteger(count) && count > 0)
    .map(([code, count]) => mutationActivation({ code, count }));
}

function mutationsFromLegacy(chapters = []) {
  const normalization = (chapters || []).find(chapter => chapter?.normalization)?.normalization;
  return mutationsFromNormalization(normalization);
}

function legacyReport(chapters, sourceFormat) {
  const format = String(sourceFormat || '').toLowerCase();
  if (format === 'pdf') return (chapters || []).find(chapter => chapter?.pdfExtraction)?.pdfExtraction || null;
  if (['mobi', 'prc', 'azw', 'azw3'].includes(format)) {
    return (chapters || []).find(chapter => chapter?.kindleExtraction)?.kindleExtraction || null;
  }
  return null;
}

function diagnosticsFromLegacy(chapters = [], sourceFormat = '') {
  const report = legacyReport(chapters, sourceFormat);
  const meaningful = hasMeaningfulNarration(chapters);
  const diagnostics = [];
  const status = report?.status;

  if (status === 'drm-protected') {
    diagnostics.push(diagnostic({
      code: DIAGNOSTIC_CODES.DRM_PROTECTED,
      severity: 'error',
      category: 'invalid-input',
      recoverability: 'none'
    }));
  } else if (status === 'unsupported') {
    diagnostics.push(diagnostic({
      code: DIAGNOSTIC_CODES.UNSUPPORTED_FORMAT,
      severity: 'error',
      category: 'invalid-input',
      recoverability: 'different-source'
    }));
  }

  if (!meaningful) {
    diagnostics.push(diagnostic({
      code: status === 'ocr-required' ? DIAGNOSTIC_CODES.OCR_REQUIRED : DIAGNOSTIC_CODES.NO_NARRATABLE_TEXT,
      severity: 'error',
      category: 'text-integrity',
      recoverability: status === 'ocr-required' ? 'ocr' : 'different-source',
      evidence: { status: status || 'empty' }
    }));
  } else if (status && status !== 'ready') {
    diagnostics.push(diagnostic({
      code: DIAGNOSTIC_CODES.STRUCTURE_LOW_CONFIDENCE,
      severity: 'warning',
      category: 'structure-confidence',
      recoverability: 'automatic',
      evidence: { status, score: Number(report?.score) || 0 }
    }));
  }

  const integrity = assessTextIntegrity(chapters);
  if (integrity.replacementChars > 0) {
    diagnostics.push(diagnostic({
      code: DIAGNOSTIC_CODES.REPLACEMENT_CHARACTERS,
      severity: 'warning',
      category: 'text-integrity',
      recoverability: 'different-candidate',
      evidence: {
        count: integrity.replacementChars,
        ratio: integrity.replacementRatio
      }
    }));
  }
  return diagnostics;
}

function attachExtractionResult(chapters, result) {
  if (!Array.isArray(chapters)) return chapters;
  Object.defineProperty(chapters, 'extractionResult', {
    value: result,
    enumerable: false,
    configurable: true
  });
  if (result.sourceDocument) {
    Object.defineProperty(chapters, 'sourceDocument', {
      value: result.sourceDocument,
      enumerable: false,
      configurable: true
    });
  }
  return chapters;
}

function createExtractionResult(value = {}) {
  const chapters = Array.isArray(value.chapters) ? value.chapters : [];
  const result = {
    chapters,
    diagnostics: (value.diagnostics || []).map(diagnostic),
    mutations: (value.mutations || []).map(mutationActivation),
    candidates: Array.isArray(value.candidates) ? value.candidates : [],
    sourceDocument: value.sourceDocument,
    sourceFormat: String(value.sourceFormat || '').toLowerCase(),
    processingVersion: Number.isInteger(value.processingVersion) ? value.processingVersion : PROCESSING_VERSION,
    textIntegrity: value.textIntegrity || assessTextIntegrity(chapters),
    narration: value.narration || assessNarration(chapters)
  };
  attachExtractionResult(chapters, result);
  return result;
}

function fromLegacyChapters(chapters = [], options = {}) {
  const existing = getExtractionResult(chapters);
  if (existing) return existing;
  const report = legacyReport(chapters, options.sourceFormat);
  return createExtractionResult({
    chapters,
    diagnostics: diagnosticsFromLegacy(chapters, options.sourceFormat),
    mutations: mergeMutationActivations([
      ...(chapters?.mutationActivations || []),
      ...mutationsFromLegacy(chapters)
    ]),
    candidates: report?.candidates || [],
    sourceDocument: options.sourceDocument || chapters?.sourceDocument,
    sourceFormat: options.sourceFormat,
    processingVersion: options.processingVersion
  });
}

function getExtractionResult(chapters) {
  return Array.isArray(chapters) ? chapters.extractionResult || null : null;
}

function isBlockingDiagnostic(value) {
  return value?.severity === 'error' && BLOCKING_CATEGORIES.has(value.category);
}

function isExtractionImportable(result) {
  return Boolean(result &&
    hasMeaningfulNarration(result.chapters) &&
    result.narration?.valid &&
    !(result.diagnostics || []).some(isBlockingDiagnostic));
}

module.exports = {
  PROCESSING_VERSION,
  DEFAULT_NARRATION_CHUNK_LIMIT,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_POLICIES,
  ALLOWED_TEXT_MUTATIONS,
  normalizedNarrationText,
  assessTextIntegrity,
  assessNarration,
  hasMeaningfulNarration,
  diagnostic,
  mutationActivation,
  mergeMutationActivations,
  createMutationCollector,
  attachMutationActivations,
  mutationsFromNormalization,
  mutationsFromLegacy,
  diagnosticsFromLegacy,
  attachExtractionResult,
  createExtractionResult,
  fromLegacyChapters,
  getExtractionResult,
  isBlockingDiagnostic,
  isExtractionImportable
};
