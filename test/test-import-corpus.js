const assert = require('assert');
const crypto = require('crypto');
const corpus = require('./fixtures/import-corpus');
const { chapterStructureKey } = require('../lib/chapter-structure');
const {
  normalizeChapterSequence,
  splitOversizedChapters,
  OVERSIZED_CHAPTER_THRESHOLD
} = require('../lib/chapter-utils');
const {
  ALLOWED_TEXT_MUTATIONS,
  createExtractionResult,
  fromLegacyChapters,
  isExtractionImportable
} = require('../lib/extraction-result');

const allowedMutationCodes = new Set(Object.values(ALLOWED_TEXT_MUTATIONS).map(value => value.code));
let passed = 0;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Sequence normalization may re-cut chapter boundaries. It may never change,
// drop, or reorder a single character of narration.
function normalizedNarration(chapters) {
  return (chapters || [])
    .map(chapter => String(chapter?.text || ''))
    .join('\n\n')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

for (const fixture of corpus) {
  const sourceHash = sha256(fixture.sourcePayload);
  let chapters = fixture.splitOversized
    ? splitOversizedChapters(clone(fixture.chapters))
    : clone(fixture.chapters);
  const preNormalizationNarration = normalizedNarration(chapters);
  if (fixture.normalizeSequence) chapters = normalizeChapterSequence(chapters, { sourceFormat: fixture.sourceFormat });
  const result = fixture.diagnostics
    ? createExtractionResult({
      chapters,
      diagnostics: fixture.diagnostics,
      sourceFormat: fixture.sourceFormat
    })
    : fromLegacyChapters(chapters, { sourceFormat: fixture.sourceFormat });
  const diagnosticCodes = result.diagnostics.map(value => value.code);
  const mutationCodes = result.mutations.map(value => value.code);

  assert.strictEqual(sourceHash, fixture.expected.sourceHash,
    `${fixture.id}: source fixture checksum changed`);
  assert.strictEqual(result.textIntegrity.normalizedHash, fixture.expected.normalizedHash,
    `${fixture.id}: normalized narration hash changed`);
  assert.strictEqual(chapterStructureKey(chapters), fixture.expected.structureKey,
    `${fixture.id}: chapter structure changed`);
  assert.strictEqual(isExtractionImportable(result), fixture.expected.importable,
    `${fixture.id}: import decision changed`);
  assert.deepStrictEqual(diagnosticCodes, fixture.expected.diagnosticCodes,
    `${fixture.id}: diagnostic contract changed`);
  assert.deepStrictEqual(mutationCodes, fixture.expected.mutationCodes,
    `${fixture.id}: mutation contract changed`);
  assert.strictEqual(chapters.length, fixture.expected.chapterCount,
    `${fixture.id}: chapter count changed`);
  assert.strictEqual(normalizedNarration(chapters), preNormalizationNarration,
    `${fixture.id}: sequence normalization must conserve narration exactly`);
  assert(result.mutations.every(value => allowedMutationCodes.has(value.code)),
    `${fixture.id}: only registered mutation classes can activate`);
  assert(!result.narration.valid || result.narration.maxChunkChars <= result.narration.limit,
    `${fixture.id}: narration chunks stay within the engine limit`);
  assert(chapters.every(chapter => String(chapter.text || '').length <= OVERSIZED_CHAPTER_THRESHOLD),
    `${fixture.id}: no unusable oversized generated chapter remains`);
  passed += 11;
}

console.log(`${passed} passed, 0 failed`);
