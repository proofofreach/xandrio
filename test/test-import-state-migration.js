const assert = require('assert');
const { removeLegacyImportReviewState } = require('../lib/import-state-migration');

const books = {
  old: {
    needsReview: true,
    validationWarnings: ['low confidence'],
    importValidation: { valid: true, needsReview: true, diagnostics: [{ code: 'structure.low-confidence' }] }
  },
  current: { title: 'Current' }
};

assert.strictEqual(removeLegacyImportReviewState(books), true);
assert(!Object.hasOwn(books.old, 'needsReview') && !Object.hasOwn(books.old, 'validationWarnings'));
assert.strictEqual(books.old.importValidation.needsReview, false);
assert.deepStrictEqual(books.old.importValidation.diagnostics, [{ code: 'structure.low-confidence' }]);
assert.strictEqual(removeLegacyImportReviewState(books), false);

// Legacy records carried the whole extraction; startup compacts them once.
{
  const { chapterStructureKey } = require('../lib/chapter-structure');
  const chapters = [
    { index: 0, title: 'One', type: 'chapter', sourceHref: 'one.xhtml', text: 'First chapter text.' },
    { index: 1, title: 'Two', type: 'chapter', sourceHref: 'two.xhtml', text: 'Second chapter text.' }
  ];
  const legacy = {
    heavy: {
      importValidation: {
        valid: true,
        warnings: ['kept'],
        content: {
          valid: true,
          extractionResult: {
            processingVersion: 7,
            diagnostics: [{ code: 'kept' }],
            chapters,
            sourceDocument: { pages: [{ pageNumber: 1, text: 'x'.repeat(5000) }], layout: [] }
          }
        }
      }
    }
  };
  const before = JSON.stringify(legacy).length;
  assert.strictEqual(removeLegacyImportReviewState(legacy), true);
  const result = legacy.heavy.importValidation.content.extractionResult;
  assert.strictEqual(result.sourceDocument, undefined);
  assert.strictEqual(result.processingVersion, 7);
  assert.deepStrictEqual(result.diagnostics, [{ code: 'kept' }]);
  assert.deepStrictEqual(legacy.heavy.importValidation.warnings, ['kept']);
  assert(result.chapters.every(chapter => chapter.text === undefined && /^[a-f0-9]{64}$/.test(chapter.textSha256)));
  assert.strictEqual(chapterStructureKey(result.chapters), chapterStructureKey(chapters));
  assert(JSON.stringify(legacy).length < before / 4);
  assert.strictEqual(removeLegacyImportReviewState(legacy), false, 'compaction is idempotent');
}

console.log('9 passed, 0 failed');
